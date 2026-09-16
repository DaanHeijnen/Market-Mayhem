import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreen } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundActive, advanceRoundCursor, loadRoundRuntime, neighbours } from '../lib/rounds';
import { questionIsLive } from '../lib/live-quiz';
import { wrap } from './_wrap';

/**
 * Move a quiz round's cursor.
 *
 * This is what replaced the generic previous/next block navigation, and it is deliberately
 * not generic: a quiz moves between questions, a presentation moves between slides, and
 * the three game types do not move at all. Sharing one abstraction across those meant
 * pretending they had the same shape.
 *
 * Advancing changes the round's cursor. It puts the new question on the projector too,
 * because that is what the host pressing NEXT QUESTION is asking for — but only if the
 * projector was already showing this round's question. A host who stepped away to the
 * dashboard keeps their dashboard.
 */
const ACTIONS = ['NEXT', 'PREVIOUS', 'GOTO'] as const;

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const action = String(p.action || '').toUpperCase() as typeof ACTIONS[number];
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Invalid navigation action');
  const targetId = action === 'GOTO' ? intValue(p.questionId, 'questionId', { min: 1 }) : null;
  const expectedRevision = p.revision == null ? null : intValue(p.revision, 'revision', { min: 0 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundType(round, 'LIVE_QUIZ');
    assertRoundActive(round);

    const runtime = await loadRoundRuntime(client, roundId);
    if (expectedRevision != null && runtime.revision !== expectedRevision) {
      throw new HttpError(409, 'This round has moved on since — refresh and try again');
    }

    // Leaving a question that is open, closed or revealed-but-unsettled would strand the
    // answers the room already gave and the reward nobody paid. Same rule as leaving the
    // round, for the same reason.
    if (runtime.currentQuizQuestionId) {
      const current = await client.query(
        'SELECT status FROM live_quiz_question_state WHERE question_id=$1',
        [runtime.currentQuizQuestionId],
      );
      if (current.rows[0] && questionIsLive(current.rows[0].status) && runtime.currentQuizQuestionId !== targetId) {
        throw new HttpError(409, `The current question is still ${current.rows[0].status} — settle it before moving on`);
      }
    }

    const listed = await client.query(
      'SELECT id FROM live_quiz_questions WHERE round_id=$1 ORDER BY sort_order,id',
      [roundId],
    );
    const questions = listed.rows.map((r: any) => ({ id: Number(r.id) }));
    if (!questions.length) throw new HttpError(409, 'This quiz round has no questions yet');

    const around = neighbours(questions, runtime.currentQuizQuestionId);
    let next: { id: number } | null;
    if (action === 'GOTO') {
      next = questions.find(q => q.id === targetId) ?? null;
      if (!next) throw new HttpError(404, 'Question not found in this round');
    } else if (action === 'NEXT') {
      next = around.next ?? (around.index < 0 ? around.first : null);
      if (!next) throw new HttpError(409, 'This is the last question');
    } else {
      next = around.previous;
      if (!next) throw new HttpError(409, 'This is the first question');
    }

    const moved = await advanceRoundCursor(client, roundId, runtime.revision, { quizQuestionId: next.id });

    // Follow the cursor on the projector only when the projector was already on this
    // round's question. Progression must not seize the screen from a host who left it.
    const screen = await client.query('SELECT mode,round_id FROM screen_state WHERE game_night_id=$1', [gameId]);
    const wasShowingThisRound = screen.rows[0]?.mode === 'QUIZ_QUESTION' && Number(screen.rows[0]?.round_id || 0) === roundId;
    if (wasShowingThisRound) {
      await setScreen(client, gameId, { kind: 'quizQuestion', roundId, questionId: next.id }, admin.username);
    }

    await audit(client, gameId, admin.username, `quiz ${action.toLowerCase()}`, 'round', roundId, { questionId: next.id });
    return {
      questionId: next.id,
      revision: moved.revision,
      followedOnScreen: wasShowingThisRound,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
