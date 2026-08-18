import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, numberValue, booleanValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(p.predictionId, 'predictionId', { min: 1 });
  const question = textValue(p.question, 'question', 300);
  const roundId = p.roundId == null || p.roundId === '' ? null : intValue(p.roundId, 'roundId', { min: 1 });
  const yesOdds = numberValue(p.yesOdds, 'yesOdds', { min: 1.001, max: 1000 });
  const noOdds = numberValue(p.noOdds, 'noOdds', { min: 1.001, max: 1000 });
  const scheduled = booleanValue(p.scheduled, 'scheduled');
  if (scheduled && !roundId) throw new HttpError(400, 'Scheduled predictions require a round');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const pred = await client.query('SELECT status FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [predictionId, gameId]);
    if (!pred.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (!['DRAFT', 'SCHEDULED'].includes(pred.rows[0].status)) throw new HttpError(409, 'Prediction can no longer be edited after it opens');
    const bets = await client.query('SELECT 1 FROM bets WHERE prediction_id=$1 LIMIT 1', [predictionId]);
    if (bets.rows[0]) throw new HttpError(409, 'Predictions with bets cannot be edited');

    if (roundId) {
      const r = await client.query('SELECT status FROM rounds WHERE id=$1 AND game_night_id=$2', [roundId, gameId]);
      if (!r.rows[0]) throw new HttpError(404, 'Round not found');
      if (r.rows[0].status === 'COMPLETED') throw new HttpError(409, 'Completed rounds cannot receive new predictions');
      if (scheduled && r.rows[0].status !== 'UPCOMING') throw new HttpError(409, 'Only upcoming rounds can receive scheduled predictions');
    }

    await client.query(
      'UPDATE predictions SET question=$2,round_id=$3,yes_odds=$4,no_odds=$5,status=$6,updated_at=NOW() WHERE id=$1',
      [predictionId, question, roundId, yesOdds, noOdds, scheduled ? 'SCHEDULED' : 'DRAFT'],
    );
    await audit(client, gameId, admin.username, 'edited prediction', 'prediction', predictionId, { roundId, yesOdds, noOdds, status: scheduled ? 'SCHEDULED' : 'DRAFT' });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
