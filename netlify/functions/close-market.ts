import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { clearScreenForPrediction, incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(payload.predictionId, 'predictionId', { min: 1 });

  return ok(await withTransaction(async (client) => {
    const prediction = await client.query(
      'SELECT status FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [predictionId, gameId],
    );
    if (!prediction.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (prediction.rows[0].status !== 'BETTING') throw new HttpError(409, 'Market is not open');

    await client.query(
      `UPDATE predictions SET status='LOCKED',betting_closed_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [predictionId],
    );
    await clearScreenForPrediction(client, gameId, predictionId, admin.username);
    await audit(client, gameId, admin.username, 'closed market', 'prediction', predictionId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
