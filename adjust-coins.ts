import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const playerId = intValue(p.playerId, 'playerId', { min: 1 });
  const amount = intValue(p.amount, 'amount');
  const reason = textValue(p.reason, 'reason', 300);
  const roundId = p.roundId == null || p.roundId === '' ? null : intValue(p.roundId, 'roundId', { min: 1 });
  const key = requestIdempotencyKey(request);
  if (amount === 0) throw new HttpError(400, 'amount cannot be zero');
  if (Math.abs(amount) > 1_000_000) throw new HttpError(400, 'amount is too large');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const duplicate = await client.query(
      `SELECT player_id,amount,description,attributed_round_id,transaction_type
       FROM ledger_entries WHERE game_night_id=$1 AND idempotency_key=$2`,
      [gameId, key],
    );
    if (duplicate.rows[0]) {
      const d = duplicate.rows[0];
      if (d.transaction_type === 'MANUAL_ADJUSTMENT' && Number(d.player_id) === playerId && Number(d.amount) === amount && d.description === reason && (d.attributed_round_id == null ? null : Number(d.attributed_round_id)) === roundId) {
        return { duplicate: true };
      }
      throw new HttpError(409, 'Idempotency key was already used for a different wallet adjustment');
    }

    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(404, 'Active player not found');
    const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [playerId, gameId]);
    if (!wallet.rows[0]) throw new HttpError(404, 'Player wallet not found');
    if (Number(wallet.rows[0].current_balance) + amount < 0) throw new HttpError(409, 'Adjustment would make wallet negative');
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
    await audit(client, gameId, admin.username, 'manual wallet adjustment', 'player', playerId, { amount, reason, roundId });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
