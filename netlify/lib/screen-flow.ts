import type { PoolClient } from 'pg';
import { HttpError } from './http';
import { setScreen, type ScreenTarget } from './game-state';
import { completeRound } from './round-lifecycle';
import { visibleNeighbours } from './presentation';
import { questionIsLive } from './live-quiz';
import { pubquizIsLive } from './pubquiz';
import { SCENE_FOR_ROUND_TYPE, type RoundType } from './round-types';

/**
 * Where NEXT and PREVIOUS go, for every round type, in one place.
 *
 * This exists because the Admin needs to answer the same question twice: once to draw the
 * preview of what NEXT will put on the projector, and once to actually put it there. Those
 * were about to become two implementations of the same rules, which is how a preview ends
 * up lying. They are one function instead, and the preview is literally the thing the
 * button will do, asked without doing it.
 *
 * It replaces Preview → Go Live. There is no staged slot any more: the host sees what is
 * live and what comes next, and pressing NEXT makes the second the first.
 */

export type ScreenStep =
  /** Put this on the projector. */
  | { kind: 'target'; target: ScreenTarget; label: string }
  /** There is nothing after this, and stepping forward ends the round. */
  | { kind: 'completeRound'; roundId: number; label: string }
  /** This round does not step in that direction, and why. */
  | { kind: 'none'; reason: string };

export type NavigationDirection = 'NEXT' | 'PREVIOUS';

/**
 * Whether a round type can be stepped through at all, and in which directions.
 *
 * Backwards is not universally safe and is not offered universally. A presentation page
 * has no state to undo, so both directions are free. A quiz question can be stepped back
 * to, but only once the current one is settled, which the step itself enforces. The four
 * game rounds are a single live scene driven by their own controls — a roulette table has
 * no "previous" that would not mean unspinning a wheel that has already paid out.
 */
export function navigationCapabilities(type: RoundType | null) {
  if (type === 'PRESENTATIE') return { next: true, previous: true };
  if (type === 'LIVE_QUIZ') return { next: true, previous: true };
  if (type === 'PUBQUIZ') return { next: true, previous: true };
  return { next: false, previous: false };
}

type ActiveRound = { id: number; type: RoundType; status: string };

async function loadActive(client: PoolClient, gameId: number): Promise<ActiveRound | null> {
  const { rows } = await client.query(
    `SELECT r.id,r.type,r.status FROM rounds r
     JOIN game_nights g ON g.current_round_id=r.id
     WHERE g.id=$1 AND r.status='ACTIVE'`,
    [gameId],
  );
  return rows[0] ? { id: Number(rows[0].id), type: rows[0].type as RoundType, status: rows[0].status } : null;
}

/**
 * Where the host currently is within the round.
 *
 * Read from `screen_state` when the projector is showing this round, and from the round's
 * own cursor otherwise. Those are two different concepts and stay two different concepts —
 * this only decides which one NEXT should be measured from, and the projector wins when it
 * is pointed at this round, because NEXT means "after what the room is looking at".
 */
async function positionIn(client: PoolClient, gameId: number, round: ActiveRound) {
  const screen = await client.query(
    'SELECT mode,round_id,quiz_question_id,slide_id,pubquiz_question_id FROM screen_state WHERE game_night_id=$1',
    [gameId],
  );
  const row = screen.rows[0];
  const onThisRound = row && Number(row.round_id || 0) === round.id;
  const runtime = await client.query(
    'SELECT current_quiz_question_id,current_slide_id,current_pubquiz_question_id FROM round_runtime WHERE round_id=$1',
    [round.id],
  );
  const cursor = runtime.rows[0] || {};
  return {
    pubquizQuestionId: onThisRound && row.mode === 'PUBQUIZ_QUESTION'
      ? Number(row.pubquiz_question_id || 0) || null
      : Number(cursor.current_pubquiz_question_id || 0) || null,
    quizQuestionId: onThisRound && row.mode === 'QUIZ_QUESTION'
      ? Number(row.quiz_question_id || 0) || null
      : Number(cursor.current_quiz_question_id || 0) || null,
    slideId: onThisRound && row.mode === 'SLIDE'
      ? Number(row.slide_id || 0) || null
      : Number(cursor.current_slide_id || 0) || null,
    projectorIsOnThisRound: Boolean(onThisRound),
  };
}

/**
 * The step NEXT or PREVIOUS would take, without taking it.
 *
 * Pure inspection: it writes nothing, so the Admin can ask for it on every poll.
 */
export async function planStep(
  client: PoolClient,
  gameId: number,
  direction: NavigationDirection,
): Promise<ScreenStep> {
  const round = await loadActive(client, gameId);
  if (!round) return { kind: 'none', reason: 'No round is being played' };

  const capabilities = navigationCapabilities(round.type);
  if (direction === 'NEXT' && !capabilities.next) {
    return { kind: 'none', reason: `A ${round.type} round is one scene — it is driven by its own controls, not by stepping` };
  }
  if (direction === 'PREVIOUS' && !capabilities.previous) {
    return { kind: 'none', reason: `A ${round.type} round has nothing to step back to` };
  }

  const at = await positionIn(client, gameId, round);

  if (round.type === 'PRESENTATIE') {
    const listed = await client.query(
      'SELECT id,hidden,title FROM presentation_slides WHERE round_id=$1 ORDER BY sort_order,id',
      [round.id],
    );
    const pages = listed.rows.map((r: any) => ({ id: Number(r.id), hidden: Boolean(r.hidden), title: r.title as string | null }));
    if (!pages.length) return { kind: 'none', reason: 'This presentation round has no pages yet' };

    const around = visibleNeighbours(pages, at.slideId);
    if (!around.visibleCount) return { kind: 'none', reason: 'Every page in this round is hidden' };

    // Not yet showing anything from this round: the first page in the run is next.
    if (direction === 'NEXT' && (at.slideId == null || around.at < 0)) {
      const first = around.first!;
      return { kind: 'target', target: { kind: 'slide', roundId: round.id, slideId: first.id }, label: pageLabel(pages, first.id) };
    }

    const step = direction === 'NEXT' ? around.next : around.previous;
    if (step) {
      return { kind: 'target', target: { kind: 'slide', roundId: round.id, slideId: step.id }, label: pageLabel(pages, step.id) };
    }
    // Past the last page in the run, forward, is the end of the round — and only from
    // there. The last page is shown normally first; it is the step *after* it that ends
    // the presentation.
    if (direction === 'NEXT') return { kind: 'completeRound', roundId: round.id, label: 'End of the presentation' };
    return { kind: 'none', reason: 'This is the first page' };
  }

  if (round.type === 'LIVE_QUIZ') {
    const listed = await client.query(
      `SELECT q.id,q.prompt,st.status FROM live_quiz_questions q
       JOIN live_quiz_question_state st ON st.question_id=q.id
       WHERE q.round_id=$1 ORDER BY q.sort_order,q.id`,
      [round.id],
    );
    const questions = listed.rows.map((r: any) => ({ id: Number(r.id), prompt: r.prompt as string, status: r.status as string }));
    if (!questions.length) return { kind: 'none', reason: 'This quiz round has no questions yet' };

    const index = questions.findIndex(q => q.id === at.quizQuestionId);
    if (direction === 'NEXT' && index < 0) {
      return { kind: 'target', target: { kind: 'quizQuestion', roundId: round.id, questionId: questions[0].id }, label: questions[0].prompt };
    }

    // The same rule the quiz's own navigation enforces, asked here so the preview can say
    // why NEXT is refused rather than letting the host find out by pressing it.
    const current = index >= 0 ? questions[index] : null;
    if (current && questionIsLive(current.status)) {
      return { kind: 'none', reason: `The current question is still ${current.status} — settle it before moving on` };
    }

    const step = direction === 'NEXT' ? questions[index + 1] : questions[index - 1];
    if (step) return { kind: 'target', target: { kind: 'quizQuestion', roundId: round.id, questionId: step.id }, label: step.prompt };
    if (direction === 'NEXT') return { kind: 'completeRound', roundId: round.id, label: 'End of the quiz' };
    return { kind: 'none', reason: 'This is the first question' };
  }

  if (round.type === 'PUBQUIZ') {
    // The full authored list, held-back questions included: the cursor may be standing on
    // one, and stepping from there still means the nearest question in the run.
    const listed = await client.query(
      `SELECT q.id,q.hidden,q.question,st.status FROM pubquiz_questions q
       JOIN pubquiz_question_state st ON st.question_id=q.id
       WHERE q.round_id=$1 ORDER BY q.sort_order,q.id`,
      [round.id],
    );
    const questions = listed.rows.map((r: any) => ({
      id: Number(r.id), hidden: Boolean(r.hidden), question: r.question as string, status: r.status as string,
    }));
    if (!questions.length) return { kind: 'none', reason: 'This pubquiz round has no questions yet' };

    const around = visibleNeighbours(questions, at.pubquizQuestionId);
    if (!around.visibleCount) return { kind: 'none', reason: 'Every question in this round is hidden' };

    if (direction === 'NEXT' && (at.pubquizQuestionId == null || around.at < 0)) {
      const first = around.first!;
      return { kind: 'target', target: { kind: 'pubquizQuestion', roundId: round.id, questionId: first.id }, label: labelFor(questions, first.id) };
    }

    // Stepping away from a question the room has answered but not been told about would
    // strand their answers with no reveal. Same shape as the quiz's rule, and said here so
    // the preview can explain the refusal rather than letting the host discover it.
    const current = around.at >= 0 ? questions[around.at] : null;
    if (current && pubquizIsLive(current.status)) {
      return { kind: 'none', reason: `The current question is still ${current.status} — close and reveal it before moving on` };
    }

    const step = direction === 'NEXT' ? around.next : around.previous;
    if (step) {
      return { kind: 'target', target: { kind: 'pubquizQuestion', roundId: round.id, questionId: step.id }, label: labelFor(questions, step.id) };
    }
    if (direction === 'NEXT') return { kind: 'completeRound', roundId: round.id, label: 'End of the pubquiz' };
    return { kind: 'none', reason: 'This is the first question' };
  }

  return { kind: 'none', reason: `A ${round.type} round is one scene` };
}

function labelFor(questions: { id: number; question: string }[], id: number) {
  return questions.find(q => q.id === id)?.question ?? 'Question';
}

function pageLabel(pages: { id: number; title: string | null }[], id: number) {
  const index = pages.findIndex(p => p.id === id);
  const page = pages[index];
  return page?.title || `Page ${index + 1}`;
}

/**
 * Take the step, and put it on the projector in the same breath.
 *
 * NEXT means "show the next thing", not "select the next thing". The intermediate GO LIVE
 * is gone: what the host presses is what the room sees.
 *
 * The round's own cursor moves with it, so progression and presentation stay in step while
 * remaining two separate ideas — `expectedRevision` guards that cursor, so a NEXT issued
 * from a tab that has fallen behind is refused rather than dragging the projector back to
 * where that tab thought it was.
 */
export async function advanceScreen(
  client: PoolClient,
  gameId: number,
  direction: NavigationDirection,
  actor: string,
  expectedRevision: number | null,
) {
  const round = await loadActive(client, gameId);
  if (!round) throw new HttpError(409, 'No round is being played');

  const runtime = await client.query(
    'SELECT revision FROM round_runtime WHERE round_id=$1 FOR UPDATE',
    [round.id],
  );
  const revision = Number(runtime.rows[0]?.revision ?? 0);
  if (expectedRevision != null && revision !== expectedRevision) {
    throw new HttpError(409, 'This round has moved on since — refresh and try again');
  }

  const step = await planStep(client, gameId, direction);
  if (step.kind === 'none') throw new HttpError(409, step.reason);

  if (step.kind === 'completeRound') {
    const { completed } = await completeRound(client, gameId, round.id, round.type, actor, 'round completed');
    return { kind: 'completeRound' as const, roundId: round.id, completed, revision };
  }

  // `setScreen` moves the round's cursor with the projector, so there is one write and
  // one place that decides where the round is. The revision check above is the guard:
  // the runtime row is held FOR UPDATE from there until this transaction commits, so a
  // step from a stale tab was already refused before anything moved.
  await setScreen(client, gameId, step.target, actor);

  // A pubquiz question that has never been asked opens the moment it reaches the
  // projector: the host presses one button, not two, and the phones are ready before the
  // room has finished reading the question. Guarded on READY, so stepping *back* onto a
  // closed or revealed question never reopens scoring the room has already seen.
  if (step.target.kind === 'pubquizQuestion') {
    await client.query(
      `UPDATE pubquiz_question_state SET status='OPEN',opened_at=NOW(),revision=revision+1,updated_at=NOW()
       WHERE question_id=$1 AND status='READY'`,
      [step.target.questionId],
    );
  }

  const after = await client.query('SELECT revision FROM round_runtime WHERE round_id=$1', [round.id]);
  return {
    kind: 'target' as const,
    target: step.target,
    label: step.label,
    roundId: round.id,
    revision: Number(after.rows[0]?.revision ?? revision + 1),
  };
}

/**
 * What the projector should show the moment a round starts.
 *
 * Starting a round now claims the big screen, for every type. The rule it replaces —
 * progression and presentation are separate, so starting changes nothing the room sees —
 * was right about the concepts and wrong about the host: it meant every round began with a
 * dashboard on the wall and a second click to fix it.
 *
 * The two ideas are still separate. Starting is simply defined as including a presentation
 * decision, made here, once, for every type — rather than each surface guessing.
 */
export async function initialScreenTarget(
  client: PoolClient,
  gameId: number,
  roundId: number,
  type: RoundType,
): Promise<ScreenTarget | null> {
  if (type === 'PRESENTATIE') {
    const { rows } = await client.query(
      'SELECT id FROM presentation_slides WHERE round_id=$1 AND hidden=FALSE ORDER BY sort_order,id LIMIT 1',
      [roundId],
    );
    // A round with nothing in the run has nothing to show, and putting an empty scene on
    // the projector would be worse than leaving the dashboard up.
    return rows[0] ? { kind: 'slide', roundId, slideId: Number(rows[0].id) } : null;
  }

  if (type === 'LIVE_QUIZ') {
    const { rows } = await client.query(
      'SELECT id FROM live_quiz_questions WHERE round_id=$1 ORDER BY sort_order,id LIMIT 1',
      [roundId],
    );
    return rows[0] ? { kind: 'quizQuestion', roundId, questionId: Number(rows[0].id) } : null;
  }

  if (type === 'PUBQUIZ') {
    const { rows } = await client.query(
      'SELECT id FROM pubquiz_questions WHERE round_id=$1 AND hidden=FALSE ORDER BY sort_order,id LIMIT 1',
      [roundId],
    );
    if (!rows[0]) return null;
    // Starting the round opens the first question, so the room can answer it straight
    // away rather than waiting for the host to press a second button.
    await client.query(
      `UPDATE pubquiz_question_state SET status='OPEN',opened_at=NOW(),revision=revision+1,updated_at=NOW()
       WHERE question_id=$1 AND status='READY'`,
      [Number(rows[0].id)],
    );
    return { kind: 'pubquizQuestion', roundId, questionId: Number(rows[0].id) };
  }

  // The four game rounds are one scene each, named by the round itself.
  return SCENE_FOR_ROUND_TYPE[type] ? { kind: 'roundGame', roundId } : null;
}
