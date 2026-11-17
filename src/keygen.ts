import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { computerResultOwner } from '../runner/result-owner.mjs';
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

// Prepare persisted projects before manager recovery: Docker's volume subpath must exist even on the first upgrade.
if (process.env.BOT_TOOL_RESULTS_DIR) {
  const root = process.env.BOT_TOOL_RESULTS_DIR;
  mkdirSync(root, { recursive: true, mode: 0o755 }); chmodSync(root, 0o755);
  const path = process.env.BOT_DATABASE_PATH;
  if (path && existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='repositories'").get())
        for (const row of db.prepare('SELECT id FROM repositories').all()) {
          const directory = join(root,computerResultOwner('project',row.id));
          mkdirSync(directory, { recursive: true, mode: 0o755 }); chmodSync(directory, 0o755);
        }
    } finally { db.close(); }
  }
}
