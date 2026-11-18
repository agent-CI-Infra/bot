import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// One acceptance run keeps its files in one directory (ACCEPTANCE_STATE_DIR, default .tmp/bot-acceptance):
//   target.json    what is under test, no secrets; the test AI reads it
//   admin.json     the super administrator bootstrap created; only bootstrap and evidence use it
//   operator.json  the project administrator the test AI acts as, through console.mjs
//   *.session.json cached console sessions
// Credential files are written 0600 and their contents are never printed.
export function stateDir(env = process.env) {
  const dir = resolve(env.ACCEPTANCE_STATE_DIR || '.tmp/bot-acceptance');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function readJson(dir, name) { return JSON.parse(readFileSync(join(dir, name), 'utf8')); }
export function readOptional(dir, name) { try { return readJson(dir, name); } catch { return null; } }
export function writeJson(dir, name, value, { secret = false } = {}) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(path, 0o600);
  return path;
}
