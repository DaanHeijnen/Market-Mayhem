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

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const pred = await client.query('SELECT status FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [predictionId, gameId]);
    if (!pred.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (pred.rows[0].status !== 'OPEN') throw new HttpError(409, 'Prediction is not open');
    await client.query("UPDATE predictions SET status='LOCKED',closes_at=LEAST(COALESCE(closes_at,NOW()),NOW()),updated_at=NOW() WHERE id=$1", [predictionId]);
    const screen = await client.query("UPDATE screen_state SET mode='PREDICTION_LOCKED',updated_at=NOW(),updated_by=$3 WHERE game_night_id=$2 AND prediction_id=$1 RETURNING game_night_id", [predictionId, gameId, admin.username]);
    if (screen.rows[0]) await client.query("UPDATE game_nights SET current_screen_mode='PREDICTION_LOCKED',updated_at=NOW() WHERE id=$1", [gameId]);
    await audit(client, gameId, admin.username, 'locked prediction', 'prediction', predictionId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
