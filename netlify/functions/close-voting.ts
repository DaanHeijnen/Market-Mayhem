import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreenMode } from '../lib/game-state';
import { marketFromVotes } from '../lib/economy';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(payload.predictionId, 'predictionId', { min: 1 });

  return ok(await withTransaction(async (client) => {
    const prediction = await client.query(
      'SELECT status,round_id,visible_to_players FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [predictionId, gameId],
    );
    if (!prediction.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (prediction.rows[0].status !== 'VOTING') throw new HttpError(409, 'Voting is not open');

    const votes = await client.query(
      `SELECT v.yes_probability
       FROM prediction_votes v
       JOIN players p ON p.id=v.player_id
       WHERE v.prediction_id=$1 AND p.active=TRUE`,
      [predictionId],
    );
    if (votes.rowCount === 0) throw new HttpError(409, 'At least one vote is required before closing voting');

    const market = marketFromVotes(votes.rows.map((row: { yes_probability: unknown }) => Number(row.yes_probability)));
    await client.query(
      `UPDATE predictions
       SET status='CALCULATING',voting_closed_at=NOW(),crowd_yes_probability=$2,crowd_no_probability=$3,
           yes_odds=$4,no_odds=$5,updated_at=NOW()
       WHERE id=$1`,
      [predictionId, market.yesProbability, market.noProbability, market.yesOdds, market.noOdds],
    );
    if (prediction.rows[0].visible_to_players) {
      await setScreenMode(client, gameId, 'CROWD_REVEAL', admin.username, prediction.rows[0].round_id, predictionId);
    }
    await audit(client, gameId, admin.username, 'closed voting', 'prediction', predictionId, { votes: votes.rowCount });
    return { version: await incrementGameVersion(client, gameId), market };
  }));
});
