import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './storage/database.js';
import { createControlPlane } from './server.js';
import { ManagerClient, ProjectService } from './projects/service.js';

process.umask(0o077);
const keyFile = process.env.BOT_MASTER_KEY_FILE;
if (!keyFile) throw new Error('BOT_MASTER_KEY_FILE is required');
const store = new Store(process.env.BOT_DATABASE_PATH || '/data/control.sqlite', readFileSync(keyFile));
const tokenFile = process.env.BOT_MANAGER_TOKEN_FILE;
if (!tokenFile) throw new Error('BOT_MANAGER_TOKEN_FILE is required');
const projects = new ProjectService(store, new ManagerClient(process.env.BOT_MANAGER_URL || 'http://manager:8793', readFileSync(tokenFile)));
void projects.reconcile();
const timer = setInterval(() => { void projects.reconcile().catch(() => {}); }, 5000);
const servers = createControlPlane({ store, staticDirectory: resolve(import.meta.dirname, '../static'),
  secureCookies: process.env.BOT_COOKIE_SECURE === 'true', adminOrigin: process.env.BOT_ADMIN_ORIGIN, projects });
for (const [name, port] of [['webhook', 8791], ['admin', 8792]] as const) {
  const server = servers[name];
  server.on('error', () => { console.error(`${name} listener failed`); process.exit(1); });
  server.listen(port, '0.0.0.0', () => console.log(`${name} listening on ${port}`));
}
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  clearInterval(timer);
  let remaining = 2;
  for (const server of Object.values(servers)) server.close(() => { if (--remaining === 0) { store.close(); process.exit(0); } });
  setTimeout(() => process.exit(1), 10_000).unref();
});
