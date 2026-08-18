import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, created, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const question = textValue(payload.question, 'question', 300);
  const roundId = payload.roundId == null ? null : intValue(payload.roundId, 'roundId', { min: 1 });
  const requestedNumber = payload.displayNumber == null ? null : intValue(payload.displayNumber, 'displayNumber', { min: 1, max: 9999 });

  return created(await withTransaction(async (client) => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    if (roundId) {
      const round = await client.query('SELECT id FROM rounds WHERE id=$1 AND game_night_id=$2', [roundId, gameId]);
      if (!round.rows[0]) throw new HttpError(404, 'Round not found');
    }
    let displayNumber = requestedNumber;
    if (!displayNumber) {
      const next = await client.query('SELECT COALESCE(MAX(display_number),0)+1 AS next FROM predictions WHERE game_night_id=$1', [gameId]);
      displayNumber = Number(next.rows[0].next);
    }
    const dup = await client.query('SELECT id FROM predictions WHERE game_night_id=$1 AND display_number=$2', [gameId, displayNumber]);
    if (dup.rows[0]) throw new HttpError(409, `Prediction #${displayNumber} already exists`);
    const result = await client.query(
      `INSERT INTO predictions(game_night_id,round_id,display_number,question,status,visible_to_players)
       VALUES($1,$2,$3,$4,'DRAFT',FALSE) RETURNING id`,
      [gameId, roundId, displayNumber, question],
    );
    const predictionId = Number(result.rows[0].id);
    await audit(client, gameId, admin.username, `created prediction #${displayNumber}`, 'prediction', predictionId, { question });
    return { predictionId, version: await incrementGameVersion(client, gameId) };
  }));
});
