import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, created, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const roundNumber = intValue(payload.roundNumber, 'roundNumber', { min: 1, max: 999 });
  const title = textValue(payload.title, 'title', 120);
  const description = typeof payload.description === 'string' ? payload.description.trim().slice(0, 1000) : '';

  return created(await withTransaction(async (client) => {
    const dup = await client.query('SELECT id FROM rounds WHERE game_night_id=$1 AND round_number=$2', [gameId, roundNumber]);
    if (dup.rows[0]) throw new HttpError(409, `Round ${roundNumber} already exists`);
    const row = await client.query(
      `INSERT INTO rounds(game_night_id,round_number,title,description,status)
       VALUES($1,$2,$3,$4,'UPCOMING') RETURNING id`,
      [gameId, roundNumber, title, description || null],
    );
    const roundId = Number(row.rows[0].id);
    await audit(client, gameId, admin.username, `created R${roundNumber} ${title}`, 'round', roundId);
    return { roundId, version: await incrementGameVersion(client, gameId) };
  }));
});
