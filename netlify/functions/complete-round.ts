import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { clearScreenForRound, incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const roundId = intValue(payload.roundId, 'roundId', { min: 1 });

  return ok(await withTransaction(async (client) => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const round = await client.query(
      'SELECT round_number,status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [roundId, gameId],
    );
    if (!round.rows[0]) throw new HttpError(404, 'Round not found');
    if (round.rows[0].status !== 'ACTIVE') throw new HttpError(409, 'Only the active round can be completed');

    const livePrediction = await client.query(
      `SELECT display_number,status FROM predictions
       WHERE round_id=$1 AND game_night_id=$2
         AND status IN ('VOTING','CALCULATING','BETTING','LOCKED','RESULT')
       ORDER BY display_number ASC LIMIT 1`,
      [roundId, gameId],
    );
    if (livePrediction.rows[0]) {
      throw new HttpError(
        409,
        `Prediction #${livePrediction.rows[0].display_number} is still ${livePrediction.rows[0].status}`,
      );
    }

    await client.query(
      `UPDATE rounds SET status='COMPLETED',completed_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [roundId],
    );
    await client.query(
      'UPDATE game_nights SET current_round_id=NULL,updated_at=NOW() WHERE id=$1 AND current_round_id=$2',
      [gameId, roundId],
    );
    await clearScreenForRound(client, gameId, roundId, admin.username);
    await audit(client, gameId, admin.username, `completed R${round.rows[0].round_number}`, 'round', roundId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
