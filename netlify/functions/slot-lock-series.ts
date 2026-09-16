import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { loadSlotConfig, loadSlotRoundSettings, playerMayPlaySlot } from '../lib/slot-state';
import { seriesTotalStake, SLOT_MAX_SPINS_LIMIT } from '../lib/slotmachine';
import { wrap } from './_wrap';

/**
 * Lock a slotmachine reeks: stake per spin x number of spins, committed up front.
 *
 * This is the only chance to choose. Players take turns and each one plays their whole
 * run before the next starts, so the run has to be bought before it begins — there is no
 * topping up afterwards, and a player who has already played gets no second series on
 * this block.
 *
 * The whole total is debited here rather than per spin. That is what "vastzetten" means
 * financially — the coins are committed to the machine and cannot be spent on a
 * prediction in between spins — and it mirrors how a prediction deposit works. The
 * unspun remainder is refunded if the series is cancelled.
 *
 * Every limit is re-checked here rather than trusted from the phone: the block must be
 * live, the machine's configuration must be valid, the player must be allowed to play,
 * the spin count must fit the block's maximum and the total must fit their wallet.
 */
export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const stakePerSpin = intValue(p.stakePerSpin, 'stakePerSpin', { min: 1, max: 1_000_000 });
  const spins = intValue(p.spins, 'spins', { min: 1, max: SLOT_MAX_SPINS_LIMIT });
  const session = await requirePlayer(request, gameId);
  const key = requestIdempotencyKey(request);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const roundResult = await client.query(
      `SELECT id,type,status AS round_status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE`,
      [roundId, gameId],
    );
    const block = roundResult.rows[0];
    if (!block) throw new HttpError(404, 'Round not found');
    if (block.type !== 'SLOTMACHINE') throw new HttpError(409, 'That round is not a slotmachine');
    if (block.round_status !== 'ACTIVE' || Number(game.rows[0].current_round_id || 0) !== roundId) {
      throw new HttpError(409, 'The slotmachine round is not active');
    }

    // Re-read the machine inside the transaction: an Admin editing the distribution
    // mid-round must not let a series be locked against a configuration that has just
    // become invalid.
    const config = await loadSlotConfig(client, gameId);
    if (!config.status.valid) throw new HttpError(409, `Slotmachine is not ready: ${config.status.reason}`);

    const settings = await loadSlotRoundSettings(client, roundId);
    if (!playerMayPlaySlot(settings, session.playerId)) throw new HttpError(403, 'You are not taking part in this slotmachine');
    if (spins > settings.maxSpins) throw new HttpError(400, `This slotmachine allows at most ${settings.maxSpins} spins per series`);

    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(403, 'Player is no longer active');

    // A replayed request returns the series it already created instead of locking a
    // second one, so a double tap on INZET VASTZETTEN cannot debit twice.
    const replay = await client.query(
      'SELECT id,stake_per_spin,total_spins,spins_remaining,total_stake FROM slot_series WHERE idempotency_key=$1 AND player_id=$2',
      [key, session.playerId],
    );
    if (replay.rows[0]) {
      const existing = replay.rows[0];
      if (Number(existing.stake_per_spin) !== stakePerSpin || Number(existing.total_spins) !== spins) {
        throw new HttpError(409, 'Idempotency key was already used for a different series');
      }
      return { duplicate: true, seriesId: Number(existing.id), spinsRemaining: Number(existing.spins_remaining) };
    }

    // Any series at all, not just a live one: one run per player per block, so a player
    // who has used all their spins cannot buy more. A CANCELLED series does not count —
    // that only happens when the host leaves the block and the machine starts over.
    const existingSeries = await client.query(
      "SELECT id,status FROM slot_series WHERE round_id=$1 AND player_id=$2 AND status IN ('ACTIVE','COMPLETED') FOR UPDATE",
      [roundId, session.playerId],
    );
    if (existingSeries.rows[0]) {
      throw new HttpError(409, existingSeries.rows[0].status === 'COMPLETED'
        ? 'You have already used your spins on this slotmachine'
        : 'You have already locked a series on this slotmachine');
    }

    const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!wallet.rows[0]) throw new HttpError(404, 'Player wallet not found');
    const totalStake = seriesTotalStake(stakePerSpin, spins);
    if (totalStake > Number(wallet.rows[0].current_balance)) throw new HttpError(409, 'Insufficient available balance for this series');

    const inserted = await client.query(
      `INSERT INTO slot_series(game_night_id,round_id,player_id,stake_per_spin,total_spins,spins_remaining,total_stake,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$5,$6,$7) RETURNING id`,
      [gameId, roundId, session.playerId, stakePerSpin, spins, totalStake, key],
    );
    const seriesId = Number(inserted.rows[0].id);

    await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,slot_series_id,created_by,idempotency_key,metadata)
       VALUES($1,$2,$3,'SLOT_STAKE',$4,$5,$6,'player',$7,$8::jsonb)`,
      [
        gameId, session.playerId, -totalStake,
        `Slotmachine series: ${spins} spin${spins === 1 ? '' : 's'} at ${stakePerSpin}`,
        roundId, seriesId, `slot:series:${seriesId}:stake`,
        JSON.stringify({ stakePerSpin, spins, totalStake }),
      ],
    );
    await client.query('UPDATE wallets SET current_balance=current_balance-$1,updated_at=NOW() WHERE player_id=$2', [totalStake, session.playerId]);

    return { seriesId, stakePerSpin, spins, totalStake, version: await incrementGameVersion(client, gameId) };
  }));
});
