import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { requireUsableSlotConfiguration } from '../lib/slot';
import { lockSlotSettings, slotStatus } from '../lib/slot-store';
import { wrap } from './_wrap';

/**
 * Locks a slot series. The whole series stake leaves the available wallet at
 * once, so "remaining spins x stake per spin" is real locked value from this
 * moment on and cannot be spent elsewhere.
 */
export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const stakePerSpin = intValue(p.stakePerSpin, 'stakePerSpin', { min: 1 });
  const spins = intValue(p.spins, 'spins', { min: 1 });
  const session = await requirePlayer(request, gameId);
  const key = requestIdempotencyKey(request);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const prior = await client.query(
      'SELECT id,player_id,stake_per_spin,total_spins FROM slot_sessions WHERE game_night_id=$1 AND idempotency_key=$2',
      [gameId, key],
    );
    if (prior.rows[0]) {
      const row = prior.rows[0];
      if (Number(row.player_id) === session.playerId && Number(row.stake_per_spin) === stakePerSpin && Number(row.total_spins) === spins) {
        return { duplicate: true, slotSessionId: Number(row.id) };
      }
      throw new HttpError(409, 'Idempotency key was already used for a different slot series');
    }

    const settings = await lockSlotSettings(client, gameId);
    const snapshot = await slotStatus(client, gameId, settings);
    requireUsableSlotConfiguration(snapshot.status);

    if (spins > settings.maximumSpins) throw new HttpError(400, `A series may contain at most ${settings.maximumSpins} spins`);
    if (stakePerSpin < settings.minimumStake) throw new HttpError(400, `Minimum stake per spin is ${settings.minimumStake}`);
    if (stakePerSpin > settings.maximumStake) throw new HttpError(400, `Maximum stake per spin is ${settings.maximumStake}`);

    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(403, 'Player is no longer active');

    const existing = await client.query(
      `SELECT s.id,s.player_id,p.display_name FROM slot_sessions s JOIN players p ON p.id=s.player_id
       WHERE s.game_night_id=$1 AND s.status='ACTIVE' FOR UPDATE OF s`,
      [gameId],
    );
    if (existing.rows[0]) {
      throw new HttpError(409, Number(existing.rows[0].player_id) === session.playerId
        ? 'You already have an active slot series'
        : `${existing.rows[0].display_name} is playing the slot machine right now`);
    }

    const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!wallet.rows[0]) throw new HttpError(404, 'Player wallet not found');
    const totalStake = stakePerSpin * spins;
    if (totalStake > Number(wallet.rows[0].current_balance)) throw new HttpError(409, `Your available balance does not cover a total stake of ${totalStake}`);

    const created = await client.query(
      `INSERT INTO slot_sessions (game_night_id,player_id,stake_per_spin,total_spins,remaining_spins,total_stake,status,idempotency_key)
       VALUES ($1,$2,$3,$4,$4,$5,'ACTIVE',$6) RETURNING id`,
      [gameId, session.playerId, stakePerSpin, spins, totalStake, key],
    );
    const slotSessionId = Number(created.rows[0].id);

    await client.query(
      `INSERT INTO ledger_entries (game_night_id,player_id,amount,transaction_type,description,slot_session_id,created_by,idempotency_key,metadata)
       VALUES ($1,$2,$3,'SLOT_DEPOSIT',$4,$5,'player',$6,$7::jsonb)`,
      [gameId, session.playerId, -totalStake, `Slot series ${spins} x ${stakePerSpin}`, slotSessionId, key, JSON.stringify({ bucket: 'locked', stakePerSpin, spins })],
    );
    await client.query('UPDATE wallets SET current_balance=current_balance-$1,updated_at=NOW() WHERE player_id=$2', [totalStake, session.playerId]);

    return { slotSessionId, stakePerSpin, spins, totalStake, version: await incrementGameVersion(client, gameId) };
  }));
});
