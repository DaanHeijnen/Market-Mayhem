import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, created, intValue, textValue, numberValue, booleanValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { probabilityToMultipliers } from '../lib/economy';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const question = textValue(p.question, 'question', 300);
  const roundId = p.roundId == null || p.roundId === '' ? null : intValue(p.roundId, 'roundId', { min: 1 });
  const probabilityPercent = numberValue(p.probabilityPercent, 'probabilityPercent', { min: 1, max: 99 });
  const predictionTimeSeconds = intValue(p.predictionTimeSeconds, 'predictionTimeSeconds', { min: 5, max: 86400 });
  const minimumStake = intValue(p.minimumStake, 'minimumStake', { min: 1, max: 1_000_000 });
  const maximumStake = intValue(p.maximumStake, 'maximumStake', { min: 1, max: 1_000_000 });
  const scheduled = booleanValue(p.scheduled, 'scheduled');
  const requested = p.displayNumber == null || p.displayNumber === '' ? null : intValue(p.displayNumber, 'displayNumber', { min: 1, max: 9999 });
  if (maximumStake < minimumStake) throw new HttpError(400, 'Maximum stake must be at least the minimum stake');
  if (scheduled && !roundId) throw new HttpError(400, 'Scheduled predictions require a round');
  const probabilityYes = probabilityPercent / 100;
  const multipliers = probabilityToMultipliers(probabilityYes);

  return created(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    if (roundId) {
      const r = await client.query('SELECT status FROM rounds WHERE id=$1 AND game_night_id=$2', [roundId, gameId]);
      if (!r.rows[0]) throw new HttpError(404, 'Round not found');
      if (r.rows[0].status === 'COMPLETED') throw new HttpError(409, 'Completed rounds cannot receive new predictions');
      if (scheduled && r.rows[0].status !== 'UPCOMING') throw new HttpError(409, 'Only upcoming rounds can receive scheduled predictions');
    }

    let displayNumber = requested;
    if (!displayNumber) {
      const n = await client.query('SELECT COALESCE(MAX(display_number),0)+1 n FROM predictions WHERE game_night_id=$1', [gameId]);
      displayNumber = Number(n.rows[0].n);
    }
    const dup = await client.query('SELECT id FROM predictions WHERE game_night_id=$1 AND display_number=$2', [gameId, displayNumber]);
    if (dup.rows[0]) throw new HttpError(409, `Prediction #${displayNumber} already exists`);

    const q = await client.query(
      `INSERT INTO predictions(
         game_night_id,round_id,display_number,question,status,probability_yes,yes_odds,no_odds,
         prediction_time_seconds,minimum_stake,maximum_stake
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [gameId, roundId, displayNumber, question, scheduled ? 'SCHEDULED' : 'DRAFT', probabilityYes, multipliers.yes, multipliers.no, predictionTimeSeconds, minimumStake, maximumStake],
    );
    const id = Number(q.rows[0].id);
    await audit(client, gameId, admin.username, 'created prediction', 'prediction', id, {
      displayNumber, roundId, probabilityPercent, multipliers, predictionTimeSeconds, minimumStake, maximumStake, status: scheduled ? 'SCHEDULED' : 'DRAFT',
    });
    return { predictionId: id, version: await incrementGameVersion(client, gameId) };
  }));
});
