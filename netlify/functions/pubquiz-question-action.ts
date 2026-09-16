import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundActive } from '../lib/rounds';
import {
  canTransitionPubquiz,
  pubquizReward,
  PUBQUIZ_ACTION_TARGET,
  type PubquizAction,
  type PubquizStatus,
} from '../lib/pubquiz';
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

    let rewarded = 0;
    let paidCoins = 0;

    if (action === 'REVEAL') {
      const reward = pubquizReward(Number(question.points), true);
      // Everyone who picked the option flagged correct. Ordered by player so two
      // transactions take the wallet locks in the same sequence and cannot deadlock.
      const winners = await client.query(
        `SELECT a.player_id
         FROM pubquiz_answers a
         JOIN pubquiz_question_options o ON o.id=a.option_id
         JOIN players pl ON pl.id=a.player_id
         JOIN wallets w ON w.player_id=a.player_id
         WHERE a.question_id=$1 AND o.is_correct AND pl.active=TRUE
         ORDER BY a.player_id FOR UPDATE OF pl,w`,
        [questionId],
      );

      for (const winner of winners.rows) {
        if (reward <= 0) break;
        // `ledger_unique_pubquiz_reward` on (question, player, 'PUBQUIZ_REWARD') is what
        // makes this idempotent; ON CONFLICT DO NOTHING is how we notice it did.
        const ledger = await client.query(
          `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,
             attributed_round_id,pubquiz_question_id,created_by,idempotency_key,metadata)
           VALUES($1,$2,$3,'PUBQUIZ_REWARD',$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            gameId, winner.player_id, reward,
            `Pubquiz reward: ${question.question}`.slice(0, 200),
            round.id, questionId, admin.username,
            `pubquiz:${questionId}:reward:${winner.player_id}`,
            JSON.stringify({ points: reward }),
          ],
        );
        if (ledger.rows[0]) {
          await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [reward, winner.player_id]);
          rewarded += 1;
          paidCoins += reward;
        }
        // No row means this player was already paid for this question, by an earlier pass
        // of this same reveal. The wallet move went with it; there is nothing to repair.
      }
    }

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
