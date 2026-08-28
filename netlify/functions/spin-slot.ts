import { randomInt } from 'node:crypto';
import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { pickWeightedOutcome, requireUsableSlotConfiguration, SLOT_SPIN_MS, slotOutcomeLabel, slotPayoutAmount } from '../lib/slot';
import { lockSlotSettings, lockWeightedOutcomes, slotStatus } from '../lib/slot-store';
import { wrap } from './_wrap';

/**
 * The game engine. The mobile client only sends the SPIN command: the outcome
 * is drawn here from the Admin-configured weighted table, never per reel and
 * never on the client.
 */
export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const session = await requirePlayer(request, gameId);
  const key = requestIdempotencyKey(request);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const prior = await client.query(
      'SELECT id,player_id,spin_number FROM slot_spins WHERE game_night_id=$1 AND idempotency_key=$2',
      [gameId, key],
    );
    if (prior.rows[0]) {
      if (Number(prior.rows[0].player_id) !== session.playerId) throw new HttpError(409, 'Idempotency key was already used for another player');
      return { duplicate: true, spinId: Number(prior.rows[0].id), spinNumber: Number(prior.rows[0].spin_number) };
    }

    const slotSession = await client.query(
      `SELECT id,player_id,stake_per_spin,total_spins,remaining_spins FROM slot_sessions
       WHERE game_night_id=$1 AND player_id=$2 AND status='ACTIVE' FOR UPDATE`,
      [gameId, session.playerId],
    );
    if (!slotSession.rows[0]) throw new HttpError(409, 'You do not have an active slot series');
    const active = slotSession.rows[0];
    const remaining = Number(active.remaining_spins);
    if (remaining <= 0) throw new HttpError(409, 'No spins are left in this series');

    // One spin at a time: the reels have to land before the next outcome is
    // drawn, or the Big Screen would skip a result. Checked against the clock
    // rather than the synced status, so it holds without an intervening read.
    const inFlight = await client.query(
      `SELECT id FROM slot_spins WHERE slot_session_id=$1 AND status='SPINNING'
         AND created_at>NOW()-($2::text||' milliseconds')::interval LIMIT 1`,
      [Number(active.id), SLOT_SPIN_MS],
    );
    if (inFlight.rows[0]) throw new HttpError(409, 'The reels are still spinning');

    const settings = await lockSlotSettings(client, gameId);
    const snapshot = await slotStatus(client, gameId, settings);
    requireUsableSlotConfiguration(snapshot.status);

    const outcomes = await lockWeightedOutcomes(client, gameId);
    const roll = randomInt(0, settings.totalProbabilityPool);
    const outcome = pickWeightedOutcome(outcomes, settings.totalProbabilityPool, roll);
    const stake = Number(active.stake_per_spin);
    const payoutMultiplier = Number(outcome.payoutMultiplier);
    const payoutAmount = slotPayoutAmount(stake, payoutMultiplier);
    const spinNumber = Number(active.total_spins) - remaining + 1;

    const spin = await client.query(
      `INSERT INTO slot_spins (game_night_id,slot_session_id,player_id,spin_number,stake,reel1_position,reel2_position,reel3_position,payout_multiplier,payout_amount,status,idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SPINNING',$11) RETURNING id,created_at`,
      [gameId, Number(active.id), session.playerId, spinNumber, stake, outcome.reel1, outcome.reel2, outcome.reel3, payoutMultiplier, payoutAmount, key],
    );
    const spinId = Number(spin.rows[0].id);

    if (payoutAmount > 0) {
      await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
      await client.query(
        `INSERT INTO ledger_entries (game_night_id,player_id,amount,transaction_type,description,slot_session_id,slot_spin_id,created_by,idempotency_key,metadata)
         VALUES ($1,$2,$3,'SLOT_PAYOUT',$4,$5,$6,'engine',$7,$8::jsonb)`,
        [
          gameId, session.playerId, payoutAmount,
          `Slot ${slotOutcomeLabel(outcome.reel1, outcome.reel2, outcome.reel3)} payout ${payoutMultiplier}x`,
          Number(active.id), spinId, `${key}:payout`,
          JSON.stringify({ spinNumber, multiplier: payoutMultiplier, stake }),
        ],
      );
      await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [payoutAmount, session.playerId]);
    }

    const remainingAfter = remaining - 1;
    await client.query(
      `UPDATE slot_sessions
       SET remaining_spins=$2,status=CASE WHEN $2=0 THEN 'COMPLETED' ELSE status END,
           closed_at=CASE WHEN $2=0 THEN NOW() ELSE closed_at END,updated_at=NOW()
       WHERE id=$1`,
      [Number(active.id), remainingAfter],
    );

    return {
      spinId,
      spinNumber,
      remainingSpins: remainingAfter,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
