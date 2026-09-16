import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { isSameManualAdjustment } from '../lib/economy';
import { wrap } from './_wrap';

/**
 * Move a player's coins by hand.
 *
 * Two ways to say the same thing, because a host thinks in both: `amount` is a movement
 * ("give them 25 more"), `targetBalance` is a destination ("make it 250"). Exactly one of
 * the two is accepted per request.
 *
 * A destination is resolved here rather than on the client, under the wallet's row lock.
 * Subtracting on screen would use the balance the Admin last polled, so a payout landing
 * in between would be silently undone — the host would ask for 250 and get 250 minus
 * whatever the player just won. Read and write happen inside one transaction instead, so
 * the number the host typed is the number that ends up in the wallet.
 *
 * Either way the money moves the only way money moves in this app: a ledger entry, and
 * the wallet as its running total, written together.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const playerId = intValue(p.playerId, 'playerId', { min: 1 });
  const reason = textValue(p.reason, 'reason', 300);
  const roundId = p.roundId == null || p.roundId === '' ? null : intValue(p.roundId, 'roundId', { min: 1 });
  const key = requestIdempotencyKey(request);

  const wantsTarget = p.targetBalance != null && p.targetBalance !== '';
  const wantsDelta = p.amount != null && p.amount !== '';
  if (wantsTarget && wantsDelta) throw new HttpError(400, 'Send either amount or targetBalance, not both');
  if (!wantsTarget && !wantsDelta) throw new HttpError(400, 'amount or targetBalance is required');

  const targetBalance = wantsTarget ? intValue(p.targetBalance, 'targetBalance', { min: 0, max: 1_000_000 }) : null;
  const requestedAmount = wantsDelta ? intValue(p.amount, 'amount') : null;
  if (requestedAmount !== null) {
    if (requestedAmount === 0) throw new HttpError(400, 'amount cannot be zero');
    if (Math.abs(requestedAmount) > 1_000_000) throw new HttpError(400, 'amount is too large');
  }

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(404, 'Active player not found');
    const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [playerId, gameId]);
    if (!wallet.rows[0]) throw new HttpError(404, 'Player wallet not found');
    const balance = Number(wallet.rows[0].current_balance);

    // The destination becomes a movement here, against the balance this transaction is
    // holding — not the one the Admin screen happened to be showing.
    const amount = requestedAmount ?? (targetBalance as number) - balance;

    const duplicate = await client.query(
      `SELECT player_id,amount,description,attributed_round_id,transaction_type
       FROM ledger_entries WHERE game_night_id=$1 AND idempotency_key=$2`,
      [gameId, key],
    );
    if (duplicate.rows[0]) {
      if (isSameManualAdjustment(duplicate.rows[0], { playerId, requestedAmount, reason, roundId })) {
        return { duplicate: true, balance };
      }
      throw new HttpError(409, 'Idempotency key was already used for a different wallet adjustment');
    }

    // Asking for the balance a player already has is not an error, and it is not a
    // transaction either: ledger_entries forbids a zero amount, and writing one would
    // claim something happened that did not.
    if (amount === 0) return { unchanged: true, balance };
    if (balance + amount < 0) throw new HttpError(409, 'Adjustment would make wallet negative');
    if (roundId) {
      const r = await client.query('SELECT id FROM rounds WHERE id=$1 AND game_night_id=$2', [roundId, gameId]);
      if (!r.rows[0]) throw new HttpError(404, 'Round not found');
    }

    await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [amount, playerId]);
    await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,created_by,idempotency_key)
       VALUES($1,$2,$3,'MANUAL_ADJUSTMENT',$4,$5,$6,$7)`,
      [gameId, playerId, amount, reason, roundId, admin.username, key],
    );
    await audit(client, gameId, admin.username, 'manual wallet adjustment', 'player', playerId, { amount, reason, roundId, targetBalance });
    return { balance: balance + amount, amount, version: await incrementGameVersion(client, gameId) };
  }));
});
