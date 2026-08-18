import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreenMode } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(payload.predictionId, 'predictionId', { min: 1 });

  return ok(await withTransaction(async (client) => {
    const prediction = await client.query(
      'SELECT status,round_id,yes_odds,no_odds,visible_to_players FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [predictionId, gameId],
    );
    if (!prediction.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (prediction.rows[0].status !== 'CALCULATING') throw new HttpError(409, 'Prediction must be CALCULATING');
    if (prediction.rows[0].yes_odds == null || prediction.rows[0].no_odds == null) {
      throw new HttpError(409, 'Prediction does not have calculated odds');
    }

    await client.query(
      `UPDATE predictions SET status='BETTING',betting_opened_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [predictionId],
    );
    if (prediction.rows[0].visible_to_players) {
      await setScreenMode(client, gameId, 'BETTING_OPEN', admin.username, prediction.rows[0].round_id, predictionId);
    }
    await audit(client, gameId, admin.username, 'opened betting', 'prediction', predictionId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
