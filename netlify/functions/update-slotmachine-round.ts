import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundEditable } from '../lib/rounds';
import { wrap } from './_wrap';

/**
 * A slotmachine round's own settings.
 *
 * Only the two things that are per round. The reel artwork and the outcome distribution
 * are game-wide and belong to Settings, so they are deliberately not reachable from here.
 *
 * The allowlist is replaced wholesale rather than patched, and only ids that resolve to a
 * player of this game survive — an allowlist naming somebody who was removed would
 * silently shrink who may play.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const maxSpins = intValue(p.maxSpins, 'maxSpins', { min: 1, max: 10 });
  const playerIds: number[] = Array.isArray(p.allowedPlayerIds)
    ? p.allowedPlayerIds.map((id: unknown, i: number) => intValue(id, `allowedPlayerIds[${i}]`, { min: 1 }))
    : [];

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundType(round, 'SLOTMACHINE');
    assertRoundEditable(round);

    await client.query(
      `INSERT INTO slotmachine_rounds(round_id,game_night_id,max_spins) VALUES($1,$2,$3)
       ON CONFLICT (round_id) DO UPDATE SET max_spins=EXCLUDED.max_spins,updated_at=NOW()`,
      [roundId, gameId, maxSpins],
    );

    await client.query('DELETE FROM slotmachine_round_participants WHERE round_id=$1', [roundId]);
    if (playerIds.length) {
      await client.query(
        `INSERT INTO slotmachine_round_participants(round_id,game_night_id,player_id)
         SELECT $1,$2,p.id FROM players p
         WHERE p.game_night_id=$2 AND p.id = ANY($3::bigint[])
         ON CONFLICT DO NOTHING`,
        [roundId, gameId, playerIds],
      );
    }

    await audit(client, gameId, admin.username, 'updated slotmachine round settings', 'round', roundId, {
      maxSpins, participants: playerIds.length,
    });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
