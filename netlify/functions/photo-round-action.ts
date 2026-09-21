import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { canTransition, type PhotoRoundStatus } from '../lib/photo-round';
import { submissionMinutesForRound } from '../lib/photo-round-state';
import { wrap } from './_wrap';

const ACTIONS = {
  OPEN: 'OPEN',
  CLOSE: 'CLOSED',
  COMPLETE: 'COMPLETED',
} as const;

type Action = keyof typeof ACTIONS;

/**
 * The host's Fotoronde controls: open submissions, close them, mark it finished.
 *
 * Forward-only, and uploads live in exactly one phase. Closing is what makes judging
 * meaningful — a team cannot swap its photo once the Admin has started looking at it —
 * and there is no route back to OPEN for the same reason.
 *
 * COMPLETE is a marker rather than a lock: awarding stays possible afterwards, so a host
 * who marks it done and then spots a photo they skipped is not stuck.
 *
 * OPEN also starts the submission clock. CLOSE stays available throughout, so a host who
 * wants to stop early never has to wait for a timer they set too generously.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const action = String(p.action || '').toUpperCase() as Action;
  if (!(action in ACTIONS)) throw new HttpError(400, 'Invalid Fotoronde action');
  const target = ACTIONS[action] as PhotoRoundStatus;

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const roundResult = await client.query(
      `SELECT id,type,status AS round_status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE`,
      [roundId, gameId],
    );
    const block = roundResult.rows[0];
    if (!block) throw new HttpError(404, 'Round not found');
    if (block.type !== 'FOTORONDE') throw new HttpError(409, 'That round is not a Fotoronde');
    if (block.round_status !== 'ACTIVE' || Number(game.rows[0].current_round_id || 0) !== roundId) {
      throw new HttpError(409, 'The Fotoronde round is not active');
    }

    // Created on first use, so an unplayed block carries no state. One per block for
    // the life of the block: the photos and their credits are history, so re-showing it
    // returns to the same round rather than starting a second one.
    await client.query(
      `INSERT INTO photo_rounds(game_night_id,round_id,status)
       VALUES($1,$2,'DRAFT')
       ON CONFLICT (round_id) DO NOTHING`,
      [gameId, roundId],
    );

    const existing = await client.query(
      'SELECT id,status FROM photo_rounds WHERE game_night_id=$1 AND round_id=$2 FOR UPDATE',
      [gameId, roundId],
    );
    const current = existing.rows[0];
    if (!current) throw new HttpError(409, 'Fotoronde could not be created');
    const status = current.status as PhotoRoundStatus;
    const photoRoundId = Number(current.id);

    // Replaying the same action is a no-op rather than an error: a host tapping twice on
    // a slow connection should not be told something went wrong.
    if (status === target) return { duplicate: true, status };
    if (!canTransition(status, target)) throw new HttpError(409, `Cannot ${action} while the Fotoronde is ${status}`);

    // Teams are the unit of submission, so opening without any is a dead end.
    if (target === 'OPEN') {
      const groups = await client.query('SELECT COUNT(*)::int AS n FROM round_groups WHERE round_id=$1', [roundId]);
      if (Number(groups.rows[0].n) === 0) throw new HttpError(409, 'Create at least one team for this round before opening the Fotoronde');
    }

    // Opening is what starts the clock. The deadline is computed from the database's own
    // NOW() rather than from this container's, so every surface counts down to the same
    // instant no matter whose clock is off — and it is stamped exactly once, because the
    // phase machine has no route back to OPEN.
    let closesAt: string | null = null;
    if (target === 'OPEN') {
      const minutes = await submissionMinutesForRound(client, gameId, roundId);
      const opened = await client.query(
        `UPDATE photo_rounds
         SET status='OPEN',opened_at=NOW(),
             submission_closes_at=NOW()+($2::text||' minutes')::interval,
             updated_at=NOW()
         WHERE id=$1 RETURNING submission_closes_at`,
        [photoRoundId, minutes],
      );
      closesAt = opened.rows[0]?.submission_closes_at ?? null;
    } else {
      const column = target === 'CLOSED' ? 'closed_at' : 'completed_at';
      await client.query(
        `UPDATE photo_rounds SET status=$2,${column}=NOW(),updated_at=NOW() WHERE id=$1`,
        [photoRoundId, target],
      );
    }

    await audit(client, gameId, admin.username, `fotoronde ${action.toLowerCase()}`, 'round', roundId, {
      photoRoundId, from: status, to: target, closesAt,
    });
    return { status: target, submissionClosesAt: closesAt, version: await incrementGameVersion(client, gameId) };
  }));
});
