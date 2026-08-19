import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { clearScreenIfReferences, incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(p.predictionId, 'predictionId', { min: 1 });
  const key = requestIdempotencyKey(request);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const pred = await client.query('SELECT status,display_number,round_id FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [predictionId, gameId]);
    if (!pred.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (pred.rows[0].status === 'CANCELLED') return { duplicate: true };
    if (!['DRAFT','SCHEDULED','OPEN','LOCKED'].includes(pred.rows[0].status)) {
      throw new HttpError(409, 'A prediction cannot be cancelled after a result has been chosen');
    }

    const bets = await client.query("SELECT * FROM bets WHERE prediction_id=$1 AND status='ACTIVE' ORDER BY player_id,id FOR UPDATE", [predictionId]);
    for (const bet of bets.rows) {
      const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [bet.player_id, gameId]);
      if (!wallet.rows[0]) throw new HttpError(409, 'Bet player wallet is missing');
      const ledger = await client.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,prediction_id,bet_id,created_by,idempotency_key)
         VALUES($1,$2,$3,'BET_REFUND',$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING RETURNING id`,
        [gameId, bet.player_id, bet.stake, `Prediction #${pred.rows[0].display_number} cancellation refund`, pred.rows[0].round_id, predictionId, bet.id, admin.username, `${key}:bet:${bet.id}`],
      );
      if (ledger.rows[0]) {
        await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [bet.stake, bet.player_id]);
      } else {
        const existing = await client.query(
          "SELECT player_id,amount,prediction_id FROM ledger_entries WHERE bet_id=$1 AND transaction_type='BET_REFUND'",
          [bet.id],
        );
        if (!existing.rows[0]
          || Number(existing.rows[0].player_id) !== Number(bet.player_id)
          || Number(existing.rows[0].amount) !== Number(bet.stake)
          || Number(existing.rows[0].prediction_id) !== predictionId) {
          throw new HttpError(409, 'Cancellation idempotency key conflicts with another transaction');
        }
      }
      await client.query("UPDATE bets SET status='REFUNDED',settled_at=NOW() WHERE id=$1", [bet.id]);
    }
    await client.query("UPDATE predictions SET status='CANCELLED',result='CANCEL',settled_at=NOW(),updated_at=NOW() WHERE id=$1", [predictionId]);
    await clearScreenIfReferences(client, gameId, admin.username, { predictionId });
    await audit(client, gameId, admin.username, 'cancelled prediction', 'prediction', predictionId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
