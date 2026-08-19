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
    const pred = await client.query('SELECT display_number,status FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [predictionId, gameId]);
    if (!pred.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (!['DRAFT', 'SCHEDULED'].includes(pred.rows[0].status)) throw new HttpError(409, 'Only unused draft/scheduled predictions can be deleted');
    const bet = await client.query('SELECT 1 FROM bets WHERE prediction_id=$1 LIMIT 1', [predictionId]);
    if (bet.rows[0]) throw new HttpError(409, 'Prediction with bets cannot be deleted');
    await client.query('DELETE FROM predictions WHERE id=$1', [predictionId]);
    await audit(client, gameId, admin.username, 'deleted prediction', 'prediction', predictionId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
