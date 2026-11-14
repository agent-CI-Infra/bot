import { modelCatalog } from './models/catalog.js';
import { existsSync, readFileSync } from 'node:fs';
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
import { GateOnboarding } from './projects/gate-onboarding.js';
import { GitCache } from './agent/git-cache.js';
import { PublicBoards } from './public-board/service.js';
import { ReleaseService } from './releases/service.js';
import { ActionsFailures } from './actions/service.js';
import { GitHubLogin } from './identity/github-login.js';
import { GitHubRefresh } from './identity/github-refresh.js';
import { deploymentOrigin, loginCallbackPath } from './onboarding/public-url.js';
import { StallMonitor } from './core/stalls.js';
import { PayloadMigration } from './storage/migration.js';
import { WorkspaceCleanup } from './projects/workspace-cleanup.js';
import { StorageReport } from './app/storage.js';
import { RetentionCleanup } from './storage/retention.js';
import { compactDatabase, IncrementalVacuum } from '../manager/compaction.mjs';
import { commandTimeoutLimit } from './agent/command.js';

process.umask(0o077);
commandTimeoutLimit();
const keyFile = process.env.BOT_MASTER_KEY_FILE;
if (!keyFile) throw new Error('BOT_MASTER_KEY_FILE is required');
const databasePath = process.env.BOT_DATABASE_PATH || '/data/control.sqlite';
// One origin for the console, login, App callbacks and webhooks; the wizard's verified address overrides it for URLs.
const publicOrigin = deploymentOrigin(process.env, message => console.warn(message));
// Once, before the control plane serves (#671): when free pages are most of control.sqlite and the disk has room for a
// copy, the file is rewritten without them. The only rewrite of a large database at start; it logs its progress.
const compaction = await compactDatabase(databasePath, { log: line => console.log('[compaction] ' + line) });
const store = new Store(databasePath, readFileSync(keyFile));
store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'compaction', JSON.stringify(compaction));
// Afterwards the pages later cleanups free go back to the disk in small steps.
const vacuum = new IncrementalVacuum(store.db);
const githubLogin = new GitHubLogin(store, {
  defaultOrigin: publicOrigin, apiUrl: process.env.BOT_GITHUB_API_URL,
  environment: () => process.env.BOT_GITHUB_OAUTH_CLIENT_ID ? {
    clientId: process.env.BOT_GITHUB_OAUTH_CLIENT_ID,
    clientSecret: readFileSync(process.env.BOT_GITHUB_OAUTH_CLIENT_SECRET_FILE || '', 'utf8').trim(),
    redirectUri: (publicOrigin || '') + loginCallbackPath, apiUrl: process.env.BOT_GITHUB_API_URL,
  } : undefined,
});
// Validate deployment defaults at startup; a saved wizard configuration takes precedence.
githubLogin.identity;
// GitHub-derived grants of signed-in principals are checked again every ten minutes (#708); nobody else is sent to GitHub.
const githubRefresh = new GitHubRefresh(store, () => githubLogin.identity); githubRefresh.start();
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
const timer = setInterval(() => { void projects.reconcile().catch(error => console.error('[projects] reconciliation failed:', error)); }, 5000);
// Finished tasks' workspaces leave the project computers: first five minutes after start, then every hour.
const workspaces = new WorkspaceCleanup(store, manager, { skip: id => projects.isRemoving(id) }); workspaces.start();
// Installed repositories are listed on start and every ten minutes; webhook events update them in between.
const installations = new InstallationSync(store, process.env.BOT_GITHUB_API_URL || undefined);
installations.start();
const onboarding = new Onboarding(store, { tunnelFile: process.env.BOT_TUNNEL_TOKEN_FILE, tunnelMetrics: process.env.BOT_TUNNEL_METRICS_URL, githubUrl: process.env.BOT_GITHUB_API_URL });
setTimeout(() => void installations.syncAll(), 5000).unref();
const syncTimer = setInterval(() => void installations.syncAll(), 10 * 60_000);
const boards = new PublicBoards(store, resolve(dirname(databasePath), 'public-boards'), process.env.BOT_GITHUB_API_URL); boards.start();
const integrations = new IntegrationChecker(store, process.env.BOT_GITHUB_API_URL || undefined);
const gateOnboarding = new GateOnboarding(store, process.env.BOT_GITHUB_API_URL || undefined);
const releases = new ReleaseService(store, process.env.BOT_GITHUB_API_URL); releases.start();
const actionsFailures = new ActionsFailures(store, process.env.BOT_GITHUB_API_URL); actionsFailures.start();
// Logs a blocked event loop with the requests in flight, and slow requests (see core/stalls.ts).
const stalls = new StallMonitor(); stalls.start();
// Cleanup by days (#671): daily, from ten minutes after the start.
const retention = new RetentionCleanup(store, manager);
const migration = new PayloadMigration(store), storage = new StorageReport(store, manager, { git_cache: gitCache.root, public_boards: resolve(dirname(databasePath), 'public-boards') }, vacuum);
const { server } = createControlPlane({ store, staticDirectory: resolve(import.meta.dirname, '../static'),
  secureCookies: process.env.BOT_COOKIE_SECURE === 'true', publicOrigin, projects, engine, repositoryConfigs, installations, external, onboarding, integrations, gateOnboarding, releases, boards,
  imageTag: process.env.BOT_IMAGE_TAG, githubUrl: process.env.BOT_GITHUB_API_URL, githubLogin, stalls, storage,
  // The assistant computers' HOME volume (compose.yaml); a control plane without it offers no assistant computer.
  assistantHomes: existsSync(process.env.BOT_ASSISTANT_HOMES || '/assistant-homes') ? process.env.BOT_ASSISTANT_HOMES || '/assistant-homes' : undefined },
  // BOT_TRUSTED_PROXIES: comma-separated proxy addresses/CIDRs allowed to name the password-login client.
  { trustedProxies: (process.env.BOT_TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean) });
// The only business listener: console, API, OAuth, App callbacks, webhooks, external executors and public boards.
server.on('error', () => { console.error('listener failed'); process.exit(1); });
server.listen(8791, '0.0.0.0', () => {
  console.log('listening on 8791');
  // Background work that never delays readiness: close the trajectory files a stopped process left open, then move
  // payloads written before #436 out of their rows, slice by slice.
  const seal = () => store.trajectories.seal().catch(error => console.error('[trajectories] sealing failed:', error));
  void seal().then(() => { if (!stopping) migration.start(); }); setInterval(seal, 10 * 60_000).unref();
  storage.start();modelCatalog(store).start();vacuum.start();retention.start();
});
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  clearInterval(timer); clearInterval(syncTimer); workspaces.close();
  server.close(async () => { await Promise.all([githubRefresh.close(),modelCatalog(store).close(),installations.close(),engine.close(),external.forwarder.close(),releases.close(),boards.close(),actionsFailures.close(),migration.stop(),vacuum.stop(),retention.stop()]); store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 100_000).unref();
});
