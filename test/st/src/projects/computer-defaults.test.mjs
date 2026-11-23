import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Projects } from '../../../../manager/projects.mjs';
import { AssistantComputers } from '../../../../manager/assistant-computers.mjs';
import { ManagerError } from '../../../../manager/docker.mjs';
import { FakeDocker } from '../../../fixtures/fake-docker.mjs';
import { fail } from '../../../../dist/core/security.js';
import { harness, setup, account, repository, testPassword } from '../../../fixtures/helpers.mjs';

const id = () => randomBytes(24).toString('hex'), mib = 1024 * 1024;
// The real manager project logic over a Docker stand-in with an 8-CPU, 32 GiB host; `call` stands in for its HTTP API and,
// like ManagerClient, turns a manager error into an HTTP error with the manager's status.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'defaults-')), docker = new FakeDocker();
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
  assert.deepEqual(view.defaults, { cpus: 2, memory_mb: 16384, pids: 1024, tmp_mb: 4096 }); assert.deepEqual(view.builtin, view.defaults);
  assert.deepEqual(view.host, { cpus: 8, memory_mb: 32768 }); assert.deepEqual(view.allocated, { computers: 1, cpus: 2, memory_mb: 16384 });
  for (const input of [{}, { cpus: 0.1 }, { memory_mb: 100 }, { pids: 1.5 }, { tmp_mb: '64' }, { egress: 'no' }, { cpus: null }, []])
    await assert.rejects(f.projects.setDefaults(input), /invalid_defaults/);
  // Docker cannot give a container more CPUs or memory than the host has, and project /tmp tmpfs must fit in container RAM.
  await assert.rejects(f.projects.setDefaults({ cpus: 12 }), /cpus_exceed_host/);
  await assert.rejects(f.projects.setDefaults({ memory_mb: 65536 }), /memory_exceeds_host/);
  await assert.rejects(f.projects.setDefaults({ tmp_mb: 20480 }), /tmp_exceeds_memory/);
  assert.equal(f.projects.resourceDefaults().cpus, 2);

  await f.projects.operate('101', 'configure', { operation_id: id(), generation: 1, request: { memory_mb: 2048 } });
  assert.deepEqual(f.projects.describe('101').computer.inherited, ['cpus', 'pids', 'tmp_mb']);
  view = await f.projects.setDefaults({ cpus: 4, memory_mb: 8192 });
  assert.deepEqual(view.defaults, { cpus: 4, memory_mb: 8192, pids: 1024, tmp_mb: 4096 });
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
  assert.equal(saved.status, 200); assert.deepEqual(saved.value.settings.computer_defaults.defaults, { cpus: 3, memory_mb: 6144, pids: 1024, tmp_mb: 4096 });
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

test('small and 16 GiB boundary hosts clamp defaults to 75% reserve, reject explicit equal-to-host saves, and fail closed on /info errors (#1279)', async t => {
  const f = fixture(t);
  // 1. 16 GiB boundary host: 16 GiB default clamps to 12 GiB (75% reserve), explicit 16 GiB is rejected.
  f.docker.info = { NCPU: 4, MemTotal: 16384 * mib };
  let view = await f.projects.defaultsView();
  assert.equal(view.defaults.memory_mb, 12288, '16 GiB built-in default clamps to 75% (12 GiB) on a 16 GiB host');
  assert.equal(view.defaults.tmp_mb, 4096);
  assert.deepEqual(view.host_clamped, { memory_mb: 12288, host_cap_mb: 12288 });
  assert.equal(view.tmp_clamped, null);
  await assert.rejects(f.projects.setDefaults({ memory_mb: 16384 }), /memory_exceeds_host/);

  await f.projects.register('301');
  let hostCfg = f.host('301');
  assert.equal(hostCfg.Memory, 12288 * mib);
  assert.equal(hostCfg.MemorySwap, 12288 * mib);
  const desc301 = f.projects.describe('301').computer;
  assert.equal(desc301.memory_mb, 12288, 'describe() exposes effective clamped memory');
  assert.equal(desc301.configured_memory_mb, 16384);
  assert.equal(desc301.host_clamped, true);
  assert.equal(desc301.host_memory_cap_mb, 12288);
  assert.equal(desc301.resources_pending, false, 'applied matches effective clamped spec');

  // 1b. Multiple enabled repositories on a 16 GiB host: Docker --memory is a per-container ceiling (idle project
  // containers only run idle.mjs ~7.5 MiB RSS), so all repos register and stay ready with each container individually
  // clamped to 75% host cap (12288 MiB), while busyMemoryMb() tracks only actively executing ('busy') projects.
  await Promise.all([f.projects.register('304'), f.projects.register('305'), f.projects.register('306')]);
  for (const repo of ['301', '304', '305', '306']) {
    assert.equal(f.projects.get(repo).state, 'ready', `${repo} stays ready on multi-repo 16 GiB host`);
    assert.equal(f.host(repo).Memory, 12288 * mib, `${repo} clamped individually to 75% host cap`);
  }
  assert.equal(f.projects.busyMemoryMb(), 0, 'idle ready project containers do not consume busyMemoryMb');

  // 1c. AssistantComputers wired to projects.busyMemoryMb() does not starve when idle projects exist,
  // and strictly queues new assistant turns when actively busy projects exhaust the 2x hostCap budget.
  const homes = join(f.directory, 'assistant-homes');
  const ownerA = 'a'.repeat(32);
  mkdirSync(join(homes, ownerA, 'home-1'), { recursive: true });
  f.docker.homesMount = homes;
  const assistants = new AssistantComputers({
    docker: f.docker,
    db: f.projects.db,
    deployment: 'fixture',
    image: 'approved',
    homes,
    allocatedMemoryMb: () => f.projects.busyMemoryMb(),
  });
  const acqIdle = await assistants.acquire(ownerA, { turn: 't-idle', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.equal(acqIdle.state, 'ready', 'idle projects must not starve assistant computer admission');
  assert.equal(f.docker.containers.get(assistants.name(ownerA)).HostConfig.Memory, 12288 * mib);
  await assistants.release(ownerA, { turn: 't-idle' });
  await assistants.remove(ownerA);

  // Mark two 12288 MiB projects as busy (= 24576 MiB = full 2x 12288 MiB budget) -> assistant turn strictly queues.
  f.projects.db.prepare("UPDATE projects SET state='busy' WHERE repository_id IN ('301', '304')").run();
  assert.equal(f.projects.busyMemoryMb(), 24576);
  const acqBusy = await assistants.acquire(ownerA, { turn: 't-busy', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.deepEqual(acqBusy, { state: 'queued', reason: 'capacity', position: 1 });
  f.projects.db.prepare("UPDATE projects SET state='ready' WHERE repository_id IN ('301', '304')").run();
  for (const repo of ['301', '304', '305', '306']) await f.projects.operate(repo, 'stop', { operation_id: id(), generation: 1 });

  // 1d. Upgrade recovery on a realistic 32 GiB host (31917 MiB RAM, 75% cap = 23808 MiB) with 11 active projects
  // (8 inheriting default 16 GiB + 3 explicit 1-2 GiB) + 1 deleted project: ALL 11 recover to ready cleanly.
  const f32 = fixture(t);
  f32.docker.info = { NCPU: 14, MemTotal: 33468145664 }; // exact 31917 MiB host
  const seedRepos = [
    ['1001', null], ['1002', null], ['1003', { memory_mb: 1024 }], ['1004', { memory_mb: 2048 }],
    ['1005', { memory_mb: 1024 }], ['1006', null], ['1007', null], ['1008', null],
    ['1009', null], ['1010', null], ['1011', null],
  ];
  for (const [repo, spec] of seedRepos) {
    f32.projects.db.prepare("INSERT INTO projects(repository_id,generation,state,desired,spec,applied) VALUES(?,1,'ready','ready',?,?)")
      .run(repo, spec ? JSON.stringify(spec) : null, JSON.stringify({ cpus: 2, memory_mb: spec?.memory_mb ?? 4096, pids: 1024, tmp_mb: 1024 }));
  }
  f32.projects.db.prepare("INSERT INTO projects(repository_id,generation,state,desired) VALUES('1012',1,'deleted','deleted')").run();
  await f32.projects.recover();
  for (const [repo, spec] of seedRepos) {
    assert.equal(f32.projects.get(repo).state, 'ready', `repo ${repo} must recover cleanly on 32 GiB host`);
    assert.equal(f32.host(repo).Memory, (spec?.memory_mb ?? 16384) * mib, `repo ${repo} memory ceiling`);
  }
  assert.equal(f32.projects.get('1012').state, 'deleted');
  assert.equal(f32.projects.busyMemoryMb(), 0);

  // 2. 8 GiB host: clamps to 6 GiB (6144 MiB), explicit equal-to-host 8192 MiB is rejected on both setDefaults and configure.
  f.docker.info = { NCPU: 4, MemTotal: 8192 * mib };
  view = await f.projects.defaultsView();
  assert.equal(view.defaults.memory_mb, 6144);
  assert.equal(view.defaults.tmp_mb, 4096);
  assert.deepEqual(view.host_clamped, { memory_mb: 6144, host_cap_mb: 6144 });
  await assert.rejects(f.projects.setDefaults({ memory_mb: 8192 }), /memory_exceeds_host/);
  await assert.rejects(f.projects.setDefaults({ memory_mb: 16384 }), /memory_exceeds_host/);
  await assert.rejects(f.projects.setDefaults({ tmp_mb: 8192 }), /tmp_exceeds_memory/);

  await f.projects.register('302');
  hostCfg = f.host('302');
  assert.equal(hostCfg.Memory, 6144 * mib);
  assert.equal(hostCfg.Tmpfs['/tmp'], `rw,exec,nosuid,nodev,size=${4096 * mib},mode=1777`);
  await assert.rejects(f.projects.operate('302', 'configure', { operation_id: id(), generation: 1, request: { memory_mb: 8192 } }), /memory_exceeds_host/);
  await assert.rejects(f.projects.operate('302', 'configure', { operation_id: id(), generation: 1, request: { tmp_mb: 8192 } }), /tmp_exceeds_memory/);

  // 3. /info failure (thrown error) OR resolved invalid/empty /info ({}, null) on cold manager both fail closed to 4096 MiB.
  for (const mode of ['throw', 'empty', 'null']) {
    const f2 = fixture(t);
    const origReq = f2.docker.request.bind(f2.docker);
    f2.docker.request = async (method, path, body, raw, timeout) => {
      if (path === '/info') {
        if (mode === 'throw') throw new Error('docker_socket_unreachable');
        return mode === 'empty' ? {} : null;
      }
      return origReq(method, path, body, raw, timeout);
    };
    const coldView = await f2.projects.defaultsView();
    assert.equal(coldView.defaults.memory_mb, 4096, mode);
    assert.equal(coldView.host_memory_cap_mb, 4096, mode);
    await assert.rejects(f2.projects.setDefaults({ memory_mb: 8192 }), /memory_exceeds_host/);
    await assert.rejects(f2.projects.setDefaults({ cpus: 16 }), /cpus_exceed_host/);
    await f2.projects.register('303');
    assert.equal(f2.host('303').Memory, 4096 * mib, mode);
    // describe() reflects the conservative fallback (4096 MiB / 2 CPUs) with resources_pending=false (#1279 F5/F6).
    const coldDesc = f2.projects.describe('303').computer;
    assert.equal(coldDesc.memory_mb, 4096, mode);
    assert.equal(coldDesc.configured_memory_mb, 16384, mode);
    assert.equal(coldDesc.host_memory_cap_mb, 4096, mode);
    assert.equal(coldDesc.host_cpus, 2, mode);
    assert.equal(coldDesc.host_clamped, true, mode);
    assert.equal(coldDesc.resources_pending, false, mode);
    await assert.rejects(
      f2.projects.operate('303', 'configure', { operation_id: id(), generation: 1, request: { cpus: 16 } }),
      /cpus_exceed_host/,
    );
  }
});
