import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { canTransition, type PhotoRoundStatus } from '../lib/photo-round';
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
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const blockId = intValue(p.blockId, 'blockId', { min: 1 });
  const action = String(p.action || '').toUpperCase() as Action;
  if (!(action in ACTIONS)) throw new HttpError(400, 'Invalid Fotoronde action');
  const target = ACTIONS[action] as PhotoRoundStatus;

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id,current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    if (Number(game.rows[0].current_round_block_id || 0) !== blockId) throw new HttpError(409, 'Show this Fotoronde block before running it');

    const blockResult = await client.query(
      `SELECT b.id,b.round_id,b.type,r.status AS round_status
       FROM round_blocks b JOIN rounds r ON r.id=b.round_id
       WHERE b.id=$1 AND b.game_night_id=$2 FOR UPDATE OF b`,
      [blockId, gameId],
    );
    const block = blockResult.rows[0];
    if (!block) throw new HttpError(404, 'Fotoronde block not found');
    if (block.type !== 'FOTORONDE') throw new HttpError(409, 'Block is not a Fotoronde');
    if (block.round_status !== 'ACTIVE' || Number(game.rows[0].current_round_id || 0) !== Number(block.round_id)) {
      throw new HttpError(409, 'The Fotoronde round is not active');
    }

    // Created on first use, so an unplayed block carries no state. One per block for
    // the life of the block: the photos and their credits are history, so re-showing it
    // returns to the same round rather than starting a second one.
    await client.query(
      `INSERT INTO photo_rounds(game_night_id,round_id,round_block_id,status)
       VALUES($1,$2,$3,'DRAFT')
       ON CONFLICT (round_block_id) DO NOTHING`,
      [gameId, Number(block.round_id), blockId],
    );

    const existing = await client.query(
      'SELECT id,status FROM photo_rounds WHERE game_night_id=$1 AND round_block_id=$2 FOR UPDATE',
      [gameId, blockId],
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
      const groups = await client.query('SELECT COUNT(*)::int AS n FROM round_groups WHERE round_id=$1', [Number(block.round_id)]);
      if (Number(groups.rows[0].n) === 0) throw new HttpError(409, 'Create at least one team for this round before opening the Fotoronde');
    }

    const column = target === 'OPEN' ? 'opened_at' : target === 'CLOSED' ? 'closed_at' : 'completed_at';
    await client.query(
      `UPDATE photo_rounds SET status=$2,${column}=NOW(),updated_at=NOW() WHERE id=$1`,
      [photoRoundId, target],
    );

    await audit(client, gameId, admin.username, `fotoronde ${action.toLowerCase()}`, 'round_block', blockId, {
      photoRoundId, from: status, to: target,
    });
    return { status: target, version: await incrementGameVersion(client, gameId) };
  }));
});
