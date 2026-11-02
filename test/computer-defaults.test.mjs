import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Projects } from '../manager/projects.mjs';
import { ManagerError } from '../manager/docker.mjs';
import { FakeDocker } from './fake-docker.mjs';
import { fail } from '../dist/core/security.js';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';

const id = () => randomBytes(24).toString('hex'), mib = 1024 * 1024;
// The real manager project logic over a Docker stand-in with an 8-CPU, 32 GiB host; `call` stands in for its HTTP API and,
// like ManagerClient, turns a manager error into an HTTP error with the manager's status.
function fixture(t) {
  mkdirSync('.tmp', { recursive: true }); const directory = mkdtempSync(resolve('.tmp/defaults-')), docker = new FakeDocker();
  docker.info = { NCPU: 8, MemTotal: 32768 * mib };
  const options = { database: join(directory, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' };
  let projects = new Projects(options);
  t.after(() => { projects.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (method, path, input) => route(method, path, input).catch(error => error instanceof ManagerError ? fail(error.status, error.message) : Promise.reject(error));
  const route = async (method, path, input) => {
    if (path === '/v1/defaults') return method === 'PUT' ? projects.setDefaults(input) : projects.defaultsView();
    const [, repo, action] = /^\/v1\/projects\/(\d+)(?:\/(\w+))?$/.exec(path);
    if (path.endsWith('/parallel')) return projects.parallelism(repo, input.tasks);
    if (method === 'GET' && !action) return projects.describe(repo);
    if (method === 'PUT') return projects.register(repo);
    return projects.operate(repo, action, input);
  };
  return { docker, directory, options, get projects() { return projects; }, manager: { call },
    restart: () => { if (projects.db.isOpen) projects.db.close(); projects = new Projects(options); }, host: repo => docker.containers.get(projects.names(repo, projects.get(repo).generation).container).HostConfig };
}

test('computers follow the resource defaults unless their project sets its own value, and null returns to the default', async t => {
  const f = fixture(t); await f.projects.register('101');
  let view = await f.projects.defaultsView();
  assert.deepEqual(view.defaults, { cpus: 2, memory_mb: 4096, pids: 1024, tmp_mb: 1024 }); assert.deepEqual(view.builtin, view.defaults);
  assert.deepEqual(view.host, { cpus: 8, memory_mb: 32768 }); assert.deepEqual(view.allocated, { computers: 1, cpus: 2, memory_mb: 4096 });
  for (const input of [{}, { cpus: 0.1 }, { memory_mb: 100 }, { pids: 1.5 }, { tmp_mb: '64' }, { egress: false }, { cpus: null }, []])
    await assert.rejects(f.projects.setDefaults(input), /invalid_defaults/);
  // Docker cannot give a container more CPUs than the host has.
  await assert.rejects(f.projects.setDefaults({ cpus: 12 }), /cpus_exceed_host/);
  assert.equal(f.projects.resourceDefaults().cpus, 2);

  await f.projects.operate('101', 'configure', { operation_id: id(), generation: 1, request: { memory_mb: 2048 } });
  assert.deepEqual(f.projects.describe('101').computer.inherited, ['cpus', 'pids', 'tmp_mb']);
  view = await f.projects.setDefaults({ cpus: 4, memory_mb: 8192 });
  assert.deepEqual(view.defaults, { cpus: 4, memory_mb: 8192, pids: 1024, tmp_mb: 1024 });
  // The running computer is not touched; it shows the new values as pending until it is refreshed.
  const computer = f.projects.describe('101').computer;
  assert.deepEqual([computer.cpus, computer.memory_mb, computer.resources_pending, f.host('101').NanoCpus], [4, 2048, true, 2e9]);
  // A new project starts with the new defaults.
  await f.projects.register('202');
  assert.deepEqual([f.host('202').NanoCpus, f.host('202').Memory, f.projects.describe('202').computer.resources_pending], [4e9, 8192 * mib, false]);
  // Refresh rebuilds the computer with the current spec; the work volume and generation stay.
  const created = f.docker.created;
  await f.projects.operate('101', 'refresh', { operation_id: id(), generation: 1 });
  assert.deepEqual([f.host('101').NanoCpus, f.host('101').Memory, f.projects.get('101').generation, f.docker.created], [4e9, 2048 * mib, 1, created + 1]);
  assert.equal(f.projects.describe('101').computer.resources_pending, false);
  // A refresh with nothing to change leaves the container alone.
  await f.projects.operate('101', 'refresh', { operation_id: id(), generation: 1 }); assert.equal(f.docker.created, created + 1);
  // null clears the project's own value.
  await f.projects.operate('101', 'configure', { operation_id: id(), generation: 1, request: { memory_mb: null } });
  assert.deepEqual([f.host('101').Memory, f.projects.own('101').memory_mb, f.projects.describe('101').computer.inherited.length], [8192 * mib, undefined, 4]);
  // The defaults survive a restart.
  f.restart(); assert.equal(f.projects.resourceDefaults().cpus, 4);
});

test('a spec saved before the defaults could change keeps only the values that differ from the built-in defaults, once', async t => {
  const f = fixture(t); await f.projects.register('101'); await f.projects.register('202');
  f.projects.db.close();
  // An earlier manager: no settings table, and every saved spec holds all four resources.
  const db = new DatabaseSync(f.options.database);
  db.exec('DROP TABLE settings');
  const full = { cpus: 2, memory_mb: 8192, pids: 1024, tmp_mb: 1024, egress: true, packages: [], env: {}, setup_script: '' };
  db.prepare('UPDATE projects SET spec=? WHERE repository_id=?').run(JSON.stringify(full), '101'); db.close();
  f.restart();
  assert.deepEqual(f.projects.own('101'), { memory_mb: 8192, egress: true, packages: [], env: {}, setup_script: '' });
  assert.deepEqual(f.projects.describe('202').computer.inherited, ['cpus', 'memory_mb', 'pids', 'tmp_mb']);
  // A value equal to the built-in default chosen after the upgrade stays the project's own.
  await f.projects.operate('101', 'configure', { operation_id: id(), generation: 1, request: { cpus: 2 } });
  f.restart(); assert.equal(f.projects.own('101').cpus, 2);
});

test('global settings change the defaults through the manager, and an idle computer is refreshed while a busy one waits', async t => {
  const f = fixture(t), h = await harness(t, f.manager), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  for (let i = 0; i < 2; i++) await h.projects.reconcile();
  const read = await admin('/api/settings');
  assert.deepEqual([read.value.settings.computer_defaults.defaults.cpus, read.value.settings.computer_defaults.host.cpus], [2, 8]);
  for (const input of [{}, { computer_defaults: null }, { computer_defaults: [] }, { computer_defaults: { cpus: 64 } }, { computer_defaults: { disk_mb: 10 } }])
    assert.equal((await admin('/api/settings', 'PATCH', input)).status, 400);
  // The console layer holds only the resources a project sets itself.
  const consoleResources = repo => { const { cpus, memory_mb, pids, tmp_mb } = JSON.parse(h.store.get('SELECT spec FROM computer_console_specs WHERE repository_id=?', repo).spec); return JSON.parse(JSON.stringify({ cpus, memory_mb, pids, tmp_mb })); };
  await admin('/api/environments/202/configure', 'POST', { operation_id: id(), generation: 1, spec: { pids: 2048 } });
  assert.deepEqual(consoleResources('202'), { pids: 2048 });
  // 101 has a task on its computer: its refresh waits until the task is gone.
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('t1','101','review.issue','running','')");
  h.store.run("INSERT INTO task_claims VALUES('t1','101','token','2026-01-01')");
  const saved = await admin('/api/settings', 'PATCH', { computer_defaults: { cpus: 3, memory_mb: 6144 } });
  assert.equal(saved.status, 200); assert.deepEqual(saved.value.settings.computer_defaults.defaults, { cpus: 3, memory_mb: 6144, pids: 1024, tmp_mb: 1024 });
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='settings.updated' AND resource_id='computer.defaults'"));
  await h.projects.reconcile();
  assert.deepEqual([f.host('101').NanoCpus, f.host('202').NanoCpus, f.host('202').PidsLimit], [2e9, 3e9, 2048]);
  assert.deepEqual(h.store.all("SELECT repository_id,state FROM environment_operations WHERE action='refresh'").map(row => [row.repository_id, row.state]), [['202', 'completed']]);
  h.store.run("DELETE FROM task_claims WHERE task_id='t1'"); await h.projects.reconcile();
  assert.deepEqual([f.host('101').NanoCpus, f.host('101').Memory], [3e9, 6144 * mib]);
  // Once applied, reconciling sends nothing more.
  await h.projects.reconcile(); assert.equal(h.store.get("SELECT count(*) AS n FROM environment_operations WHERE action='refresh'").n, 2);
  // Clearing a project's own value from the console returns it to the default.
  await admin('/api/environments/202/configure', 'POST', { operation_id: id(), generation: 1, spec: { pids: null } });
  assert.deepEqual([f.host('202').PidsLimit, consoleResources('202')], [1024, {}]);
  // Project administrators can neither read nor change the defaults.
  const password = testPassword();
  await admin('/api/users', 'POST', { username: 'project-admin', password, role: 'project_admin', repository_ids: ['101'] });
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'project-admin', password });
  assert.equal((await member('/api/settings', 'PATCH', { computer_defaults: { cpus: 1 } })).status, 403);
});
