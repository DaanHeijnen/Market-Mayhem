import { withTransaction } from '../lib/db';
import { body, HttpError, ok, textValue } from '../lib/http';
import { PLAYER_COOKIE, randomToken, sessionCookie, sessionDigest, sha256 } from '../lib/security';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const payload = await body<any>(request);
  const token = textValue(payload.token, 'token', 500);
  const tokenHash = sha256(token);
  const rawSession = randomToken();

  const joined = await withTransaction(async (client) => {
    // Resolve the token first without taking a lock. Once its game is known,
    // serialize on game -> player -> token, matching player-management writes.
    const candidateResult = await client.query(
      `SELECT id, player_id, game_night_id
       FROM player_join_tokens
       WHERE token_hash = $1`,
      [tokenHash],
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) throw new HttpError(400, 'Join link is invalid or expired');

    const gameResult = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [candidate.game_night_id]);
    if (!gameResult.rows[0]) throw new HttpError(400, 'Join link is invalid or expired');

    const playerResult = await client.query(
      `SELECT active
       FROM players
       WHERE id = $1 AND game_night_id = $2
       FOR UPDATE`,
      [candidate.player_id, candidate.game_night_id],
    );
    if (!playerResult.rows[0]?.active) {
      throw new HttpError(400, 'Join link is invalid or expired');
    }

    const tokenResult = await client.query(
      `SELECT id, player_id, game_night_id
       FROM player_join_tokens
       WHERE id = $1
         AND token_hash = $2
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > NOW()
       FOR UPDATE`,
      [candidate.id, tokenHash],
    );
    const row = tokenResult.rows[0];
    if (!row) throw new HttpError(400, 'Join link is invalid or expired');

    await client.query('UPDATE player_join_tokens SET used_at = NOW() WHERE id = $1', [row.id]);
    await client.query(
      `INSERT INTO player_sessions(player_id, game_night_id, session_hash, expires_at)
       VALUES($1, $2, $3, NOW() + INTERVAL '30 days')`,
      [row.player_id, row.game_night_id, sessionDigest(rawSession)],
    );
    await incrementGameVersion(client, Number(row.game_night_id));

    return row;
  });

  return ok(
    { gameId: Number(joined.game_night_id) },
    { headers: { 'set-cookie': sessionCookie(PLAYER_COOKIE, rawSession, 2592000) } },
  );
});
