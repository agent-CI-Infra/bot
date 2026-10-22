import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './storage/database.js';
import { createControlPlane } from './server.js';

process.umask(0o077);
const keyFile = process.env.BOT_MASTER_KEY_FILE;
if (!keyFile) throw new Error('BOT_MASTER_KEY_FILE is required');
const store = new Store(process.env.BOT_DATABASE_PATH || '/data/control.sqlite', readFileSync(keyFile));
const servers = createControlPlane({ store, staticDirectory: resolve(import.meta.dirname, '../static'),
  secureCookies: process.env.BOT_COOKIE_SECURE === 'true', adminOrigin: process.env.BOT_ADMIN_ORIGIN });
for (const [name, port] of [['webhook', 8791], ['admin', 8792]] as const) {
  const server = servers[name];
  server.on('error', () => { console.error(`${name} listener failed`); process.exit(1); });
  server.listen(port, '0.0.0.0', () => console.log(`${name} listening on ${port}`));
}
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  let remaining = 2;
  for (const server of Object.values(servers)) server.close(() => { if (--remaining === 0) { store.close(); process.exit(0); } });
  setTimeout(() => process.exit(1), 10_000).unref();
});
