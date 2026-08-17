import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http';

export const PLAYER_COOKIE = 'mm_player_session';
export const ADMIN_COOKIE = 'mm_admin_session';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function parseCookies(request: Request) {
  const header = request.headers.get('cookie') || '';
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key && rest.length) result[key] = decodeURIComponent(rest.join('='));
  }
  return result;
}

export function sessionCookie(name: string, value: string, maxAgeSeconds: number) {
  const secure = process.env.CONTEXT === 'production' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearCookie(name: string) {
  const secure = process.env.CONTEXT === 'production' ? '; Secure' : '';
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function verifyPassword(password: string, encoded: string) {
  const [scheme, algorithm, iterationRaw, salt, expectedHex] = encoded.split('$');
  if (scheme !== 'pbkdf2' || algorithm !== 'sha256' || !iterationRaw || !salt || !expectedHex) return false;
  const iterations = Number(iterationRaw);
  if (!Number.isInteger(iterations) || iterations < 100_000) return false;
  const actual = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function assertSessionSecret() {
  const value = process.env.SESSION_SECRET || '';
  if (value.length < 32) throw new HttpError(500, 'SESSION_SECRET must contain at least 32 characters');
}
