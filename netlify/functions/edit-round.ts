import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundEditable } from '../lib/rounds';
import { wrap } from './_wrap';

/**
 * Edit a round's own fields.
 *
 * Not its type: a round's type decides what content it may hold, and content already
 * authored under one type has nowhere to go under another. Changing type means creating
 * the other round and moving on.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const title = textValue(p.title, 'title', 120);
  const description = typeof p.description === 'string' ? p.description.trim().slice(0, 1000) : '';
  const instructions = typeof p.instructions === 'string' ? p.instructions.trim().slice(0, 2000) : '';
  const defaultPoints = p.defaultPoints == null ? null : intValue(p.defaultPoints, 'defaultPoints', { min: 0, max: 100000 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundEditable(round);

    await client.query(
      `UPDATE rounds SET title=$2,description=$3,instructions=$4,
         default_points=COALESCE($5,default_points),updated_at=NOW()
       WHERE id=$1`,
      [roundId, title, description || null, instructions, defaultPoints],
    );

    if (round.type === 'SLOTMACHINE' && p.maxSpins != null) {
      const maxSpins = intValue(p.maxSpins, 'maxSpins', { min: 1, max: 10 });
      await client.query(
        `INSERT INTO slotmachine_rounds(round_id,game_night_id,max_spins) VALUES($1,$2,$3)
         ON CONFLICT (round_id) DO UPDATE SET max_spins=EXCLUDED.max_spins,updated_at=NOW()`,
        [roundId, gameId, maxSpins],
      );
    }

    await audit(client, gameId, admin.username, 'edited round', 'round', roundId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
