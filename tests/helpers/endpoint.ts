import { createHmac } from 'node:crypto';
import type { TestDb } from './pglite';

/**
 * Driving a Netlify Function against a real database.
 *
 * The rules can be tested pure and the tables can be tested with SQL, but neither answers
 * the question that matters for an endpoint: does *this handler* refuse what it should.
 * "The server rejects an upload after the deadline" is not a property of a pure function —
 * it is a property of the request path, including its auth, its transaction and the order
 * it checks things in.
 *
 * So these helpers give a test the two things a handler needs: a `database()` that talks to
 * PGlite, and a signed cookie that `requireAdmin`/`requirePlayer` will accept.
 */

export const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-chars-long';

/**
 * The tagged-template `sql` the auth helpers use, over PGlite.
 *
 * Neon's driver takes a template literal; pg takes a string and parameters. This is the
 * bridge, and it parameterises rather than interpolating — a test helper that built SQL by
 * string concatenation would be teaching the wrong shape.
 */
export function sqlTag(db: TestDb) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
    const { rows } = await db.query(text, values);
    return rows;
  };
}

/** A signed admin session for `requireAdmin`, written into the database it reads. */
export async function adminCookie(db: TestDb, username = 'admin') {
  const raw = `admin-${Math.random().toString(36).slice(2)}`;
  const hash = createHmac('sha256', TEST_SESSION_SECRET).update(raw).digest('hex');
  await db.query(
    `INSERT INTO admin_sessions(username,session_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour')`,
    [username, hash],
  );
  return `mm_admin_session=${raw}`;
}

/** A signed player session for `requirePlayer`. */
export async function playerCookie(db: TestDb, gameId: number, playerId: number) {
  const raw = `player-${Math.random().toString(36).slice(2)}`;
  const hash = createHmac('sha256', TEST_SESSION_SECRET).update(raw).digest('hex');
  await db.query(
    `INSERT INTO player_sessions(player_id,game_night_id,session_hash,expires_at)
     VALUES($1,$2,$3,NOW()+INTERVAL '1 hour')`,
    [playerId, gameId, hash],
  );
  return `mm_player_session=${raw}`;
}

export function jsonRequest(path: string, body: Record<string, unknown>, cookie: string) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

/** A multipart upload, with a real (tiny) PNG so the media checks have something to read. */
export function uploadRequest(path: string, fields: Record<string, string>, cookie: string, file?: File) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('file', file ?? tinyPng());
  return new Request(`https://example.test${path}`, { method: 'POST', headers: { cookie }, body: form });
}

/** The smallest valid PNG, so `assertAcceptableMedia` sees a real image. */
export function tinyPng(name = 'photo.png') {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  return new File([Buffer.from(base64, 'base64')], name, { type: 'image/png' });
}

export async function readJson(response: Response) {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as any };
  } catch {
    return { status: response.status, body: { raw: text } as any };
  }
}
