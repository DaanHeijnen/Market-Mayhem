import { timingSafeEqual } from 'node:crypto';
import { database } from '../lib/db';
import { body, ok, HttpError } from '../lib/http';
import {
  randomToken,
  sessionCookie,
  sha256,
  verifyPassword,
  ADMIN_COOKIE,
  assertSessionSecret,
} from '../lib/security';
import { wrap } from './_wrap';

function safeTextEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');

  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

export default wrap(async (request) => {
  assertSessionSecret();

  const payload = await body<any>(request);
  const username = String(payload.username || '');
  const password = String(payload.password || '');

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
