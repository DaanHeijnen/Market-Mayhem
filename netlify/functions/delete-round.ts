import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const roundId = intValue(payload.roundId, 'roundId', { min: 1 });
  return ok(await withTransaction(async (client) => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const q = await client.query('SELECT round_number,title,status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [roundId, gameId]);
    if (!q.rows[0]) throw new HttpError(404, 'Round not found');
    if (q.rows[0].status !== 'UPCOMING') throw new HttpError(409, 'Only upcoming rounds can be deleted');
    const linked = await client.query('SELECT COUNT(*)::int AS count FROM predictions WHERE round_id=$1', [roundId]);
    if (Number(linked.rows[0].count) > 0) throw new HttpError(409, 'Remove or reassign predictions linked to this round first');
    await client.query('DELETE FROM rounds WHERE id=$1', [roundId]);
    await audit(client, gameId, admin.username, `deleted R${q.rows[0].round_number} ${q.rows[0].title}`, 'round', roundId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
