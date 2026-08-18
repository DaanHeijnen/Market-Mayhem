import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, booleanValue, HttpError } from '../lib/http';
import { randomToken, sha256 } from '../lib/security';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const playerId = intValue(p.playerId, 'playerId', { min: 1 });
  const revokeSessions = p.revokeSessions == null ? false : booleanValue(p.revokeSessions, 'revokeSessions');
  const raw = randomToken();

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(404, 'Active player not found');
    await client.query('UPDATE player_join_tokens SET revoked_at=NOW() WHERE player_id=$1 AND used_at IS NULL AND revoked_at IS NULL', [playerId]);
    if (revokeSessions) await client.query('UPDATE player_sessions SET revoked_at=NOW() WHERE player_id=$1 AND revoked_at IS NULL', [playerId]);
    await client.query(
      `INSERT INTO player_join_tokens(player_id,game_night_id,token_hash,expires_at)
       VALUES($1,$2,$3,NOW()+INTERVAL '24 hours')`,
      [playerId, gameId, sha256(raw)],
    );
    await audit(client, gameId, admin.username, 'generated player join link', 'player', playerId, { revokedSessions: revokeSessions });
    return { path: `/join/${raw}`, version: await incrementGameVersion(client, gameId) };
  }));
});
