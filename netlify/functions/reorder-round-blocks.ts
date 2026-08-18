import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  if (!Array.isArray(p.blockIds)) throw new HttpError(400, 'blockIds must be an array');
  const ids: number[] = p.blockIds.map((v: unknown) => intValue(v, 'blockId', { min: 1 }));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'blockIds contains duplicates');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await client.query('SELECT status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [roundId, gameId]);
    if (!round.rows[0]) throw new HttpError(404, 'Round not found');
    if (round.rows[0].status === 'COMPLETED') throw new HttpError(409, 'Completed round content is read-only');

    const rows = await client.query('SELECT id,sort_order FROM round_blocks WHERE round_id=$1 AND game_night_id=$2 ORDER BY id FOR UPDATE', [roundId, gameId]);
    const actual = rows.rows.map((r: any) => Number(r.id)).sort((a: number, b: number) => a - b);
    const given = [...ids].sort((a: number, b: number) => a - b);
    if (JSON.stringify(actual) !== JSON.stringify(given)) throw new HttpError(400, 'blockIds must contain every block in the round exactly once');

    const maxOrder = rows.rows.reduce((max: number, r: any) => Math.max(max, Number(r.sort_order)), -1);
    const offset = maxOrder + ids.length + 1;
    await client.query('UPDATE round_blocks SET sort_order=sort_order+$2 WHERE round_id=$1', [roundId, offset]);
    for (let i = 0; i < ids.length; i += 1) {
      await client.query('UPDATE round_blocks SET sort_order=$2,updated_at=NOW() WHERE id=$1', [ids[i], i]);
    }
    await audit(client, gameId, admin.username, 'reordered round blocks', 'round', roundId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
