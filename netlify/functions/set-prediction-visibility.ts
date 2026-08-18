import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(payload.predictionId, 'predictionId', { min: 1 });
  const visible = payload.visible === true;
  return ok(await withTransaction(async (client) => {
    const p = await client.query('SELECT display_number FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [predictionId, gameId]);
    if (!p.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (visible) {
      await client.query('UPDATE predictions SET visible_to_players=FALSE,updated_at=NOW() WHERE game_night_id=$1 AND id<>$2', [gameId, predictionId]);
    }
    await client.query('UPDATE predictions SET visible_to_players=$2,updated_at=NOW() WHERE id=$1', [predictionId, visible]);
    await audit(client, gameId, admin.username, `${visible ? 'showed' : 'hid'} prediction #${p.rows[0].display_number} for players`, 'prediction', predictionId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
