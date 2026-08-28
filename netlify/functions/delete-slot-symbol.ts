import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { slotPositionValue, slotReelValue } from '../lib/slot';
import { slotStatus } from '../lib/slot-store';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const reel = slotReelValue(p.reel, 'reel');
  const position = slotPositionValue(p.position, 'position');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const active = await client.query("SELECT id FROM slot_sessions WHERE game_night_id=$1 AND status='ACTIVE' FOR UPDATE", [gameId]);
    if (active.rows[0]) throw new HttpError(409, 'Finish or cancel the active slot series before changing reel symbols');
    const removed = await client.query(
      'DELETE FROM slot_symbols WHERE game_night_id=$1 AND reel=$2 AND symbol_position=$3 RETURNING id',
      [gameId, reel, position],
    );
    if (!removed.rows[0]) throw new HttpError(404, 'Reel symbol not found');
    await audit(client, gameId, admin.username, 'removed slot reel symbol', 'slot_symbol', gameId, { reel, position });
    const snapshot = await slotStatus(client, gameId);
    return { reel, position, status: snapshot.status, version: await incrementGameVersion(client, gameId) };
  }));
});
