import { timingSafeEqual } from 'node:crypto';
import { database } from '../lib/db';
import { body, ok, HttpError } from '../lib/http';
import { randomToken, sessionCookie, sessionDigest, verifyAdminPassword, ADMIN_COOKIE } from '../lib/security';
import { wrap } from './_wrap';

function safeTextEqual(a: string, b: string) {
  const aa = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

export default wrap(async (request) => {
  const payload = await body<any>(request);
  if (typeof payload.username !== 'string' || typeof payload.password !== 'string') {
    throw new HttpError(400, 'username and password must be strings');
  }
  if (payload.username.length > 100 || payload.password.length > 1024) {
    throw new HttpError(400, 'Credentials are too long');
  }

  const expectedUsername = process.env.ADMIN_USERNAME || '';
  const expectedPasswordHash = process.env.ADMIN_PASSWORD_HASH || '';
  if (!expectedUsername || !expectedPasswordHash) {
    console.error('Admin login is missing ADMIN_USERNAME or ADMIN_PASSWORD_HASH');
    throw new HttpError(503, 'Admin credentials are not configured');
  }

  const usernameMatches = safeTextEqual(payload.username, expectedUsername);
  let passwordMatches = false;
  try {
    passwordMatches = await verifyAdminPassword(payload.password, expectedPasswordHash);
  } catch (error) {
    console.error('Unable to verify ADMIN_PASSWORD_HASH', error);
    throw new HttpError(503, 'Admin password hash is not configured correctly');
  }

  if (!usernameMatches || !passwordMatches) {
    throw new HttpError(401, 'Invalid credentials');
  }

  const rawSession = randomToken();
  await database().sql`
    INSERT INTO admin_sessions (username, session_hash, expires_at)
    VALUES (${payload.username}, ${sessionDigest(rawSession)}, NOW() + INTERVAL '12 hours')
  `;

  return ok({ ok: true }, { headers: { 'set-cookie': sessionCookie(ADMIN_COOKIE, rawSession, 43200) } });
});
