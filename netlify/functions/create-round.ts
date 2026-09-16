import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, created, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { roundTypeValue } from '../lib/rounds';
import { wrap } from './_wrap';

/**
 * Create a round.
 *
 * The type is chosen here and never again: it decides which content tables the round may
 * have, so changing it later would mean deciding what to do with content that no longer
 * fits. `edit-round` therefore has no type parameter.
 */
export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const type = roundTypeValue(payload.type);
  const title = textValue(payload.title, 'title', 120);
  const description = typeof payload.description === 'string' ? payload.description.trim().slice(0, 1000) : '';
  const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim().slice(0, 2000) : '';
  const defaultPoints = payload.defaultPoints == null
    ? 10
    : intValue(payload.defaultPoints, 'defaultPoints', { min: 0, max: 100000 });

  return created(await withTransaction(async (client) => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    // Appended to the end of the evening. The host reorders afterwards if they want it
    // elsewhere — asking for a number up front only invited collisions.
    const next = await client.query(
      'SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM rounds WHERE game_night_id=$1',
      [gameId],
    );
    const sortOrder = Number(next.rows[0].next);

    const row = await client.query(
      `INSERT INTO rounds(game_night_id,sort_order,title,description,type,status,instructions,default_points)
       VALUES($1,$2,$3,$4,$5,'UPCOMING',$6,$7) RETURNING id`,
      [gameId, sortOrder, title, description || null, type, instructions, defaultPoints],
    );
    const roundId = Number(row.rows[0].id);

    // Every round gets its runtime row at birth, so no later code has to wonder whether
    // one exists before it can advance a cursor.
    await client.query('INSERT INTO round_runtime(round_id,game_night_id) VALUES($1,$2)', [roundId, gameId]);

    if (type === 'SLOTMACHINE') {
      const maxSpins = payload.maxSpins == null ? 10 : intValue(payload.maxSpins, 'maxSpins', { min: 1, max: 10 });
      await client.query(
        'INSERT INTO slotmachine_rounds(round_id,game_night_id,max_spins) VALUES($1,$2,$3)',
        [roundId, gameId, maxSpins],
      );
    }

    await audit(client, gameId, admin.username, `created ${type} round "${title}"`, 'round', roundId);
    return { roundId, type, version: await incrementGameVersion(client, gameId) };
  }));
});
