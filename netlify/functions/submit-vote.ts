import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(payload.predictionId, 'predictionId', { min: 1 });
  const yesProbability = intValue(payload.yesProbability, 'yesProbability', { min: 0, max: 100 });
  const session = await requirePlayer(request, gameId);

  return ok(await withTransaction(async (client) => {
    const p = await client.query(
      'SELECT status,visible_to_players FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [predictionId, gameId],
    );
    if (p.rows[0]?.status !== 'VOTING') throw new HttpError(409, 'Voting is closed');
    if (!p.rows[0].visible_to_players) throw new HttpError(409, 'This prediction is hidden from players');
    await client.query(
      `INSERT INTO prediction_votes(prediction_id,player_id,yes_probability)
       VALUES($1,$2,$3)
       ON CONFLICT(prediction_id,player_id)
       DO UPDATE SET yes_probability=EXCLUDED.yes_probability,updated_at=NOW()`,
      [predictionId, session.playerId, yesProbability],
    );
    return { ok: true, version: await incrementGameVersion(client, gameId) };
  }));
});
