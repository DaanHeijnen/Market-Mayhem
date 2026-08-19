import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';

export const PLAYER_COOKIE = 'mm_player_session';
export const ADMIN_COOKIE = 'mm_admin_session';

const ADMIN_PASSWORD_ALGORITHM = 'pbkdf2';
const ADMIN_PASSWORD_DIGEST = 'sha256';
const MIN_PBKDF2_ITERATIONS = 100_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function sessionDigest(value: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be configured with at least 32 characters');
  }
  return createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * Verifies hashes produced by scripts/hash-admin-password.mjs.
 * Format: pbkdf2$sha256$<iterations>$<saltHex>$<digestHex>
 */
export async function verifyAdminPassword(password: string, storedHash: string) {
  const parts = storedHash.split('$');
  if (parts.length !== 5) return false;

  const [algorithm, digestName, iterationsText, saltHex, digestHex] = parts;
  if (algorithm !== ADMIN_PASSWORD_ALGORITHM || digestName !== ADMIN_PASSWORD_DIGEST) return false;

  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) return false;
  if (!/^[0-9a-f]+$/i.test(saltHex) || saltHex.length < 32 || saltHex.length % 2 !== 0) return false;
  if (!/^[0-9a-f]+$/i.test(digestHex) || digestHex.length < 64 || digestHex.length % 2 !== 0) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(digestHex, 'hex');

  const actual = await new Promise<Buffer>((resolve, reject) => {
    pbkdf2(password, salt, iterations, expected.length, ADMIN_PASSWORD_DIGEST, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });

  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
  const isLocalDevelopment = process.env.CONTEXT === 'dev' || process.env.NODE_ENV === 'development';
  const secure = isLocalDevelopment ? '' : '; Secure';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
