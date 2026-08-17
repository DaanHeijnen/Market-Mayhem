import { pbkdf2Sync, randomBytes } from 'node:crypto';
const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run admin:hash -- "your password"');
  process.exit(1);
}
const iterations = 210000;
const salt = randomBytes(16).toString('hex');
const digest = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
console.log(`pbkdf2$sha256$${iterations}$${salt}$${digest}`);
