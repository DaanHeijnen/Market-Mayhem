import { createHash, createHmac, randomBytes } from 'node:crypto';

export const PLAYER_COOKIE = 'mm_player_session';
export const ADMIN_COOKIE = 'mm_admin_session';

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
