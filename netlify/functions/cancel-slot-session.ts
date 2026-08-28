import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { slotLockedValue } from '../lib/slot';
import { wrap } from './_wrap';

/**
 * Admin escape hatch. Only one slot series may be live per game night, so an
 * abandoned series must be closable. Unspun stake is returned in full.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const key = requestIdempotencyKey(request);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const found = await client.query(
      "SELECT id,player_id,stake_per_spin,remaining_spins FROM slot_sessions WHERE game_night_id=$1 AND status='ACTIVE' FOR UPDATE",
      [gameId],
    );
    if (!found.rows[0]) return { duplicate: true, refunded: 0 };
    const slotSession = found.rows[0];
    const refund = slotLockedValue(Number(slotSession.remaining_spins), Number(slotSession.stake_per_spin));

    if (refund > 0) {
      const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [slotSession.player_id, gameId]);
      if (!wallet.rows[0]) throw new HttpError(409, 'Slot player wallet is missing');
      const ledger = await client.query(
        `INSERT INTO ledger_entries (game_night_id,player_id,amount,transaction_type,description,slot_session_id,created_by,idempotency_key)
         VALUES ($1,$2,$3,'SLOT_REFUND','Cancelled slot series refund',$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
        [gameId, slotSession.player_id, refund, Number(slotSession.id), admin.username, key],
      );
      if (ledger.rows[0]) {
        await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [refund, slotSession.player_id]);
      } else {
        const existing = await client.query(
          "SELECT player_id,amount FROM ledger_entries WHERE slot_session_id=$1 AND transaction_type='SLOT_REFUND'",
          [Number(slotSession.id)],
        );
        if (!existing.rows[0] || Number(existing.rows[0].player_id) !== Number(slotSession.player_id) || Number(existing.rows[0].amount) !== refund) {
          throw new HttpError(409, 'Slot refund idempotency key conflicts with another transaction');
        }
      }
    }

    await client.query("UPDATE slot_sessions SET status='CANCELLED',remaining_spins=0,closed_at=NOW(),updated_at=NOW() WHERE id=$1", [Number(slotSession.id)]);
    await audit(client, gameId, admin.username, 'cancelled slot series', 'slot_session', Number(slotSession.id), { refund });
    return { refunded: refund, version: await incrementGameVersion(client, gameId) };
  }));
});
