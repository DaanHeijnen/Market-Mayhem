import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const groupId = intValue(p.groupId, 'groupId', { min: 1 });
  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const group = await client.query(`SELECT g.round_id,r.status AS round_status FROM round_groups g JOIN rounds r ON r.id=g.round_id WHERE g.id=$1 AND g.game_night_id=$2 FOR UPDATE OF g,r`, [groupId, gameId]);
    if (!group.rows[0]) throw new HttpError(404, 'Round group not found');
    if (group.rows[0].round_status === 'COMPLETED') throw new HttpError(409, 'Completed round groups are retained for history');
    const used = await client.query('SELECT 1 FROM ledger_entries WHERE game_night_id=$1 AND round_group_id=$2 LIMIT 1', [gameId, groupId]);
    if (used.rows[0]) throw new HttpError(409, 'This group has financial history and cannot be deleted; rename it or keep it for the ledger');
    const q = await client.query('DELETE FROM round_groups WHERE id=$1 AND game_night_id=$2 RETURNING round_id', [groupId, gameId]);
    if (!q.rows[0]) throw new HttpError(404, 'Round group not found');
    await audit(client, gameId, admin.username, 'deleted round group', 'round_group', groupId, { roundId: Number(q.rows[0].round_id) });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
