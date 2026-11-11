import { randomBytes } from 'node:crypto';
import { ManagerError } from './docker.mjs';
import { logFailure } from './projects.mjs';

/**
 * Run environments: one container for one RoleRun, discarded when the run ends. It reuses the project computer's image
 * and its hardening (uid 10001, read-only root, every capability dropped, no-new-privileges, init) and adds what the
 * shared computer cannot give a single run:
 * - its own processes, HOME, /tmp and workspace: the whole of /workspace is a size-limited tmpfs of this container, so
 *   HOME, caches, the git store and the checkout disappear with it and never reach another run;
 * - no volume or bind mount at all: no developer volume, project notes, host HOME, Docker socket or other project state;
 * - its own network identity: no network at all (loopback only) by default, or a bridge network of its own with egress;
 * - limits on CPU, memory (no swap), processes, disk (tmpfs sizes) and run time, after which the manager removes it;
 * - a clean environment: the project's configured variables are not passed in.
 * The control plane checks the inspected settings itself before admitting a run (src/projects/run-environment.ts).
 */
const mib = 1024 * 1024, id48 = /^[a-f0-9]{48}$/;
const bounds = { cpus: [0.25, 8], memory_mb: [256, 16384], pids: [64, 4096], tmp_mb: [16, 4096], workspace_mb: [64, 16384], timeout_ms: [10_000, 24 * 3600_000] };
export const runDefaults = { cpus: 1, memory_mb: 2048, pids: 512, tmp_mb: 256, workspace_mb: 2048, timeout_ms: 3600_000 };
// Runner operations a run container accepts; all of them act on the run's own workspace id.
const runTypes = ['health', 'command', 'read', 'write', 'workspace_init', 'workspace_checkout', 'workspace_read','workspace_export', 'workspace_write', 'workspace_command', 'workspace_snapshot', 'workspace_finalize', 'workspace_blob', 'git_have', 'git_pack', 'git_import', 'git_export', 'reap'];
// keep_background lets a role keep a process (a test server) beyond one command; the container ends with the run anyway.
const runKeys = ['type', 'command', 'path', 'content', 'timeout_ms', 'keep_background', 'workspace_id', 'base64', 'offset', 'final', 'mode', 'snapshot', 'sha', 'tree_sha', 'pack_id', 'commits'];
export function validateRun(input) {
  // lease_epoch 0: the environment is prepared before the scheduler binds the run; the binding is recorded in the task trace.
  const keys = ['run_id', 'task_id', 'lease_epoch', 'profile', 'network', 'limits'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new ManagerError('invalid_run', 400);
  if (!id48.test(input.run_id || '') || typeof input.task_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.task_id) || !Number.isSafeInteger(input.lease_epoch) || input.lease_epoch < 0) throw new ManagerError('invalid_run', 400);
  if (!['writer', 'observer'].includes(input.profile) || !['none', 'egress'].includes(input.network ?? 'none')) throw new ManagerError('invalid_run', 400);
  const limits = { ...runDefaults, ...(input.limits ?? {}) };
  if (Object.keys(input.limits ?? {}).some(k => !Object.hasOwn(bounds, k))) throw new ManagerError('invalid_run_limits', 400);
  for (const [key, [min, max]] of Object.entries(bounds)) if (typeof limits[key] !== 'number' || !Number.isFinite(limits[key]) || limits[key] < min || limits[key] > max || key !== 'cpus' && !Number.isInteger(limits[key])) throw new ManagerError('invalid_run_limits', 400);
  return { run_id: input.run_id, task_id: input.task_id, lease_epoch: input.lease_epoch, profile: input.profile, network: input.network ?? 'none', limits };
}
function validateRunCall(run, call) {
  if (!call || !runTypes.includes(call.type) || Object.keys(call).some(k => !runKeys.includes(k))) throw new ManagerError('invalid_runner_request', 400);
  // The run's workspace id is its run id: an operation can never name another workspace.
  if (call.workspace_id !== undefined && call.workspace_id !== run.run_id) throw new ManagerError('cross_run_workspace', 403);
  if (call.timeout_ms != null && !(Number.isFinite(call.timeout_ms) && call.timeout_ms > 0)) throw new ManagerError('invalid_runner_request', 400);
}
export class RunEnvironments {
  constructor(projects) {
    this.projects = projects; this.docker = projects.docker; this.db = projects.db; this.locks = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_environments(run_id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,task_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,profile TEXT NOT NULL,
      network TEXT NOT NULL,limits TEXT NOT NULL,image TEXT NOT NULL,state TEXT NOT NULL,deadline INTEGER NOT NULL,created_at INTEGER NOT NULL,released_at INTEGER,release_reason TEXT)`);
  }
  names(repo, run) { const prefix = `dbot-${this.projects.deployment}-${repo}-run-${run.slice(0, 20)}`; return { container: prefix, network: prefix + '-net' }; }
  labels(row) { return { 'department.bot.deployment': this.projects.deployment, 'department.bot.repository': row.repository_id, 'department.bot.kind': 'run', 'department.bot.run': row.run_id, 'department.bot.task': row.task_id, 'department.bot.epoch': String(row.lease_epoch) }; }
  get(repo, run) { const row = this.db.prepare('SELECT * FROM run_environments WHERE run_id=? AND repository_id=?').get(run, repo); if (!row) throw new ManagerError('run_environment_not_found', 404); return row; }
  lock(run, fn) { const previous = this.locks.get(run) || Promise.resolve(), next = previous.then(fn, fn); this.locks.set(run, next.catch(() => {})); return next; }
  async owned(row) {
    const container = await this.docker.request('GET', `/containers/${this.names(row.repository_id, row.run_id).container}/json`);
    if (container && Object.entries(this.labels(row)).some(([k, v]) => container.Config?.Labels?.[k] !== v)) throw new ManagerError('resource_ownership_mismatch', 403);
    return container;
  }
  /** Creates (or returns) the environment of one run. The same run id is idempotent; a released run cannot be recreated. */
  async create(repo, input) {
    this.projects.validate(repo); const spec = validateRun(input);
    return this.lock(spec.run_id, async () => {
      const existing = this.db.prepare('SELECT * FROM run_environments WHERE run_id=?').get(spec.run_id);
      if (existing) {
        if (existing.repository_id !== repo || existing.task_id !== spec.task_id || existing.lease_epoch !== spec.lease_epoch || existing.profile !== spec.profile) throw new ManagerError('run_id_conflict');
        if (existing.state !== 'ready') throw new ManagerError('run_environment_released', 410);
        return this.describe(existing);
      }
      const project = this.projects.get(repo);
      if (!project || !['ready', 'busy'].includes(project.state)) throw new ManagerError('environment_not_ready');
      // The project's approved image (its packages included); the computer itself is not touched.
      const image = this.db.prepare('SELECT image FROM resources WHERE repository_id=? AND generation=?').get(repo, project.generation)?.image;
      if (!image) throw new ManagerError('environment_not_ready');
      const now = Date.now(), row = { run_id: spec.run_id, repository_id: repo, task_id: spec.task_id, lease_epoch: spec.lease_epoch, profile: spec.profile, network: spec.network, limits: JSON.stringify(spec.limits), image, state: 'ready', deadline: now + spec.limits.timeout_ms, created_at: now };
      this.db.prepare('INSERT INTO run_environments(run_id,repository_id,task_id,lease_epoch,profile,network,limits,image,state,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(row.run_id, repo, row.task_id, row.lease_epoch, row.profile, row.network, row.limits, image, 'ready', row.deadline, now);
      const names = this.names(repo, spec.run_id), l = spec.limits;
      try {
        if (spec.network === 'egress') await this.docker.request('POST', '/networks/create', { Name: names.network, Driver: 'bridge', Internal: false, CheckDuplicate: true, Labels: { ...this.labels(row), 'department.bot.kind': 'run-network' } });
        await this.docker.request('POST', `/containers/create?name=${names.container}`, { Image: image, User: '10001:10001', WorkingDir: '/workspace', Hostname: 'run',
          Cmd: ['node', '/opt/runner/idle.mjs'], Env: ['HOME=/workspace/home', 'LANG=C.UTF-8'], Labels: this.labels(row),
          HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false, Init: true, RestartPolicy: { Name: 'no' },
            Memory: l.memory_mb * mib, MemorySwap: l.memory_mb * mib, NanoCpus: Math.round(l.cpus * 1e9), PidsLimit: l.pids, IpcMode: 'private',
            NetworkMode: spec.network === 'egress' ? names.network : 'none', Mounts: [],
            Tmpfs: { '/workspace': `rw,nosuid,nodev,size=${l.workspace_mb * mib},uid=10001,gid=10001,mode=0700`, '/tmp': `rw,nosuid,nodev,noexec,size=${l.tmp_mb * mib},mode=1777` } } });
        await this.docker.request('POST', `/containers/${names.container}/start`);
        const health = await this.docker.runner(names.container, { operation_id: randomBytes(24).toString('hex'), type: 'health' });
        if (!health.ok || !health.result?.ready) throw new ManagerError('runner_not_ready');
      } catch (error) { await this.remove(row, 'create_failed').catch(() => {}); throw error; }
      return this.describe(row);
    });
  }
  /** Inspected facts, not a verdict: the control plane decides whether they satisfy its policy. */
  async describe(row) {
    const container = await this.owned(row), host = container?.HostConfig ?? {}, config = container?.Config ?? {};
    return { run_id: row.run_id, task_id: row.task_id, lease_epoch: row.lease_epoch, profile: row.profile, state: row.state, deadline: row.deadline, limits: JSON.parse(row.limits), image: row.image,
      container: container ? { name: this.names(row.repository_id, row.run_id).container, running: !!container.State?.Running, user: config.User ?? null, readonly_rootfs: host.ReadonlyRootfs === true, privileged: host.Privileged === true,
        cap_drop: host.CapDrop ?? [], cap_add: host.CapAdd ?? [], security_opt: host.SecurityOpt ?? [], network_mode: host.NetworkMode ?? null, networks: Object.keys(container.NetworkSettings?.Networks ?? {}),
        mounts: (container.Mounts ?? []).map(m => ({ type: m.Type, source: m.Source ?? m.Name ?? null, destination: m.Destination, rw: !!m.RW })), binds: host.Binds ?? [], tmpfs: host.Tmpfs ?? {},
        memory: host.Memory ?? 0, memory_swap: host.MemorySwap ?? 0, nano_cpus: host.NanoCpus ?? 0, pids_limit: host.PidsLimit ?? 0, ipc_mode: host.IpcMode ?? null, pid_mode: host.PidMode ?? '', userns_mode: host.UsernsMode ?? '',
        env_names: (config.Env ?? []).map(e => e.slice(0, e.indexOf('='))) } : null };
  }
  async inspect(repo, run) { this.projects.validate(repo); return this.describe(this.get(repo, run)); }
  async execute(repo, run, input) {
    this.projects.validate(repo);
    if (!id48.test(input?.operation_id || '') || Object.keys(input || {}).some(k => !['operation_id', 'request'].includes(k))) throw new ManagerError('invalid_operation', 400);
    const row = this.get(repo, run); validateRunCall(row, input.request);
    if (row.state !== 'ready') throw new ManagerError('run_environment_released', 410);
    const left = row.deadline - Date.now();
    if (left <= 0) { await this.release(repo, run, 'deadline'); throw new ManagerError('run_deadline_exceeded', 410); }
    const call = input.request, command = ['command', 'workspace_command'].includes(call.type);
    // A command never outlives the run's deadline; the runner kills its process group at the limit.
    const request = command ? { ...call, timeout_ms: Math.min(call.timeout_ms ?? left, left) } : call;
    const container = await this.owned(row);
    if (!container?.State?.Running) throw new ManagerError('run_environment_stopped', 410);
    return this.docker.runner(this.names(repo, run).container, { ...request, operation_id: input.operation_id }, command ? request.timeout_ms + 30_000 : 0);
  }
  /** Kills and removes the container and its network. Idempotent; the record of the run stays. */
  async release(repo, run, reason = 'released') { this.projects.validate(repo); const row = this.get(repo, run); return this.lock(run, () => this.remove(row, reason)); }
  async remove(row, reason) {
    const names = this.names(row.repository_id, row.run_id), container = await this.owned(row).catch(error => { if (error.message === 'resource_ownership_mismatch') throw error; return null; });
    if (container) await this.docker.request('DELETE', `/containers/${names.container}?force=true`);
    if (row.network === 'egress' && await this.docker.request('GET', `/networks/${names.network}`)) await this.docker.request('DELETE', `/networks/${names.network}`);
    this.db.prepare("UPDATE run_environments SET state='released',released_at=coalesce(released_at,?),release_reason=coalesce(release_reason,?) WHERE run_id=?").run(Date.now(), reason, row.run_id);
    return { run_id: row.run_id, state: 'released', reason: this.db.prepare('SELECT release_reason FROM run_environments WHERE run_id=?').get(row.run_id).release_reason, container_removed: !!container };
  }
  /** Run environments past their deadline, and after a manager restart every one still marked ready, are removed. */
  async reap({ all = false } = {}) {
    const rows = this.db.prepare(`SELECT * FROM run_environments WHERE state='ready'${all ? '' : ' AND deadline<=?'}`).all(...(all ? [] : [Date.now()]));
    for (const row of rows) await this.lock(row.run_id, () => this.remove(row, all ? 'manager_restart' : 'deadline')).catch(error => logFailure(`run environment ${row.run_id} cleanup failed`, error));
    return rows.length;
  }
}
