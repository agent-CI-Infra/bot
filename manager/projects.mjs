import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { ManagerError } from './docker.mjs';

const randomId = () => randomBytes(24).toString('hex');
// Default project computer spec and the bounds the manager enforces; callers can only choose values inside them.
const defaults = { cpus: 2, memory_mb: 4096, pids: 1024, tmp_mb: 1024, max_command_minutes: 60, packages: [], env: {}, setup_script: '' };
const bounds = { cpus: [0.25, 16], memory_mb: [256, 65536], pids: [64, 16384], tmp_mb: [16, 16384], max_command_minutes: [1, 240] };
const mib = 1024 * 1024;
// Debian package names only (no options, files or URLs); environment names that the computer or runner own are refused.
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,99}(?::[a-z0-9-]{1,20})?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/, reservedEnv = new Set(['PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL', 'PWD', 'HOSTNAME', 'NPM_CONFIG_PREFIX']);
export function validateSpec(input) {
  const keys = ['egress', 'packages', 'env', 'setup_script', 'rerun_setup', ...Object.keys(bounds)];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new ManagerError('invalid_spec', 400);
  for (const [key, [min, max]] of Object.entries(bounds)) if (input[key] !== undefined) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || key !== 'cpus' && !Number.isInteger(value) || key === 'cpus' && Math.round(value * 100) !== value * 100) throw new ManagerError('invalid_spec', 400);
  }
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
export class Projects {
  constructor({ database, docker, deployment, image, egress = true }) {
    // background: repository -> task workspace whose kept processes may outlive a command. executing: repositories running a runner request.
    this.egress = egress; this.background = new Map(); this.executing = new Set(); this.usage = new Map();
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(database); this.docker = docker; this.deployment = deployment; this.image = image; this.queues = new Map();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(repository_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,state TEXT NOT NULL,desired TEXT NOT NULL,error TEXT,started_at TEXT);
      CREATE TABLE IF NOT EXISTS resources(repository_id TEXT NOT NULL,generation INTEGER NOT NULL,image TEXT NOT NULL,PRIMARY KEY(repository_id,generation));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,action TEXT NOT NULL,generation INTEGER NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
    `);
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'revision')) this.db.exec('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    // spec: the requested computer; build: the image built for its packages; setup: the last setup script run.
    for (const column of ['spec', 'build', 'setup']) if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === column)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${column} TEXT`);
  }
  get(repo) { return this.db.prepare('SELECT * FROM projects WHERE repository_id=?').get(repo); }
  list() { return this.db.prepare('SELECT * FROM projects ORDER BY repository_id').all(); }
  // A project's saved spec over the defaults; it survives restarts and resets.
  spec(repo) { const saved = this.get(repo)?.spec; return { ...defaults, egress: this.egress, ...(saved ? JSON.parse(saved) : {}) }; }
  describe(repo) {
    const project = this.get(repo); if (!project) return null;
    const resource = this.db.prepare('SELECT image FROM resources WHERE repository_id=? AND generation=?').get(repo, project.generation);
    const generations = this.db.prepare('SELECT count(*) AS n FROM resources WHERE repository_id=?').get(repo).n;
    const { spec: _saved, build, setup, ...state } = project, spec = this.spec(repo);
    return { ...state, computer: { ...this.names(repo, project.generation), image: resource?.image || null, user: '10001:10001', workdir: '/workspace',
      root_filesystem: 'read-only', network_policy: spec.egress ? 'internet egress' : 'internal, no egress', init: true,
      ...spec, build: build ? JSON.parse(build) : null, setup: setup ? JSON.parse(setup) : null, retained_generations: generations, bounds } };
  }
  lock(repo, fn) {
    const previous = this.queues.get(repo) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn); this.queues.set(repo, next);
    return next.finally(() => { if (this.queues.get(repo) === next) this.queues.delete(repo); });
  }
  validate(repo) { if (!/^[1-9]\d{0,19}$/.test(repo)) throw new ManagerError('invalid_repository', 400); }
  names(repo, generation) {
    const prefix = `dbot-${this.deployment}-${repo}-g${generation}`;
    return { container: prefix, volume: prefix + '-work', network: prefix + '-net' };
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
    let network = await this.inspect(repo, generation, 'network'), container = await this.inspect(repo, generation, 'container');
    // A container whose template or spec differs (approved image, init, resources, network policy) is replaced in place when
    // provisioned; the work volume and generation stay. This never happens in the middle of a command.
    const networkStale = network && network.Internal !== !spec.egress, host = container?.HostConfig;
    // Compare only the variables the manager sets (the image adds its own, such as PATH); old names come from BOT_PROJECT_ENV_KEYS.
    const current = container?.Config?.Env || [], listed = current.find(e => e.startsWith('BOT_PROJECT_ENV_KEYS='))?.slice(21).split(',').filter(Boolean) || [];
    const managed = new Set(['HOME', 'LANG', 'BOT_PROJECT_ENV_KEYS', ...Object.keys(spec.env), ...listed]);
    const envStale = container && JSON.stringify(current.filter(e => managed.has(e.slice(0, e.indexOf('=')))).sort()) !== JSON.stringify([...env].sort());
    if (container && (container.Image !== approved.Id || host?.Init !== true || networkStale || envStale || host?.Memory !== spec.memory_mb * mib
      || host?.NanoCpus !== Math.round(spec.cpus * 1e9) || host?.PidsLimit !== spec.pids || host?.Tmpfs?.['/tmp'] !== tmpfs)) {
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
          Mounts: [{ Type: 'volume', Source: names.volume, Target: '/workspace' }] } });
      container = await this.inspect(repo, generation, 'container');
    }
    if (!container.State.Running) await this.docker.request('POST', `/containers/${names.container}/start`);
    // Readiness is a protocol and journal check, not a Docker running flag.
    const health = await this.docker.runner(names.container, { operation_id: randomId(), type: 'health' });
    if (!health.ok || !health.result.ready) throw new ManagerError('runner_not_ready');
    await this.setup(repo, generation, spec, forceSetup);
    container = await this.inspect(repo, generation, 'container');
    this.update(repo, 'ready', 'ready', null, container.State.StartedAt);
    return this.get(repo);
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
    const name = this.names(repo, generation).container, timeout = spec.max_command_minutes * 60000, started = new Date().toISOString();
    this.db.prepare('UPDATE projects SET setup=? WHERE repository_id=?').run(JSON.stringify({ generation, hash, state: 'running', started_at: started }), repo);
    const run = await this.docker.runner(name, { operation_id: randomId(), type: 'command', command: spec.setup_script, timeout_ms: timeout }, timeout + 60000).catch(() => null);
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
      catch (error) { this.update(repo, 'failed', 'ready', error instanceof ManagerError ? error.message : 'provision_failed'); throw error; }
    });
  }
  // Stops leftover processes without restarting the container; falls back to a restart if any survive.
  async reap(repo, generation) {
    const result = await this.docker.runner(this.names(repo, generation).container, { operation_id: randomId(), type: 'reap' }).catch(() => null);
    if (result?.ok) return result.result;
    await this.stopGeneration(repo, generation); await this.provision(repo); return { restarted: true };
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
    if (!['start', 'stop', 'reset', 'delete', 'execute', 'configure'].includes(action) || !/^[a-f0-9]{48}$/.test(input.operation_id || '') || !Number.isSafeInteger(input.generation)) throw new ManagerError('invalid_operation', 400);
    // An invalid spec is rejected before it is recorded, so it never touches the running computer.
    if (action === 'configure') validateSpec(input.request);
    // A long command holds the project lock; a new stop, reset or delete interrupts it by stopping the container.
    if (['stop', 'reset', 'delete'].includes(action) && this.executing.has(repo) && !this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(input.operation_id)
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
      if (action === 'execute' && project.state !== 'ready') throw new ManagerError('environment_not_ready');
      if (action === 'start' && project.state === 'reset_failed') throw new ManagerError('reset_required');
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,'running',NULL)").run(input.operation_id, repo, action, input.generation, encoded);
      try {
        let result;
        if (action === 'configure') {
          // Saved under the project lock, so a running command finishes first; a stopped computer applies it on the next start.
          const { rerun_setup: rerun, ...requested } = input.request, previous = this.get(repo).spec, spec = { ...this.spec(repo), ...requested };
          this.db.prepare('UPDATE projects SET spec=? WHERE repository_id=?').run(JSON.stringify(spec), repo);
          // Build a new package image before touching the running computer; a failed build leaves it as it was.
          try { await this.resolveImage(repo, spec); }
          catch (error) { this.db.prepare('UPDATE projects SET spec=? WHERE repository_id=?').run(previous, repo); throw Object.assign(error, { untouched: true }); }
          if (project.desired === 'ready' && project.state !== 'reset_failed') {
            this.background.delete(repo); await this.stopGeneration(repo, project.generation); await this.provision(repo, { forceSetup: rerun === true });
          }
          result = this.describe(repo);
        } else if (action === 'execute') {
          this.update(repo, 'busy', 'ready', null, project.started_at);
          const container = await this.inspect(repo, project.generation, 'container');
          if (!container?.State.Running || container.State.StartedAt !== project.started_at) throw new ManagerError('recovery_required');
          const call = input.request;
          const types=['command','read','write','workspace_init','workspace_write','workspace_snapshot','workspace_read','workspace_command','workspace_finalize','workspace_blob','workspace_agent_config','workspace_agent_start','workspace_agent_poll','workspace_agent_reply','workspace_agent_live','reap'];
          const keys=['type','command','path','content','timeout_ms','keep_background','workspace_id','base64','offset','author_email','final','mode','snapshot','sha','tree_sha','config','request_id'];
          if (!call || !types.includes(call.type) || Object.keys(call).some(k => !keys.includes(k))) throw new ManagerError('invalid_runner_request', 400);
          // Kept background processes belong to one task workspace; any other work stops them first.
          const owner = this.background.get(repo);
          if (owner && owner !== call.workspace_id) { this.background.delete(repo); await this.reap(repo, project.generation); }
          if (call.type === 'reap') { this.background.delete(repo); result = { ok: true, result: await this.reap(repo, project.generation) }; }
          else {
            // Commands are capped by the project's own limit, which an administrator sets in the computer spec.
            const limit = Math.min(Math.max(Number(call.timeout_ms) || 10000, 100), this.spec(repo).max_command_minutes * 60000);
            const request = commandTypes.includes(call.type) ? { ...call, timeout_ms: limit } : call, timeout = commandTypes.includes(call.type) ? limit + 60000 : 90000;
            this.executing.add(repo);
            try { result = await this.docker.runner(this.names(repo, project.generation).container, { ...request, operation_id: input.operation_id }, timeout); }
            finally { this.executing.delete(repo); }
            if (commandTypes.includes(call.type)) {
              if (call.type === 'workspace_command' && call.keep_background === true && result.ok) this.background.set(repo, call.workspace_id);
              // Processes that escaped the command's process group end here unless this task keeps background work.
              else if (!call.workspace_id || this.background.get(repo) !== call.workspace_id) await this.reap(repo, project.generation);
            }
          }
          this.update(repo, 'ready', 'ready', null, this.get(repo).started_at);
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
            }
            const state = action === 'stop' && project.state === 'reset_failed' ? 'reset_failed' : action === 'stop' ? 'stopped' : 'deleted';
            this.update(repo, state, action === 'stop' ? 'stopped' : 'deleted', state === 'reset_failed' ? project.error : null); result = this.get(repo);
          }
        }
        this.db.prepare("UPDATE operations SET state='completed',result=? WHERE id=?").run(JSON.stringify(result), input.operation_id); return result;
      } catch (error) {
        if (error?.untouched) { this.db.prepare("UPDATE operations SET state='interrupted' WHERE id=?").run(input.operation_id); throw error; }
        // On an uncertain exec result, kill the entire environment before releasing its lock.
        try { await this.stopAll(repo); } catch {}
        this.update(repo, action === 'reset' ? 'reset_failed' : 'failed', 'stopped', error instanceof ManagerError ? error.message : 'operation_failed');
        this.db.prepare("UPDATE operations SET state='interrupted' WHERE id=?").run(input.operation_id);
        throw error;
      }
    });
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
      } catch { this.update(row.repository_id, row.state === 'resetting' ? 'reset_failed' : 'failed', 'stopped', 'recovery_failed'); }
    });
  }
  async check() {
    await Promise.all(this.list().filter(p => p.state === 'ready').map(row => this.lock(row.repository_id, async () => {
      const current = this.get(row.repository_id); if (current.state !== 'ready') return;
      try {
        const container = await this.inspect(row.repository_id, current.generation, 'container');
        if (!container?.State.Running || container.State.StartedAt !== current.started_at) {
          this.update(row.repository_id, 'recovering', 'ready'); await this.stopAll(row.repository_id); await this.provision(row.repository_id);
        }
      } catch { this.update(row.repository_id, 'failed', 'stopped', 'recovery_failed'); }
    })));
  }
  async shutdown() { await Promise.all([...this.queues.values()].map(p => p.catch(() => {}))); for (const row of this.list()) await this.stopAll(row.repository_id); this.db.close(); }
}
