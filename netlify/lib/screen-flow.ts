import type { PoolClient } from 'pg';
import { HttpError } from './http';
import { setScreen, type ScreenTarget } from './game-state';
import { completeRound } from './round-lifecycle';
import { visibleNeighbours } from './presentation';
import { slideIsRevealed } from './presentation';
import { isRevealed as quizIsRevealed } from './live-quiz';
import { pubquizIsRevealed } from './pubquiz';
import { revealPubquizQuestion, revealQuizQuestion } from './question-reveal';
import { SCENE_FOR_ROUND_TYPE, type RoundType } from './round-types';

/**
 * The chronology of a game night: what VOLGENDE means, everywhere, once.
 *
 * A round is a story. It opens on its own title card, walks through whatever it holds —
 * pages and their answers, questions and their reveals, or a single live game scene — and
 * ends. One pair of buttons walks that story, and this module is the only place that knows
 * what the next sentence is.
 *
 * That matters twice over. The Admin has to answer the same question to *draw* the NEXT
 * preview and to *take* the step, and those were on their way to becoming two
 * implementations of one rule — which is precisely how a preview starts lying. Here they
 * are the same function: `planStep` is the step, asked without taking it, and
 * `advanceScreen` is `planStep` plus the write.
 *
 * Central does not mean uniform. Each type keeps its own sequence below, because a
 * presentation page and a roulette table have nothing in common except that the host
 * presses the same button to leave them.
 *
 *   PRESENTATIE  INTRO → page → its reveal, if it has one → next page → … → COMPLETED
 *   PUBQUIZ      INTRO → question (opens) → its reveal, which pays → next → … → COMPLETED
 *   LIVE_QUIZ    INTRO → question (opens) → its reveal, which pays → next → … → COMPLETED
 *   game rounds  INTRO → the round's own scene, which its own controls drive
 *
 * VORIGE is not the inverse of any of that. See `planStep` for why.
 */

export type ScreenStep =
  /** Put this on the projector. `reveal` additionally opens or reveals what it points at. */
  | { kind: 'target'; target: ScreenTarget; label: string; reveal?: boolean }
  /** There is nothing after this, and stepping forward ends the round. */
  | { kind: 'completeRound'; roundId: number; label: string }
  /** Nothing to step to in that direction, and why. */
  | { kind: 'none'; reason: string };

export type NavigationDirection = 'NEXT' | 'PREVIOUS';

/**
 * Which directions are available right now.
 *
 * Sent to the Admin rather than guessed there, so a button is disabled because the server
 * said so and not because the frontend re-derived a rule it might have got wrong.
 */
export function navigationCapabilities(type: RoundType | null) {
  // Every type now has an intro to step out of and back to, so every type navigates.
  // What differs is how far forward it goes, which is the sequence below.
  if (!type) return { canGoNext: false, canGoPrevious: false };
  return { canGoNext: true, canGoPrevious: true };
}

type ActiveRound = {
  id: number;
  type: RoundType;
  status: string;
  title: string;
};

async function loadActive(client: PoolClient, gameId: number): Promise<ActiveRound | null> {
  const { rows } = await client.query(
    `SELECT r.id,r.type,r.status,r.title FROM rounds r
     JOIN game_nights g ON g.current_round_id=r.id
     WHERE g.id=$1 AND r.status='ACTIVE'`,
    [gameId],
  );
  return rows[0]
    ? { id: Number(rows[0].id), type: rows[0].type as RoundType, status: rows[0].status, title: rows[0].title }
    : null;
}

/** Where the projector is standing, which is what NEXT is measured from. */
async function screenPosition(client: PoolClient, gameId: number, round: ActiveRound) {
  const { rows } = await client.query(
    `SELECT mode,round_id,quiz_question_id,slide_id,pubquiz_question_id,revision
     FROM screen_state WHERE game_night_id=$1`,
    [gameId],
  );
  const row = rows[0] || {};
  const onThisRound = Number(row.round_id || 0) === round.id;
  return {
    mode: String(row.mode || 'DASHBOARD'),
    revision: Number(row.revision ?? 0),
    onThisRound,
    onIntro: onThisRound && row.mode === 'ROUND_INTRO',
    quizQuestionId: onThisRound && row.mode === 'QUIZ_QUESTION' ? Number(row.quiz_question_id || 0) || null : null,
    slideId: onThisRound && row.mode === 'SLIDE' ? Number(row.slide_id || 0) || null : null,
    pubquizQuestionId: onThisRound && row.mode === 'PUBQUIZ_QUESTION' ? Number(row.pubquiz_question_id || 0) || null : null,
  };
}

type Position = Awaited<ReturnType<typeof screenPosition>>;

const introStep = (round: ActiveRound): ScreenStep => ({
  kind: 'target',
  target: { kind: 'roundIntro', roundId: round.id },
  label: round.title,
});

/**
 * PRESENTATIE.
 *
 * A page with something to reveal is two steps, not one: the page, then its answer. A page
 * with nothing to reveal is one step, and no empty answer card is invented for it —
 * whether it has an answer is read from what the host authored (`reveal_text`, or a title
 * that is itself the answer).
 */
async function planPresentation(
  client: PoolClient,
  round: ActiveRound,
  at: Position,
  direction: NavigationDirection,
): Promise<ScreenStep> {
  const { rows } = await client.query(
    `SELECT s.id,s.hidden,s.title,s.reveal_text,s.hide_title_until_reveal,st.revealed_at
     FROM presentation_slides s
     LEFT JOIN presentation_slide_state st ON st.slide_id=s.id
     WHERE s.round_id=$1 ORDER BY s.sort_order,s.id`,
    [round.id],
  );
  const pages = rows.map((r: any, index: number) => ({
    id: Number(r.id),
    hidden: Boolean(r.hidden),
    label: (r.title as string) || `Page ${index + 1}`,
    hasAnswer: Boolean(r.reveal_text) || Boolean(r.hide_title_until_reveal),
    revealed: slideIsRevealed(r.revealed_at),
  }));

  if (!pages.length) {
    return direction === 'NEXT'
      ? { kind: 'completeRound', roundId: round.id, label: 'This presentation has no pages' }
      : introStep(round);
  }
  const around = visibleNeighbours(pages, at.slideId);
  if (!around.visibleCount) {
    return direction === 'NEXT'
      ? { kind: 'completeRound', roundId: round.id, label: 'Every page is hidden' }
      : introStep(round);
  }

  if (direction === 'PREVIOUS') {
    if (at.slideId == null) return { kind: 'none', reason: 'This is the start of the round' };
    const back = around.previous;
    if (back) return { kind: 'target', target: { kind: 'slide', roundId: round.id, slideId: back.id }, label: back.label };
    return introStep(round);
  }

  // From the intro, or from anywhere that is not this round's pages, the first page.
  if (at.slideId == null || around.at < 0) {
    const first = around.first!;
    return { kind: 'target', target: { kind: 'slide', roundId: round.id, slideId: first.id }, label: first.label };
  }

  // Standing on a page that still has its answer to give: the answer is the next step,
  // on the same page.
  const current = pages[around.at];
  if (current.hasAnswer && !current.revealed) {
    return {
      kind: 'target',
      target: { kind: 'slide', roundId: round.id, slideId: current.id },
      label: `${current.label} — antwoord`,
      reveal: true,
    };
  }

  const next = around.next;
  if (next) return { kind: 'target', target: { kind: 'slide', roundId: round.id, slideId: next.id }, label: next.label };
  return { kind: 'completeRound', roundId: round.id, label: 'End of the presentation' };
}

/**
 * PUBQUIZ and LIVE_QUIZ.
 *
 * The same shape, over two different sets of tables. A question is two steps: asking it —
 * which opens it for answers, so the host presses one button rather than two — and
 * revealing it, which is also when it pays.
 */
async function planQuestions(
  client: PoolClient,
  round: ActiveRound,
  at: Position,
  direction: NavigationDirection,
  flavour: 'PUBQUIZ' | 'LIVE_QUIZ',
): Promise<ScreenStep> {
  const isPub = flavour === 'PUBQUIZ';
  const { rows } = isPub
    ? await client.query(
      `SELECT q.id,q.hidden,q.question AS label,st.status FROM pubquiz_questions q
       JOIN pubquiz_question_state st ON st.question_id=q.id
       WHERE q.round_id=$1 ORDER BY q.sort_order,q.id`,
      [round.id],
    )
    : await client.query(
      `SELECT q.id,FALSE AS hidden,q.prompt AS label,st.status FROM live_quiz_questions q
       JOIN live_quiz_question_state st ON st.question_id=q.id
       WHERE q.round_id=$1 ORDER BY q.sort_order,q.id`,
      [round.id],
    );

  const questions = rows.map((r: any) => ({
    id: Number(r.id),
    hidden: Boolean(r.hidden),
    label: r.label as string,
    status: r.status as string,
    revealed: isPub ? pubquizIsRevealed(r.status) : quizIsRevealed(r.status),
  }));

  const currentId = isPub ? at.pubquizQuestionId : at.quizQuestionId;
  const targetFor = (id: number): ScreenTarget => (isPub
    ? { kind: 'pubquizQuestion', roundId: round.id, questionId: id }
    : { kind: 'quizQuestion', roundId: round.id, questionId: id });

  if (!questions.length) {
    return direction === 'NEXT'
      ? { kind: 'completeRound', roundId: round.id, label: 'This round has no questions' }
      : introStep(round);
  }
  const around = visibleNeighbours(questions, currentId);
  if (!around.visibleCount) {
    return direction === 'NEXT'
      ? { kind: 'completeRound', roundId: round.id, label: 'Every question is hidden' }
      : introStep(round);
  }

  if (direction === 'PREVIOUS') {
    if (currentId == null) return { kind: 'none', reason: 'This is the start of the round' };
    const back = around.previous;
    if (back) return { kind: 'target', target: targetFor(back.id), label: back.label };
    return introStep(round);
  }

  if (currentId == null || around.at < 0) {
    const first = around.first!;
    return { kind: 'target', target: targetFor(first.id), label: first.label, reveal: true };
  }

  const current = questions[around.at];
  // Asked but not answered yet: revealing is the next step, and it is what pays.
  if (!current.revealed) {
    return { kind: 'target', target: targetFor(current.id), label: `${current.label} — antwoord`, reveal: true };
  }

  const next = around.next;
  if (next) return { kind: 'target', target: targetFor(next.id), label: next.label, reveal: true };
  return { kind: 'completeRound', roundId: round.id, label: 'End of the round' };
}

/**
 * ROULETTE, SLOTMACHINE, PAK_EEN_ZES, FOTORONDE.
 *
 * One live scene each, driven entirely by their own controls — opening betting, spinning,
 * judging a photo. Their chronology is therefore short and honest: the intro, then the
 * scene. VOLGENDE from the scene ends the round rather than pretending there is a next
 * page, and VORIGE goes back to the title card without touching anything the round has
 * done. A settled spin is never unspun by a navigation button.
 */
function planGameRound(round: ActiveRound, at: Position, direction: NavigationDirection): ScreenStep {
  const scene = SCENE_FOR_ROUND_TYPE[round.type];
  const onScene = at.onThisRound && at.mode === scene;

  if (direction === 'PREVIOUS') {
    if (onScene) return introStep(round);
    return { kind: 'none', reason: 'This is the start of the round' };
  }
  if (!onScene) return { kind: 'target', target: { kind: 'roundGame', roundId: round.id }, label: round.title };
  return { kind: 'completeRound', roundId: round.id, label: `End of ${round.title}` };
}

/**
 * The step NEXT or PREVIOUS would take, without taking it.
 *
 * Reads only, so the Admin can ask for it on every poll to draw the NEXT preview.
 *
 * VORIGE deliberately moves the pointer and nothing else. It is presentation history, not
 * an undo: going back to a page shows it as it now is, revealed answer and all, and going
 * back past a roulette spin shows the table without unpaying anybody. Domain state is only
 * ever moved forward, by the round's own controls or by NEXT.
 */
export async function planStep(
  client: PoolClient,
  gameId: number,
  direction: NavigationDirection,
): Promise<ScreenStep> {
  const round = await loadActive(client, gameId);
  if (!round) return { kind: 'none', reason: 'No round is being played' };

  const at = await screenPosition(client, gameId, round);

  // Anywhere that is not this round — the dashboard, a prediction, a round that has since
  // ended — the way back in is the round's own title card.
  if (!at.onThisRound) return introStep(round);

  if (at.onIntro && direction === 'PREVIOUS') {
    return { kind: 'none', reason: 'This is the start of the round' };
  }

  if (round.type === 'PRESENTATIE') return planPresentation(client, round, at, direction);
  if (round.type === 'PUBQUIZ') return planQuestions(client, round, at, direction, 'PUBQUIZ');
  if (round.type === 'LIVE_QUIZ') return planQuestions(client, round, at, direction, 'LIVE_QUIZ');
  return planGameRound(round, at, direction);
}

/**
 * Take the step, and put it on the projector in the same breath.
 *
 * NEXT means "show the next thing", not "select the next thing" — what the host presses is
 * what the room sees, with no intermediate confirmation.
 *
 * `expectedRevision` is the screen revision the Admin was looking at. A step from a tab
 * that has fallen behind is refused rather than dragging the room back to where that tab
 * thought the evening was. The screen rather than the round cursor, because the intro and
 * the round-ending step belong to no item inside a round.
 */
export async function advanceScreen(
  client: PoolClient,
  gameId: number,
  direction: NavigationDirection,
  actor: string,
  expectedRevision: number | null,
) {
  // Held until this transaction commits, so two steps arriving together serialise here
  // rather than racing each other to the projector.
  const locked = await client.query(
    'SELECT revision FROM screen_state WHERE game_night_id=$1 FOR UPDATE',
    [gameId],
  );
  const revision = Number(locked.rows[0]?.revision ?? 0);
  if (expectedRevision != null && revision !== expectedRevision) {
    throw new HttpError(409, 'The big screen has moved on since — refresh and try again');
  }

  const round = await loadActive(client, gameId);
  if (!round) throw new HttpError(409, 'No round is being played');

  const step = await planStep(client, gameId, direction);
  if (step.kind === 'none') throw new HttpError(409, step.reason);

  if (step.kind === 'completeRound') {
    const { completed } = await completeRound(client, gameId, round.id, round.type, actor, 'round completed');
    return { kind: 'completeRound' as const, roundId: round.id, completed, revision };
  }

  // Reveal before showing, so the projector never renders the unrevealed version of a
  // state the host has already stepped past.
  if (step.reveal) await applyReveal(client, gameId, step.target, actor);

  await setScreen(client, gameId, step.target, actor);

  const after = await client.query('SELECT revision FROM screen_state WHERE game_night_id=$1', [gameId]);
  return {
    kind: 'target' as const,
    target: step.target,
    label: step.label,
    roundId: round.id,
    revision: Number(after.rows[0]?.revision ?? revision + 1),
  };
}

/**
 * Open or reveal whatever the step points at.
 *
 * Which of the two depends on where the question already is, and that is the whole of the
 * pubquiz and quiz chronology: arriving on a fresh question asks it, and stepping again
 * from an asked question answers it. Two presses, two meanings, one button.
 *
 * Revealing is where the coins move, so it goes through the same `question-reveal`
 * operation the reveal button uses rather than writing a status here — one rule, two
 * callers. Every write is guarded on the state it expects, so a step that arrives twice
 * changes nothing the second time.
 */
async function applyReveal(client: PoolClient, gameId: number, target: ScreenTarget, actor: string) {
  if (target.kind === 'slide') {
    // A slide's reveal pays nothing, so it is a plain guarded flag.
    await client.query(
      `UPDATE presentation_slide_state SET revealed_at=NOW(),revision=revision+1,updated_at=NOW()
       WHERE slide_id=$1 AND revealed_at IS NULL`,
      [target.slideId],
    );
    return;
  }

  if (target.kind === 'pubquizQuestion') {
    const opened = await client.query(
      `UPDATE pubquiz_question_state SET status='OPEN',opened_at=NOW(),revision=revision+1,updated_at=NOW()
       WHERE question_id=$1 AND status='READY' RETURNING question_id`,
      [target.questionId],
    );
    // It was fresh, so this step asked it. Answering it is the next press.
    if (opened.rows[0]) return;
    await revealPubquizQuestion(client, gameId, target.questionId, actor);
    return;
  }

  if (target.kind === 'quizQuestion') {
    const opened = await client.query(
      `UPDATE live_quiz_question_state SET status='OPEN',opened_at=NOW(),revision=revision+1,updated_at=NOW()
       WHERE question_id=$1 AND status='READY' RETURNING question_id`,
      [target.questionId],
    );
    if (opened.rows[0]) return;
    await revealQuizQuestion(client, gameId, target.questionId, actor);
  }
}

/**
 * What the projector shows the moment a round starts: the round's own title card.
 *
 * Deliberately not the first question. A round that opens on its content gives the room no
 * moment to see what is starting, and gives the host nowhere to stand while explaining it.
 * The content is one VOLGENDE away.
 */
export async function initialScreenTarget(
  _client: PoolClient,
  _gameId: number,
  roundId: number,
  _type: RoundType,
): Promise<ScreenTarget | null> {
  return { kind: 'roundIntro', roundId };
}
