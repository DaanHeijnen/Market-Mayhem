import type { PoolClient } from 'pg';
import { HttpError } from './http';
import { closeSlotSeriesForRound } from './slot-state';
import { closePakEenZesForRound } from './pak-een-zes-state';
import { closePhotoRoundForRound } from './photo-round-state';
import type { RoundType } from './round-types';
import { setScreen } from './game-state';

/**
 * What has to happen when the host leaves a round.
 *
 * Every round type ends differently, and the differences are deliberate rather than
 * historical:
 *
 *   LIVE_QUIZ    refuses, while a question is open, closed or revealed but unsettled.
 *                An unfinished question has answers that were given and a reward that was
 *                not paid; walking away from it silently loses somebody's points.
 *   ROULETTE     refuses, while a game has money on the table. A draft game, which has
 *                none, is cancelled instead.
 *   SLOTMACHINE  refunds and closes. It does not block, because a slot series is
 *                per-player and one player who locked twenty spins and wandered off must
 *                not be able to hold the whole evening hostage. No coins are lost — the
 *                unspun remainder is returned and spins already taken keep their payout.
 *   PAK_EEN_ZES  cancels. Nothing financial is at stake, but leaving it in DRAWING keeps a
 *                turn indicator live on somebody's phone for a game nobody is watching.
 *                Draws and predictions are kept: cancelling must never erase the record.
 *   FOTORONDE    closes, and keeps everything. Its photos and the chance to award credits
 *                for them are the point of the round, so ending the upload window must not
 *                throw away work nobody has judged yet.
 *   PRESENTATIE  has nothing to settle.
 *
 * All of it lives here, in one function, because the previous version of this rule was
 * copied into `setActiveRoundBlock` and `complete-round` with subtly different guards and
 * a different order. A policy that exists in two places is a policy one route can skip.
 * Every path that ends a round — completing it, starting another one — goes through
 * `leaveRound`, and there is no second way to do it.
 */

export type LeaveReason = 'round completed' | 'another round started' | 'round deleted';

export type LeaveOutcome = {
  roundId: number;
  type: RoundType;
  slotSeriesClosed: number;
  slotCoinsRefunded: number;
  pakEenZesCancelled: number;
  photoRoundsClosed: number;
  rouletteDraftsCancelled: number;
};

/**
 * Refuse to leave a round that is not finished with.
 *
 * Separate from the settling below so a caller can ask "may I?" and get the same answer
 * the write path would give. Both are called inside the same transaction and behind the
 * same lock, so the answer cannot go stale between them.
 */
export async function assertRoundMayBeLeft(
  client: PoolClient,
  gameId: number,
  roundId: number,
  type: RoundType,
) {
  if (type === 'LIVE_QUIZ') {
    const live = await client.query(
      `SELECT q.id,q.sort_order,st.status
       FROM live_quiz_question_state st
       JOIN live_quiz_questions q ON q.id=st.question_id
       WHERE st.round_id=$1 AND st.game_night_id=$2 AND st.status IN ('OPEN','CLOSED','REVEALED')
       ORDER BY q.sort_order,q.id LIMIT 1`,
      [roundId, gameId],
    );
    if (live.rows[0]) {
      throw new HttpError(
        409,
        `Question ${Number(live.rows[0].sort_order) + 1} is still ${live.rows[0].status} — finish or settle it first`,
      );
    }
  }

  if (type === 'ROULETTE') {
    const live = await client.query(
      `SELECT id,status FROM roulette_games
       WHERE game_night_id=$1 AND round_id=$2 AND status IN ('OPEN','LOCKED','SPINNING','RESULT')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [gameId, roundId],
    );
    if (live.rows[0]) {
      throw new HttpError(409, `Roulette #${live.rows[0].id} is still ${live.rows[0].status} — settle or cancel it first`);
    }
  }
}

/**
 * Run the round's exit policy and leave it settled.
 *
 * Idempotent by construction: each underlying close is a guarded UPDATE over rows in a
 * live status, and the slot refund is pinned by a partial unique index on
 * `(slot_series_id, 'SLOT_REFUND')`. Calling it twice therefore closes nothing the second
 * time and pays nothing twice.
 *
 * The caller must already hold the game row, and must have called `assertRoundMayBeLeft`.
 */
export async function leaveRound(
  client: PoolClient,
  gameId: number,
  roundId: number,
  type: RoundType,
  actor: string,
  reason: LeaveReason,
): Promise<LeaveOutcome> {
  const outcome: LeaveOutcome = {
    roundId,
    type,
    slotSeriesClosed: 0,
    slotCoinsRefunded: 0,
    pakEenZesCancelled: 0,
    photoRoundsClosed: 0,
    rouletteDraftsCancelled: 0,
  };

  if (type === 'SLOTMACHINE') {
    const closed = await closeSlotSeriesForRound(client, gameId, roundId, actor, reason);
    outcome.slotSeriesClosed = closed.closed;
    outcome.slotCoinsRefunded = closed.refunded;
  }

  if (type === 'PAK_EEN_ZES') {
    const cancelled = await closePakEenZesForRound(client, gameId, roundId);
    outcome.pakEenZesCancelled = cancelled.cancelled;
  }

  if (type === 'FOTORONDE') {
    const closed = await closePhotoRoundForRound(client, gameId, roundId);
    outcome.photoRoundsClosed = closed.closed;
  }

  if (type === 'ROULETTE') {
    // A draft game has no money attached and should not survive as stray operational
    // state. Anything further along was refused by assertRoundMayBeLeft.
    const { rowCount } = await client.query(
      `UPDATE roulette_games SET status='CANCELLED',settled_at=NOW(),updated_at=NOW()
       WHERE game_night_id=$1 AND round_id=$2 AND status='DRAFT'`,
      [gameId, roundId],
    );
    outcome.rouletteDraftsCancelled = rowCount ?? 0;
  }

  return outcome;
}

/**
 * Prepare a round's runtime for play.
 *
 * Starting a round is allowed to touch runtime state — that is what starting means — but
 * it must not touch presentation. Nothing in here writes to `screen_state`.
 */
export async function enterRound(client: PoolClient, gameId: number, roundId: number, type: RoundType) {
  await client.query(
    `INSERT INTO round_runtime(round_id,game_night_id) VALUES($1,$2)
     ON CONFLICT (round_id) DO NOTHING`,
    [roundId, gameId],
  );

  // The cursor starts on the round's first item so a freshly started round has somewhere
  // to be, without that choice reaching the projector.
  if (type === 'LIVE_QUIZ') {
    await client.query(
      `UPDATE round_runtime SET current_quiz_question_id=COALESCE(
         current_quiz_question_id,
         (SELECT id FROM live_quiz_questions WHERE round_id=$1 ORDER BY sort_order,id LIMIT 1)
       ),updated_at=NOW() WHERE round_id=$1`,
      [roundId],
    );
  }

  if (type === 'PRESENTATIE') {
    await client.query(
      `UPDATE round_runtime SET current_slide_id=COALESCE(
         current_slide_id,
         -- The first page *in the run*. Starting a round on a page the host has held
         -- back would put the cursor somewhere previous/next cannot reach.
         (SELECT id FROM presentation_slides WHERE round_id=$1 AND hidden=FALSE ORDER BY sort_order,id LIMIT 1)
       ),updated_at=NOW() WHERE round_id=$1`,
      [roundId],
    );
  }

  if (type === 'ROULETTE') {
    // One draft game per roulette round, created on entry so the host has something to
    // open. Guarded rather than blind, so re-starting a round cannot create a second.
    await client.query(
      // Run 1 of the round, or the next number if earlier runs have already settled —
      // re-entering a round whose wheel has been spun starts a fresh run rather than
      // reopening a finished one. The NOT EXISTS guard is what stops a second live table
      // appearing beside one that is still going.
      `INSERT INTO roulette_games(game_night_id,round_id,status,run_number)
       SELECT $1,$2,'DRAFT',(SELECT COALESCE(MAX(run_number),0)+1 FROM roulette_games WHERE round_id=$2)
       WHERE NOT EXISTS (
         SELECT 1 FROM roulette_games
         WHERE game_night_id=$1 AND round_id=$2 AND status IN ('DRAFT','OPEN','LOCKED','SPINNING','RESULT')
       )`,
      [gameId, roundId],
    );
  }
}

/**
 * End the active round, whoever asked.
 *
 * Extracted so that completing a round by hand, running off the end of a presentation and
 * the last slotmachine player finishing their spins are all literally the same code. They
 * used to be one route and two things that did not exist; adding them as separate writes
 * would have meant three subtly different ideas of what "completed" means.
 *
 * Idempotent and race-free through the guard on the UPDATE: two callers arriving together
 * both run, one moves the row out of ACTIVE and the other gets no rows back and reports
 * that it did nothing. The caller must already hold the game row.
 */
export async function completeRound(
  client: PoolClient,
  gameId: number,
  roundId: number,
  type: RoundType,
  actor: string,
  reason: LeaveReason,
): Promise<{ completed: boolean; outcome: LeaveOutcome | null }> {
  await assertRoundMayBeLeft(client, gameId, roundId, type);
  const outcome = await leaveRound(client, gameId, roundId, type, actor, reason);

  const moved = await client.query(
    "UPDATE rounds SET status='COMPLETED',completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='ACTIVE' RETURNING id",
    [roundId],
  );
  if (!moved.rows[0]) return { completed: false, outcome: null };

  await client.query('UPDATE game_nights SET current_round_id=NULL,updated_at=NOW() WHERE id=$1 AND current_round_id=$2', [gameId, roundId]);

  // The one place ending a round touches the projector, and only because what it was
  // showing belongs to a round nobody is playing any more.
  await setScreen(client, gameId, { kind: 'dashboard' }, actor);
  return { completed: true, outcome };
}
