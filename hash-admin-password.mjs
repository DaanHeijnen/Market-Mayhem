import { pbkdf2Sync, randomBytes } from 'node:crypto';

async function readHidden(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return null;
  }

  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(label);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0008' || char === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    process.stdin.on('data', onData);
  });
}

let password = process.argv[2];

if (!password) {
  try {
    password = await readHidden('New admin password: ');
    if (password === null) {
      console.error('Interactive input is unavailable. Usage: npm run admin:hash -- "your password"');
      process.exit(1);
    }
    const confirmation = await readHidden('Confirm admin password: ');
    if (password !== confirmation) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to read password');
    process.exit(1);
  }
}

if (!password) {
  console.error('Password cannot be empty.');
  process.exit(1);
}

// Current OWASP recommendation for PBKDF2-HMAC-SHA256.
const iterations = 600_000;
const salt = randomBytes(16);
const digest = pbkdf2Sync(password, salt, iterations, 32, 'sha256');

console.log('\nCopy this entire value into Netlify as ADMIN_PASSWORD_HASH:\n');
console.log(`pbkdf2$sha256$${iterations}$${salt.toString('hex')}$${digest.toString('hex')}`);
