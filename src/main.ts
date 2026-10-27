import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Store } from './storage/database.js';
import { createControlPlane } from './server.js';
import { ManagerClient, ProjectService } from './projects/service.js';
import { TaskEngine } from './agent/engine.js';
import { loadRepositoryConfigs, repositoryConfigMap } from './automation/repository-config.js';
import { InstallationSync } from './app/installations.js';
import { ExternalService } from './external/service.js';
import { Onboarding } from './onboarding/service.js';
import { IntegrationChecker } from './projects/integrations.js';
import { Quickstart } from './projects/quickstart.js';
import { GitCache } from './agent/git-cache.js';

process.umask(0o077);
const keyFile = process.env.BOT_MASTER_KEY_FILE;
if (!keyFile) throw new Error('BOT_MASTER_KEY_FILE is required');
const databasePath = process.env.BOT_DATABASE_PATH || '/data/control.sqlite';
const store = new Store(databasePath, readFileSync(keyFile));
const tokenFile = process.env.BOT_MANAGER_TOKEN_FILE;
if (!tokenFile) throw new Error('BOT_MANAGER_TOKEN_FILE is required');
const manager=new ManagerClient(process.env.BOT_MANAGER_URL || 'http://manager:8793',readFileSync(tokenFile));
const projects = new ProjectService(store, manager);
// A repository's YAML config is the base for its automation; a policy row saved through the API
// still merges on top. A malformed file stops startup instead of running with a silent default.
const repositoryConfigs = repositoryConfigMap(loadRepositoryConfigs(
  process.env.BOT_REPOSITORY_CONFIG_DIR || resolve(import.meta.dirname, '../config/repositories')));
// Repository mirrors live next to the database on the control plane's own volume.
const gitCache = new GitCache(process.env.BOT_GIT_CACHE_DIR || resolve(dirname(databasePath), 'git-cache'));
const engine=new TaskEngine(store,manager,process.env.BOT_GITHUB_API_URL,gitCache);engine.start();
const external=new ExternalService(store,{githubUrl:process.env.BOT_GITHUB_API_URL,privateHosts:(process.env.BOT_FORWARD_PRIVATE_HOSTS||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean)});external.forwarder.start();
void projects.reconcile();
const timer = setInterval(() => { void projects.reconcile().catch(() => {}); }, 5000);
// Installed repositories are listed on start and every ten minutes; webhook events update them in between.
const installations = new InstallationSync(store, process.env.BOT_GITHUB_API_URL || undefined);
const onboarding = new Onboarding(store, { tunnelFile: process.env.BOT_TUNNEL_TOKEN_FILE, tunnelMetrics: process.env.BOT_TUNNEL_METRICS_URL, githubUrl: process.env.BOT_GITHUB_API_URL });
setTimeout(() => void installations.syncAll(), 5000).unref();
const syncTimer = setInterval(() => void installations.syncAll(), 10 * 60_000);
const integrations = new IntegrationChecker(store, process.env.BOT_GITHUB_API_URL || undefined);
const quickstart = new Quickstart(store, process.env.BOT_GITHUB_API_URL || undefined);
const servers = createControlPlane({ store, staticDirectory: resolve(import.meta.dirname, '../static'),
  secureCookies: process.env.BOT_COOKIE_SECURE === 'true', adminOrigin: process.env.BOT_ADMIN_ORIGIN, projects, engine, repositoryConfigs, installations, external, onboarding, integrations, quickstart,
  imageTag: process.env.BOT_IMAGE_TAG, githubUrl: process.env.BOT_GITHUB_API_URL });
for (const [name, port] of [['webhook', 8791], ['admin', 8792]] as const) {
  const server = servers[name];
  server.on('error', () => { console.error(`${name} listener failed`); process.exit(1); });
  server.listen(port, '0.0.0.0', () => console.log(`${name} listening on ${port}`));
}
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  clearInterval(timer); clearInterval(syncTimer);
  let remaining = 2;
  for (const server of Object.values(servers)) server.close(async () => { if (--remaining === 0) { await Promise.all([engine.close(),external.forwarder.close()]); store.close(); process.exit(0); } });
  setTimeout(() => process.exit(1), 100_000).unref();
});
