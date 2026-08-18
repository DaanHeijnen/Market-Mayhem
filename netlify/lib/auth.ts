import type { PoolClient } from 'pg';
import { database } from './db';
import { HttpError } from './http';
import { ADMIN_COOKIE, PLAYER_COOKIE, parseCookies, sessionDigest } from './security';

export interface PlayerSession {
  playerId: number;
  gameId: number;
  displayName: string;
}

export interface AdminSession {
  username: string;
}

export async function requirePlayer(request: Request, gameId?: number): Promise<PlayerSession> {
  const raw = parseCookies(request)[PLAYER_COOKIE];
  if (!raw) throw new HttpError(401, 'Player session required');
  const hash = sessionDigest(raw);
  const rows = await database().sql<{ player_id: number; game_night_id: number; display_name: string }>`
    SELECT s.player_id, s.game_night_id, p.display_name
    FROM player_sessions s
    JOIN players p ON p.id = s.player_id
    WHERE s.session_hash = ${hash}
      AND s.revoked_at IS NULL
      AND s.expires_at > NOW()
      AND p.active = TRUE
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new HttpError(401, 'Player session expired');
  if (gameId !== undefined && Number(row.game_night_id) !== gameId) throw new HttpError(403, 'Session does not belong to this game');
  return { playerId: Number(row.player_id), gameId: Number(row.game_night_id), displayName: row.display_name };
}

export async function requireAdmin(request: Request): Promise<AdminSession> {
  const raw = parseCookies(request)[ADMIN_COOKIE];
  if (!raw) throw new HttpError(401, 'Admin session required');
  const hash = sessionDigest(raw);
  const rows = await database().sql<{ username: string }>`
    SELECT username
    FROM admin_sessions
    WHERE session_hash = ${hash}
      AND revoked_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `;
  if (!rows[0]) throw new HttpError(401, 'Admin session expired');
  return { username: rows[0].username };
}

export async function audit(client: PoolClient, gameId: number, actor: string, action: string, entityType?: string, entityId?: number, metadata: unknown = {}) {
  await client.query(
    `INSERT INTO admin_audit_log (game_night_id, actor, action, entity_type, entity_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [gameId, actor, action, entityType || null, entityId || null, JSON.stringify(metadata)]
  );
}
