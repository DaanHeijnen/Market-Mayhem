import { pbkdf2Sync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { databaseSql } = vi.hoisted(() => ({
  databaseSql: vi.fn(async () => []),
}));

vi.mock('../netlify/lib/db', () => ({
  database: () => ({ sql: databaseSql }),
}));

import adminLogin from '../netlify/functions/admin-login';

function testHash(password: string) {
  const iterations = 100_000;
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const digest = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `pbkdf2$sha256$${iterations}$${salt.toString('hex')}$${digest.toString('hex')}`;
}

function request(username = 'admin', password = 'correct password') {
  return new Request('https://example.test/api/admin-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

const originalEnvironment = {
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH,
  SESSION_SECRET: process.env.SESSION_SECRET,
  CONTEXT: process.env.CONTEXT,
  NODE_ENV: process.env.NODE_ENV,
};

beforeEach(() => {
  databaseSql.mockClear();
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD_HASH = testHash('correct password');
  process.env.SESSION_SECRET = '12345678901234567890123456789012';
  delete process.env.CONTEXT;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('admin login', () => {
  it('returns 503 when admin credentials are not configured', async () => {
    delete process.env.ADMIN_PASSWORD_HASH;
    const response = await adminLogin(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'Admin credentials are not configured' });
    expect(databaseSql).not.toHaveBeenCalled();
  });

  it('returns 503 when SESSION_SECRET is missing or too short', async () => {
    process.env.SESSION_SECRET = 'too-short';
    const response = await adminLogin(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'Admin session secret is not configured correctly' });
    expect(databaseSql).not.toHaveBeenCalled();
  });

  it('rejects incorrect credentials without creating a session', async () => {
    const response = await adminLogin(request('admin', 'wrong password'));
    expect(response.status).toBe(401);
    expect(databaseSql).not.toHaveBeenCalled();
  });

  it('creates a session and returns a hardened production cookie for correct credentials', async () => {
    const response = await adminLogin(request());
    expect(response.status).toBe(200);
    expect(databaseSql).toHaveBeenCalledTimes(1);
    const cookie = response.headers.get('set-cookie') || '';
    expect(cookie).toContain('mm_admin_session=');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=43200');
    expect(cookie).toContain('Secure');
  });
});
