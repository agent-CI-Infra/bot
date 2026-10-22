import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Projects } from '../manager/projects.mjs';
import { ManagerError } from '../manager/docker.mjs';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
const id = () => randomBytes(24).toString('hex');

class FakeDocker {
  containers = new Map(); volumes = new Map(); networks = new Map(); starts = 0; failNetwork = false;
  async request(method, path, body) {
    if (path.startsWith('/images/')) return { Id: 'sha256:fixture' };
    const [kind, name] = path.slice(1).split('/');
    if (kind === 'volumes') {
      if (method === 'POST') { this.volumes.set(body.Name, { Labels: body.Labels }); return {}; }
      return this.volumes.get(name) || null;
    }
    if (kind === 'networks') {
      if (method === 'POST') { if (this.failNetwork) throw new ManagerError('injected_network_failure'); this.networks.set(body.Name, { Labels: body.Labels }); return {}; }
      if (method === 'DELETE') { this.networks.delete(name); return {}; }
      return this.networks.get(name) || null;
    }
    if (path.startsWith('/containers/create')) { this.containers.set(new URL('http://docker' + path).searchParams.get('name'), { Config: body, State: { Running: false, StartedAt: '' } }); return {}; }
    if (kind === 'containers') {
      const row = this.containers.get(name);
      if (method === 'GET') return row || null;
      if (path.endsWith('/start')) { row.State = { Running: true, StartedAt: String(++this.starts) }; return {}; }
      if (path.includes('/stop')) { row.State.Running = false; return {}; }
      if (method === 'DELETE') { this.containers.delete(name); return {}; }
    }
    throw new Error('Unexpected fake Docker call');
  }
  async runner() { return { ok: true, result: { ready: true } }; }
}
function fixture(t) {
  mkdirSync('.tmp', { recursive: true }); const directory = mkdtempSync(resolve('.tmp/env-unit-'));
  const docker = new FakeDocker(), options = { database: join(directory, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' };
  let projects = new Projects(options);
  t.after(() => { projects.db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { docker, get projects() { return projects; }, restart: () => { projects.db.close(); projects = new Projects(options); } };
}
test('one persistent environment per repository and fully owned resources only', async t => {
  const f = fixture(t); await Promise.all(Array.from({ length: 5 }, () => f.projects.register('101')));
  assert.equal(f.docker.containers.size, 1); assert.equal(f.docker.volumes.size, 1); assert.equal(f.projects.get('101').state, 'ready');
  const name = f.projects.names('101', 1).container;
  f.docker.containers.get(name).Config.Labels['department.bot.repository'] = '202';
  await assert.rejects(f.projects.operate('101', 'stop', { operation_id: id(), generation: 1 }), /resource_ownership_mismatch/);
  assert.equal(f.docker.containers.get(name).State.Running, true);
});
test('reset fences the generation, preserves old volume, and never starts two writers', async t => {
  const f = fixture(t); await f.projects.register('101');
  const request = { operation_id: id(), generation: 1 };
  const result = await f.projects.operate('101', 'reset', request);
  assert.equal(result.generation, 2); assert.equal(f.docker.volumes.size, 2);
  assert.equal(f.docker.containers.get(f.projects.names('101', 1).container).State.Running, false);
  assert.equal([...f.docker.containers.values()].filter(c => c.State.Running).length, 1);
  assert.deepEqual(await f.projects.operate('101', 'reset', request), { ...result });
  await assert.rejects(f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'command', command: 'true' } }), /stale_generation/);
  await f.projects.operate('101', 'stop', { operation_id: id(), generation: 2 });
  await f.projects.operate('101', 'delete', { operation_id: id(), generation: 2 });
  assert.equal(f.docker.containers.size, 0); assert.equal(f.docker.networks.size, 0); assert.equal(f.docker.volumes.size, 2);
});
test('failed and interrupted resets remain failed and cannot silently start the old workspace', async t => {
  const f = fixture(t); await f.projects.register('101'); f.docker.failNetwork = true;
  await assert.rejects(f.projects.operate('101', 'reset', { operation_id: id(), generation: 1 }), /injected_network_failure/);
  assert.equal(f.projects.get('101').state, 'reset_failed'); assert.equal(f.projects.get('101').generation, 2);
  assert.equal([...f.docker.containers.values()].filter(c => c.State.Running).length, 0);
  await f.projects.operate('101', 'stop', { operation_id: id(), generation: 2 });
  assert.equal(f.projects.get('101').state, 'reset_failed');
  await assert.rejects(f.projects.operate('101', 'start', { operation_id: id(), generation: 2 }), /reset_required/);
  f.docker.failNetwork = false;
  await f.projects.operate('101', 'reset', { operation_id: id(), generation: 2 });
  f.projects.db.prepare("INSERT INTO operations VALUES(?,?,?,?,'{}','running',NULL)").run(id(), '101', 'reset', 3);
  f.projects.update('101', 'resetting', 'ready'); f.restart(); await f.projects.recover();
  assert.equal(f.projects.get('101').state, 'reset_failed'); assert.equal([...f.docker.containers.values()].filter(c => c.State.Running).length, 0);
});
test('manager restart rechecks runner and kills uncertain work before becoming ready', async t => {
  const f = fixture(t); await f.projects.register('101'); const started = f.projects.get('101').started_at;
  f.projects.db.prepare("INSERT INTO operations VALUES(?,?,?,?,'{}','running',NULL)").run(id(), '101', 'execute', 1);
  f.projects.update('101', 'busy', 'ready', null, started); f.restart(); await f.projects.recover();
  assert.equal(f.projects.get('101').state, 'ready'); assert.notEqual(f.projects.get('101').started_at, started);
  assert.equal(f.projects.get('101').generation, 1);
  assert.equal(f.projects.db.prepare('SELECT state FROM operations').get().state, 'interrupted');
});
test('environment API enforces project roles for unfiltered list, detail, start, stop and reset', async t => {
  const rows = new Map(), operations = new Map();
  const manager = { async call(method, path, input) {
    const repo = path.split('/')[3], action = path.split('/')[4];
    if (method === 'PUT') rows.set(repo, { repository_id: repo, generation: 1, state: 'ready', desired: 'ready', revision: 1 });
    if (method === 'POST') {
      if (operations.has(input.operation_id)) return operations.get(input.operation_id);
      rows.set(repo, { ...rows.get(repo), state: action === 'stop' ? 'stopped' : 'ready', desired: action === 'stop' ? 'stopped' : 'ready',
        generation: input.generation + (action === 'reset' ? 1 : 0), revision: rows.get(repo).revision + 1 });
      operations.set(input.operation_id, rows.get(repo));
    }
    return rows.get(repo) || null;
  } };
  const h = await harness(t, manager), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202'); await h.projects.reconcile();
  const password = testPassword(); await admin('/api/users', 'POST', { username: 'member', password, repository_ids: ['101'] });
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await admin('/api/environments')).value.environments.length, 2);
  assert.deepEqual((await member('/api/environments')).value.environments.map(r => r.repository_id), ['101']);
  for (const suffix of ['', '/start', '/stop', '/reset']) assert.equal((await member('/api/environments/202' + suffix, suffix ? 'POST' : 'GET', suffix ? { operation_id: id(), generation: 1 } : undefined)).status, 403);
  assert.equal((await member('/api/environments/101/reset', 'POST', { operation_id: id(), generation: 1 })).value.environment.generation, 2);
  assert.equal((await member('/api/environments/101/delete', 'POST', { operation_id: id(), generation: 2, confirm: true })).status, 403);
  const stoppedId = id();
  await member('/api/environments/101/stop', 'POST', { operation_id: stoppedId, generation: 2 });
  await member('/api/environments/101/start', 'POST', { operation_id: id(), generation: 2 });
  await member('/api/environments/101/stop', 'POST', { operation_id: stoppedId, generation: 2 });
  assert.equal(h.store.get("SELECT enabled FROM policies WHERE repository_id='101'").enabled, 1);
  assert.equal(h.store.get("SELECT state FROM project_environments WHERE repository_id='101'").state, 'ready');
  const pendingId=id(); h.store.run("INSERT INTO environment_operations VALUES(?,'101','reset','{}','pending',NULL)", pendingId);
  assert.equal((await member('/api/environments/101/reset','POST',{ operation_id:id(),generation:2 })).status,409);
  assert.equal((await member('/api/environments')).value.environments[0].operation_pending,1);
});
