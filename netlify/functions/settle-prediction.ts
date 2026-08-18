import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { clearScreenForPrediction, incrementGameVersion, setScreenMode } from '../lib/game-state';
import { payoutForStake } from '../lib/economy';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(payload.predictionId, 'predictionId', { min: 1 });
  const result = String(payload.result);
  const key = requestIdempotencyKey(request);

  if (!['YES', 'NO', 'CANCEL'].includes(result)) throw new HttpError(400, 'Invalid result');

  return ok(await withTransaction(async (client) => {
    const prediction = await client.query(
      'SELECT * FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [predictionId, gameId],
    );
    if (!prediction.rows[0]) throw new HttpError(404, 'Prediction not found');

    if (['SETTLED', 'CANCELLED'].includes(prediction.rows[0].status)) {
      if (prediction.rows[0].result === result) return { duplicate: true };
      throw new HttpError(409, `Prediction is already settled as ${prediction.rows[0].result}`);
    }
    if (prediction.rows[0].status !== 'LOCKED') throw new HttpError(409, 'Market must be LOCKED');

    const bets = await client.query('SELECT * FROM bets WHERE prediction_id=$1 FOR UPDATE', [predictionId]);
    for (const bet of bets.rows) {
      const refund = result === 'CANCEL';
      const win = !refund && bet.side === result;
      const credit = refund
        ? Number(bet.stake)
        : win
          ? payoutForStake(Number(bet.stake), Number(bet.odds_snapshot))
          : 0;

      if (credit > 0) {
        await client.query(
          'UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2',
          [credit, bet.player_id],
        );
        await client.query(
          `INSERT INTO ledger_entries(
             game_night_id,player_id,amount,transaction_type,description,prediction_id,bet_id,created_by,idempotency_key
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            gameId,
            bet.player_id,
            credit,
            refund ? 'BET_REFUND' : 'BET_PAYOUT',
            refund ? 'Cancelled market refund' : 'Prediction payout',
            predictionId,
            bet.id,
            admin.username,
            `${key}:bet:${bet.id}`,
          ],
        );
      }

      await client.query(
        'UPDATE bets SET status=$2,settled_at=NOW() WHERE id=$1',
        [bet.id, refund ? 'REFUNDED' : win ? 'WON' : 'LOST'],
      );
    }

    await client.query(
      `UPDATE predictions
       SET status=$2,result=$3,settled_at=NOW(),updated_at=NOW()
       WHERE id=$1`,
      [predictionId, result === 'CANCEL' ? 'CANCELLED' : 'SETTLED', result],
    );

    if (result === 'CANCEL') {
      await clearScreenForPrediction(client, gameId, predictionId, admin.username);
    } else if (prediction.rows[0].visible_to_players) {
      await setScreenMode(
        client,
        gameId,
        'PREDICTION_RESULT',
        admin.username,
        prediction.rows[0].round_id,
        predictionId,
        { result },
      );
    }

    await audit(client, gameId, admin.username, `settled prediction ${result}`, 'prediction', predictionId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
