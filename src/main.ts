import { modelCatalog } from './models/catalog.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Store } from './storage/database.js';
import { createControlPlane } from './server.js';
import { ManagerClient, ProjectService, startProjectRuntime } from './projects/service.js';
import { DEFAULT_PROJECT_TOOLS_ROOT, ProjectToolsService } from './projects/tools.js';
import { NotesReclaimer } from './projects/reclaim.js';
import { TaskEngine } from './agent/engine.js';
import { InstallationSync } from './app/installations.js';
import { ExternalService } from './external/service.js';
import { Onboarding } from './onboarding/service.js';
import { IntegrationChecker } from './projects/integrations.js';
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
import { AgentToolManager, AgentToolsAutoInstaller, DEFAULT_AGENT_TOOLS_ROOT } from './harness/agent-tools.js';
import { agentToolsRetainCount } from './app/agent-tools.js';
import { activeCliVersions } from './roles/role-run.js';
import { ensureServiceSkillScope, resolveSkillStoreRoot } from './roles/skill-store.js';
import { migrateLegacyProjectMemories } from './memory/migration.js';
import { startModelGatewayServer } from './harness/model-gateway.js';

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
// Repository collaborator and installation owner caches are refreshed every ten minutes (#1158), decoupled from user count.
const githubRefresh = new GitHubRefresh(store, () => githubLogin.identity, { apiUrl: process.env.BOT_GITHUB_API_URL }); githubRefresh.start();
const tokenFile = process.env.BOT_MANAGER_TOKEN_FILE;
if (!tokenFile) throw new Error('BOT_MANAGER_TOKEN_FILE is required');
const manager=new ManagerClient(process.env.BOT_MANAGER_URL || 'http://manager:8793',readFileSync(tokenFile));
const projects = new ProjectService(store, manager);
// Repository mirrors live next to the database on the control plane's own volume.
const gitCache = new GitCache(process.env.BOT_GIT_CACHE_DIR || resolve(dirname(databasePath), 'git-cache'));
const engine=new TaskEngine(store,manager,process.env.BOT_GITHUB_API_URL,gitCache);
// A count read from the environment, or the default when unset; a value that is not a positive integer stops startup
// instead of turning into NaN, which would make a threshold that never fires (#771).
const count = (name: string, fallback: number, min = 1): number => {
  const raw = process.env[name]; if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) { console.error(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`); process.exit(1); }
  return value;
};
const patrolIntervalMs = (() => {
  const value = count('BOT_PR_PATROL_INTERVAL_MS', 6 * 60 * 60 * 1000, 0);
  if (value > 0 && value < 60_000) { console.error(`BOT_PR_PATROL_INTERVAL_MS must be 0 or >= 60000, got ${value}`); process.exit(1); }
  return value;
})();
const patrolCooldownMs = count('BOT_PR_PATROL_COOLDOWN_MS', 24 * 60 * 60 * 1000, 60_000);
// Tasks in 待处理 that nobody needs to act on any more leave it in small batches (#713).
engine.obsolete.start();
engine.botPrWake.start(60_000, { intervalMs: patrolIntervalMs, cooldownMs: patrolCooldownMs });
const external=new ExternalService(store,{githubUrl:process.env.BOT_GITHUB_API_URL,privateHosts:(process.env.BOT_FORWARD_PRIVATE_HOSTS||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean)});external.forwarder.start();
// Fail closed on saved project_environments before starting TaskEngine immediately, then reconcile in the background
// so slow pending operations never delay engine startup and manager_not_ready never clears the startup gate.
void startProjectRuntime(projects, engine);
const timer = setInterval(() => { void projects.reconcile().catch(error => console.error('[projects] reconciliation failed:', error)); }, 5000);
// A deletion that could not delete its notes volume is retried with backoff; what stays behind fails `/readyz` (#771).
const reclaimer = new NotesReclaimer(store, projects, {
  maxAttempts: count('BOT_NOTES_RECLAIM_ATTEMPTS', 6),
  baseDelayMs: count('BOT_NOTES_RECLAIM_DELAY_MS', 60_000),
});
const reclaimTimer = setInterval(() => void reclaimer.sweep().catch(error => console.error('[reclaim] sweep failed:', error)), 5 * 60_000);
void reclaimer.sweep().catch(error => console.error('[reclaim] first sweep failed:', error));
// Finished tasks' workspaces leave the project computers: first five minutes after start, then every hour.
const workspaces = new WorkspaceCleanup(store, manager, { skip: id => projects.isRemoving(id) }); workspaces.start();
// Installed repositories are listed on start and every ten minutes; webhook events update them in between.
const installations = new InstallationSync(store, process.env.BOT_GITHUB_API_URL || undefined);
installations.onSynced = () => { void githubRefresh.run().catch(error => console.error('[github-refresh] post-sync failed:', error)); };
installations.start();
const onboarding = new Onboarding(store, { tunnelFile: process.env.BOT_TUNNEL_TOKEN_FILE, tunnelMetrics: process.env.BOT_TUNNEL_METRICS_URL, githubUrl: process.env.BOT_GITHUB_API_URL });
setTimeout(() => void installations.syncAll(), 5000).unref();
const syncTimer = setInterval(() => void installations.syncAll(), 10 * 60_000);
const boards = new PublicBoards(store, resolve(dirname(databasePath), 'public-boards'), process.env.BOT_GITHUB_API_URL); boards.start();
const integrations = new IntegrationChecker(store, process.env.BOT_GITHUB_API_URL || undefined);
const releases = new ReleaseService(store, process.env.BOT_GITHUB_API_URL); releases.start();
const actionsFailures = new ActionsFailures(store, process.env.BOT_GITHUB_API_URL); actionsFailures.start();
// Logs a blocked event loop with the requests in flight, and slow requests (see core/stalls.ts).
const stalls = new StallMonitor(); stalls.start();
// Cleanup by days (#671): daily, from ten minutes after the start.
// Entries whose file is gone are swept, so a cleanup interrupted between its rows and its files cannot leave a row the
// reader reports as a truncated file (#787). Ten minutes is the same cadence as the installation sync.
const trajectorySweep = setInterval(() => {
  try { store.trajectories.sweepOrphans(); } catch (error) { console.error('[trajectories] orphan sweep failed:', error); }
}, 10 * 60_000);
trajectorySweep.unref?.();
try { store.trajectories.sweepOrphans(); } catch (error) { console.error('[trajectories] first orphan sweep failed:', error); }
const retention = new RetentionCleanup(store, manager);
const projectToolsRoot = process.env.BOT_PROJECT_TOOLS_DIR || DEFAULT_PROJECT_TOOLS_ROOT;
const projectTools = new ProjectToolsService(store, {
  root: existsSync(projectToolsRoot) ? projectToolsRoot : undefined,
  manager,
  reconcile: () => { void projects.reconcile().catch(() => {}); },
});
const skillStoreRoot = resolveSkillStoreRoot(store);
if (skillStoreRoot) {
  try { ensureServiceSkillScope(skillStoreRoot); }
  catch (error) { console.error('[skill-store] initializing service scope failed:', error); }
}
const migration = new PayloadMigration(store), storage = new StorageReport(store, manager, { git_cache: gitCache.root, public_boards: resolve(dirname(databasePath), 'public-boards'),
  homes: process.env.BOT_ASSISTANT_HOMES || '/assistant-homes', tools: '/opt/agent-tools', project_tools: projectToolsRoot, ...(skillStoreRoot ? { skill_store: skillStoreRoot } : {}), machine: process.env.BOT_HOST_STORAGE_DIR }, vacuum, retention, workspaces);
const agentTools = new AgentToolManager({
  volumeRoot: process.env.BOT_AGENT_TOOLS_DIR || DEFAULT_AGENT_TOOLS_ROOT,
  protectedVersions: cli => activeCliVersions(store, cli),
  acpBuilder: async req => {
    await manager.call('POST', '/v1/agent-tools/install-acp', {
      product: req.product,
      version: req.version,
      source_dir: req.containerSourceDir,
      uv_bin: req.containerUvBin,
      offline: Boolean(req.offline),
    }, 20 * 60_000);
  },
});
const agentToolsAuto = new AgentToolsAutoInstaller(agentTools, {
  retainCount: () => agentToolsRetainCount(store),
  protectedVersions: cli => activeCliVersions(store, cli),
  onInstalled: (product, version) => {
    store.audit('system', 'agent_tools.auto_installed', `${product}@${version}`);
    console.log(`[agent-tools] auto-installed ${product}@${version}`);
  },
  onFailed: (product, version, error) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[agent-tools] auto-install failed for ${product}@${version}: ${reason}`);
  },
});
const { server } = createControlPlane({ store, staticDirectory: resolve(import.meta.dirname, '../static'),
  secureCookies: process.env.BOT_COOKIE_SECURE === 'true', publicOrigin, projects, engine, installations, external, onboarding, integrations, releases, boards,
  imageTag: process.env.BOT_IMAGE_TAG, githubUrl: process.env.BOT_GITHUB_API_URL, githubLogin, stalls, storage, agentTools, projectTools,
  // The thresholds are configuration, not magic numbers: who operates the deployment sets what it tolerates (#771).
  notesReclaimer: reclaimer,
  notesOrphanThreshold: count('BOT_NOTES_ORPHAN_THRESHOLD', 10),
  notesOrphanMaxAgeMs: count('BOT_NOTES_ORPHAN_MAX_AGE_MS', 7 * 24 * 3600_000, 1000),
  notesOrphanWarnAgeMs: count('BOT_NOTES_ORPHAN_WARN_AGE_MS', 24 * 3600_000, 1000),
  // The assistant computers' HOME volume (compose.yaml); a control plane without it offers no assistant computer.
  assistantHomes: existsSync(process.env.BOT_ASSISTANT_HOMES || '/assistant-homes') ? process.env.BOT_ASSISTANT_HOMES || '/assistant-homes' : undefined },
  // BOT_TRUSTED_PROXIES: comma-separated proxy addresses/CIDRs allowed to name the password-login client.
  { trustedProxies: (process.env.BOT_TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean) });
// Dedicated UDS passthrough model gateway for project and assistant computers (mounted read-only at /run/model-gateway).
const modelGatewaySocket = process.env.BOT_MODEL_GATEWAY_SOCKET;
const modelGatewayServer = modelGatewaySocket ? await startModelGatewayServer(modelGatewaySocket) : null;
if (modelGatewayServer) console.log(`model gateway listening on ${modelGatewayServer.socketPath}`);
// The only business listener: console, API, OAuth, App callbacks, webhooks, external executors and public boards.
server.on('error', () => { console.error('listener failed'); process.exit(1); });
server.listen(8791, '0.0.0.0', () => {
  console.log('listening on 8791');
  // Background work that never delays readiness: close the trajectory files a stopped process left open, then move
  // payloads written before #436 out of their rows, slice by slice.
  const seal = () => store.trajectories.seal().catch(error => console.error('[trajectories] sealing failed:', error));
  void seal().then(() => { if (!stopping) migration.start(); }); setInterval(seal, 10 * 60_000).unref();
  let migrationAttempts = 0;
  const runLegacyMemoryMigration = () => migrateLegacyProjectMemories(store, manager).then(res => {
    if (res.migrated || res.failed) console.log(`[memory] legacy migration: migrated=${res.migrated} skipped=${res.skipped} failed=${res.failed}`);
    if (res.failed && !stopping && ++migrationAttempts < 10) setTimeout(() => { if (!stopping) void runLegacyMemoryMigration(); }, 30_000).unref();
  }).catch(error => console.error('[memory] legacy migration failed:', error));
  void runLegacyMemoryMigration();
  storage.start();modelCatalog(store).start();vacuum.start();retention.start();agentToolsAuto.start();projectTools.start();
});
// Bound HTTP draining and shutdown below compose.yaml stop_grace_period (100s) so deployments never hit Docker SIGKILL.
const shutdownDrainMs = 5_000, shutdownLimitMs = 80_000;
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  clearInterval(timer); clearInterval(syncTimer); clearInterval(trajectorySweep); clearInterval(reclaimTimer); stalls.stop(); workspaces.close(); engine.obsolete.close();
  const forceExit = setTimeout(() => { console.error('[bot] shutdown timed out before stop_grace_period, exiting'); process.exit(1); }, shutdownLimitMs);
  forceExit.unref?.();
  const forceConnections = setTimeout(() => server.closeAllConnections?.(), shutdownDrainMs);
  forceConnections.unref?.();
  server.close(async () => {
    clearTimeout(forceConnections);
    const settled = await Promise.allSettled([modelGatewayServer?.close(), projectTools.stop(), agentToolsAuto.stop(), storage.stop(), githubRefresh.close(), modelCatalog(store).close(), installations.close(), engine.close(), external.forwarder.close(), releases.close(), boards.close(), actionsFailures.close(), migration.stop(), vacuum.stop(), retention.stop()]);
    for (const entry of settled) if (entry.status === 'rejected') console.error('[bot] shutdown step failed:', entry.reason);
    try { store.close(); } catch (error) { console.error('[bot] store close failed:', error); }
    clearTimeout(forceExit);
    process.exit(0);
  });
  server.closeIdleConnections?.();
});
