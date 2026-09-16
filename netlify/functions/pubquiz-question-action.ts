import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundActive } from '../lib/rounds';
import {
  canTransitionPubquiz,
  PUBQUIZ_ACTION_TARGET,
  type PubquizAction,
  type PubquizStatus,
} from '../lib/pubquiz';
import { revealPubquizQuestion } from '../lib/question-reveal';
import { wrap } from './_wrap';

const ACTIONS: PubquizAction[] = ['OPEN', 'CLOSE', 'REVEAL', 'REOPEN'];

/**
 * Drive one pubquiz question through its phases.
 *
 * Revealing is also paying. The room is told the answer and the points land in the same
 * transaction, because a reveal that leaves scoring to a second button is a reveal whose
 * second button can be forgotten — and the room has already been told who was right.
 *
 * Guarded against a stale command twice over. The transition is checked against the phase
 * machine, so a REVEAL arriving after somebody already revealed is refused rather than
 * paying again. And the write carries the revision the caller read, so two admin tabs
 * pressing the same button produce one change and one 409.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const questionId = intValue(p.questionId, 'questionId', { min: 1 });
  const action = String(p.action || '').toUpperCase() as PubquizAction;
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Invalid pubquiz action');
  const expectedRevision = p.revision == null ? null : intValue(p.revision, 'revision', { min: 0 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const found = await client.query(
      `SELECT q.id,q.round_id,q.question,q.points,st.status,st.revision
       FROM pubquiz_questions q
       JOIN pubquiz_question_state st ON st.question_id=q.id
       WHERE q.id=$1 AND q.game_night_id=$2 FOR UPDATE OF st`,
      [questionId, gameId],
    );
    if (!found.rows[0]) throw new HttpError(404, 'Question not found');
    const question = found.rows[0];
    const round = await lockRound(client, gameId, Number(question.round_id));
    assertRoundType(round, 'PUBQUIZ');
    assertRoundActive(round);

    const from = question.status as PubquizStatus;
    const to = PUBQUIZ_ACTION_TARGET[action];

    // An action already applied is answered with what it produced rather than an error:
    // a double-tapped REVEAL is a retry, not a mistake.
    if (from === to) return { duplicate: true, status: from, revision: Number(question.revision) };
    if (!canTransitionPubquiz(from, to)) throw new HttpError(409, `A ${from} question cannot go to ${to}`);
    if (expectedRevision != null && Number(question.revision) !== expectedRevision) {
      throw new HttpError(409, 'This question has moved on since — refresh and try again');
    }

    // Revealing is also paying, and that operation lives in question-reveal.ts because
    // the central VOLGENDE performs the same step. It writes the status itself, so this
    // returns straight after rather than falling through to the generic transition below.
    if (action === 'REVEAL') {
      const outcome = await revealPubquizQuestion(client, gameId, questionId, admin.username, ['CLOSED']);
      await audit(client, gameId, admin.username, 'pubquiz question reveal', 'round', round.id, {
        questionId, rewarded: outcome.rewarded, paidCoins: outcome.paidCoins,
      });
      const after = await client.query('SELECT revision FROM pubquiz_question_state WHERE question_id=$1', [questionId]);
      return {
        status: 'REVEALED',
        revision: Number(after.rows[0]?.revision ?? 0),
        rewarded: outcome.rewarded,
        paidCoins: outcome.paidCoins,
        version: await incrementGameVersion(client, gameId),
      };
    }

    const rewarded = 0;
    const paidCoins = 0;

    const stamps: Record<PubquizStatus, string> = {
      READY: '',
      OPEN: 'opened_at=NOW()',
      CLOSED: 'closed_at=NOW()',
      REVEALED: 'revealed_at=NOW()',
    };
    const stamp = stamps[to] ? `,${stamps[to]}` : '';

    const updated = await client.query(
      `UPDATE pubquiz_question_state
       SET status=$2${stamp},revision=revision+1,updated_at=NOW()
       WHERE question_id=$1 AND revision=$3
       RETURNING revision`,
      [questionId, to, Number(question.revision)],
    );
    if (!updated.rows[0]) throw new HttpError(409, 'This question has moved on since — refresh and try again');

    await audit(client, gameId, admin.username, `pubquiz question ${action.toLowerCase()}`, 'round', round.id, {
      questionId, rewarded, paidCoins,
    });
    return {
      status: to,
      revision: Number(updated.rows[0].revision),
      rewarded,
      paidCoins,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
