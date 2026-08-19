import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, numberValue, booleanValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { probabilityToMultipliers } from '../lib/economy';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(p.predictionId, 'predictionId', { min: 1 });
  const question = textValue(p.question, 'question', 300);
  const roundId = p.roundId == null || p.roundId === '' ? null : intValue(p.roundId, 'roundId', { min: 1 });
  const probabilityPercent = numberValue(p.probabilityPercent, 'probabilityPercent', { min: 1, max: 99 });
  const predictionTimeSeconds = intValue(p.predictionTimeSeconds, 'predictionTimeSeconds', { min: 5, max: 86400 });
  const minimumStake = intValue(p.minimumStake, 'minimumStake', { min: 1, max: 1_000_000 });
  const maximumStake = intValue(p.maximumStake, 'maximumStake', { min: 1, max: 1_000_000 });
  const scheduled = booleanValue(p.scheduled, 'scheduled');
  if (maximumStake < minimumStake) throw new HttpError(400, 'Maximum stake must be at least the minimum stake');
  if (scheduled && !roundId) throw new HttpError(400, 'Scheduled predictions require a round');
  const probabilityYes = probabilityPercent / 100;
  const multipliers = probabilityToMultipliers(probabilityYes);

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
      `UPDATE predictions
       SET question=$2,round_id=$3,probability_yes=$4,yes_odds=$5,no_odds=$6,status=$7,
           prediction_time_seconds=$8,minimum_stake=$9,maximum_stake=$10,updated_at=NOW()
       WHERE id=$1`,
      [predictionId, question, roundId, probabilityYes, multipliers.yes, multipliers.no, scheduled ? 'SCHEDULED' : 'DRAFT', predictionTimeSeconds, minimumStake, maximumStake],
    );
    await audit(client, gameId, admin.username, 'edited prediction', 'prediction', predictionId, {
      roundId, probabilityPercent, multipliers, predictionTimeSeconds, minimumStake, maximumStake, status: scheduled ? 'SCHEDULED' : 'DRAFT',
    });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
