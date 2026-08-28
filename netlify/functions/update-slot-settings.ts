import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockSlotSettings, slotStatus } from '../lib/slot-store';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const totalProbabilityPool = intValue(p.totalProbabilityPool, 'totalProbabilityPool', { min: 1, max: 1_000_000 });
  const maximumSpins = intValue(p.maximumSpins, 'maximumSpins', { min: 1, max: 500 });
  const minimumStake = intValue(p.minimumStake, 'minimumStake', { min: 1, max: 1_000_000 });
  const maximumStake = intValue(p.maximumStake, 'maximumStake', { min: 1, max: 1_000_000 });
  if (maximumStake < minimumStake) throw new HttpError(400, 'maximumStake must be at least minimumStake');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    await lockSlotSettings(client, gameId);
    await client.query(
      `UPDATE slot_settings
       SET total_probability_pool=$2,maximum_spins=$3,minimum_stake=$4,maximum_stake=$5,updated_by=$6,updated_at=NOW()
       WHERE game_night_id=$1`,
      [gameId, totalProbabilityPool, maximumSpins, minimumStake, maximumStake, admin.username],
    );
    await audit(client, gameId, admin.username, 'updated slot settings', 'slot_settings', gameId, { totalProbabilityPool, maximumSpins, minimumStake, maximumStake });
    const snapshot = await slotStatus(client, gameId);
    return { status: snapshot.status, version: await incrementGameVersion(client, gameId) };
  }));
});
