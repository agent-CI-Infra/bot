import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

process.umask(0o077);
const paths = process.argv.slice(2);
if (!paths.length) throw new Error('key file argument required');
for (const [index, path] of paths.entries()) {
  const internal = index > 0;
  mkdirSync(dirname(path), { recursive: true, mode: internal ? 0o750 : 0o700 });
  chmodSync(dirname(path), internal ? 0o750 : 0o700);
  try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: internal ? 0o640 : 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  chmodSync(path, internal ? 0o640 : 0o600);
  if (readFileSync(path).length !== 32) throw new Error('invalid existing key file');
}
console.log('Encryption key is ready');
