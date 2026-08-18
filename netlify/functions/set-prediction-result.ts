import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(p.predictionId, 'predictionId', { min: 1 });
  const result = typeof p.result === 'string' ? p.result : '';
  if (!['YES', 'NO'].includes(result)) throw new HttpError(400, 'result must be YES or NO');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const pred = await client.query('SELECT status,result FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [predictionId, gameId]);
    if (!pred.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (pred.rows[0].status === 'RESULT' && pred.rows[0].result === result) return { duplicate: true };
    if (pred.rows[0].status === 'RESULT' && pred.rows[0].result !== result) throw new HttpError(409, 'Prediction result is already set to a different outcome');
    if (pred.rows[0].status !== 'LOCKED') throw new HttpError(409, 'Prediction must be locked before choosing a result');
    await client.query("UPDATE predictions SET status='RESULT',result=$2,updated_at=NOW() WHERE id=$1", [predictionId, result]);
    const screen = await client.query("UPDATE screen_state SET mode='PREDICTION_RESULT',updated_at=NOW(),updated_by=$3 WHERE game_night_id=$2 AND prediction_id=$1 RETURNING game_night_id", [predictionId, gameId, admin.username]);
    if (screen.rows[0]) await client.query("UPDATE game_nights SET current_screen_mode='PREDICTION_RESULT',updated_at=NOW() WHERE id=$1", [gameId]);
    await audit(client, gameId, admin.username, `set prediction result ${result}`, 'prediction', predictionId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
