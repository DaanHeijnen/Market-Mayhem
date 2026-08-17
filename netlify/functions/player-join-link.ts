import { requireAdmin } from '../lib/auth';
import { database } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { randomToken, sha256 } from '../lib/security';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const playerId = intValue(payload.playerId, 'playerId', { min: 1 });
  const pool = database().pool;
  const player = await pool.query('SELECT id FROM players WHERE id=$1 AND game_night_id=$2 AND active=TRUE', [playerId, gameId]);
  if (!player.rows[0]) throw new HttpError(404, 'Active player not found');
  const raw = randomToken();
  await pool.query('UPDATE player_join_tokens SET revoked_at=NOW() WHERE player_id=$1 AND used_at IS NULL AND revoked_at IS NULL', [playerId]);
  await pool.query(
    `INSERT INTO player_join_tokens(player_id,game_night_id,token_hash,expires_at)
     VALUES($1,$2,$3,NOW()+INTERVAL '24 hours')`,
    [playerId, gameId, sha256(raw)],
  );
  return ok({ path: `/join/${raw}` });
});
