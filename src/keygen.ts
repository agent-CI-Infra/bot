import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

process.umask(0o077);
const path = process.argv[2];
if (!path) throw new Error('key file argument required');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
if (readFileSync(path).length !== 32) throw new Error('invalid existing key file');
console.log('Encryption key is ready');
