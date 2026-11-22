import { storageFootprint, managerLocations } from './storage-footprint.mjs';
import { computerResultOwner } from '../runner/result-owner.mjs';
import { lstat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { ManagerError } from './docker.mjs';
import { collectDockerUsage, readDockerContainers, readDockerVolumes } from './docker-usage.mjs';
import { Notes, noteName } from '../runner/notes.mjs';
import { FileTree } from './file-tree.mjs';
import { validNoteId } from '../runner/note-catalog.mjs';
import { LedgerMigration, Trajectories, TrajectoryExpiry, inputHeader, trajectoryStorage } from './trajectories.mjs';
import { DiskGuard } from './disk.mjs';
import { IncrementalVacuum } from './compaction.mjs';
import { isCleanupCall, validateCall } from './project-runner-calls.mjs';
import { sanitizeAgentPollTrajectory } from '../runner/image-budget.mjs';
import { PrecompiledImageBuilder, reservedEnv, normalizePackages, normalizeScript, computeImageKey } from './precompiled-images.mjs';

export { validateCall };

const randomId = () => randomBytes(24).toString('hex');
// One line on stderr per failure that changes a computer's state, so `docker compose logs manager` says why it happened.
export function logFailure(what, error) {
  const reason = error instanceof ManagerError ? error.message + (error.detail ? ` (${error.detail})` : '') : error?.stack || String(error);
  console.error(`[manager] ${what}: ${reason}`);
}
// Default project computer spec and the bounds the manager enforces; callers can only choose values inside them.
// The resource values are the built-in defaults: a super administrator replaces them in the global settings, and every
// resource a project does not set itself follows the current default.
const builtin = { cpus: 2, memory_mb: 4096, pids: 1024, tmp_mb: 1024 };
const defaults = { ...builtin, packages: [], env: {}, setup_script: '' };
export const resourceBounds = { cpus: [0.25, 16], memory_mb: [256, 65536], pids: [64, 16384], tmp_mb: [16, 16384] };
const bounds = resourceBounds;
const resourceKeys = Object.keys(bounds), resources = spec => Object.fromEntries(resourceKeys.map(key => [key, spec[key]]));
const mib = 1024 * 1024;
// CPUs in steps of 0.01, the other resources whole numbers, all inside their bounds (assistant computers pass their own).
export function validResource(key, value, limits = bounds) {
  const [min, max] = limits[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (key === 'cpus' ? Math.round(value * 100) === value * 100 : Number.isInteger(value));
}
// Debian package names only (no options, files or URLs); environment names that the computer or runner own (or that can
// dynamically inject code into the runner) are refused.
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,99}(?::[a-z0-9-]{1,20})?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export { reservedEnv };
function validateSoftwareFields(input) {
  if (input.packages !== undefined && (!Array.isArray(input.packages) || input.packages.length > 100 || new Set(input.packages).size !== input.packages.length
    || input.packages.some(name => typeof name !== 'string' || !PACKAGE_NAME.test(name)))) throw new ManagerError('invalid_packages', 400);
  if (input.env !== undefined && (!input.env || typeof input.env !== 'object' || Array.isArray(input.env) || Object.keys(input.env).length > 64
    || Object.entries(input.env).some(([name, value]) => !ENV_NAME.test(name) || reservedEnv.has(name) || /^(BOT_|GIT_)/.test(name)
      || typeof value !== 'string' || value.length > 4096 || value.includes('\0')))) throw new ManagerError('invalid_env', 400);
  if (input.setup_script !== undefined && (typeof input.setup_script !== 'string' || input.setup_script.length > 16384 || input.setup_script.includes('\0'))) throw new ManagerError('invalid_setup_script', 400);
}
export function validateSpec(input) {
  const keys = ['egress', 'packages', 'env', 'setup_script', 'rerun_setup', 'rebuild', ...Object.keys(bounds)];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new ManagerError('invalid_spec', 400);
  // null clears the project's own value, so the resource follows the default again.
  for (const key of resourceKeys) if (input[key] != null && !validResource(key, input[key])) throw new ManagerError('invalid_spec', 400);
  for (const key of ['egress', 'rerun_setup', 'rebuild']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ManagerError('invalid_spec', 400);
  validateSoftwareFields(input);
  return input;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const commandTypes = ['command', 'workspace_command'];
export const parallelBounds = [1, 32];
const RUN_TOKEN_PATTERN = /\brrt_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}\b/g;
function sanitizeTrajectoryValue(value) {
  if (typeof value === 'string') return value.includes('rrt_') ? value.replace(RUN_TOKEN_PATTERN, '[redacted:run_token]') : value;
  if (Array.isArray(value)) return value.map(sanitizeTrajectoryValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key === 'run_token' || key === 'token') && typeof entry === 'string' && entry.length > 0) out[key] = '[redacted]';
    else out[key] = sanitizeTrajectoryValue(entry);
  }
  return out;
}
export function sanitizeTrajectoryInput(input) {
  if (input?.request && ['workspace_harness_config', 'workspace_agent_token', 'workspace_agent_config', 'workspace_agent_tool'].includes(input.request.type) && typeof input.request.base64 === 'string') {
    return sanitizeTrajectoryValue({ ...input, request: { ...input.request, base64: '[redacted]' } });
  }
  return sanitizeTrajectoryValue(input);
}
export function sanitizeTrajectoryResult(type, result) {
  if (type === 'workspace_agent_poll' || type === 'workspace_harness_poll') return sanitizeAgentPollTrajectory(sanitizeTrajectoryValue(result));
  if ((type === 'workspace_agent_request' || type === 'workspace_agent_model_request') && result && typeof result === 'object' && typeof result.base64 === 'string') {
    return sanitizeTrajectoryValue({ ...result, base64: '[omitted]' });
  }
  return result;
}
// WAL files keep the largest size they ever reached; after a checkpoint resets the log, SQLite truncates it to this.
// The control plane uses the same limit (src/storage/database.ts).
export const walSizeLimit = 512 * 1024 * 1024;

export class Projects {
  constructor({ database, docker, deployment, image, egress = true, tools = '/opt/agent-tools', results = null }) {
    // background: repository -> task workspaces whose kept processes may outlive a command.
    // gates: repository -> runner calls running now, whether a lifecycle action holds the computer, and who waits.
    // restarting: computers with a restart queued under the exclusive lock (restartAlone).
    this.resultsMount = results; this.egress = egress; this.toolsMount = tools; this.background = new Map(); this.usage = new Map(); this.gates = new Map(); this.pending = new Set(); this.restarting = new Set();
    // pruned: when each computer's journal was last pruned; pruning: computers with a prune running now.
    this.pruned = new Map(); this.pruning = new Set();
    // scanning: the work volume scan running now (one computer at a time); dockerUsageAt: when Docker's usage was read.
    this.scanning = null; this.dockerUsageAt = 0; this.lastPruneAt = 0; this.approvedImageId = null;
    this.reconcilingGlobal = null;
    this.globalReconcileState = { key: null, attempts: 0, nextRetryAt: 0 };
    this.globalBuildJob = null; this.projectBuildJobs = new Map();
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(database); this.docker = docker; this.deployment = deployment; this.image = image;
    this.images = new PrecompiledImageBuilder({ docker, db: this.db, deployment, logFailure });
    this.databasePath = database;
    this.notesRoot = dirname(database) + '/project-notes';
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA journal_size_limit=${walSizeLimit};
      CREATE TABLE IF NOT EXISTS projects(repository_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,state TEXT NOT NULL,desired TEXT NOT NULL,error TEXT,started_at TEXT);
      CREATE TABLE IF NOT EXISTS resources(repository_id TEXT NOT NULL,generation INTEGER NOT NULL,image TEXT NOT NULL,PRIMARY KEY(repository_id,generation));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,action TEXT NOT NULL,generation INTEGER NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
    `);
    // The operations still running: all that recovery needs from the ledger, which keeps every runner call with its input
    // and result (3.8M rows, ~100 GB in production). Without this index each project's recovery scanned the whole ledger,
    // reading state behind every input; the manager stayed unready for minutes on each start. Creating it reads the ledger
    // once; afterwards it holds only the few rows in flight.
    this.db.exec("CREATE INDEX IF NOT EXISTS operations_running ON operations(repository_id,action) WHERE state='running'");
    // The bodies of runner calls are appended to per-project trajectory files next to the ledger (#436); a row keeps the
    // call's state, a small header, the hash of its input and refs to its input and result. Adding the columns reads no rows.
    const ledgerColumns = new Set(this.db.prepare('PRAGMA table_info(operations)').all().map(row => row.name));
    for (const column of ['input_ref', 'result_ref', 'input_sha256']) if (!ledgerColumns.has(column)) this.db.exec(`ALTER TABLE operations ADD COLUMN ${column} TEXT`);
    trajectoryStorage(this.db);
    this.trajectories = new Trajectories(this.db, dirname(database) + '/trajectories');
    // The data disk's free space; the migration waits while it is below the reserve (#671).
    this.disk = new DiskGuard(dirname(database));
    // Moves the bodies of rows written before, and removes the files no call replays any more (#671); both are started
    // by main.mjs once the manager is ready.
    this.migration = new LedgerMigration(this.db, this.trajectories, { guard: this.disk });
    this.expiry = new TrajectoryExpiry(this.db, this.trajectories);
    // Returns the pages later cleanups free once the ledger is compacted (auto_vacuum=INCREMENTAL, #671); main.mjs starts it.
    this.vacuum = new IncrementalVacuum(this.db);
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'revision')) this.db.exec('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    // spec: the requested computer; build: the image built for its packages; setup: the last setup script run.
    for (const column of ['spec', 'build', 'setup']) if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === column)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${column} TEXT`);
    // parallel: how many runner calls may share the computer, one per task the control plane may run there at once.
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'parallel')) this.db.exec('ALTER TABLE projects ADD COLUMN parallel INTEGER NOT NULL DEFAULT 1');
    // applied: the resources the current container was created with, so a changed default shows as pending.
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'applied')) this.db.exec('ALTER TABLE projects ADD COLUMN applied TEXT');
    // notes_purge: a committed deletion whose notes volume could not be removed owes this cleanup (#774). A deletion the
    // control plane refused leaves its notes alone, so the row being deleted is not enough to decide.
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'notes_purge')) this.db.exec('ALTER TABLE projects ADD COLUMN notes_purge INTEGER NOT NULL DEFAULT 0');
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'spec_revision')) this.db.exec('ALTER TABLE projects ADD COLUMN spec_revision INTEGER NOT NULL DEFAULT 0');
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'configured_keys')) this.db.exec('ALTER TABLE projects ADD COLUMN configured_keys TEXT');
    this.db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    // The last answer of each computer's work volume scan (#671): written by scanStorage, read by the storage page.
    this.db.exec('CREATE TABLE IF NOT EXISTS computer_storage(repository_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,scanned_at TEXT NOT NULL,result TEXT NOT NULL)');
    // Before the defaults could change, a saved spec held all four resources. Values equal to the built-in defaults are
    // dropped once, so those projects follow the global default from then on; any other value stays the project's own.
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key='own_resources'").get()) {
      this.db.exec('BEGIN IMMEDIATE');
      for (const row of this.db.prepare('SELECT repository_id,spec FROM projects WHERE spec IS NOT NULL').all()) {
        const spec = JSON.parse(row.spec); for (const key of resourceKeys) if (spec[key] === builtin[key]) delete spec[key];
        this.db.prepare('UPDATE projects SET spec=? WHERE repository_id=?').run(JSON.stringify(spec), row.repository_id);
      }
      this.db.prepare("INSERT INTO settings VALUES('own_resources','1')").run(); this.db.exec('COMMIT');
    }
  }
  get(repo) { return this.db.prepare('SELECT * FROM projects WHERE repository_id=?').get(repo); }
  list() { return this.db.prepare('SELECT * FROM projects ORDER BY repository_id').all(); }
  // The values a project set itself; it survives restarts and resets.
  // Commands have no time limit, so a max_command_minutes saved by an earlier version is dropped.
  own(repo) { const saved = this.get(repo)?.spec, { max_command_minutes: _removed, ...spec } = saved ? JSON.parse(saved) : {}; return spec; }
  // The resource defaults now in force: the built-in values with the ones saved in the global settings.
  resourceDefaults() { const saved = this.db.prepare("SELECT value FROM settings WHERE key='resource_defaults'").get(); return { ...builtin, ...(saved ? JSON.parse(saved.value) : {}) }; }
  // The unified global environment defaults shared by project computers and assistant computers.
  globalEnvironmentDefaults() {
    const saved = this.db.prepare("SELECT value FROM settings WHERE key='computer_defaults_env'").get();
    const parsed = saved ? JSON.parse(saved.value) : {};
    return {
      egress: typeof parsed.egress === 'boolean' ? parsed.egress : this.egress,
      packages: normalizePackages(parsed.packages || []),
      setup_script: typeof parsed.setup_script === 'string' ? parsed.setup_script : '',
      env: parsed.env && typeof parsed.env === 'object' ? parsed.env : {},
    };
  }
  globalDefaults() { return { ...this.resourceDefaults(), ...this.globalEnvironmentDefaults() }; }
  currentGlobalImage() {
    const saved = this.db.prepare("SELECT value FROM settings WHERE key='global_precompiled_image'").get();
    return saved ? JSON.parse(saved.value) : null;
  }
  setCurrentGlobalImage(value) {
    if (!value) this.db.prepare("DELETE FROM settings WHERE key='global_precompiled_image'").run();
    else this.db.prepare("INSERT INTO settings VALUES('global_precompiled_image',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
  }
  globalBuildView() {
    if (this.globalBuildJob?.state) return { ...this.globalBuildJob.state };
    const saved = this.db.prepare("SELECT value FROM settings WHERE key='global_build'").get();
    return saved ? JSON.parse(saved.value) : null;
  }
  saveGlobalBuild(value) {
    if (!value) this.db.prepare("DELETE FROM settings WHERE key='global_build'").run();
    else this.db.prepare("INSERT INTO settings VALUES('global_build',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
  }
  // Effective global environment for assistant computers: shares global defaults, precompiled image and env.
  assistantGlobalEnvironment() {
    const res = this.resourceDefaults(), envDefaults = this.globalEnvironmentDefaults(), globalImg = this.currentGlobalImage();
    const validBase = !this.approvedImageId || (globalImg?.base_image_id && globalImg.base_image_id === this.approvedImageId);
    return {
      image: validBase && globalImg?.id ? globalImg.id : this.image,
      tag: validBase ? (globalImg?.tag || null) : null,
      base_image_id: this.approvedImageId || globalImg?.base_image_id || null,
      env: envDefaults.env,
      defaults: { ...res, egress: envDefaults.egress },
      onStaleImage: () => { void this.reconcileGlobalImage().catch(error => logFailure('reconciling stale global image failed', error)); },
    };
  }
  // Validates the persisted global precompiled image against the current approved base image and local Docker store
  // (checking stored image ID, not just tag). Serializes concurrent calls and applies backoff + attempt cap on failure
  // so broken global configurations never loop on the 5-second health check timer.
  reconcileGlobalImage() {
    if (this.reconcilingGlobal) return this.reconcilingGlobal;
    this.reconcilingGlobal = this._reconcileGlobalImage().finally(() => { this.reconcilingGlobal = null; });
    return this.reconcilingGlobal;
  }
  async _reconcileGlobalImage() {
    const approved = await this.docker.request('GET', `/images/${encodeURIComponent(this.image)}/json`).catch(() => null);
    if (!approved?.Id) return;
    this.approvedImageId = approved.Id;
    const stored = this.currentGlobalImage();
    const envDefaults = this.globalEnvironmentDefaults();
    const wantsGlobal = envDefaults.packages.length > 0 || !!normalizeScript(envDefaults.setup_script);
    const targetKey = wantsGlobal
      ? computeImageKey({
        baseImageId: approved.Id,
        packages: envDefaults.packages,
        setupScript: envDefaults.setup_script,
        env: normalizeScript(envDefaults.setup_script) ? envDefaults.env : {},
        egress: envDefaults.egress,
      })
      : null;

    if (stored) {
      const baseMatches = !!stored.base_image_id && stored.base_image_id === approved.Id;
      const keyMatches = !targetKey || !stored.image_key || stored.image_key === targetKey;
      if (baseMatches && keyMatches && stored.id) {
        const presentById = await this.docker.request('GET', `/images/${encodeURIComponent(stored.id)}/json`).catch(() => null);
        if (presentById?.Id) {
          this.globalReconcileState = { key: null, attempts: 0, nextRetryAt: 0 };
          return;
        }
        // Stored ID was pruned; only adopt the tag if it exists and was built on the same approved base image.
        if (stored.tag) {
          const presentByTag = await this.docker.request('GET', `/images/${encodeURIComponent(stored.tag)}/json`).catch(() => null);
          const tagBase = presentByTag?.Config?.Labels?.['department.bot.base_image_id'];
          if (presentByTag?.Id && (!tagBase || tagBase === approved.Id)) {
            this.setCurrentGlobalImage({ ...stored, id: presentByTag.Id, base_image_id: approved.Id });
            this.globalReconcileState = { key: null, attempts: 0, nextRetryAt: 0 };
            return;
          }
        }
      }
      this.setCurrentGlobalImage(null);
    }

    if (!wantsGlobal || this.globalBuildJob) return;
    const cached = await this.images.checkLayeredCache({ approvedImage: approved, globalSpec: envDefaults, egress: envDefaults.egress });
    if (cached.cached && cached.image) {
      const finished_at = new Date().toISOString();
      this.setCurrentGlobalImage({ id: cached.image.Id, tag: cached.tag, image_key: cached.image_key, base_image_id: approved.Id, finished_at });
      this.globalReconcileState = { key: null, attempts: 0, nextRetryAt: 0 };
      return;
    }

    // Backoff & attempt limit keyed by (approved base image + global spec + egress): never loop every 5s on failure/cancel.
    if (this.globalReconcileState.key !== targetKey) {
      const persisted = this.globalBuildView();
      if (persisted?.target_key === targetKey && (persisted.state === 'cancelled' || (persisted.state === 'failed' && persisted.error !== 'build_interrupted'))) {
        this.globalReconcileState = { key: targetKey, attempts: 3, nextRetryAt: Infinity };
        return;
      }
      this.globalReconcileState = { key: targetKey, attempts: 0, nextRetryAt: 0 };
    }
    if (this.globalReconcileState.attempts >= 3 || Date.now() < this.globalReconcileState.nextRetryAt) return;
    await this.triggerGlobalBuild({ forceRebuild: false });
  }
  // Reconciles builds that were queued or running before a manager restart so UI never stays stuck and cancel is never a no-op.
  reconcileInterruptedBuilds() {
    const now = new Date().toISOString();
    const interrupted = new Map();
    this.images.reconcileInterrupted();
    const gb = this.globalBuildView();
    if (!this.globalBuildJob && gb && ['queued', 'building', 'cancelling'].includes(gb.state)) {
      this.saveGlobalBuild({
        ...gb,
        state: 'failed',
        error: 'build_interrupted',
        queue_position: null,
        can_cancel: false,
        output: `${gb.output ? gb.output + '\n' : ''}[interrupted by manager restart]`.slice(-16000),
        updated_at: now,
        finished_at: now,
      });
    }
    for (const row of this.list()) {
      if (this.projectBuildJobs.has(row.repository_id) || !row.build) continue;
      let parsed; try { parsed = JSON.parse(row.build); } catch { continue; }
      if (parsed && ['queued', 'building', 'cancelling'].includes(parsed.state)) {
        const nextBuild = {
          ...parsed,
          state: 'failed',
          error: 'build_interrupted',
          queue_position: null,
          can_cancel: false,
          output: `${parsed.output ? parsed.output + '\n' : ''}[interrupted by manager restart]`.slice(-16000),
          updated_at: now,
          finished_at: now,
        };
        const serialized = JSON.stringify(nextBuild);
        this.db.prepare('UPDATE projects SET build=? WHERE repository_id=?').run(serialized, row.repository_id);
        interrupted.set(row.repository_id, serialized);
      }
    }
    return interrupted;
  }
  // Effective project computer spec: project overlay stacked on top of unified global defaults.
  spec(repo) {
    const res = this.resourceDefaults(), globalEnv = this.globalEnvironmentDefaults(), own = this.own(repo);
    return {
      ...defaults,
      ...res,
      egress: own.egress ?? globalEnv.egress,
      ...own,
      packages: normalizePackages([...globalEnv.packages, ...(own.packages || [])]),
      env: { ...globalEnv.env, ...(own.env || {}) },
      setup_script: own.setup_script || '',
    };
  }
  describe(repo) {
    const project = this.get(repo); if (!project) return null;
    const resource = this.db.prepare('SELECT image FROM resources WHERE repository_id=? AND generation=?').get(repo, project.generation);
    const generations = this.db.prepare('SELECT count(*) AS n FROM resources WHERE repository_id=?').get(repo).n;
    const { spec: _saved, build, setup, applied, spec_revision: specRevision, configured_keys: configuredKeys, ...state } = project, spec = this.spec(repo), own = this.own(repo);
    const liveBuild = this.projectBuildJobs.get(repo)?.state;
    const buildInfo = liveBuild ? { ...liveBuild } : (build ? JSON.parse(build) : null);
    const globalDefaults = this.globalDefaults();
    const wantsPrecompiled = spec.packages.length > 0 || !!normalizeScript(globalDefaults.setup_script) || !!normalizeScript(own.setup_script);
    const imagePending = !!(buildInfo?.state === 'ready' && buildInfo?.image_id && resource?.image && resource.image !== buildInfo.image_id);
    const toolchainPending = wantsPrecompiled && (
      imagePending
      || (!!this.approvedImageId && resource?.image === this.approvedImageId)
      || (!resource?.image && ['queued', 'building', 'cancelling', 'failed', 'cancelled'].includes(String(buildInfo?.state || '')))
    );
    // inherited: the resources that follow the default; resources_pending: the container still has other resources.
    return { ...state, computer: { ...this.names(repo, project.generation), image: resource?.image || null, user: '10001:10001', workdir: '/workspace',
      root_filesystem: 'read-only', network_policy: spec.egress ? 'internet egress' : 'internal, no egress', init: true,
      ...spec, spec_revision: Number(specRevision) || 0, configured_keys: configuredKeys ? JSON.parse(configuredKeys) : null, build: buildInfo, setup: setup ? JSON.parse(setup) : null, retained_generations: generations, bounds,
      defaults: this.resourceDefaults(), global_defaults: globalDefaults,
      own: {
        ...Object.fromEntries(resourceKeys.filter(k => own[k] !== undefined).map(k => [k, own[k]])),
        ...(own.egress !== undefined ? { egress: own.egress } : {}),
        packages: normalizePackages(own.packages || []),
        setup_script: own.setup_script || '',
        env: own.env || {},
      },
      inherited: resourceKeys.filter(key => own[key] === undefined),
      resources_pending: !!applied && applied !== JSON.stringify(resources(spec)),
      image_pending: imagePending,
      toolchain_pending: toolchainPending } };
  }
  // The unified global defaults with their bounds, host capacity, allocated resources and global precompiled image state.
  async defaultsView() {
    const info = await this.docker.request('GET', '/info').catch(() => null);
    const approved = await this.docker.request('GET', `/images/${encodeURIComponent(this.image)}/json`).catch(() => null);
    const running = this.list().filter(p => ['ready', 'busy'].includes(p.state)).map(p => this.spec(p.repository_id));
    return {
      defaults: this.resourceDefaults(),
      builtin,
      bounds,
      host: info?.NCPU ? { cpus: info.NCPU, memory_mb: Math.floor(info.MemTotal / mib) } : null,
      allocated: { computers: running.length, cpus: Math.round(running.reduce((sum, s) => sum + s.cpus, 0) * 100) / 100, memory_mb: running.reduce((sum, s) => sum + s.memory_mb, 0) },
      environment: this.globalEnvironmentDefaults(),
      environment_builtin: { egress: this.egress, packages: [], setup_script: '', env: {} },
      build: this.globalBuildView(),
      global_image: this.currentGlobalImage(),
      toolchain: approved?.Config?.Labels?.['department.bot.toolchain'] || null,
    };
  }
  // New computers use the new defaults at once; a running one that follows them shows resources_pending until the control
  // plane sends refresh while no task uses it. Global packages/setup_script trigger an automatic precompiled image build.
  async setDefaults(input) {
    const allowed = [...resourceKeys, 'egress', 'packages', 'setup_script', 'env', 'rebuild'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length
      || Object.keys(input).some(key => !allowed.includes(key))) throw new ManagerError('invalid_defaults', 400);
    for (const key of resourceKeys) if (input[key] !== undefined && !validResource(key, input[key])) throw new ManagerError('invalid_defaults', 400);
    for (const key of ['egress', 'rebuild']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ManagerError('invalid_defaults', 400);
    validateSoftwareFields(input);
    // Docker refuses to create a container that is given more CPUs than the host has.
    const info = await this.docker.request('GET', '/info').catch(() => null);
    if (info?.NCPU && input.cpus > info.NCPU) throw new ManagerError('cpus_exceed_host', 400);

    const resUpdates = Object.fromEntries(resourceKeys.filter(k => input[k] !== undefined).map(k => [k, input[k]]));
    if (Object.keys(resUpdates).length) {
      this.db.prepare("INSERT INTO settings VALUES('resource_defaults',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({ ...this.resourceDefaults(), ...resUpdates }));
    }
    const envKeys = ['egress', 'packages', 'setup_script', 'env'];
    const envUpdates = Object.fromEntries(envKeys.filter(k => input[k] !== undefined).map(k => [k, k === 'packages' ? normalizePackages(input[k]) : input[k]]));
    if (Object.keys(envUpdates).length) {
      this.db.prepare("INSERT INTO settings VALUES('computer_defaults_env',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({ ...this.globalEnvironmentDefaults(), ...envUpdates }));
    }
    const touchesBuild = input.packages !== undefined || input.setup_script !== undefined || input.env !== undefined || input.rebuild === true
      || (input.egress !== undefined && (this.globalEnvironmentDefaults().packages.length > 0 || !!normalizeScript(this.globalEnvironmentDefaults().setup_script)));
    if (touchesBuild) {
      this.globalReconcileState = { key: null, attempts: 0, nextRetryAt: 0 };
      await this.triggerGlobalBuild({ forceRebuild: input.rebuild === true });
    }
    return this.defaultsView();
  }
  async triggerGlobalBuild({ forceRebuild = false } = {}) {
    const approved = await this.docker.request('GET', `/images/${encodeURIComponent(this.image)}/json`).catch(() => null);
    if (!approved?.Id) throw new ManagerError('approved_image_missing', 503);
    this.approvedImageId = approved.Id;
    const toolchain = approved.Config?.Labels?.['department.bot.toolchain'] || null;
    const envDefaults = this.globalEnvironmentDefaults();
    if (this.globalBuildJob) {
      this.globalBuildJob.superseded = true;
      this.globalBuildJob.handle.cancel();
      this.globalBuildJob = null;
    }
    if (!envDefaults.packages.length && !normalizeScript(envDefaults.setup_script)) {
      this.setCurrentGlobalImage(null);
      this.globalReconcileState = { key: null, attempts: 0, nextRetryAt: 0 };
      this.saveGlobalBuild({ state: 'none', toolchain, packages: [], can_cancel: false, finished_at: new Date().toISOString() });
      return;
    }
    const targetKey = computeImageKey({
      baseImageId: approved.Id,
      packages: envDefaults.packages,
      setupScript: envDefaults.setup_script,
      env: normalizeScript(envDefaults.setup_script) ? envDefaults.env : {},
      egress: envDefaults.egress,
    });
    if (!forceRebuild) {
      const cached = await this.images.checkLayeredCache({ approvedImage: approved, globalSpec: envDefaults, egress: envDefaults.egress });
      if (cached.cached && cached.image) {
        const finished_at = new Date().toISOString();
        this.setCurrentGlobalImage({ id: cached.image.Id, tag: cached.tag, image_key: cached.image_key, base_image_id: approved.Id, finished_at });
        this.globalReconcileState = { key: null, attempts: 0, nextRetryAt: 0 };
        this.saveGlobalBuild({ state: 'ready', tag: cached.tag, image_key: cached.image_key, target_key: targetKey, phase: 'global', toolchain, packages: envDefaults.packages, can_cancel: false, finished_at });
        return;
      }
    }
    const job = { handle: null, state: null, superseded: false, promise: null };
    const handle = this.images.startLayered({
      approvedImage: approved,
      globalSpec: envDefaults,
      projectSpec: null,
      resources: this.resourceDefaults(),
      egress: envDefaults.egress,
      forceRebuildGlobal: forceRebuild,
      onProgress: snapshot => {
        if (job.superseded) return;
        job.state = { ...snapshot, target_key: targetKey, toolchain, packages: envDefaults.packages };
        this.saveGlobalBuild(job.state);
      },
    });
    job.handle = handle;
    this.globalBuildJob = job;
    job.promise = handle.promise.then(result => {
      if (job.superseded) return result;
      const finished_at = new Date().toISOString();
      this.setCurrentGlobalImage({ id: result.image.Id, tag: result.tag, image_key: result.image_key, base_image_id: approved.Id, finished_at });
      this.globalReconcileState = { key: null, attempts: 0, nextRetryAt: 0 };
      const finalState = {
        build_id: handle.build_id, image_key: result.image_key, target_key: targetKey, tag: result.tag, phase: 'global',
        state: 'ready', queue_position: null, toolchain, packages: envDefaults.packages,
        output: result.output ? result.output.slice(-16000) : null, can_cancel: false, finished_at,
      };
      this.saveGlobalBuild(finalState);
      if (this.globalBuildJob === job) this.globalBuildJob = null;
      return result;
    }, error => {
      if (job.superseded) return null;
      const finished_at = new Date().toISOString();
      const cancelled = !!error?.cancelled;
      if (cancelled) {
        this.globalReconcileState = { key: targetKey, attempts: 3, nextRetryAt: Infinity };
      } else {
        const prevAttempts = this.globalReconcileState.key === targetKey ? this.globalReconcileState.attempts : 0;
        const attempts = prevAttempts + 1;
        const backoffMs = Math.min(60_000 * 2 ** (attempts - 1), 15 * 60_000);
        this.globalReconcileState = { key: targetKey, attempts, nextRetryAt: attempts >= 3 ? Infinity : Date.now() + backoffMs };
      }
      const finalState = {
        build_id: handle.build_id, image_key: job.state?.image_key ?? null, target_key: targetKey, tag: job.state?.tag ?? null, phase: 'global',
        state: cancelled ? 'cancelled' : 'failed', queue_position: null, toolchain, packages: envDefaults.packages,
        output: (error?.output || job.state?.output || null)?.slice(-16000) ?? null, can_cancel: false, finished_at,
      };
      this.saveGlobalBuild(finalState);
      if (this.globalBuildJob === job) this.globalBuildJob = null;
      return null;
    });
  }
  cancelGlobalBuild() {
    const job = this.globalBuildJob;
    if (!job) return { cancelled: false, build: this.globalBuildView() };
    const cancelled = job.handle.cancel();
    return { cancelled, build: this.globalBuildView() };
  }
  async waitForGlobalBuild() {
    if (this.globalBuildJob?.promise) await this.globalBuildJob.promise;
    return this.globalBuildView();
  }
  // Up to `parallel` runner calls (shared) use a computer at once; lifecycle actions (exclusive) run alone. Waiters are
  // admitted in arrival order, so a stop, reset or configure is not starved by a stream of runner calls.
  admit(repo) {
    const gate = this.gates.get(repo); if (!gate) return;
    const limit = this.get(repo)?.parallel || 1;
    while (gate.waiting.length && !gate.exclusive) {
      const next = gate.waiting[0];
      if (next.shared ? gate.shared >= limit : gate.shared > 0) break;
      gate.waiting.shift(); if (next.shared) gate.shared++; else gate.exclusive = true; next.resolve();
    }
    if (!gate.shared && !gate.exclusive && !gate.waiting.length) this.gates.delete(repo);
  }
  lock(repo, fn, shared = false) {
    let gate = this.gates.get(repo); if (!gate) { gate = { shared: 0, exclusive: false, waiting: [] }; this.gates.set(repo, gate); }
    // The computer is busy while runner calls hold slots; the last one to leave marks it ready again.
    const held = gate, run = new Promise(resolve => { held.waiting.push({ shared, resolve }); this.admit(repo); }).then(fn)
      .finally(() => {
        if (shared && !--held.shared) { const project = this.get(repo); if (project?.state === 'busy') this.update(repo, 'ready', 'ready', null, project.started_at); }
        if (!shared) held.exclusive = false; this.admit(repo);
      });
    const settled = run.catch(() => {}); this.pending.add(settled); settled.then(() => this.pending.delete(settled));
    return run;
  }
  running(repo) { return this.gates.get(repo)?.shared || 0; }
  kept(repo) { let set = this.background.get(repo); if (!set) { set = new Set(); this.background.set(repo, set); } return set; }
  // Sets how many runner calls may share the computer; raising it admits waiting calls at once.
  parallelism(repo, tasks) {
    this.validate(repo);
    if (!Number.isSafeInteger(tasks) || tasks < parallelBounds[0] || tasks > parallelBounds[1]) throw new ManagerError('invalid_parallel', 400);
    if (!this.get(repo)) throw new ManagerError('project_not_registered', 404);
    this.db.prepare('UPDATE projects SET parallel=? WHERE repository_id=?').run(tasks, repo); this.admit(repo);
    return this.describe(repo);
  }
  validate(repo) { if (!/^[1-9]\d{0,19}$/.test(repo)) throw new ManagerError('invalid_repository', 400); }
  names(repo, generation) {
    const prefix = `dbot-${this.deployment}-${repo}-g${generation}`;
    return { container: prefix, volume: prefix + '-work', network: prefix + '-net' };
  }
  notesName(repo) { return `dbot-${this.deployment}-${repo}-notes`; }
  notesLabels(repo) { return { 'department.bot.deployment': this.deployment, 'department.bot.repository': repo, 'department.bot.kind': 'notes' }; }
  // Every notes volume this deployment owns, whether or not a project row still refers to it: the control plane uses
  // this to find volumes a committed deletion left behind and to clear stale notes before a repository is connected again.
  async notesVolumes() {
    const filters = JSON.stringify({ label: [`department.bot.deployment=${this.deployment}`, 'department.bot.kind=notes'] });
    const listed = await this.docker.request('GET', '/volumes?filters=' + encodeURIComponent(filters));
    return (listed?.Volumes ?? []).map(volume => ({ name: String(volume.Name), repository_id: String(volume.Labels?.['department.bot.repository'] ?? ''), created_at: volume.CreatedAt ?? null }));
  }
  // Idempotent name-based reclaim: it never needs the project row, so it also works once a project is gone here. It is
  // how a retried deletion finishes, and how a reconnected repository starts from empty notes instead of old ones.
  async reclaimNotes(repo) {
    const volume = await this.docker.request('GET', '/volumes/' + this.notesName(repo));
    if (volume && Object.entries(this.notesLabels(repo)).some(([key, value]) => volume.Labels?.[key] !== value)) throw new ManagerError('resource_ownership_mismatch', 403);
    if (volume) await this.docker.request('DELETE', '/volumes/' + this.notesName(repo));
    await rm(this.notesRoot + '/' + repo, { recursive: true, force: true });
    return { reclaimed: true, repository_id: repo, volume: !!volume };
  }
  async notesVolume(repo, create = true) {
    const name = this.notesName(repo), labels = this.notesLabels(repo);
    let volume = await this.docker.request('GET', '/volumes/' + name);
    if (volume && Object.entries(labels).some(([key,value]) => volume.Labels?.[key] !== value)) throw new ManagerError('resource_ownership_mismatch', 403);
    if (!volume && create) {
      const notes = new Notes(this.notesRoot + '/' + repo); await notes.directory();
      const device = await this.docker.volumeSource(notes.root);
      await this.docker.request('POST', '/volumes/create', { Name: name, Labels: labels, Driver: 'local', DriverOpts: { type: 'none', o: 'bind', device } });
      volume = await this.notesVolume(repo, false);
    }
    return volume;
  }
  // #774: a deletion whose notes removal failed leaves the volume under the name this.notesName(repo) derives from the
  // repository id, with the previous project's notes in the directory it binds. A project that is not live (no row, or a
  // row that still owes the purge) must never adopt that residue: the volume and its directory go before the first notes
  // read or write, and a Docker that refuses the volume removal fails the entry instead of serving the old content.
  async reclaimStaleNotes(repo) {
    const row = this.get(repo);
    // A purge is owed only by a committed deletion whose notes removal failed; a deletion the control plane refused keeps
    // its notes, and a project that failed for another reason keeps real user notes. A repository with no row at all is a
    // reconnect or a first creation: nothing names those notes as still in use, so they go before the new project reads.
    // notes_purge alone marks that intent (#783): a stop after the deletion, or a pending reset that ended reset_failed,
    // moves the state away from deleted while the cleanup is still owed, and the marker survives those transitions.
    if (row && Number(row.notes_purge) !== 1) return false;
    const name = this.notesName(repo), volume = await this.docker.request('GET', '/volumes/' + name);
    if (volume) {
      if (Object.entries(this.notesLabels(repo)).some(([key, value]) => volume.Labels?.[key] !== value)) throw new ManagerError('resource_ownership_mismatch', 403);
      try { await this.docker.request('DELETE', '/volumes/' + name); }
      catch (error) { throw new ManagerError('notes_residue_unclearable', 503); }
    }
    await rm(this.notesRoot + '/' + repo, { recursive: true, force: true });
    if (row) this.db.prepare('UPDATE projects SET notes_purge=0 WHERE repository_id=?').run(repo);
    return true;
  }
  async notes(repo, method, name, input = {}) {
    this.validate(repo); if (name !== undefined) { try { noteName(name); } catch { throw new ManagerError('invalid_note_name', 400); } }
    if (!['GET','PUT','DELETE'].includes(method) || method !== 'GET' && name === undefined || Object.keys(input).some(key => key !== 'content')) throw new ManagerError('invalid_notes_request', 400);
    return this.lock(repo, async () => {
      // A page can edit notes before the first boot. Register only the stopped metadata, never provision a computer.
      await this.reclaimStaleNotes(repo);
      if (!this.get(repo)) this.db.prepare("INSERT INTO projects(repository_id,generation,state,desired) VALUES(?,1,'stopped','stopped')").run(repo);
      await this.notesVolume(repo);
      const notes = new Notes(this.notesRoot + '/' + repo);
      try {
        if (method === 'GET') return name === undefined ? { files: await notes.list() } : await notes.read(name);
        if (method === 'PUT') return await notes.write(name, input.content);
        return await notes.delete(name);
      } catch (error) {
        if (error.code === 'ENOENT') throw new ManagerError('note_not_found', 404);
        if (/^(invalid_note|notes_(?:lock_expired|busy))/.test(error.message)) throw new ManagerError(error.message, 400);
        throw error;
      }
    });
  }
  async files(repo, method, name, action, input = {}, query = {}) {
    this.validate(repo); if (name !== undefined) noteName(name);
    if (Object.keys(input).some(k => !['content','expected_revision','revision','actor'].includes(k))) throw new ManagerError('invalid_input', 400);
    if (method !== 'GET' && (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0)) throw new ManagerError('invalid_note_revision', 400);
    if (input.actor !== undefined && (typeof input.actor !== 'string' || input.actor.length > 240)) throw new ManagerError('invalid_input', 400);
    return this.lock(repo, async () => {
      await this.reclaimStaleNotes(repo);
      if (!this.get(repo)) this.db.prepare("INSERT INTO projects(repository_id,generation,state,desired) VALUES(?,1,'stopped','stopped')").run(repo);
      await this.notesVolume(repo); const notes = new Notes(this.notesRoot + '/' + repo);
      try {
        if (method === 'GET' && name === undefined) return await notes.files(query.include_deleted === '1');
        if (method === 'GET' && action === 'versions') return await notes.versions(name);
        if (method === 'GET' && !action) return await notes.file(name, query.revision === undefined ? undefined : Number(query.revision));
        if (method === 'PUT' && name && !action) return await notes.saveFile(name, input.content, input.expected_revision, input.actor ?? 'console');
        if (method === 'DELETE' && name && !action) return await notes.removeFile(name, input.expected_revision, input.actor ?? 'console');
        if (method === 'POST' && name && action === 'restore' && Number.isSafeInteger(input.revision) && input.revision > 0) return await notes.restoreFile(name, input.revision, input.expected_revision, input.actor ?? 'console');
        throw new ManagerError('invalid_notes_request', 400);
      } catch (error) {
        if (error.code === 'ENOENT') throw new ManagerError('note_not_found', 404);
        if (error.message === 'note_revision_changed') throw new ManagerError(error.message, 409);
        if (/^(invalid_note|notes_(?:lock_expired|busy))/.test(error.message)) throw new ManagerError(error.message, 400);
        throw error;
      }
    });
  }
  async fileTree(repo, method, id, action, input = {}, query = {}) {
    this.validate(repo);
    const directories=id==='directories';
    if(id!==undefined&&!directories&&!validNoteId(id))throw new ManagerError('invalid_note_id',400);
    const allowed=directories?['path']:id===undefined?['path','content','actor']:action==='move'?['path','expected_revision','actor']:action==='restore'?['revision','expected_revision','actor']:method==='DELETE'?['expected_revision','actor']:['content','expected_revision','actor'];
    if(Object.keys(input).some(key=>!allowed.includes(key)))throw new ManagerError('invalid_input',400);
    if(input.actor!==undefined&&(typeof input.actor!=='string'||input.actor.length>240))throw new ManagerError('invalid_input',400);
    if(id!==undefined&&!directories&&method!=='GET'&&(!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1))throw new ManagerError('invalid_note_revision',400);
    if(action==='restore'&&(!Number.isSafeInteger(input.revision)||input.revision<1))throw new ManagerError('invalid_note_revision',400);
    return this.lock(repo,async()=>{
      await this.reclaimStaleNotes(repo);
      if(!this.get(repo))this.db.prepare("INSERT INTO projects(repository_id,generation,state,desired) VALUES(?,1,'stopped','stopped')").run(repo);
      await this.notesVolume(repo);const tree=new FileTree(this.notesRoot+'/'+repo),actor=input.actor??'console';
      try{
        if(directories&&method==='POST')return await tree.createDirectory(input.path);
        if(directories&&method==='DELETE')return await tree.deleteDirectory(input.path);
        if(id===undefined&&method==='GET')return await tree.list({directory:query.directory??'',query:query.query??'',includeDeleted:query.include_deleted==='1',deletedOnly:query.deleted_only==='1',recursive:query.recursive==='1'});
        if(id===undefined&&method==='POST')return await tree.create(input.path,input.content,actor);
        if(method==='GET'&&action==='versions')return await tree.versions(id);
        if(method==='GET'&&!action)return await tree.read(id,query.revision===undefined?undefined:Number(query.revision));
        if(method==='PUT'&&!action)return await tree.save(id,input.content,input.expected_revision,actor);
        if(method==='DELETE'&&!action)return await tree.delete(id,input.expected_revision,actor);
        if(method==='POST'&&action==='restore')return await tree.restore(id,input.revision,input.expected_revision,actor);
        if(method==='POST'&&action==='move')return await tree.move(id,input.path,input.expected_revision,actor);
        throw new ManagerError('method_not_allowed',405);
      }catch(error){
        if(error instanceof ManagerError)throw error;
        if(error.code==='ENOENT')throw new ManagerError('note_not_found',404);
        if(error.message==='unsupported_note_format')throw new ManagerError(error.message,415);
        if(error.message==='note_revision_changed')throw new ManagerError(error.message,409);
        if(/^(?:invalid_note|notes_|note_(?:path_conflict|not_found|move_)|directory_)/.test(error.message))throw new ManagerError(error.message,error.status??400);
        throw error;
      }
    });
  }
  labels(repo, generation, kind) { return { 'department.bot.deployment': this.deployment, 'department.bot.repository': repo,
    'department.bot.generation': String(generation), 'department.bot.kind': kind }; }
  async agentToolsVolume() {
    if (!this.toolsMount) return null;
    const name = await this.docker.volumeName(this.toolsMount);
    if (!name) return null;
    const volume = await this.docker.request('GET', '/volumes/' + encodeURIComponent(name));
    const labels = volume?.Labels;
    const trusted = typeof name === 'string' && /^(?:[a-z0-9][a-z0-9._-]*[_-])?agent-tools$/i.test(name) &&
      labels && typeof labels === 'object' &&
      (labels['com.docker.compose.volume'] === 'agent-tools' || labels['department.bot.kind'] === 'agent-tools');
    if (!volume || !trusted) throw new ManagerError('agent_tools_volume_invalid', 503);
    return name;
  }
  async resultMount(owner) {
    if (!this.resultsMount) return [];
    if (!/^[a-z]+-[a-f0-9]{64}$/.test(owner)) throw new ManagerError('tool_result_owner_invalid', 400);
    const name = await this.docker.volumeName(this.resultsMount);
    if (!name) throw new ManagerError('tool_result_volume_missing', 503);
    const volume = await this.docker.request('GET', '/volumes/' + encodeURIComponent(name));
    if (!volume || !(volume.Labels?.['com.docker.compose.volume'] === 'tool-results' || volume.Labels?.['department.bot.kind'] === 'tool-results')) throw new ManagerError('tool_result_volume_invalid', 503);
    const info = await lstat(this.resultsMount + '/' + owner).catch(() => null);
    if (!info?.isDirectory()) throw new ManagerError('tool_result_directory_missing', 503);
    return [{ Type: 'volume', Source: name, Target: '/results', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: owner } }];
  }
  async inspect(repo, generation, kind) {
    if (!this.db.prepare('SELECT 1 FROM resources WHERE repository_id=? AND generation=?').get(repo, generation)) throw new ManagerError('unregistered_resource');
    const name = this.names(repo, generation)[kind];
    const resource = await this.docker.request('GET', `/${kind === 'container' ? 'containers' : kind === 'volume' ? 'volumes' : 'networks'}/${name}${kind === 'container' ? '/json' : ''}`);
    if (resource) {
      const actual = kind === 'container' ? resource.Config.Labels : resource.Labels;
      if (Object.entries(this.labels(repo, generation, kind)).some(([key, value]) => actual?.[key] !== value)) throw new ManagerError('resource_ownership_mismatch', 403);
    }
    return resource;
  }
  update(repo, state, desired, error = null, started = null) {
    this.db.prepare('UPDATE projects SET state=?,desired=?,error=?,started_at=?,revision=revision+1 WHERE repository_id=?').run(state, desired, error, started, repo);
  }
  async stopGeneration(repo, generation) {
    const container = await this.inspect(repo, generation, 'container');
    if (container?.State.Running) {
      await this.docker.request('POST', `/containers/${this.names(repo, generation).container}/stop?t=2`);
      if ((await this.inspect(repo, generation, 'container'))?.State.Running) throw new ManagerError('container_not_stopped');
    }
  }
  async stopAll(repo) {
    for (const row of this.db.prepare('SELECT generation FROM resources WHERE repository_id=?').all(repo)) await this.stopGeneration(repo, row.generation);
  }
  async provision(repo, { forceSetup = false, deferBuild = false } = {}) {
    const project = this.get(repo), generation = project.generation, names = this.names(repo, generation), spec = this.spec(repo);
    // /tmp runs programs like the work volume does (noexec there would only send tools such as venvs elsewhere); Docker
    // mounts a tmpfs noexec unless `exec` is given. The memory limit allows no swap on top, so a computer has the same
    // memory whether or not the host has swap.
    const tmpfs = `rw,exec,nosuid,nodev,size=${spec.tmp_mb * mib},mode=1777`, memory = spec.memory_mb * mib, approved = await this.resolveImage(repo, spec, { deferBuild });
    // Repository variables reach commands through the runner, which reads the names listed in BOT_PROJECT_ENV_KEYS.
    const env = ['HOME=/workspace/home', 'LANG=C.UTF-8', ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`), `BOT_PROJECT_ENV_KEYS=${Object.keys(spec.env).join(',')}`];
    let resource = this.db.prepare('SELECT image FROM resources WHERE repository_id=? AND generation=?').get(repo, generation);
    if (!resource) { this.db.prepare('INSERT INTO resources VALUES(?,?,?)').run(repo, generation, approved.Id); resource = { image: approved.Id }; }
    if (!await this.inspect(repo, generation, 'volume')) await this.docker.request('POST', '/volumes/create', { Name: names.volume, Labels: this.labels(repo, generation, 'volume') });
    await this.inspect(repo, generation, 'volume');
    await this.notesVolume(repo);
    const toolsVolume = await this.agentToolsVolume();
    const resultMounts = await this.resultMount(computerResultOwner('project',repo));
    let network = await this.inspect(repo, generation, 'network'), container = await this.inspect(repo, generation, 'container');
    // A container whose template or spec differs (approved image, init, resources, network policy) is replaced in place when
    // provisioned; the work volume and generation stay. This never happens in the middle of a command.
    const networkStale = network && network.Internal !== !spec.egress, host = container?.HostConfig;
    // Compare only the variables the manager sets (the image adds its own, such as PATH); old names come from BOT_PROJECT_ENV_KEYS.
    const current = container?.Config?.Env || [], listed = current.find(e => e.startsWith('BOT_PROJECT_ENV_KEYS='))?.slice(21).split(',').filter(Boolean) || [];
    const managed = new Set(['HOME', 'LANG', 'BOT_PROJECT_ENV_KEYS', ...Object.keys(spec.env), ...listed]);
    const envStale = container && JSON.stringify(current.filter(e => managed.has(e.slice(0, e.indexOf('=')))).sort()) !== JSON.stringify([...env].sort());
    const toolsMountStale = toolsVolume
      ? !host?.Mounts?.some(m => m.Type === 'volume' && m.Source === toolsVolume && m.Target === '/opt/agent-tools' && m.ReadOnly === true)
      : !!host?.Mounts?.some(m => m.Target === '/opt/agent-tools');
    if (container && (container.Image !== approved.Id || host?.Init !== true || networkStale || envStale || host?.Memory !== memory || host?.MemorySwap !== memory
      || host?.NanoCpus !== Math.round(spec.cpus * 1e9) || host?.PidsLimit !== spec.pids || host?.Tmpfs?.['/tmp'] !== tmpfs
      || !host?.Mounts?.some(m => m.Type === 'volume' && m.Source === this.notesName(repo) && m.Target === '/workspace/project-notes' && !m.ReadOnly)
      || toolsMountStale || (host?.Mounts?.filter(m => m.Target === '/results').length ?? 0) !== resultMounts.length || resultMounts.some(expected => !host?.Mounts?.some(m => m.Target === '/results' && m.Type === expected.Type && m.Source === expected.Source && m.ReadOnly === true && m.VolumeOptions?.Subpath === expected.VolumeOptions.Subpath)))) {
      if (container.State.Running) await this.docker.request('POST', `/containers/${names.container}/stop?t=2`);
      await this.docker.request('DELETE', `/containers/${names.container}?force=true`); container = null;
    }
    if (resource.image !== approved.Id) { this.db.prepare('UPDATE resources SET image=? WHERE repository_id=? AND generation=?').run(approved.Id, repo, generation); resource = { image: approved.Id }; }
    if (networkStale) { await this.docker.request('DELETE', `/networks/${names.network}`); network = null; }
    if (!network) await this.docker.request('POST', '/networks/create', { Name: names.network, Driver: 'bridge', Internal: !spec.egress, CheckDuplicate: true, Labels: this.labels(repo, generation, 'network') });
    await this.inspect(repo, generation, 'network');
    if (!container) {
      const mounts = [
        { Type: 'volume', Source: names.volume, Target: '/workspace' },
        { Type: 'volume', Source: this.notesName(repo), Target: '/workspace/project-notes', ReadOnly: false },
        ...(toolsVolume ? [{ Type: 'volume', Source: toolsVolume, Target: '/opt/agent-tools', ReadOnly: true }] : []),
        ...resultMounts,
      ];
      await this.docker.request('POST', `/containers/create?name=${names.container}`, { Image: resource.image, User: '10001:10001', WorkingDir: '/workspace',
        Cmd: ['node', '/opt/runner/idle.mjs'], Env: env, Labels: this.labels(repo, generation, 'container'),
        HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false,
          Memory: memory, MemorySwap: memory, NanoCpus: Math.round(spec.cpus * 1e9), PidsLimit: spec.pids, NetworkMode: names.network,
          Init: true, RestartPolicy: { Name: 'no' }, Tmpfs: { '/tmp': tmpfs },
          Mounts: mounts } });
      container = await this.inspect(repo, generation, 'container');
    }
    this.db.prepare('UPDATE projects SET applied=? WHERE repository_id=?').run(JSON.stringify(resources(spec)), repo);
    if (!container.State.Running) await this.docker.request('POST', `/containers/${names.container}/start`);
    // Readiness is a protocol and journal check, not a Docker running flag.
    const health = await this.docker.runner(names.container, { operation_id: randomId(), type: 'health' });
    if (!health.ok || !health.result.ready) throw new ManagerError('runner_not_ready');
    container = await this.inspect(repo, generation, 'container');
    this.update(repo, 'ready', 'ready', null, container.State.StartedAt);
    this.prune(repo, true);
    return this.get(repo);
  }
  // Removes journal records older than a day from a running computer's work volume, after each provision and every
  // six hours. It runs in the background and outside the project lock, without a time limit: it deletes only records no
  // call uses any more, and the first run on a large journal can take minutes. One prune per computer at a time.
  prune(repo, now = false) {
    const project = this.get(repo);
    if (!project || this.pruning.has(repo) || !now && Date.now() - (this.pruned.get(repo) || 0) < 6 * 3600 * 1000) return;
    this.pruning.add(repo); this.pruned.set(repo, Date.now());
    void this.docker.runner(this.names(repo, project.generation).container, { operation_id: randomId(), type: 'prune' }, 0)
      .then(result => { if (!result?.ok) logFailure(`project ${repo} journal prune failed`, result?.error || 'no detail'); },
        error => logFailure(`project ${repo} journal prune failed`, error))
      .finally(() => this.pruning.delete(repo));
  }
  // Measures a running computer's work volume for the storage page (#671): every six hours, one computer at a time so the
  // scans never compete for the disk, in the background and outside the project lock (it only reads). The runner's answer
  // is kept per project; a computer reset to a new generation is scanned again at once.
  scanStorage(now = Date.now()) {
    if (this.scanning) return;
    const last = new Map(this.db.prepare('SELECT repository_id,generation,scanned_at FROM computer_storage').all().map(row => [row.repository_id, row]));
    const due = this.list().filter(p => ['ready', 'busy'].includes(p.state)).find(p => last.get(p.repository_id)?.generation !== p.generation
      || now - Date.parse(last.get(p.repository_id).scanned_at) >= (this.scanIntervalMs ?? 6 * 3600_000));
    if (!due) return;
    const repo = due.repository_id, generation = due.generation;
    this.scanning = repo; this.scanInvalidated = false;
    void this.docker.runner(this.names(repo, generation).container, { operation_id: randomId(), type: 'storage_scan' }, 0)
      .then(answer => {
        if (this.scanInvalidated) return;
        // A failed scan is retried at the next interval, like a successful one, rather than every few seconds.
        const result = answer?.ok ? answer.result : { scanned_at: new Date().toISOString(), error: answer?.error || 'storage_scan_failed' };
        if (!answer?.ok) logFailure(`project ${repo} storage scan failed`, answer?.error || 'no detail');
        this.db.prepare(`INSERT INTO computer_storage VALUES(?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET generation=excluded.generation,
          scanned_at=excluded.scanned_at,result=excluded.result`).run(repo, generation, new Date().toISOString(), JSON.stringify(result));
      }, error => {
        if (this.scanInvalidated) return;
        logFailure(`project ${repo} storage scan failed`, error);
        this.db.prepare(`INSERT INTO computer_storage VALUES(?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET generation=excluded.generation,
          scanned_at=excluded.scanned_at,result=excluded.result`).run(repo, generation, new Date().toISOString(), JSON.stringify({ error: error instanceof ManagerError ? error.message : 'storage_scan_failed' }));
      })
      .finally(() => { this.scanning = null; });
  }
  // What Docker keeps on the host (#671), read every half hour in the background: the storage page shows it with what
  // can be reclaimed, and this is the only place those numbers come from. The read never runs on the request path, and a
  // stopped socket or an answer past the 4 MB cap in request() keeps the previous reading.
  //
  // Images and the build cache come from one quick /system/df (#671); the containers are asked for on their own (#680),
  // because Docker sizes a container's writable layer by walking it, and a host with a slow or stuck container must not
  // cost the other two rows their numbers. The volumes are a third read of their own (#968): most of them hold bytes the
  // storage table already counts as a database, a trajectory directory or a project computer, and the assistant HOME gets
  // a row of its own instead of sitting in "other".
  async readDockerUsage(now = Date.now()) {
    if (now - this.dockerUsageAt < 30 * 60_000) return;
    this.dockerUsageAt = now;
    try {
      // Keep the reader entry points overridable; polling state and persisted snapshots stay on Projects.
      const usage = await collectDockerUsage({ docker: this.docker,
        readContainers: () => this.readContainers(), readVolumes: () => this.readVolumes(), logFailure }, now);
      this.db.prepare("INSERT INTO settings VALUES('docker_usage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(usage));
    } catch (error) { logFailure('reading Docker disk usage failed', error); }
  }
  refreshFootprint(now = Date.now()) {
    if (!this.readingFootprint && (!this.footprint || now - Date.parse(this.footprint.measured_at) >= 3600_000)) {
      this.readingFootprint = storageFootprint(this.databasePath, managerLocations(this.databasePath))
        .then(result => { this.footprint = result; }).finally(() => { this.readingFootprint = null; });
    }
    return this.readingFootprint;
  }
  async readContainers() { return readDockerContainers(this.docker); }
  async readVolumes() { return readDockerVolumes(this.docker); }
  // The approved image, or a two-level precompiled image (global defaults + project overlay). Built via the serial
  // PrecompiledImageBuilder: apt runs via validated package names only, and setup_script ALWAYS runs as UID 10001.
  async resolveImage(repo, spec, { forceRebuild = false, deferBuild = false } = {}) {
    const approved = await this.docker.request('GET', `/images/${encodeURIComponent(this.image)}/json`);
    if (!approved?.Id) throw new ManagerError('approved_image_missing', 503);
    this.approvedImageId = approved.Id;
    const toolchain = approved.Config?.Labels?.['department.bot.toolchain'] || null;
    const globalEnv = this.globalEnvironmentDefaults(), own = this.own(repo);
    const projectSpec = { packages: normalizePackages(own.packages || []), setup_script: own.setup_script || '', env: own.env || {} };
    const effectivePackages = normalizePackages([...globalEnv.packages, ...projectSpec.packages]);
    const hasSetup = !!(normalizeScript(globalEnv.setup_script) || normalizeScript(projectSpec.setup_script));
    if (!effectivePackages.length && !hasSetup) {
      this.db.prepare('UPDATE projects SET build=?, setup=NULL WHERE repository_id=?').run(JSON.stringify({ state: 'none', toolchain, packages: [], can_cancel: false }), repo);
      return approved;
    }
    const record = value => this.db.prepare('UPDATE projects SET build=? WHERE repository_id=?').run(JSON.stringify({ toolchain, packages: effectivePackages, ...value }), repo);
    if (deferBuild && !forceRebuild) {
      const cached = await this.images.checkLayeredCache({ approvedImage: approved, globalSpec: globalEnv, projectSpec, egress: spec.egress });
      if (cached.cached && cached.image) {
        const finished_at = new Date().toISOString();
        if (cached.image_key) this.images.touchRow(cached.image_key, cached.image.Size ?? null);
        const existingOutput = JSON.parse(this.get(repo)?.build || '{}').output || null;
        record({
          image_key: cached.image_key, image_id: cached.image.Id, tag: cached.tag, phase: projectSpec.packages.length || normalizeScript(projectSpec.setup_script) ? 'project' : 'global',
          state: 'ready', queue_position: null, output: existingOutput, can_cancel: false, finished_at,
        });
        this.recordPrecompiledSetup(repo, this.get(repo)?.generation || 1, globalEnv.setup_script, projectSpec.setup_script, 'succeeded', finished_at, existingOutput);
        return cached.image;
      }
      // On startup recovery, do not block manager readiness on multi-minute image builds: start on a matching-base
      // previous image if one exists (ensuring runner/manager protocol compatibility), else the approved base image,
      // and enqueue the precompiled build asynchronously. Switching onto the newly built image happens strictly when
      // idle via `image_pending` + the control plane's claim-gated `refresh`.
      const generation = this.get(repo)?.generation;
      const previousRef = generation ? this.db.prepare('SELECT image FROM resources WHERE repository_id=? AND generation=?').get(repo, generation)?.image : null;
      const previousImage = previousRef && previousRef !== approved.Id
        ? await this.docker.request('GET', `/images/${encodeURIComponent(previousRef)}/json`).catch(() => null)
        : null;
      const previousMatchesBase = !!previousImage?.Id && previousImage.Config?.Labels?.['department.bot.base_image_id'] === approved.Id;
      this.startProjectBuild(repo, {
        approvedImage: approved, toolchain, globalSpec: globalEnv, nextOwn: own, nextSpec: spec,
        requestedKeys: [], forceRebuild: false, commitSpec: false,
      });
      return previousMatchesBase ? previousImage : approved;
    }
    const handle = this.images.startLayered({
      approvedImage: approved,
      globalSpec: globalEnv,
      projectSpec,
      resources: { cpus: spec.cpus, memory_mb: spec.memory_mb },
      egress: spec.egress,
      forceRebuild,
      onProgress: snapshot => record(snapshot),
    });
    try {
      const result = await handle.promise;
      const finished_at = new Date().toISOString();
      if (spec.egress === globalEnv.egress && result.globalImage?.Id && result.globalImage.Id !== approved.Id && (globalEnv.packages.length || normalizeScript(globalEnv.setup_script))) {
        const cachedGlobal = await this.images.findCachedLayer({ fromImageId: approved.Id, packages: globalEnv.packages, setupScript: globalEnv.setup_script, env: globalEnv.env, egress: globalEnv.egress });
        if (cachedGlobal.tag) this.setCurrentGlobalImage({ id: result.globalImage.Id, tag: cachedGlobal.tag, image_key: cachedGlobal.imageKey, base_image_id: approved.Id, finished_at });
      }
      const existingOutput = JSON.parse(this.get(repo)?.build || '{}').output || null;
      record({
        build_id: handle.build_id, image_key: result.image_key, tag: result.tag, phase: projectSpec.packages.length || normalizeScript(projectSpec.setup_script) ? 'project' : 'global',
        state: 'ready', queue_position: null, output: result.output ? result.output.slice(-16000) : existingOutput, can_cancel: false, finished_at,
      });
      this.recordPrecompiledSetup(repo, this.get(repo)?.generation || 1, globalEnv.setup_script, projectSpec.setup_script, 'succeeded', finished_at, result.output);
      return result.image;
    } catch (error) {
      const finished_at = new Date().toISOString();
      const cancelled = !!error?.cancelled;
      record({
        build_id: handle.build_id, state: cancelled ? 'cancelled' : 'failed', queue_position: null,
        output: (error?.output || null)?.slice(-16000) ?? null, can_cancel: false, finished_at,
      });
      if (hasSetup) this.recordPrecompiledSetup(repo, this.get(repo)?.generation || 1, globalEnv.setup_script, projectSpec.setup_script, cancelled ? 'cancelled' : 'failed', finished_at, error?.output || null);
      throw error;
    }
  }
  recordPrecompiledSetup(repo, generation, globalScript, projectScript, state, finishedAt, output = null) {
    const combined = [normalizeScript(globalScript), normalizeScript(projectScript)].filter(Boolean).join('\n---\n');
    if (!combined) {
      this.db.prepare('UPDATE projects SET setup=NULL WHERE repository_id=?').run(repo);
      return;
    }
    this.db.prepare('UPDATE projects SET setup=? WHERE repository_id=?').run(JSON.stringify({
      mode: 'precompiled', generation, hash: digest(combined), state,
      exit_code: state === 'succeeded' ? 0 : null, timed_out: false,
      error: state === 'cancelled' ? 'image_build_cancelled' : state === 'failed' ? 'image_build_failed' : null,
      output: output ? String(output).slice(-8000) : null, finished_at: finishedAt,
    }), repo);
  }
  startProjectBuild(repo, { approvedImage, toolchain, globalSpec, nextOwn, nextSpec, requestedKeys = [], forceRebuild, commitSpec = true }) {
    const existing = this.projectBuildJobs.get(repo);
    if (existing) {
      existing.superseded = true;
      existing.handle.cancel();
      this.projectBuildJobs.delete(repo);
    }
    const projectSpec = { packages: normalizePackages(nextOwn.packages || []), setup_script: nextOwn.setup_script || '', env: nextOwn.env || {} };
    const effectivePackages = normalizePackages([...globalSpec.packages, ...projectSpec.packages]);
    const hasSetup = !!(normalizeScript(globalSpec.setup_script) || normalizeScript(projectSpec.setup_script));
    const job = { handle: null, state: null, superseded: false, promise: null, applyPromise: null };
    const recordBuild = value => {
      this.db.prepare('UPDATE projects SET build=? WHERE repository_id=?').run(JSON.stringify(value), repo);
    };
    const handle = this.images.startLayered({
      approvedImage,
      globalSpec,
      projectSpec,
      resources: { cpus: nextSpec.cpus, memory_mb: nextSpec.memory_mb },
      egress: nextSpec.egress,
      forceRebuild,
      onProgress: snapshot => {
        if (job.superseded) return;
        job.state = { ...snapshot, toolchain, packages: effectivePackages };
        recordBuild(job.state);
      },
    });
    job.handle = handle;
    if (!job.state) {
      job.state = {
        build_id: handle.build_id, image_key: null, tag: null, phase: projectSpec.packages.length || normalizeScript(projectSpec.setup_script) ? 'project' : 'global',
        state: 'queued', queue_position: null, started_at: null, updated_at: new Date().toISOString(), finished_at: null,
        output: null, can_cancel: true, toolchain, packages: effectivePackages,
      };
      recordBuild(job.state);
    }
    this.projectBuildJobs.set(repo, job);
    job.promise = handle.promise.then(async result => {
      if (job.superseded) return result;
      const finished_at = new Date().toISOString();
      if (nextSpec.egress === globalSpec.egress && result.globalImage?.Id && result.globalImage.Id !== approvedImage.Id && (globalSpec.packages.length || normalizeScript(globalSpec.setup_script))) {
        const cachedGlobal = await this.images.findCachedLayer({ fromImageId: approvedImage.Id, packages: globalSpec.packages, setupScript: globalSpec.setup_script, env: globalSpec.env, egress: globalSpec.egress });
        if (cachedGlobal.tag) this.setCurrentGlobalImage({ id: result.globalImage.Id, tag: cachedGlobal.tag, image_key: cachedGlobal.imageKey, base_image_id: approvedImage.Id, finished_at });
      }
      const finalBuild = {
        build_id: handle.build_id, image_key: result.image_key, image_id: result.image.Id, tag: result.tag,
        phase: projectSpec.packages.length || normalizeScript(projectSpec.setup_script) ? 'project' : 'global',
        state: 'ready', queue_position: null, toolchain, packages: effectivePackages,
        output: result.output ? result.output.slice(-16000) : (job.state?.output || null),
        can_cancel: false, started_at: job.state?.started_at || finished_at, updated_at: finished_at, finished_at,
      };
      job.state = finalBuild;
      recordBuild(finalBuild);
      const apply = this.lock(repo, async () => {
        if (job.superseded) return;
        const current = this.get(repo);
        if (!current || current.state === 'deleted') return;
        if (commitSpec) {
          this.db.prepare('UPDATE projects SET spec=?, spec_revision=spec_revision+1, configured_keys=? WHERE repository_id=?')
            .run(JSON.stringify(nextOwn), JSON.stringify(requestedKeys), repo);
        }
        this.recordPrecompiledSetup(repo, current.generation, globalSpec.setup_script, projectSpec.setup_script, 'succeeded', finished_at, result.output);
        // Deferred recovery builds (!commitSpec) never interrupt running tasks by stopping the container directly:
        // describe() reports image_pending=true so the control plane switches cleanly via claim-gated idle refresh.
        if (!commitSpec) return;
        if (current.desired === 'ready' && current.state !== 'reset_failed') {
          this.background.delete(repo);
          await this.stopGeneration(repo, current.generation);
          await this.provision(repo);
        }
      }).catch(error => logFailure(`project ${repo} apply after precompiled build failed`, error));
      job.applyPromise = apply;
      await apply;
      if (this.projectBuildJobs.get(repo) === job) this.projectBuildJobs.delete(repo);
      return result;
    }, error => {
      if (job.superseded) return null;
      const finished_at = new Date().toISOString();
      const cancelled = !!error?.cancelled;
      const finalBuild = {
        build_id: handle.build_id, image_key: job.state?.image_key ?? null, tag: job.state?.tag ?? null,
        phase: job.state?.phase ?? 'project', state: cancelled ? 'cancelled' : 'failed', queue_position: null,
        toolchain, packages: effectivePackages,
        output: (error?.output || job.state?.output || null)?.slice(-16000) ?? null,
        can_cancel: false, started_at: job.state?.started_at || null, updated_at: finished_at, finished_at,
      };
      job.state = finalBuild;
      recordBuild(finalBuild);
      if (hasSetup) this.recordPrecompiledSetup(repo, this.get(repo)?.generation || 1, globalSpec.setup_script, projectSpec.setup_script, cancelled ? 'cancelled' : 'failed', finished_at, finalBuild.output);
      if (this.projectBuildJobs.get(repo) === job) this.projectBuildJobs.delete(repo);
      return null;
    });
    return job;
  }
  cancelBuild(repo) {
    this.validate(repo);
    if (!this.get(repo)) throw new ManagerError('project_not_registered', 404);
    const job = this.projectBuildJobs.get(repo);
    if (!job) return { cancelled: false, environment: this.describe(repo) };
    const cancelled = job.handle.cancel();
    return { cancelled, environment: this.describe(repo) };
  }
  async waitForBuild(repo) {
    const job = this.projectBuildJobs.get(repo);
    if (job?.promise) await job.promise;
    if (job?.applyPromise) await job.applyPromise;
    return this.describe(repo);
  }
  // Live resource use; read-only and outside the project lock. Workspace size is sampled at most once a minute.
  async stats(repo) {
    this.validate(repo); const project = this.get(repo); if (!project) throw new ManagerError('project_not_registered', 404);
    const container = await this.inspect(repo, project.generation, 'container');
    if (!container?.State.Running) return { running: false };
    const name = this.names(repo, project.generation).container, cached = this.usage.get(repo);
    let usage = cached && Date.now() - cached.at < 60000 ? cached.value : null;
    if (!usage) {
      const result = await this.docker.runner(name, { operation_id: randomId(), type: 'usage' }).catch(() => null);
      usage = result?.ok ? result.result : null; this.usage.set(repo, { at: Date.now(), value: usage });
    }
    return { running: true, ...(await this.docker.stats(name)), workspace_bytes: usage?.workspace_bytes ?? null, sampled_at: new Date().toISOString() };
  }
  register(repo) {
    this.validate(repo);
    return this.lock(repo, async () => {
      const existing = this.get(repo);
      // A project on its way out (`desired` deleted, whether the row still says deleted or failed) is not a running
      // project: connecting the repository again starts a new one, and the old notes must not be read by it.
      if (existing && existing.desired !== 'deleted') return existing;
      // A deletion that committed but could not remove its notes volume still owes that cleanup (#774).
      await this.reclaimStaleNotes(repo);
      if (existing) {
        // The project was deleted but its row stayed: connecting the repository again starts a new project, not the old one.
        this.db.prepare('DELETE FROM resources WHERE repository_id=?').run(repo);
        this.db.prepare('DELETE FROM operations WHERE repository_id=?').run(repo);
        this.db.prepare('DELETE FROM projects WHERE repository_id=?').run(repo);
      }
      this.db.prepare("INSERT INTO projects(repository_id,generation,state,desired,error,started_at) VALUES(?,1,'provisioning','ready',NULL,NULL)").run(repo);
      try { return await this.provision(repo); }
      catch (error) { logFailure(`project ${repo} first provision failed`, error); this.update(repo, 'failed', 'ready', error instanceof ManagerError ? error.message : 'provision_failed'); throw error; }
    });
  }
  // Stops leftover processes without restarting the container; falls back to a restart if any survive. With a workspace,
  // only that task's processes end (its waiting agent survives with keep_agent), so other tasks on the computer keep
  // running; without one, everything ends except init, the idle keeper and the runner itself. The caller holds a shared
  // slot, so the restart is queued to run alone rather than done here, under other tasks' calls.
  async reap(repo, generation, scope = {}) {
    const result = await this.docker.runner(this.names(repo, generation).container, { operation_id: randomId(), type: 'reap', ...scope }).catch(error => ({ ok: false, error }));
    if (result?.ok) return result.result;
    this.restartAlone(repo, generation, 'its leftover processes could not be ended', result?.error);
    return { restart_queued: true };
  }
  // Restarts a computer under the exclusive lock: it waits for the runner calls running now, and calls that arrive later
  // wait for it, so no call finds the container changed under it (which would stop the computer as failed). Processes of
  // the tasks on it end with the restart, so those tasks start again; the work volume and generation stay. A computer
  // has at most one restart queued, and one that has meanwhile been stopped, reset or reconfigured is left as it is.
  restartAlone(repo, generation, reason, cause) {
    if (this.restarting.has(repo)) return; this.restarting.add(repo);
    logFailure(`project ${repo} restart queued: ${reason}`, cause || 'no detail');
    void this.lock(repo, async () => {
      try {
        const project = this.get(repo);
        if (project?.generation !== generation || project.desired !== 'ready' || !['ready', 'busy'].includes(project.state)) return;
        this.update(repo, 'recovering', 'ready'); this.background.delete(repo);
        await this.stopAll(repo); await this.provision(repo);
      } catch (error) {
        // desired stays ready, so the control plane starts it again.
        logFailure(`project ${repo} restart failed`, error); this.update(repo, 'failed', 'ready', error instanceof ManagerError ? error.message : 'recovery_failed');
      }
    }).finally(() => this.restarting.delete(repo));
  }
  async output(repo, operation, offset) {
    this.validate(repo);
    if (!/^[a-f0-9]{48}$/.test(operation) || !Number.isSafeInteger(offset) || offset < 0) throw new ManagerError('invalid_operation', 400);
    const project = this.get(repo); if (!project) throw new ManagerError('project_not_registered', 404);
    const container = await this.inspect(repo, project.generation, 'container');
    if (!container?.State.Running) return { data: '', offset, size: 0, state: 'unavailable' };
    // Read-only and outside the project lock, so it works while the command holds the lock.
    const result = await this.docker.runner(this.names(repo, project.generation).container, { operation_id: operation, type: 'tail', offset });
    if (!result.ok) throw new ManagerError('output_unavailable', 503);
    return result.result;
  }
  async executeHarnessPoll(repo, input) {
    const project = this.get(repo);
    if (!project) throw new ManagerError('project_not_registered', 404);
    if (project.generation !== input.generation) throw new ManagerError('stale_generation');
    if (!['ready', 'busy'].includes(project.state)) throw new ManagerError('environment_not_ready');
    const container = await this.inspect(repo, project.generation, 'container');
    if (!container?.State.Running || container.State.StartedAt !== project.started_at) {
      this.restartAlone(repo, input.generation, 'its container stopped or restarted outside the manager');
      throw new ManagerError('recovery_required');
    }
    return this.docker.runner(this.names(repo, project.generation).container, { ...input.request, operation_id: input.operation_id }, 90000);
  }
  async operate(repo, action, input) {
    this.validate(repo);
    if (!['start', 'stop', 'reset', 'delete', 'execute', 'configure', 'refresh'].includes(action) || !/^[a-f0-9]{48}$/.test(input.operation_id || '') || !Number.isSafeInteger(input.generation)) throw new ManagerError('invalid_operation', 400);
    // An invalid spec or runner request is rejected before it is recorded, so it never touches the running computer.
    if (action === 'configure') validateSpec(input.request);
    if (action === 'execute') validateCall(input.request);
    if (action === 'delete' && input.request !== undefined && (!input.request || Object.keys(input.request).some(key => key !== 'delete_notes') || input.request.delete_notes !== true)) throw new ManagerError('invalid_operation', 400);
    // Read-only container harness polling runs outside the shared parallel slot (unless a lifecycle action holds the
    // exclusive lock) and skips ledger/trajectory fsyncs so active polling neither starves concurrent mailbox replies nor
    // bloats the manager database (#705).
    if (action === 'execute' && input.request.type === 'workspace_harness_poll') {
      return this.gates.get(repo)?.exclusive ? this.lock(repo, () => this.executeHarnessPoll(repo, input), true) : this.executeHarnessPoll(repo, input);
    }
    // Running commands hold their slots; a new stop, reset or delete interrupts all of them by stopping the container.
    if (['stop', 'reset', 'delete'].includes(action) && this.running(repo) && !this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(input.operation_id)
      && this.get(repo)?.generation === input.generation) await this.stopGeneration(repo, input.generation).catch(() => {});
    return this.lock(repo, async () => {
      const encoded = JSON.stringify(input), hash = digest(encoded), old = this.db.prepare('SELECT * FROM operations WHERE id=?').get(input.operation_id);
      if (old) {
        // A row recorded since #436 keeps the hash of its input; an older one the input itself.
        if (old.repository_id !== repo || old.action !== action || (old.input_sha256 ? old.input_sha256 !== hash : old.input !== encoded)) throw new ManagerError('operation_id_conflict');
        if (old.state === 'completed') {
          if (!old.result_ref) return JSON.parse(old.result);
          // A recorded result that fails its hash is refused rather than run again; one removed after its retention
          // window (TrajectoryExpiry) is answered as expired, never with another result.
          try { return this.trajectories.read(old.result_ref).data; } catch (error) {
            if (error?.code === 'trajectory_expired') throw new ManagerError('operation_result_expired', 410);
            logFailure(`operation ${input.operation_id} result`, error); throw new ManagerError('operation_record_unreadable');
          }
        }
        throw new ManagerError('operation_interrupted');
      }
      const project = this.get(repo);
      if (!project) throw new ManagerError('project_not_registered', 404);
      if (project.generation !== input.generation) throw new ManagerError('stale_generation');
      // Other tasks' calls keep the computer busy; that alone never refuses a call.
      if (action === 'execute' && !['ready', 'busy'].includes(project.state)) throw new ManagerError('environment_not_ready');
      if (action === 'start' && project.state === 'reset_failed') throw new ManagerError('reset_required');
      // The input goes to the file of the project and task workspace first; the row keeps its header, hash and ref.
      const scope = Trajectories.scope(repo, action === 'execute' ? input.request.workspace_id : undefined);
      this.db.prepare("INSERT INTO operations(id,repository_id,action,generation,input,state,result,input_ref,input_sha256) VALUES(?,?,?,?,?,'running',NULL,?,?)")
        .run(input.operation_id, repo, action, input.generation, JSON.stringify(inputHeader(input)), this.trajectories.append(scope, 'tool_call', input.operation_id, sanitizeTrajectoryInput(input)), hash);
      try {
        let result;
        if (action === 'configure') {
          // Only the project's own values are saved; a null resource is removed, so it follows the default again.
          const { rerun_setup: rerun, rebuild, ...requested } = input.request;
          const own = { ...this.own(repo), ...requested };
          for (const key of resourceKeys) if (own[key] === null) delete own[key];
          if (own.packages !== undefined) own.packages = normalizePackages(own.packages);
          const forceRebuild = rebuild === true || rerun === true;
          const globalEnv = this.globalEnvironmentDefaults(), globalRes = this.resourceDefaults();
          const nextSpec = {
            ...defaults,
            ...globalRes,
            egress: own.egress ?? globalEnv.egress,
            ...own,
            packages: normalizePackages([...globalEnv.packages, ...(own.packages || [])]),
            env: { ...globalEnv.env, ...(own.env || {}) },
            setup_script: own.setup_script || '',
          };
          const approved = await this.docker.request('GET', `/images/${encodeURIComponent(this.image)}/json`);
          if (!approved?.Id) throw new ManagerError('approved_image_missing', 503);
          const toolchain = approved.Config?.Labels?.['department.bot.toolchain'] || null;
          const projectOverlay = { packages: normalizePackages(own.packages || []), setup_script: own.setup_script || '', env: own.env || {} };
          const requestedKeys = Object.keys(requested);
          const cache = await this.images.checkLayeredCache({ approvedImage: approved, globalSpec: globalEnv, projectSpec: projectOverlay, egress: nextSpec.egress });
          const needsBuild = forceRebuild ? (nextSpec.packages.length > 0 || !!normalizeScript(globalEnv.setup_script) || !!normalizeScript(projectOverlay.setup_script)) : !cache.cached;
          if (!needsBuild) {
            const pendingJob = this.projectBuildJobs.get(repo);
            if (pendingJob) { pendingJob.superseded = true; pendingJob.handle.cancel(); this.projectBuildJobs.delete(repo); }
            this.db.prepare('UPDATE projects SET spec=?, spec_revision=spec_revision+1, configured_keys=? WHERE repository_id=?')
              .run(JSON.stringify(own), JSON.stringify(requestedKeys), repo);
            if (project.desired === 'ready' && project.state !== 'reset_failed') {
              this.background.delete(repo); await this.stopGeneration(repo, project.generation); await this.provision(repo);
            } else {
              const finished_at = new Date().toISOString();
              this.db.prepare('UPDATE projects SET build=? WHERE repository_id=?').run(JSON.stringify({
                state: cache.tag ? 'ready' : 'none', tag: cache.tag, image_key: cache.image_key, toolchain,
                packages: nextSpec.packages, can_cancel: false, finished_at,
              }), repo);
              this.recordPrecompiledSetup(repo, project.generation, globalEnv.setup_script, projectOverlay.setup_script, 'succeeded', finished_at, null);
            }
          } else {
            // Asynchronous build outside the project lock: running container and tasks stay uninterrupted while
            // live progress streams and callers may cancel at any time.
            this.startProjectBuild(repo, { approvedImage: approved, toolchain, globalSpec: globalEnv, nextOwn: own, nextSpec, requestedKeys, forceRebuild });
          }
          result = this.describe(repo);
        } else if (action === 'refresh') {
          // Applies the current spec, such as changed resource defaults, to a ready computer. provision replaces the container
          // only when it differs; the work volume and generation stay. The control plane sends it only while no task runs there.
          if (project.desired === 'ready' && project.state === 'ready') { this.background.delete(repo); await this.provision(repo); }
          result = this.describe(repo);
        } else if (action === 'execute') {
          if (project.state === 'ready') this.update(repo, 'busy', 'ready', null, project.started_at);
          const container = await this.inspect(repo, project.generation, 'container');
          if (!container?.State.Running || container.State.StartedAt !== project.started_at) throw new ManagerError('recovery_required');
          const call = input.request, kept = this.kept(repo);
          if (call.type === 'reap') {
            // A task's release ends its own processes, kept background work included. The last task on the computer (idle)
            // clears every leftover process, so the next task starts on a clean computer.
            if (call.idle === true || !call.workspace_id) { kept.clear(); result = { ok: true, result: await this.reap(repo, project.generation) }; }
            else { kept.delete(call.workspace_id); result = { ok: true, result: await this.reap(repo, project.generation, { workspace_id: call.workspace_id }) }; }
          } else {
            // Commands run until they end unless the caller sets its own timeout_ms; stop, reset or delete interrupts them.
            const limit = call.timeout_ms == null ? null : Math.max(call.timeout_ms, 100), command = commandTypes.includes(call.type);
            const request = command ? { ...call, timeout_ms: limit } : call,
              timeout = command ? (limit === null ? 0 : limit + 60000) : ['workspace_restore','workspace_snapshot','workspace_finalize','workspace_blob','workspace_checkout','workspace_advance','workspace_worktree_create','workspace_worktree_bind','workspace_import_commits','workspace_verify_merge','git_import','tasks_remove','worktrees_remove'].includes(call.type) ? 0 : ['tasks_list','worktrees_list'].includes(call.type) ? 300000 : 90000;
            result = await this.docker.runner(this.names(repo, project.generation).container, { ...request, operation_id: input.operation_id }, timeout);
            if (['tasks_remove', 'worktrees_remove'].includes(call.type) && result.ok && result.result?.removed?.length) {
              // Exclude the pre-cleanup total until the next background check scans the volume.
              // A scan already in flight may have visited the deleted directories too.
              if (this.scanning === repo) this.scanInvalidated = true;
              this.db.prepare('DELETE FROM computer_storage WHERE repository_id=? AND generation=?').run(repo, project.generation);
            }
            if (commandTypes.includes(call.type)) {
              if (call.type === 'workspace_command' && call.keep_background === true && result.ok) kept.add(call.workspace_id);
              // Processes that escaped a task command's process group end here, unless the task keeps background work; the
              // task's waiting agent and every other task's processes stay. A plain command clears the computer as before.
              else if (!call.workspace_id) await this.reap(repo, project.generation);
              else if (!kept.has(call.workspace_id)) await this.reap(repo, project.generation, { workspace_id: call.workspace_id, keep_agent: true });
            }
          }
        } else {
          // #774: re-enabling or resetting a project that still owes a notes purge reclaims the old notes first, so the new
          // generation cannot read them; a refusal here leaves the row as it was instead of starting on top of the residue.
          // The state is not part of the test (#783): the purge marker is what says the cleanup is still owed.
          if (['start', 'reset'].includes(action)) await this.reclaimStaleNotes(repo);
          this.update(repo, action === 'reset' ? 'resetting' : 'recovering', action === 'stop' ? 'stopped' : action === 'delete' ? 'deleted' : 'ready');
          await this.stopAll(repo);
          if (action === 'reset') this.db.prepare('UPDATE projects SET generation=generation+1 WHERE repository_id=?').run(repo);
          if (action === 'start' || action === 'reset') result = await this.provision(repo);
          else {
            if (action === 'delete') {
              for (const { generation } of this.db.prepare('SELECT generation FROM resources WHERE repository_id=?').all(repo)) {
                if (await this.inspect(repo, generation, 'container')) await this.docker.request('DELETE', `/containers/${this.names(repo, generation).container}`);
                if (await this.inspect(repo, generation, 'network')) await this.docker.request('DELETE', `/networks/${this.names(repo, generation).network}`);
              }
              // Deleting just a computer keeps project notes; only the project-removal flow requests their deletion.
              if (input.request?.delete_notes) {
                try {
                  if (await this.notesVolume(repo, false)) await this.docker.request('DELETE', '/volumes/' + this.notesName(repo));
                  await rm(this.notesRoot + '/' + repo, { recursive: true, force: true });
                  this.db.prepare('UPDATE projects SET notes_purge=0 WHERE repository_id=?').run(repo);
                } catch (error) {
                  // The deletion is committed; the volume it could not remove is owed a purge, which the next enable, a
                  // notes read of the still-deleted project, or the sweep performs (#774).
                  this.db.prepare('UPDATE projects SET notes_purge=1 WHERE repository_id=?').run(repo);
                  throw error;
                }
              }
            }
            const state = action === 'stop' && project.state === 'reset_failed' ? 'reset_failed' : action === 'stop' ? 'stopped' : 'deleted';
            this.update(repo, state, action === 'stop' ? 'stopped' : 'deleted', state === 'reset_failed' ? project.error : null); result = this.get(repo);
          }
        }
        // A repeated call replays this result: it is on disk before the row points to it.
        const trajectoryResult = action === 'execute' ? sanitizeTrajectoryResult(input.request.type, result) : result;
        const resultRef = this.trajectories.append(scope, 'tool_result', input.operation_id, trajectoryResult);
        await this.trajectories.sync(resultRef);
        this.db.prepare("UPDATE operations SET state='completed',result=NULL,result_ref=? WHERE id=?").run(resultRef, input.operation_id);
        // A task's release ends its workspace's calls: its file is complete.
        if (action === 'execute' && input.request.type === 'reap' && input.request.workspace_id) this.trajectories.close(scope.key);
        return result;
      } catch (error) {
        if (error?.untouched) { this.db.prepare("UPDATE operations SET state='interrupted' WHERE id=?").run(input.operation_id); throw error; }
        // The container stopped or restarted on its own before this call ran anything in it: the call fails, so its task
        // starts again, and the computer is brought back alone instead of being stopped as failed.
        if (error?.message === 'recovery_required') {
          this.db.prepare("UPDATE operations SET state='interrupted' WHERE id=?").run(input.operation_id);
          this.restartAlone(repo, input.generation, 'its container stopped or restarted outside the manager'); throw error;
        }
        // A task's failed runner call ends that task's processes; when that works, the computer and the other tasks on it
        // keep running. When they cannot be ended, the computer is restarted alone, which ends them too: this call holds a
        // shared slot, and stopping the computer here would fail the other tasks' calls running beside it.
        const workspace = action === 'execute' ? input.request.workspace_id : undefined, current = this.get(repo);
        if (workspace && current?.generation === input.generation && ['ready', 'busy'].includes(current.state)) {
          const reaped = await this.docker.runner(this.names(repo, input.generation).container, { operation_id: randomId(), type: 'reap', workspace_id: workspace }).catch(() => null);
          this.kept(repo).delete(workspace); this.db.prepare("UPDATE operations SET state='interrupted' WHERE id=?").run(input.operation_id);
          if (!reaped?.ok) this.restartAlone(repo, input.generation, `a failed ${input.request.type} left processes that could not be ended`, error);
          throw error;
        }
        // Listing or removing task directories starts no project process, and a removal that goes on after a lost answer
        // deletes only what it was sent: the call fails, and the computer and the tasks on it keep running.
        if (action === 'execute' && isCleanupCall(input.request.type)) {
          logFailure(`project ${repo} ${input.request.type} failed`, error);
          this.db.prepare("UPDATE operations SET state='interrupted' WHERE id=?").run(input.operation_id); throw error;
        }
        if(action==='execute'&&!workspace&&current?.generation===input.generation&&['ready','busy'].includes(current.state)){
          const container=this.names(repo,input.generation).container;
          const reaped=await this.docker.runner(container,{operation_id:randomId(),type:'reap_operation',target_operation_id:input.operation_id},10000).catch(()=>null);
          const health=await this.docker.runner(container,{operation_id:randomId(),type:'health'},10000).catch(()=>null);
          if(reaped?.ok&&health?.ok&&health.result?.ready){
            logFailure(`project ${repo} ${input.request.type} failed, operation ended and runner healthy`,error);
            this.db.prepare("UPDATE operations SET state='interrupted' WHERE id=?").run(input.operation_id);throw error;
          }
          logFailure(`project ${repo} operation recovery failed (${!reaped?.ok?'operation cleanup failed':'runner health check failed'})`,error);
        }
        // A failed lifecycle action or a runner that cannot be recovered still stops the computer.
        logFailure(`project ${repo} ${action === 'execute' ? input.request.type : action} failed, computer stopped`, error);
        try { await this.stopAll(repo); } catch {}
        // A deletion that only failed to remove the notes volume stays deleted: the rows and the computer are gone, and the
        // leftover volume is what #774's reclaim and sweep clean up (#758 already reports it instead of failing the call).
        // A re-enable that failed before it changed the row (the residue could not be cleared) stays deleted for the same
        // reason: turning it 'failed' would make the next notes read mistake the residue for a live project's notes.
        const staysDeleted = action === 'delete' || this.get(repo)?.state === 'deleted';
        this.update(repo, staysDeleted ? 'deleted' : action === 'reset' ? 'reset_failed' : 'failed',
          staysDeleted ? 'deleted' : 'stopped', error instanceof ManagerError ? error.message : 'operation_failed');
        this.db.prepare("UPDATE operations SET state='interrupted' WHERE id=?").run(input.operation_id);
        throw error;
      }
    }, action === 'execute');
  }
  async recover() {
    const interrupted = this.reconcileInterruptedBuilds();
    await this.reconcileGlobalImage().catch(error => logFailure('reconciling global precompiled image on start failed', error));
    for (const row of this.list()) await this.lock(row.repository_id, async () => {
      const pending = this.db.prepare("SELECT action FROM operations WHERE repository_id=? AND state='running'").all(row.repository_id);
      this.db.prepare("UPDATE operations SET state='interrupted' WHERE repository_id=? AND state='running'").run(row.repository_id);
      try {
        await this.stopAll(row.repository_id);
        if (pending.some(p => p.action === 'reset')) { this.update(row.repository_id, 'reset_failed', 'stopped', 'reset_interrupted'); return; }
        if (row.state === 'reset_failed') return;
        if (row.desired === 'ready') {
          this.update(row.repository_id, 'recovering', 'ready');
          await this.provision(row.repository_id, { deferBuild: true });
          // Preserve the interrupted-build notice when recovery reused a cached image (and did not enqueue a new build).
          if (interrupted.has(row.repository_id) && !this.projectBuildJobs.has(row.repository_id)) {
            this.db.prepare('UPDATE projects SET build=? WHERE repository_id=?').run(interrupted.get(row.repository_id), row.repository_id);
          }
        }
        else this.update(row.repository_id, row.desired, row.desired, row.error);
      } catch (error) { logFailure(`project ${row.repository_id} recovery on start failed`, error); this.update(row.repository_id, row.state === 'resetting' ? 'reset_failed' : 'failed', 'stopped', 'recovery_failed'); }
    });
  }
  protectedImageRefs(assistantImages = []) {
    const protectedImageIds = new Set(), protectedTags = new Set();
    const globalImg = this.currentGlobalImage();
    if (globalImg?.id) protectedImageIds.add(globalImg.id);
    if (globalImg?.tag) protectedTags.add(globalImg.tag);
    for (const row of this.db.prepare("SELECT r.image FROM resources r JOIN projects p ON p.repository_id=r.repository_id AND p.generation=r.generation WHERE p.state<>'deleted'").all()) {
      if (row.image) protectedImageIds.add(row.image);
    }
    for (const ref of assistantImages || []) {
      if (!ref) continue;
      if (String(ref).startsWith('sha256:')) protectedImageIds.add(ref);
      else protectedTags.add(ref);
    }
    return { protectedImageIds, protectedTags };
  }
  listPrecompiledImages(assistantImages = []) {
    return this.images.listImages(this.protectedImageRefs(assistantImages));
  }
  prunePrecompiledImages(assistantImages = [], options = {}) {
    return this.images.prune({ ...this.protectedImageRefs(assistantImages), ...options });
  }
  // Liveness check of idle computers only: one with runner calls in flight is skipped rather than queued behind them.
  async check(assistantImages = []) {
    for (const row of this.list()) if (['ready', 'busy'].includes(row.state)) this.prune(row.repository_id);
    this.scanStorage(); void this.readDockerUsage(); void this.refreshFootprint();
    void this.reconcileGlobalImage().catch(error => logFailure('reconciling global precompiled image failed', error));
    if (Date.now() - this.lastPruneAt >= 30 * 60_000) {
      this.lastPruneAt = Date.now();
      void this.prunePrecompiledImages(assistantImages, { force: false }).catch(error => logFailure('precompiled image GC failed', error));
    }
    await Promise.all(this.list().filter(p => p.state === 'ready' && !this.gates.has(p.repository_id)).map(row => this.lock(row.repository_id, async () => {
      const current = this.get(row.repository_id); if (current.state !== 'ready') return;
      try {
        const container = await this.inspect(row.repository_id, current.generation, 'container');
        if (!container?.State.Running || container.State.StartedAt !== current.started_at) {
          this.update(row.repository_id, 'recovering', 'ready'); await this.stopAll(row.repository_id); await this.provision(row.repository_id);
        }
      } catch (error) { logFailure(`project ${row.repository_id} recovery after its container stopped failed`, error); this.update(row.repository_id, 'failed', 'stopped', 'recovery_failed'); }
    })));
  }
  // The storage page's numbers from this manager: trajectory totals per project (kind 'open' sizes the files still being
  // written, one per running task; 'expired' counts the files removed after their window), the ledger's size and free
  // pages, the disk with its reserve, the migration and the expiry. The PRAGMAs read the database header and
  // trajectory_usage holds a few rows per project: nothing here scans the ledger.
  storage() {
    const value = pragma => Number(Object.values(this.db.prepare('PRAGMA ' + pragma).get() ?? {})[0] ?? 0);
    const pageSize = value('page_size'), pages = value('page_count'), free = value('freelist_count'), data = dirname(this.trajectories.root);
    const usage = this.db.prepare('SELECT repository_id,kind,count,bytes FROM trajectory_usage').all(), open = new Map();
    for (const row of this.db.prepare('SELECT repository_id,path FROM trajectory_files WHERE closed_at IS NULL').all()) {
      let bytes = 0; try { bytes = statSync(this.trajectories.root + '/' + row.path).size; } catch {}
      const entry = open.get(row.repository_id) ?? { repository_id: row.repository_id, kind: 'open', count: 0, bytes: 0 }; entry.count++; entry.bytes += bytes; open.set(row.repository_id, entry);
    }
    let wal = 0; try { wal = statSync(data + '/manager.sqlite-wal').size; } catch {}
    // The last scan of each computer's work volume, and Docker's images, containers and build cache, as the background work
    // left them.
    const computers = this.db.prepare('SELECT s.repository_id,s.generation,s.scanned_at,s.result FROM computer_storage s JOIN projects p ON p.repository_id=s.repository_id AND p.generation=s.generation WHERE p.state<>\'deleted\'').all().map(row => ({ ...row, result: JSON.parse(row.result) }));
    const docker = JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='docker_usage'").get()?.value ?? 'null');
    const compaction = JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='compaction'").get()?.value ?? 'null');
    const precompiledRows = this.db.prepare('SELECT image_key,state,size_bytes FROM precompiled_images').all();
    const precompiled = {
      count: precompiledRows.filter(r => r.state === 'ready').length,
      total_bytes: precompiledRows.filter(r => r.state === 'ready').reduce((sum, r) => sum + (Number(r.size_bytes) || 0), 0),
      queue_length: this.images.queue.length,
      active_build: this.images.active ? { image_key: this.images.active.imageKey, tag: this.images.active.tag, kind: this.images.active.kind, started_at: this.images.active.startedAt } : null,
    };
    return { footprint: this.footprint ?? null, workspace_projects: this.db.prepare("SELECT DISTINCT r.repository_id FROM resources r JOIN projects p ON p.repository_id=r.repository_id AND p.generation=r.generation WHERE p.state<>'deleted'").all().map(row => row.repository_id), usage: [...usage, ...open.values()], database: { bytes: pageSize * pages, pages, page_size: pageSize, free_pages: free, free_bytes: pageSize * free, wal_bytes: wal, auto_vacuum: value('auto_vacuum') },
      disk: this.disk.check(), migration: this.migration.state(), expiry: this.expiry.state(), computers, docker, compaction, vacuum: this.vacuum.state(), precompiled_images: precompiled };
  }
  /** Saves the expiry window in days (1–365); the next expiry pass uses it. */
  setRetention(input) {
    if (!input || Object.keys(input).some(key => key !== 'payload_days') || !Number.isSafeInteger(input.payload_days) || input.payload_days < 1 || input.payload_days > 365)
      throw new ManagerError('invalid_retention', 400);
    this.db.prepare("INSERT INTO settings VALUES('payload_retention',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ days: input.payload_days }));
    return this.expiry.state();
  }
  async shutdown() {
    await this.images.shutdown();
    await this.migration.stop(); await this.expiry.stop(); await this.vacuum.stop(); await Promise.all([...this.pending]); for (const row of this.list()) await this.stopAll(row.repository_id);
    this.trajectories.closeAll(); await this.trajectories.settle(); this.db.close();
  }
}
