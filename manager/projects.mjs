import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ManagerError } from './docker.mjs';

const randomId = () => randomBytes(24).toString('hex');
export class Projects {
  constructor({ database, docker, deployment, image }) {
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(database); this.docker = docker; this.deployment = deployment; this.image = image; this.queues = new Map();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(repository_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,state TEXT NOT NULL,desired TEXT NOT NULL,error TEXT,started_at TEXT);
      CREATE TABLE IF NOT EXISTS resources(repository_id TEXT NOT NULL,generation INTEGER NOT NULL,image TEXT NOT NULL,PRIMARY KEY(repository_id,generation));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,action TEXT NOT NULL,generation INTEGER NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
    `);
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(row => row.name === 'revision')) this.db.exec('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }
  get(repo) { return this.db.prepare('SELECT * FROM projects WHERE repository_id=?').get(repo); }
  list() { return this.db.prepare('SELECT * FROM projects ORDER BY repository_id').all(); }
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
  async provision(repo) {
    const project = this.get(repo), generation = project.generation, names = this.names(repo, generation);
    let resource = this.db.prepare('SELECT image FROM resources WHERE repository_id=? AND generation=?').get(repo, generation);
    if (!resource) {
      const image = await this.docker.request('GET', `/images/${encodeURIComponent(this.image)}/json`);
      if (!image?.Id) throw new ManagerError('approved_image_missing', 503);
      this.db.prepare('INSERT INTO resources VALUES(?,?,?)').run(repo, generation, image.Id); resource = { image: image.Id };
    }
    if (!await this.inspect(repo, generation, 'volume')) await this.docker.request('POST', '/volumes/create', { Name: names.volume, Labels: this.labels(repo, generation, 'volume') });
    await this.inspect(repo, generation, 'volume');
    if (!await this.inspect(repo, generation, 'network')) await this.docker.request('POST', '/networks/create', { Name: names.network, Driver: 'bridge', Internal: true, CheckDuplicate: true, Labels: this.labels(repo, generation, 'network') });
    await this.inspect(repo, generation, 'network');
    let container = await this.inspect(repo, generation, 'container');
    if (!container) {
      await this.docker.request('POST', `/containers/create?name=${names.container}`, { Image: resource.image, User: '10001:10001', WorkingDir: '/workspace',
        Cmd: ['node', '/opt/runner/idle.mjs'], Env: ['HOME=/workspace/home', 'LANG=C.UTF-8'], Labels: this.labels(repo, generation, 'container'),
        HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false,
          Memory: 512 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 128, NetworkMode: names.network,
          RestartPolicy: { Name: 'no' }, Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,mode=1777' },
          Mounts: [{ Type: 'volume', Source: names.volume, Target: '/workspace' }] } });
      container = await this.inspect(repo, generation, 'container');
    }
    if (!container.State.Running) await this.docker.request('POST', `/containers/${names.container}/start`);
    // Readiness is a protocol and journal check, not a Docker running flag.
    const health = await this.docker.runner(names.container, { operation_id: randomId(), type: 'health' });
    if (!health.ok || !health.result.ready) throw new ManagerError('runner_not_ready');
    container = await this.inspect(repo, generation, 'container');
    this.update(repo, 'ready', 'ready', null, container.State.StartedAt);
    return this.get(repo);
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
  operate(repo, action, input) {
    this.validate(repo);
    if (!['start', 'stop', 'reset', 'delete', 'execute'].includes(action) || !/^[a-f0-9]{48}$/.test(input.operation_id || '') || !Number.isSafeInteger(input.generation)) throw new ManagerError('invalid_operation', 400);
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
        if (action === 'execute') {
          this.update(repo, 'busy', 'ready');
          const container = await this.inspect(repo, project.generation, 'container');
          if (!container?.State.Running || container.State.StartedAt !== project.started_at) throw new ManagerError('recovery_required');
          const call = input.request;
          if (!call || !['command', 'read', 'write'].includes(call.type) || Object.keys(call).some(k => !['type','command','path','content','timeout_ms'].includes(k))) throw new ManagerError('invalid_runner_request', 400);
          result = await this.docker.runner(this.names(repo, project.generation).container, { ...call, operation_id: input.operation_id });
          this.update(repo, 'ready', 'ready', null, project.started_at);
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
