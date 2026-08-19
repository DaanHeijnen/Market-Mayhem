import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const roundNumber = intValue(p.roundNumber, 'roundNumber', { min: 1, max: 999 });
  const title = textValue(p.title, 'title', 120);
  const description = typeof p.description === 'string' ? p.description.trim().slice(0, 1000) : '';

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const r = await client.query('SELECT status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [roundId, gameId]);
    if (!r.rows[0]) throw new HttpError(404, 'Round not found');
    if (r.rows[0].status === 'COMPLETED') throw new HttpError(409, 'Completed rounds are read-only');
    const dup = await client.query('SELECT id FROM rounds WHERE game_night_id=$1 AND round_number=$2 AND id<>$3', [gameId, roundNumber, roundId]);
    if (dup.rows[0]) throw new HttpError(409, `Round ${roundNumber} already exists`);
    await client.query('UPDATE rounds SET round_number=$2,title=$3,description=$4,updated_at=NOW() WHERE id=$1', [roundId, roundNumber, title, description || null]);
    await audit(client, gameId, admin.username, 'edited round', 'round', roundId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
