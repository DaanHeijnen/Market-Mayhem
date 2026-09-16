import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundActive } from '../lib/rounds';
import {
  canTransitionQuestion,
  QUIZ_ACTION_TARGET,
  rewardForAnswer,
  type QuizAction,
  type QuizQuestionStatus,
} from '../lib/live-quiz';
import { wrap } from './_wrap';

const ACTIONS: QuizAction[] = ['OPEN', 'CLOSE', 'REVEAL', 'SETTLE', 'REOPEN'];

/**
 * Drive one quiz question through its phases.
 *
 * Guarded against a stale command in two ways at once. The status transition is checked
 * against the phase machine, so a REVEAL that arrives after somebody already settled is
 * refused rather than rolling the question back. And the write carries the revision the
 * caller read, so two admin tabs pressing the same button produce one change and one 409
 * — never two.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const questionId = intValue(p.questionId, 'questionId', { min: 1 });
  const action = String(p.action || '').toUpperCase() as QuizAction;
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Invalid quiz action');
  // Optional so a host can still act from a stale-but-harmless UI; when present it is
  // enforced, which is what the Admin console sends.
  const expectedRevision = p.revision == null ? null : intValue(p.revision, 'revision', { min: 0 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const found = await client.query(
      `SELECT q.id,q.round_id,q.prompt,q.points,st.status,st.revision
       FROM live_quiz_questions q
       JOIN live_quiz_question_state st ON st.question_id=q.id
       WHERE q.id=$1 AND q.game_night_id=$2 FOR UPDATE OF st`,
      [questionId, gameId],
    );
    if (!found.rows[0]) throw new HttpError(404, 'Question not found');
    const question = found.rows[0];
    const round = await lockRound(client, gameId, Number(question.round_id));
    assertRoundType(round, 'LIVE_QUIZ');
    assertRoundActive(round);

    const from = question.status as QuizQuestionStatus;
    const to = QUIZ_ACTION_TARGET[action];

    // An action that has already been applied is answered with what it produced rather
    // than an error: a double-tapped REVEAL is a retry, not a mistake.
    if (from === to) return { duplicate: true, status: from, revision: Number(question.revision) };
    if (!canTransitionQuestion(from, to)) throw new HttpError(409, `A ${from} question cannot go to ${to}`);
    if (expectedRevision != null && Number(question.revision) !== expectedRevision) {
      throw new HttpError(409, 'This question has moved on since — refresh and try again');
    }

    let rewarded = 0;
    let paidCoins = 0;

    if (action === 'REVEAL') {
      // Everyone who picked an option flagged correct. Ordered by player so concurrent
      // transactions take the wallet locks in the same sequence.
      const winners = await client.query(
        `SELECT a.player_id
         FROM quiz_answers a
         JOIN live_quiz_question_options o ON o.id=a.option_id
         JOIN players pl ON pl.id=a.player_id
         JOIN wallets w ON w.player_id=a.player_id
         WHERE a.question_id=$1 AND o.is_correct AND pl.active=TRUE
         ORDER BY a.player_id FOR UPDATE OF pl,w`,
        [questionId],
      );
      const reward = rewardForAnswer(Number(question.points), true);

      for (const winner of winners.rows) {
        if (reward <= 0) break;
        // The partial unique index on (quiz_question_id, player_id, 'QUESTION_REWARD') is
        // what makes this idempotent; ON CONFLICT DO NOTHING is how we notice.
        const ledger = await client.query(
          `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,
             attributed_round_id,quiz_question_id,created_by,idempotency_key,metadata)
           VALUES($1,$2,$3,'QUESTION_REWARD',$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            gameId, winner.player_id, reward,
            `Quiz reward: ${question.prompt}`.slice(0, 200),
            round.id, questionId, admin.username,
            `quiz:${questionId}:reward:${winner.player_id}`,
            JSON.stringify({ points: reward }),
          ],
        );
        if (ledger.rows[0]) {
          await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [reward, winner.player_id]);
          rewarded += 1;
          paidCoins += reward;
        } else {
          const existing = await client.query(
            `SELECT amount FROM ledger_entries
             WHERE quiz_question_id=$1 AND player_id=$2 AND transaction_type='QUESTION_REWARD'`,
            [questionId, winner.player_id],
          );
          if (!existing.rows[0] || Number(existing.rows[0].amount) !== reward) {
            throw new HttpError(409, 'Quiz reward idempotency conflict');
          }
        }
      }
    }

    const stamps: Record<QuizQuestionStatus, string> = {
      READY: '',
      OPEN: 'opened_at=NOW()',
      CLOSED: 'closed_at=NOW()',
      REVEALED: 'revealed_at=NOW()',
      SETTLED: 'settled_at=NOW()',
    };
    const stamp = stamps[to] ? `,${stamps[to]}` : '';

    const updated = await client.query(
      `UPDATE live_quiz_question_state
       SET status=$2${stamp},revision=revision+1,updated_at=NOW()
       WHERE question_id=$1 AND revision=$3
       RETURNING revision`,
      [questionId, to, Number(question.revision)],
    );
    if (!updated.rows[0]) throw new HttpError(409, 'This question has moved on since — refresh and try again');

    // Reopening hands the room a fresh chance, so a leftover reveal flag must not put the
    // context photo back on the projector the moment answers open again.
    if (action === 'REOPEN') {
      await client.query('UPDATE live_quiz_question_state SET context_photo_shown=FALSE WHERE question_id=$1', [questionId]);
    }

    await audit(client, gameId, admin.username, `quiz question ${action.toLowerCase()}`, 'round', round.id, {
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
