import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { ManagerError } from './docker.mjs';
import { Notes, noteName } from '../runner/notes.mjs';

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
const bounds = { cpus: [0.25, 16], memory_mb: [256, 65536], pids: [64, 16384], tmp_mb: [16, 16384] };
const resourceKeys = Object.keys(bounds), resources = spec => Object.fromEntries(resourceKeys.map(key => [key, spec[key]]));
const mib = 1024 * 1024;
// CPUs in steps of 0.01, the other resources whole numbers, all inside their bounds.
function validResource(key, value) {
  const [min, max] = bounds[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (key === 'cpus' ? Math.round(value * 100) === value * 100 : Number.isInteger(value));
}
// Debian package names only (no options, files or URLs); environment names that the computer or runner own are refused.
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,99}(?::[a-z0-9-]{1,20})?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/, reservedEnv = new Set(['PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL', 'PWD', 'HOSTNAME', 'NPM_CONFIG_PREFIX']);
export function validateSpec(input) {
  const keys = ['egress', 'packages', 'env', 'setup_script', 'rerun_setup', ...Object.keys(bounds)];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new ManagerError('invalid_spec', 400);
  // null clears the project's own value, so the resource follows the default again.
  for (const key of resourceKeys) if (input[key] != null && !validResource(key, input[key])) throw new ManagerError('invalid_spec', 400);
  for (const key of ['egress', 'rerun_setup']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ManagerError('invalid_spec', 400);
  if (input.packages !== undefined && (!Array.isArray(input.packages) || input.packages.length > 100 || new Set(input.packages).size !== input.packages.length
    || input.packages.some(name => typeof name !== 'string' || !PACKAGE_NAME.test(name)))) throw new ManagerError('invalid_packages', 400);
  if (input.env !== undefined && (!input.env || typeof input.env !== 'object' || Array.isArray(input.env) || Object.keys(input.env).length > 64
    || Object.entries(input.env).some(([name, value]) => !ENV_NAME.test(name) || reservedEnv.has(name) || /^(BOT_|GIT_)/.test(name)
      || typeof value !== 'string' || value.length > 4096 || value.includes('\0')))) throw new ManagerError('invalid_env', 400);
  if (input.setup_script !== undefined && (typeof input.setup_script !== 'string' || input.setup_script.length > 16384 || input.setup_script.includes('\0'))) throw new ManagerError('invalid_setup_script', 400);
  return input;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const commandTypes = ['command', 'workspace_command'];
export const parallelBounds = [1, 32];
const runnerTypes = ['command','read','write','workspace_init','workspace_acceptance','workspace_source','workspace_restore','workspace_checkout','workspace_context','git_have','git_pack','git_import','git_export','workspace_write','workspace_snapshot','workspace_read','workspace_command','workspace_finalize','workspace_blob','workspace_reuse','workspace_cache','workspace_agent_history','workspace_agent_session','workspace_agent_boundary','workspace_agent_continue','workspace_agent_config','workspace_agent_start','workspace_agent_poll','workspace_agent_reply','workspace_agent_progress','workspace_agent_token','workspace_agent_repository_tool','workspace_agent_pull_request','workspace_agent_live','workspace_agent_runtime','workspace_agent_control_tool','reap'];
const runnerKeys = ['type','command','path','content','timeout_ms','keep_background','workspace_id','source_workspace_id','base64','offset','author_email','final','mode','snapshot','sha','tree_sha','config','request_id','sequence','idle','pack_id','commits'];
// A runner request is checked before it can touch the computer, so a malformed one never interrupts other tasks.
function validateCall(call) {
  if (!call || !runnerTypes.includes(call.type) || Object.keys(call).some(k => !runnerKeys.includes(k))) throw new ManagerError('invalid_runner_request', 400);
  if (call.workspace_id !== undefined && !/^[a-f0-9]{48}$/.test(call.workspace_id) || call.idle !== undefined && call.idle !== true) throw new ManagerError('invalid_runner_request', 400);
  if (call.source_workspace_id !== undefined && (!['workspace_acceptance','workspace_restore'].includes(call.type) || !/^[a-f0-9]{48}$/.test(call.source_workspace_id))) throw new ManagerError('invalid_runner_request', 400);
  if (['workspace_acceptance','workspace_restore'].includes(call.type) && !/^[a-f0-9]{48}$/.test(call.source_workspace_id || '')) throw new ManagerError('invalid_runner_request', 400);
  if (call.timeout_ms != null && !(Number.isFinite(call.timeout_ms) && call.timeout_ms > 0)) throw new ManagerError('invalid_runner_request', 400);
}
export class Projects {
  constructor({ database, docker, deployment, image, egress = true }) {
    // background: repository -> task workspaces whose kept processes may outlive a command.
    // gates: repository -> runner calls running now, whether a lifecycle action holds the computer, and who waits.
    // restarting: computers with a restart queued under the exclusive lock (restartAlone).
    this.egress = egress; this.background = new Map(); this.usage = new Map(); this.gates = new Map(); this.pending = new Set(); this.restarting = new Set();
    // pruned: when each computer's journal was last pruned; pruning: computers with a prune running now.
    this.pruned = new Map(); this.pruning = new Set();
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(database); this.docker = docker; this.deployment = deployment; this.image = image;
    this.notesRoot = dirname(database) + '/project-notes';
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(repository_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,state TEXT NOT NULL,desired TEXT NOT NULL,error TEXT,started_at TEXT);
      CREATE TABLE IF NOT EXISTS resources(repository_id TEXT NOT NULL,generation INTEGER NOT NULL,image TEXT NOT NULL,PRIMARY KEY(repository_id,generation));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,action TEXT NOT NULL,generation INTEGER NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
    `);
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'revision')) this.db.exec('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    // spec: the requested computer; build: the image built for its packages; setup: the last setup script run.
    for (const column of ['spec', 'build', 'setup']) if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === column)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${column} TEXT`);
    // parallel: how many runner calls may share the computer, one per task the control plane may run there at once.
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'parallel')) this.db.exec('ALTER TABLE projects ADD COLUMN parallel INTEGER NOT NULL DEFAULT 1');
    // applied: the resources the current container was created with, so a changed default shows as pending.
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'applied')) this.db.exec('ALTER TABLE projects ADD COLUMN applied TEXT');
    this.db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
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
  spec(repo) { return { ...defaults, ...this.resourceDefaults(), egress: this.egress, ...this.own(repo) }; }
  describe(repo) {
    const project = this.get(repo); if (!project) return null;
    const resource = this.db.prepare('SELECT image FROM resources WHERE repository_id=? AND generation=?').get(repo, project.generation);
    const generations = this.db.prepare('SELECT count(*) AS n FROM resources WHERE repository_id=?').get(repo).n;
    const { spec: _saved, build, setup, applied, ...state } = project, spec = this.spec(repo), own = this.own(repo);
    // inherited: the resources that follow the default; resources_pending: the container still has other resources.
    return { ...state, computer: { ...this.names(repo, project.generation), image: resource?.image || null, user: '10001:10001', workdir: '/workspace',
      root_filesystem: 'read-only', network_policy: spec.egress ? 'internet egress' : 'internal, no egress', init: true,
      ...spec, build: build ? JSON.parse(build) : null, setup: setup ? JSON.parse(setup) : null, retained_generations: generations, bounds,
      defaults: this.resourceDefaults(), inherited: resourceKeys.filter(key => own[key] === undefined),
      resources_pending: !!applied && applied !== JSON.stringify(resources(spec)) } };
  }
  // The resource defaults with their bounds, and for reference the host's CPUs and memory and what the running computers
  // are given (computers share the host, so their totals may exceed it).
  async defaultsView() {
    const info = await this.docker.request('GET', '/info').catch(() => null);
    const running = this.list().filter(p => ['ready', 'busy'].includes(p.state)).map(p => this.spec(p.repository_id));
    return { defaults: this.resourceDefaults(), builtin, bounds, host: info?.NCPU ? { cpus: info.NCPU, memory_mb: Math.floor(info.MemTotal / mib) } : null,
      allocated: { computers: running.length, cpus: Math.round(running.reduce((sum, s) => sum + s.cpus, 0) * 100) / 100, memory_mb: running.reduce((sum, s) => sum + s.memory_mb, 0) } };
  }
  // New computers use the new defaults at once; a running one that follows them shows resources_pending until the control
  // plane sends refresh while no task uses it.
  async setDefaults(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.entries(input).some(([key, value]) => !resourceKeys.includes(key) || !validResource(key, value))) throw new ManagerError('invalid_defaults', 400);
    // Docker refuses to create a container that is given more CPUs than the host has.
    const info = await this.docker.request('GET', '/info').catch(() => null);
    if (info?.NCPU && input.cpus > info.NCPU) throw new ManagerError('cpus_exceed_host', 400);
    this.db.prepare("INSERT INTO settings VALUES('resource_defaults',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ ...this.resourceDefaults(), ...input }));
    return this.defaultsView();
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
  async notes(repo, method, name, input = {}) {
    this.validate(repo); if (name !== undefined) { try { noteName(name); } catch { throw new ManagerError('invalid_note_name', 400); } }
    if (!['GET','PUT','DELETE'].includes(method) || method !== 'GET' && name === undefined || Object.keys(input).some(key => key !== 'content')) throw new ManagerError('invalid_notes_request', 400);
    return this.lock(repo, async () => {
      // A page can edit notes before the first boot. Register only the stopped metadata, never provision a computer.
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
  labels(repo, generation, kind) { return { 'department.bot.deployment': this.deployment, 'department.bot.repository': repo,
    'department.bot.generation': String(generation), 'department.bot.kind': kind }; }
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
  async provision(repo, { forceSetup = false } = {}) {
    const project = this.get(repo), generation = project.generation, names = this.names(repo, generation), spec = this.spec(repo);
    const tmpfs = `rw,nosuid,nodev,noexec,size=${spec.tmp_mb * mib},mode=1777`, approved = await this.resolveImage(repo, spec);
    // Repository variables reach commands through the runner, which reads the names listed in BOT_PROJECT_ENV_KEYS.
    const env = ['HOME=/workspace/home', 'LANG=C.UTF-8', ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`), `BOT_PROJECT_ENV_KEYS=${Object.keys(spec.env).join(',')}`];
    let resource = this.db.prepare('SELECT image FROM resources WHERE repository_id=? AND generation=?').get(repo, generation);
    if (!resource) { this.db.prepare('INSERT INTO resources VALUES(?,?,?)').run(repo, generation, approved.Id); resource = { image: approved.Id }; }
    if (!await this.inspect(repo, generation, 'volume')) await this.docker.request('POST', '/volumes/create', { Name: names.volume, Labels: this.labels(repo, generation, 'volume') });
    await this.inspect(repo, generation, 'volume');
    await this.notesVolume(repo);
    let network = await this.inspect(repo, generation, 'network'), container = await this.inspect(repo, generation, 'container');
    // A container whose template or spec differs (approved image, init, resources, network policy) is replaced in place when
    // provisioned; the work volume and generation stay. This never happens in the middle of a command.
    const networkStale = network && network.Internal !== !spec.egress, host = container?.HostConfig;
    // Compare only the variables the manager sets (the image adds its own, such as PATH); old names come from BOT_PROJECT_ENV_KEYS.
    const current = container?.Config?.Env || [], listed = current.find(e => e.startsWith('BOT_PROJECT_ENV_KEYS='))?.slice(21).split(',').filter(Boolean) || [];
    const managed = new Set(['HOME', 'LANG', 'BOT_PROJECT_ENV_KEYS', ...Object.keys(spec.env), ...listed]);
    const envStale = container && JSON.stringify(current.filter(e => managed.has(e.slice(0, e.indexOf('=')))).sort()) !== JSON.stringify([...env].sort());
    if (container && (container.Image !== approved.Id || host?.Init !== true || networkStale || envStale || host?.Memory !== spec.memory_mb * mib
      || host?.NanoCpus !== Math.round(spec.cpus * 1e9) || host?.PidsLimit !== spec.pids || host?.Tmpfs?.['/tmp'] !== tmpfs
      || !host?.Mounts?.some(m => m.Type === 'volume' && m.Source === this.notesName(repo) && m.Target === '/workspace/project-notes' && !m.ReadOnly))) {
      if (container.State.Running) await this.docker.request('POST', `/containers/${names.container}/stop?t=2`);
      await this.docker.request('DELETE', `/containers/${names.container}?force=true`); container = null;
    }
    if (resource.image !== approved.Id) { this.db.prepare('UPDATE resources SET image=? WHERE repository_id=? AND generation=?').run(approved.Id, repo, generation); resource = { image: approved.Id }; }
    if (networkStale) { await this.docker.request('DELETE', `/networks/${names.network}`); network = null; }
    if (!network) await this.docker.request('POST', '/networks/create', { Name: names.network, Driver: 'bridge', Internal: !spec.egress, CheckDuplicate: true, Labels: this.labels(repo, generation, 'network') });
    await this.inspect(repo, generation, 'network');
    if (!container) {
      await this.docker.request('POST', `/containers/create?name=${names.container}`, { Image: resource.image, User: '10001:10001', WorkingDir: '/workspace',
        Cmd: ['node', '/opt/runner/idle.mjs'], Env: env, Labels: this.labels(repo, generation, 'container'),
        HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false,
          Memory: spec.memory_mb * mib, NanoCpus: Math.round(spec.cpus * 1e9), PidsLimit: spec.pids, NetworkMode: names.network,
          Init: true, RestartPolicy: { Name: 'no' }, Tmpfs: { '/tmp': tmpfs },
          Mounts: [{ Type: 'volume', Source: names.volume, Target: '/workspace' }, { Type: 'volume', Source: this.notesName(repo), Target: '/workspace/project-notes', ReadOnly: false }] } });
      container = await this.inspect(repo, generation, 'container');
    }
    this.db.prepare('UPDATE projects SET applied=? WHERE repository_id=?').run(JSON.stringify(resources(spec)), repo);
    if (!container.State.Running) await this.docker.request('POST', `/containers/${names.container}/start`);
    // Readiness is a protocol and journal check, not a Docker running flag.
    const health = await this.docker.runner(names.container, { operation_id: randomId(), type: 'health' });
    if (!health.ok || !health.result.ready) throw new ManagerError('runner_not_ready');
    await this.setup(repo, generation, spec, forceSetup);
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
  // The approved image, or one derived from it with the project's system packages. Built once per package set and base image,
  // and only by the manager: apt runs as root at build time, nothing inside the computer needs root.
  async resolveImage(repo, spec) {
    const approved = await this.docker.request('GET', `/images/${encodeURIComponent(this.image)}/json`);
    if (!approved?.Id) throw new ManagerError('approved_image_missing', 503);
    const toolchain = approved.Config?.Labels?.['department.bot.toolchain'] || null, packages = [...spec.packages].sort();
    if (!packages.length) { this.db.prepare('UPDATE projects SET build=? WHERE repository_id=?').run(JSON.stringify({ state: 'none', toolchain }), repo); return approved; }
    const tag = `department-bot-project-custom:${digest(approved.Id + '\n' + packages.join(' ')).slice(0, 16)}`;
    let image = await this.docker.request('GET', `/images/${encodeURIComponent(tag)}/json`), output = null;
    const record = value => this.db.prepare('UPDATE projects SET build=? WHERE repository_id=?').run(JSON.stringify({ tag, packages, toolchain, ...value }), repo);
    if (!image) {
      record({ state: 'building', started_at: new Date().toISOString() });
      const dockerfile = `FROM ${approved.Id}\nUSER 0\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -- ${packages.join(' ')} \\\n && rm -rf /var/lib/apt/lists/*\nUSER 10001:10001\n`;
      try { output = await this.docker.build(tag, dockerfile, { 'department.bot.deployment': this.deployment, 'department.bot.kind': 'project-image' }); }
      catch (error) { record({ state: 'failed', output: error.output || null, finished_at: new Date().toISOString() }); throw error; }
      image = await this.docker.request('GET', `/images/${encodeURIComponent(tag)}/json`);
      if (!image?.Id) throw new ManagerError('image_build_failed', 409);
    }
    record({ state: 'ready', output: output ? output.slice(-4000) : JSON.parse(this.get(repo).build || '{}').output || null, finished_at: new Date().toISOString() });
    return image;
  }
  // Runs the project's setup script as the project user when the script or the generation changed (or on request).
  // Its results live in the work volume (HOME), so later containers of the same generation do not repeat it.
  async setup(repo, generation, spec, force) {
    const previous = JSON.parse(this.get(repo).setup || 'null'), hash = digest(spec.setup_script);
    if (!spec.setup_script.trim()) { if (previous) this.db.prepare('UPDATE projects SET setup=NULL WHERE repository_id=?').run(repo); return; }
    if (!force && previous?.generation === generation && previous.hash === hash) return;
    const name = this.names(repo, generation).container, started = new Date().toISOString();
    this.db.prepare('UPDATE projects SET setup=? WHERE repository_id=?').run(JSON.stringify({ generation, hash, state: 'running', started_at: started }), repo);
    // The script runs until it ends; stop, reset or delete interrupts it.
    const run = await this.docker.runner(name, { operation_id: randomId(), type: 'command', command: spec.setup_script, timeout_ms: null }, 0).catch(() => null);
    const result = run?.ok ? run.result : { exit_code: null, output: '', error: run?.error || 'runner_failed' };
    await this.docker.runner(name, { operation_id: randomId(), type: 'reap' }).catch(() => null);
    this.db.prepare('UPDATE projects SET setup=? WHERE repository_id=?').run(JSON.stringify({ generation, hash, state: result.exit_code === 0 ? 'succeeded' : 'failed',
      exit_code: result.exit_code, timed_out: !!result.timed_out, error: result.error || null, output: String(result.output || '').slice(-8000), started_at: started, finished_at: new Date().toISOString() }), repo);
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
      if (this.get(repo)) return this.get(repo);
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
  async operate(repo, action, input) {
    this.validate(repo);
    if (!['start', 'stop', 'reset', 'delete', 'execute', 'configure', 'refresh'].includes(action) || !/^[a-f0-9]{48}$/.test(input.operation_id || '') || !Number.isSafeInteger(input.generation)) throw new ManagerError('invalid_operation', 400);
    // An invalid spec or runner request is rejected before it is recorded, so it never touches the running computer.
    if (action === 'configure') validateSpec(input.request);
    if (action === 'execute') validateCall(input.request);
    if (action === 'delete' && input.request !== undefined && (!input.request || Object.keys(input.request).some(key => key !== 'delete_notes') || input.request.delete_notes !== true)) throw new ManagerError('invalid_operation', 400);
    // Running commands hold their slots; a new stop, reset or delete interrupts all of them by stopping the container.
    if (['stop', 'reset', 'delete'].includes(action) && this.running(repo) && !this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(input.operation_id)
      && this.get(repo)?.generation === input.generation) await this.stopGeneration(repo, input.generation).catch(() => {});
    return this.lock(repo, async () => {
      const encoded = JSON.stringify(input), old = this.db.prepare('SELECT * FROM operations WHERE id=?').get(input.operation_id);
      if (old) {
        if (old.repository_id !== repo || old.action !== action || old.input !== encoded) throw new ManagerError('operation_id_conflict');
        if (old.state === 'completed') return JSON.parse(old.result);
        throw new ManagerError('operation_interrupted');
      }
      const project = this.get(repo);
      if (!project) throw new ManagerError('project_not_registered', 404);
      if (project.generation !== input.generation) throw new ManagerError('stale_generation');
      // Other tasks' calls keep the computer busy; that alone never refuses a call.
      if (action === 'execute' && !['ready', 'busy'].includes(project.state)) throw new ManagerError('environment_not_ready');
      if (action === 'start' && project.state === 'reset_failed') throw new ManagerError('reset_required');
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,'running',NULL)").run(input.operation_id, repo, action, input.generation, encoded);
      try {
        let result;
        if (action === 'configure') {
          // Saved under the project lock, so a running command finishes first; a stopped computer applies it on the next start.
          // Only the project's own values are saved; a null resource is removed, so it follows the default again.
          const { rerun_setup: rerun, ...requested } = input.request, previous = this.get(repo).spec, own = { ...this.own(repo), ...requested };
          for (const key of resourceKeys) if (own[key] === null) delete own[key];
          this.db.prepare('UPDATE projects SET spec=? WHERE repository_id=?').run(JSON.stringify(own), repo);
          // Build a new package image before touching the running computer; a failed build leaves it as it was.
          try { await this.resolveImage(repo, this.spec(repo)); }
          catch (error) { this.db.prepare('UPDATE projects SET spec=? WHERE repository_id=?').run(previous, repo); throw Object.assign(error, { untouched: true }); }
          if (project.desired === 'ready' && project.state !== 'reset_failed') {
            this.background.delete(repo); await this.stopGeneration(repo, project.generation); await this.provision(repo, { forceSetup: rerun === true });
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
              timeout = command ? (limit === null ? 0 : limit + 60000) : ['workspace_acceptance','workspace_restore','workspace_snapshot','workspace_finalize','workspace_blob','workspace_checkout','git_import'].includes(call.type) ? 0 : 90000;
            result = await this.docker.runner(this.names(repo, project.generation).container, { ...request, operation_id: input.operation_id }, timeout);
            if (commandTypes.includes(call.type)) {
              if (call.type === 'workspace_command' && call.keep_background === true && result.ok) kept.add(call.workspace_id);
              // Processes that escaped a task command's process group end here, unless the task keeps background work; the
              // task's waiting agent and every other task's processes stay. A plain command clears the computer as before.
              else if (!call.workspace_id) await this.reap(repo, project.generation);
              else if (!kept.has(call.workspace_id)) await this.reap(repo, project.generation, { workspace_id: call.workspace_id, keep_agent: true });
            }
          }
        } else {
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
                if (await this.notesVolume(repo, false)) await this.docker.request('DELETE', '/volumes/' + this.notesName(repo));
                await rm(this.notesRoot + '/' + repo, { recursive: true, force: true });
              }
            }
            const state = action === 'stop' && project.state === 'reset_failed' ? 'reset_failed' : action === 'stop' ? 'stopped' : 'deleted';
            this.update(repo, state, action === 'stop' ? 'stopped' : 'deleted', state === 'reset_failed' ? project.error : null); result = this.get(repo);
          }
        }
        this.db.prepare("UPDATE operations SET state='completed',result=? WHERE id=?").run(JSON.stringify(result), input.operation_id); return result;
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
        // On an uncertain exec result, kill the entire environment before releasing its lock.
        logFailure(`project ${repo} ${action === 'execute' ? input.request.type : action} failed, computer stopped`, error);
        try { await this.stopAll(repo); } catch {}
        this.update(repo, action === 'reset' ? 'reset_failed' : 'failed', 'stopped', error instanceof ManagerError ? error.message : 'operation_failed');
        this.db.prepare("UPDATE operations SET state='interrupted' WHERE id=?").run(input.operation_id);
        throw error;
      }
    }, action === 'execute');
  }
  async recover() {
    for (const row of this.list()) await this.lock(row.repository_id, async () => {
      const pending = this.db.prepare("SELECT action FROM operations WHERE repository_id=? AND state='running'").all(row.repository_id);
      this.db.prepare("UPDATE operations SET state='interrupted' WHERE repository_id=? AND state='running'").run(row.repository_id);
      try {
        await this.stopAll(row.repository_id);
        if (pending.some(p => p.action === 'reset')) { this.update(row.repository_id, 'reset_failed', 'stopped', 'reset_interrupted'); return; }
        if (row.state === 'reset_failed') return;
        if (row.desired === 'ready') { this.update(row.repository_id, 'recovering', 'ready'); await this.provision(row.repository_id); }
        else this.update(row.repository_id, row.desired, row.desired, row.error);
      } catch (error) { logFailure(`project ${row.repository_id} recovery on start failed`, error); this.update(row.repository_id, row.state === 'resetting' ? 'reset_failed' : 'failed', 'stopped', 'recovery_failed'); }
    });
  }
  // Liveness check of idle computers only: one with runner calls in flight is skipped rather than queued behind them.
  async check() {
    for (const row of this.list()) if (['ready', 'busy'].includes(row.state)) this.prune(row.repository_id);
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
  async shutdown() { await Promise.all([...this.pending]); for (const row of this.list()) await this.stopAll(row.repository_id); this.db.close(); }
}
