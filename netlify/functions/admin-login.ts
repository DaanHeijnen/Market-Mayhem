import { timingSafeEqual } from 'node:crypto';
import { database } from '../lib/db';
import { body, ok, HttpError } from '../lib/http';
import {
  randomToken,
  sessionCookie,
  sha256,
  verifyPassword,
  ADMIN_COOKIE,
} from '../lib/security';
import { wrap } from './_wrap';

function safeTextEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');

  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

export default wrap(async (request) => {
  const payload = await body<any>(request);
  if (typeof payload.username !== 'string' || typeof payload.password !== 'string') {
    throw new HttpError(400, 'username and password must be strings');
  }
  const username = payload.username;
  const password = payload.password;
  if (username.length > 100 || password.length > 1024) throw new HttpError(400, 'Credentials are too long');

  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
  const plainPassword = process.env.ADMIN_PASSWORD || '';
  const passwordHash = process.env.ADMIN_PASSWORD_HASH || '';

  const passwordMatches = plainPassword
    ? safeTextEqual(password, plainPassword)
    : passwordHash
      ? verifyPassword(password, passwordHash)
      : false;

  if (username !== expectedUsername || !passwordMatches) {
    throw new HttpError(401, 'Invalid credentials');
  }

  const rawSession = randomToken();

  await database().sql`
    INSERT INTO admin_sessions (username, session_hash, expires_at)
    VALUES (${username}, ${sha256(rawSession)}, NOW() + INTERVAL '12 hours')
  `;

  return ok(
    { ok: true },
    {
      headers: {
        'set-cookie': sessionCookie(ADMIN_COOKIE, rawSession, 43200),
      },
    },
  );
});
