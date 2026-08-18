import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const playerId = intValue(payload.playerId, 'playerId', { min: 1 });
  const amount = intValue(payload.amount, 'amount');
  if (amount === 0) throw new HttpError(400, 'amount cannot be zero');
  const reason = textValue(payload.reason, 'reason', 300);
  const roundId = payload.roundId ? intValue(payload.roundId, 'roundId', { min: 1 }) : null;
  const key = requestIdempotencyKey(request);

  const result = await withTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM ledger_entries WHERE game_night_id=$1 AND idempotency_key=$2', [gameId, key]);
    if (existing.rows[0]) return { duplicate: true };
    const wallet = await client.query(
      `SELECT w.current_balance
         FROM wallets w JOIN players p ON p.id=w.player_id
        WHERE w.game_night_id=$1 AND w.player_id=$2 AND p.active=TRUE
        FOR UPDATE`,
      [gameId, playerId],
    );
    if (!wallet.rows[0]) throw new HttpError(404, 'Active player wallet not found');
    if (Number(wallet.rows[0].current_balance) + amount < 0) throw new HttpError(409, 'Adjustment would make wallet negative');
    if (roundId) {
      const round = await client.query('SELECT id FROM rounds WHERE id=$1 AND game_night_id=$2', [roundId, gameId]);
      if (!round.rows[0]) throw new HttpError(404, 'Round not found');
    }
    await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [amount, playerId]);
    await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,created_by,idempotency_key)
       VALUES($1,$2,$3,'MANUAL_ADJUSTMENT',$4,$5,$6,$7)`,
      [gameId, playerId, amount, reason, roundId, admin.username, key],
    );
    const version = await incrementGameVersion(client, gameId);
    await audit(client, gameId, admin.username, `adjusted player ${playerId} ${amount > 0 ? '+' : ''}${amount}`, 'player', playerId, { reason, roundId });
    return { version };
  });
  return ok(result);
});
