import { audit, requireAdmin } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, HttpError, intValue, ok } from '../lib/http';
import { clearScreenForPrediction, incrementGameVersion, setScreenMode } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(payload.predictionId, 'predictionId', { min: 1 });
  if (typeof payload.visible !== 'boolean') throw new HttpError(400, 'visible must be a boolean');
  const visible = payload.visible;

  return ok(await withTransaction(async (client) => {
    // Showing one prediction may update every prediction in the game. Lock them
    // in a deterministic order first so two admin tabs cannot deadlock while
    // trying to show different predictions at the same time.
    const predictions = await client.query(
      `SELECT id, display_number, status, round_id, visible_to_players
       FROM predictions
       WHERE game_night_id=$1
       ORDER BY id
       FOR UPDATE`,
      [gameId],
    );
    const prediction = predictions.rows.find((row: { id: unknown }) => Number(row.id) === predictionId);
    if (!prediction) throw new HttpError(404, 'Prediction not found');
    const previouslyVisible = predictions.rows.find(
      (row: { id: unknown; visible_to_players: unknown }) => Boolean(row.visible_to_players) && Number(row.id) !== predictionId,
    );

    if (visible) {
      await client.query(
        'UPDATE predictions SET visible_to_players=FALSE,updated_at=NOW() WHERE game_night_id=$1 AND id<>$2',
        [gameId, predictionId],
      );
    }
    await client.query(
      'UPDATE predictions SET visible_to_players=$2,updated_at=NOW() WHERE id=$1',
      [predictionId, visible],
    );

    if (!visible) {
      await clearScreenForPrediction(client, gameId, predictionId, admin.username);
    } else {
      if (previouslyVisible) {
        await clearScreenForPrediction(client, gameId, Number(previouslyVisible.id), admin.username);
      }
      if (prediction.status === 'VOTING') {
        await setScreenMode(client, gameId, 'PREDICTION_VOTING', admin.username, prediction.round_id, predictionId);
      } else if (prediction.status === 'CALCULATING') {
        await setScreenMode(client, gameId, 'CROWD_REVEAL', admin.username, prediction.round_id, predictionId);
      } else if (prediction.status === 'BETTING') {
        await setScreenMode(client, gameId, 'BETTING_OPEN', admin.username, prediction.round_id, predictionId);
      }
    }

    await audit(
      client,
      gameId,
      admin.username,
      `${visible ? 'showed' : 'hid'} prediction #${prediction.display_number} for players`,
      'prediction',
      predictionId,
    );
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
