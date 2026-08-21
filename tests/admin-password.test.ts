import { describe, expect, it } from 'vitest';
import { pbkdf2Sync } from 'node:crypto';
import { verifyAdminPassword } from '../netlify/lib/security';

function testHash(password: string) {
  const iterations = 100_000;
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const digest = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `pbkdf2$sha256$${iterations}$${salt.toString('hex')}$${digest.toString('hex')}`;
}

describe('admin password hashes', () => {
  it('accepts the original password and rejects a wrong password', async () => {
    const hash = testHash('correct horse battery staple');
    await expect(verifyAdminPassword('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyAdminPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('rejects malformed or unsupported hashes', async () => {
    await expect(verifyAdminPassword('password', '$2b$12$not-a-supported-bcrypt-hash')).resolves.toBe(false);
    await expect(verifyAdminPassword('password', 'pbkdf2$sha256$1$00$00')).resolves.toBe(false);
  });
});
