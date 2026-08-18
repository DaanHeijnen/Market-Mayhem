import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const playerId = intValue(payload.playerId, 'playerId', { min: 1 });

  return ok(await withTransaction(async (client) => {
    const player = await client.query(
      'SELECT display_name FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [playerId, gameId],
    );
    if (!player.rows[0]) throw new HttpError(404, 'Player not found');
    const activeBets = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM bets b JOIN predictions pr ON pr.id=b.prediction_id
        WHERE b.player_id=$1 AND pr.game_night_id=$2 AND b.status='ACTIVE'`,
      [playerId, gameId],
    );
    if (Number(activeBets.rows[0].count) > 0) throw new HttpError(409, "Settle or cancel this player's active bets before removing them");
    await client.query('UPDATE players SET active=FALSE,updated_at=NOW() WHERE id=$1', [playerId]);
    await client.query('UPDATE player_sessions SET revoked_at=NOW() WHERE player_id=$1 AND revoked_at IS NULL', [playerId]);
    await client.query('UPDATE player_join_tokens SET revoked_at=NOW() WHERE player_id=$1 AND revoked_at IS NULL', [playerId]);
    await audit(client, gameId, admin.username, `removed player ${player.rows[0].display_name}`, 'player', playerId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
