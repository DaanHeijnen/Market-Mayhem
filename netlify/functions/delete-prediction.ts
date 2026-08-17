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
    const p = await client.query('SELECT display_number,status FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [predictionId, gameId]);
    if (!p.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (p.rows[0].status !== 'DRAFT') throw new HttpError(409, 'Only draft predictions can be deleted');
    await client.query('DELETE FROM predictions WHERE id=$1', [predictionId]);
    const screen = await client.query('SELECT prediction_id FROM screen_state WHERE game_night_id=$1', [gameId]);
    if (Number(screen.rows[0]?.prediction_id) === predictionId) await setScreenMode(client, gameId, 'DASHBOARD', admin.username, null, null);
    await audit(client, gameId, admin.username, `deleted prediction #${p.rows[0].display_number}`, 'prediction', predictionId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
