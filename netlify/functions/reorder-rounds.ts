import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

/**
 * Reorder the evening.
 *
 * Takes the whole list rather than a move instruction, so the result is the order the host
 * is looking at rather than the order their click implied. Two passes, because
 * (game_night_id, sort_order) is unique and a single pass would collide with rows it has
 * not renumbered yet.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundIds: number[] = Array.isArray(p.roundIds)
    ? p.roundIds.map((id: unknown, i: number) => intValue(id, `roundIds[${i}]`, { min: 1 }))
    : [];
  if (!roundIds.length) throw new HttpError(400, 'roundIds is required');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const existing = await client.query(
      'SELECT id FROM rounds WHERE game_night_id=$1 ORDER BY sort_order,id FOR UPDATE',
      [gameId],
    );
    const known = existing.rows.map((r: any) => Number(r.id));
    // The list must be the game's rounds exactly — no strangers, nobody left out — or the
    // reorder would silently drop a round to the end.
    if (roundIds.length !== known.length || !known.every(id => roundIds.includes(id))) {
      throw new HttpError(409, 'The round list is out of date — refresh and try again');
    }

    await client.query('UPDATE rounds SET sort_order=sort_order+100000 WHERE game_night_id=$1', [gameId]);
    for (const [index, roundId] of roundIds.entries()) {
      await client.query('UPDATE rounds SET sort_order=$2,updated_at=NOW() WHERE id=$1', [roundId, index + 1]);
    }

    await audit(client, gameId, admin.username, 'reordered rounds', 'game', gameId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
