import type { PoolClient } from 'pg';
import { HttpError } from './http';
import { rewardForAnswer } from './live-quiz';
import { pubquizReward } from './pubquiz';

/**
 * Revealing a question, which is also paying for it.
 *
 * Extracted out of the two action endpoints because it now has a second caller: the
 * central VOLGENDE. "Show the answer" is a step in the evening's chronology as much as it
 * is a button, and the two must be the same operation — a NEXT that revealed without
 * paying, or paid by a slightly different rule, would be a quiet way to lose somebody's
 * points.
 *
 * Both are idempotent along two independent lines. The status transition is guarded on the
 * status this call read, so a second attempt moves nothing. And each reward carries a
 * business key pinned by a partial unique index, so one player can be paid for one
 * question exactly once however many times a reveal is clicked, retried or stepped into.
 *
 * The caller must already hold the game row.
 */

export type RevealOutcome = {
  /** False when the question was already revealed — a replay, not a failure. */
  changed: boolean;
  rewarded: number;
  paidCoins: number;
};

const NOTHING: RevealOutcome = { changed: false, rewarded: 0, paidCoins: 0 };

/**
 * Reveal a pubquiz question and pay everyone who got it right.
 *
 * `fromStatuses` is what the caller is willing to move out of. The action endpoint allows
 * only CLOSED, because its phase machine says so; the central step also allows OPEN,
 * because pressing VOLGENDE on a question that is still open means "that is enough, here
 * is the answer" and making the host close it first would be a button for its own sake.
 */
export async function revealPubquizQuestion(
  client: PoolClient,
  gameId: number,
  questionId: number,
  actor: string,
  fromStatuses: string[] = ['OPEN', 'CLOSED'],
): Promise<RevealOutcome> {
  const found = await client.query(
    `SELECT q.id,q.round_id,q.question,q.points,st.status,st.revision
     FROM pubquiz_questions q
     JOIN pubquiz_question_state st ON st.question_id=q.id
     WHERE q.id=$1 AND q.game_night_id=$2 FOR UPDATE OF st`,
    [questionId, gameId],
  );
  if (!found.rows[0]) throw new HttpError(404, 'Question not found');
  const question = found.rows[0];
  if (question.status === 'REVEALED') return NOTHING;
  if (!fromStatuses.includes(question.status)) {
    throw new HttpError(409, `A ${question.status} question cannot be revealed`);
  }

  const reward = pubquizReward(Number(question.points), true);
  // Everyone who picked the option flagged correct. Ordered by player so two transactions
  // take the wallet locks in the same sequence and cannot deadlock.
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

  let rewarded = 0;
  let paidCoins = 0;
  for (const winner of winners.rows) {
    if (reward <= 0) break;
    const ledger = await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,
         attributed_round_id,pubquiz_question_id,created_by,idempotency_key,metadata)
       VALUES($1,$2,$3,'PUBQUIZ_REWARD',$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        gameId, winner.player_id, reward,
        `Pubquiz reward: ${question.question}`.slice(0, 200),
        question.round_id, questionId, actor,
        `pubquiz:${questionId}:reward:${winner.player_id}`,
        JSON.stringify({ points: reward }),
      ],
    );
    if (ledger.rows[0]) {
      await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [reward, winner.player_id]);
      rewarded += 1;
      paidCoins += reward;
    }
    // No row means this player was already paid for this question by an earlier pass. The
    // wallet move went with it; there is nothing to repair.
  }

  const updated = await client.query(
    `UPDATE pubquiz_question_state
     SET status='REVEALED',revealed_at=NOW(),revision=revision+1,updated_at=NOW()
     WHERE question_id=$1 AND revision=$2 RETURNING revision`,
    [questionId, Number(question.revision)],
  );
  if (!updated.rows[0]) throw new HttpError(409, 'This question has moved on since — refresh and try again');

  return { changed: true, rewarded, paidCoins };
}

/**
 * Reveal a live quiz question and pay everyone who got it right.
 *
 * The same operation over the LIVE_QUIZ tables. A quiz question may have more than one
 * correct option, which is why "correct" is read from the option rather than from an index.
 */
export async function revealQuizQuestion(
  client: PoolClient,
  gameId: number,
  questionId: number,
  actor: string,
  fromStatuses: string[] = ['OPEN', 'CLOSED'],
): Promise<RevealOutcome> {
  const found = await client.query(
    `SELECT q.id,q.round_id,q.prompt,q.points,st.status,st.revision
     FROM live_quiz_questions q
     JOIN live_quiz_question_state st ON st.question_id=q.id
     WHERE q.id=$1 AND q.game_night_id=$2 FOR UPDATE OF st`,
    [questionId, gameId],
  );
  if (!found.rows[0]) throw new HttpError(404, 'Question not found');
  const question = found.rows[0];
  if (question.status === 'REVEALED' || question.status === 'SETTLED') return NOTHING;
  if (!fromStatuses.includes(question.status)) {
    throw new HttpError(409, `A ${question.status} question cannot be revealed`);
  }

  const reward = rewardForAnswer(Number(question.points), true);
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

  let rewarded = 0;
  let paidCoins = 0;
  for (const winner of winners.rows) {
    if (reward <= 0) break;
    const ledger = await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,
         attributed_round_id,quiz_question_id,created_by,idempotency_key,metadata)
       VALUES($1,$2,$3,'QUESTION_REWARD',$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        gameId, winner.player_id, reward,
        `Quiz reward: ${question.prompt}`.slice(0, 200),
        question.round_id, questionId, actor,
        `quiz:${questionId}:reward:${winner.player_id}`,
        JSON.stringify({ points: reward }),
      ],
    );
    if (ledger.rows[0]) {
      await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [reward, winner.player_id]);
      rewarded += 1;
      paidCoins += reward;
    }
  }

  const updated = await client.query(
    `UPDATE live_quiz_question_state
     SET status='REVEALED',revealed_at=NOW(),revision=revision+1,updated_at=NOW()
     WHERE question_id=$1 AND revision=$2 RETURNING revision`,
    [questionId, Number(question.revision)],
  );
  if (!updated.rows[0]) throw new HttpError(409, 'This question has moved on since — refresh and try again');

  return { changed: true, rewarded, paidCoins };
}
