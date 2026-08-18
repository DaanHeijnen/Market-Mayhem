import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, created, intValue, textValue, numberValue, booleanValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const question = textValue(p.question, 'question', 300);
  const roundId = p.roundId == null || p.roundId === '' ? null : intValue(p.roundId, 'roundId', { min: 1 });
  const yesOdds = numberValue(p.yesOdds, 'yesOdds', { min: 1.001, max: 1000 });
  const noOdds = numberValue(p.noOdds, 'noOdds', { min: 1.001, max: 1000 });
  const scheduled = booleanValue(p.scheduled, 'scheduled');
  const requested = p.displayNumber == null || p.displayNumber === '' ? null : intValue(p.displayNumber, 'displayNumber', { min: 1, max: 9999 });
  if (scheduled && !roundId) throw new HttpError(400, 'Scheduled predictions require a round');

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
      `INSERT INTO predictions(game_night_id,round_id,display_number,question,status,yes_odds,no_odds)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [gameId, roundId, displayNumber, question, scheduled ? 'SCHEDULED' : 'DRAFT', yesOdds, noOdds],
    );
    const id = Number(q.rows[0].id);
    await audit(client, gameId, admin.username, 'created prediction', 'prediction', id, { displayNumber, roundId, yesOdds, noOdds, status: scheduled ? 'SCHEDULED' : 'DRAFT' });
    return { predictionId: id, version: await incrementGameVersion(client, gameId) };
  }));
});
