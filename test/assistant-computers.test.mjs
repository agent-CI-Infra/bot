import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AssistantComputers, abandonAfterMs, assistantDefaults } from '../manager/assistant-computers.mjs';
import { Projects } from '../manager/projects.mjs';
import { createManagerServer } from '../manager/server.mjs';
import { FakeDocker } from './fake-docker.mjs';
import { ManagerError } from '../manager/docker.mjs';
import { ManagerClient } from '../dist/projects/service.js';

const hex = n => randomBytes(n).toString('hex'), opId = () => hex(24);
const fence = 'f'.repeat(64);
function fixture(t, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-computers-')), homes = join(directory, 'homes'); mkdirSync(homes);
  const docker = new FakeDocker(); docker.homesMount = homes; docker.info = { NCPU: 8, MemTotal: 32 * 1024 ** 3 };
  const db = new DatabaseSync(':memory:'), computers = new AssistantComputers({ docker, db, deployment: 'fixture', image: 'approved', homes, ...extra });
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  // The control plane creates an owner's generation directory before it asks for the computer.
  const home = (owner, generation = 1) => mkdirSync(join(homes, owner, 'home-' + generation), { recursive: true });
  const owner = (generation = 1) => { const id = hex(16); home(id, generation); return id; };
  const acquire = (id, turn, input = {}) => computers.acquire(id, { turn, fence, home_generation: 1, home_mode: 'rw', ...input });
  return { directory, homes, docker, db, computers, home, owner, acquire };
}

test('an assistant computer is a hardened container without network whose only persistent mount is its owner HOME generation', async t => {
  const f = fixture(t), id = f.owner(), turn = opId();
  const ready = await f.acquire(id, turn);
  assert.deepEqual([ready.state, ready.reused, ready.computer.state, ready.computer.turn], ['ready', false, 'busy', turn]);
  const created = f.docker.containers.get(f.computers.name(id)), host = created.HostConfig;
  assert.deepEqual([created.Config.User, host.ReadonlyRootfs, host.CapDrop, host.SecurityOpt, host.Privileged, host.NetworkMode, host.IpcMode, host.Init],
    ['10001:10001', true, ['ALL'], ['no-new-privileges:true'], false, 'none', 'private', true]);
  assert.ok(!('Runtime' in host), 'Docker\'s default runtime, never one named by a setting');
  assert.equal(host.Memory, host.MemorySwap, 'no swap beyond the memory limit');
  // The default resources: 1 CPU, 2048 MiB, 512 processes, 512 MiB each for /tmp and the working directory.
  assert.deepEqual([host.NanoCpus, host.Memory, host.PidsLimit], [1e9, 2048 * 1024 ** 2, 512]);
  assert.match(host.Tmpfs['/tmp'], new RegExp(`size=${512 * 1024 ** 2},`));
  assert.deepEqual(host.Mounts, [{ Type: 'volume', Source: 'fixture-assistant-homes', Target: '/home/assistant', ReadOnly: false, VolumeOptions: { NoCopy: true, Subpath: `${id}/home-1` } }]);
  assert.deepEqual(Object.keys(host.Tmpfs).sort(), ['/tmp', '/workspace']);
  assert.match(host.Tmpfs['/workspace'], /size=\d+.*uid=10001/);
  assert.deepEqual(created.Config.Env, ['HOME=/home/assistant', 'LANG=C.UTF-8', 'BOT_COMPUTER_KIND=assistant']);
  assert.equal(created.Image, 'approved');
  assert.deepEqual(created.Config.Labels, { 'department.bot.deployment': 'fixture', 'department.bot.kind': 'assistant', 'department.bot.owner': id });
  assert.ok(!JSON.stringify(created).includes('docker.sock') && !host.Binds);
  assert.equal(f.docker.runs.at(-1).type, 'health');
  // The inspected facts the control plane may check against its own policy.
  const facts = f.computers.facts(await f.computers.inspect(id));
  assert.deepEqual([facts.network_mode, facts.readonly_rootfs, facts.mounts], ['none', true, [{ type: 'volume', source: 'fixture-assistant-homes', target: '/home/assistant', read_only: false, subpath: `${id}/home-1` }]]);
});

test('a later turn reuses the idle container; a changed fence, HOME generation or mode replaces it', async t => {
  const f = fixture(t), id = f.owner();
  await f.acquire(id, 'turn-1');
  assert.deepEqual(await f.computers.release(id, { turn: 'turn-1' }), { state: 'idle', released: true });
  assert.deepEqual(f.docker.runs.slice(-2).map(r => r.type), ['reap', 'journal_clear'], 'the turn\'s processes end and its journal is cleared');
  const created = f.docker.created;
  const reused = await f.acquire(id, 'turn-2');
  assert.deepEqual([reused.reused, f.docker.created], [true, created]);
  // The same turn asking again keeps it (a retried request).
  assert.equal((await f.acquire(id, 'turn-2')).computer.turn, 'turn-2');
  await f.computers.release(id, { turn: 'turn-2' });
  // Another authorization fence: the container is removed and created again.
  const replaced = await f.acquire(id, 'turn-3', { fence: 'e'.repeat(64) });
  assert.deepEqual([replaced.reused, f.docker.created], [false, created + 1]);
  assert.ok(f.docker.calls.includes(`DELETE /containers/${f.computers.name(id)}?force=true`));
  await f.computers.release(id, { turn: 'turn-3' });
  // Over its HOME limit the next turn gets the same HOME read-only.
  await f.acquire(id, 'turn-4', { fence: 'e'.repeat(64), home_mode: 'ro' });
  assert.equal(f.docker.containers.get(f.computers.name(id)).HostConfig.Mounts[0].ReadOnly, true);
  await f.computers.release(id, { turn: 'turn-4' });
  // A new HOME generation mounts only the new directory.
  f.home(id, 2);
  await f.acquire(id, 'turn-5', { fence: 'e'.repeat(64), home_generation: 2 });
  assert.equal(f.docker.containers.get(f.computers.name(id)).HostConfig.Mounts[0].VolumeOptions.Subpath, `${id}/home-2`);
  assert.equal(f.docker.containers.size, 1);
});

test('operations need the turn holding the computer and an allowlisted runner type', async t => {
  const f = fixture(t), id = f.owner();
  await f.acquire(id, 'turn-1');
  const ran = await f.computers.execute(id, { turn: 'turn-1', operation_id: opId(), request: { type: 'command', command: 'true', timeout_ms: 5000 } });
  assert.equal(ran.ok, true);
  assert.deepEqual([f.docker.runs.at(-1).type, f.docker.runs.at(-1).wait], ['command', 35000]);
  await assert.rejects(f.computers.execute(id, { turn: 'other', operation_id: opId(), request: { type: 'command', command: 'true' } }), /assistant_computer_not_acquired/);
  for (const type of ['workspace_command', 'workspace_read', 'reap', 'journal_clear', 'health', 'tasks_remove'])
    await assert.rejects(f.computers.execute(id, { turn: 'turn-1', operation_id: opId(), request: { type, command: 'true' } }), /invalid_runner_request/, type);
  await assert.rejects(f.computers.execute(id, { turn: 'turn-1', operation_id: opId(), request: { type: 'assistant_read', path: '/tmp/a', workspace_id: opId() } }), /invalid_runner_request/);
  await assert.rejects(f.computers.execute(id, { turn: 'turn-1', operation_id: 'short', request: { type: 'command', command: 'true' } }), /invalid_operation/);
  assert.equal((await f.computers.execute(id, { turn: 'turn-1', operation_id: opId(), request: { type: 'assistant_write', path: 'a.txt', base64: '', offset: 0 } })).ok, true);
  await f.computers.release(id, { turn: 'turn-1' });
  await assert.rejects(f.computers.execute(id, { turn: 'turn-1', operation_id: opId(), request: { type: 'command', command: 'true' } }), /assistant_computer_not_acquired/);
  await assert.rejects(f.computers.execute(hex(16), { turn: 'turn-1', operation_id: opId(), request: { type: 'command', command: 'true' } }), /assistant_computer_released/);
  for (const bad of ['../x', 'A'.repeat(32), hex(15)]) await assert.rejects(f.acquire(bad, 'turn'), /invalid_assistant_owner/);
  await assert.rejects(f.computers.acquire(id, { turn: 'turn', fence, home_generation: 1, home_mode: 'rw', volume: 'other' }), /invalid_assistant_request/);
});

test('idle, lifetime and abandoned computers are removed; a busy one is never cut short', async t => {
  const f = fixture(t), idle = f.owner(), busy = f.owner(), running = f.owner();
  for (const [id, turn] of [[idle, 'a'], [busy, 'b'], [running, 'c']]) await f.acquire(id, turn);
  await f.computers.release(idle, { turn: 'a' });
  assert.equal(await f.computers.check(), 0);
  // Five idle minutes end it; a turn that keeps renewing (model thinking) keeps it for as long as it runs.
  f.computers.leases.get(idle).used -= assistantDefaults.idle_minutes * 60_000;
  f.computers.leases.get(busy).created -= 24 * 3600_000;
  f.computers.renew(busy, { turn: 'b' });
  assert.equal(await f.computers.check(), 1);
  assert.ok(!f.docker.containers.has(f.computers.name(idle)) && f.docker.containers.has(f.computers.name(busy)));
  // Past its lifetime it is replaced at the next turn, never during this one.
  await f.computers.release(busy, { turn: 'b' });
  const created = f.docker.created;
  assert.equal((await f.acquire(busy, 'b2')).reused, false); assert.equal(f.docker.created, created + 1);
  // A turn whose control plane stopped renewing it is abandoned, unless one of its commands still runs.
  f.computers.leases.get(running).renewed -= abandonAfterMs;
  f.computers.leases.get(running).inflight = 1;
  assert.equal(await f.computers.check(), 0);
  f.computers.leases.get(running).inflight = 0;
  assert.equal(await f.computers.check(), 1);
  assert.ok(!f.docker.containers.has(f.computers.name(running)));
  await assert.rejects(Promise.resolve().then(() => f.computers.renew(running, { turn: 'c' })), /assistant_computer_released/);
});

test('one turn per owner: another turn waits until it is released or abandoned', async t => {
  const f = fixture(t), id = f.owner();
  await f.acquire(id, 'console-turn');
  assert.deepEqual(await f.acquire(id, 'feishu-turn'), { state: 'queued', reason: 'owner_busy', position: 1 });
  f.computers.leases.get(id).renewed -= abandonAfterMs;
  const taken = await f.acquire(id, 'feishu-turn');
  assert.deepEqual([taken.state, taken.reused, taken.computer.turn], ['ready', false, 'feishu-turn']);
  await assert.rejects(f.computers.execute(id, { turn: 'console-turn', operation_id: opId(), request: { type: 'command', command: 'true' } }), /assistant_computer_not_acquired/);
  assert.deepEqual(await f.computers.release(id, { turn: 'console-turn' }), { state: 'busy', released: false });
});

test('at capacity the idle computer used longest ago gives way; otherwise owners wait in arrival order', async t => {
  const f = fixture(t), [a, b, c, d] = [f.owner(), f.owner(), f.owner(), f.owner()];
  await f.computers.setSettings({ max_containers: 2 });
  await f.acquire(a, 'ta'); await f.acquire(b, 'tb');
  assert.deepEqual(await f.acquire(c, 'tc'), { state: 'queued', reason: 'capacity', position: 1 });
  assert.deepEqual(await f.acquire(d, 'td'), { state: 'queued', reason: 'capacity', position: 2 });
  await f.computers.release(b, { turn: 'tb' });
  // d asked first after the slot freed up but c is ahead of it.
  assert.equal((await f.acquire(d, 'td')).position, 2);
  const taken = await f.acquire(c, 'tc');
  assert.equal(taken.state, 'ready');
  assert.ok(!f.computers.leases.has(b) && !f.docker.containers.has(f.computers.name(b)), 'the idle computer was removed');
  assert.deepEqual(await f.acquire(d, 'td'), { state: 'queued', reason: 'capacity', position: 1 });
  // An owner that already has a computer is not queued behind new owners.
  await f.computers.release(a, { turn: 'ta' });
  assert.equal((await f.acquire(a, 'ta2')).reused, true);
  assert.deepEqual((await f.computers.settingsView()).usage, { computers: 2, busy: 2, waiting: 1 });
});

test('reconcile keeps only the computers of turns the control plane still runs; a restart removes leftovers', async t => {
  const f = fixture(t), [a, b, c] = [f.owner(), f.owner(), f.owner()];
  await f.acquire(a, 'ta'); await f.acquire(b, 'tb'); await f.acquire(c, 'tc'); await f.computers.release(c, { turn: 'tc' });
  assert.deepEqual(await f.computers.reconcile({ turns: ['ta'] }), { removed: 2 });
  assert.deepEqual([...f.computers.leases.keys()], [a]);
  assert.ok(f.docker.containers.has(f.computers.name(a)) && !f.docker.containers.has(f.computers.name(b)));
  // Another deployment's containers are not touched.
  f.docker.containers.set('other-deployment', { Config: { Labels: { 'department.bot.deployment': 'other', 'department.bot.kind': 'assistant' } }, HostConfig: {}, State: { Running: true } });
  const restarted = new AssistantComputers({ docker: f.docker, db: f.db, deployment: 'fixture', image: 'approved', homes: f.homes });
  assert.equal(await restarted.recover(), 1);
  assert.deepEqual([...f.docker.containers.keys()], ['other-deployment']);
});

test('removing a computer that is still going away waits for that removal instead of failing', async t => {
  const f = fixture(t), id = f.owner();
  await f.acquire(id, 'turn'); await f.computers.release(id, { turn: 'turn' });
  // Docker answers a second DELETE of a container whose removal is still in progress with HTTP 409.
  const request = f.docker.request.bind(f.docker); let open, deleting = false; const gate = new Promise(resolve => { open = resolve; });
  f.docker.request = async (method, path, body) => {
    if (method !== 'DELETE' || !path.startsWith('/containers/')) return request(method, path, body);
    if (deleting) throw Object.assign(new ManagerError('docker_operation_failed', 503), { detail: 'HTTP 409: removal already in progress' });
    deleting = true; await gate; try { return await request(method, path, body); } finally { deleting = false; }
  };
  // The control plane's sweep removes the computer (its fence changed) while a console clear removes it too.
  const sweep = f.computers.remove(id, 'fence'), clear = f.computers.remove(id);
  await new Promise(resolve => setImmediate(resolve)); open();
  assert.deepEqual(await Promise.all([sweep, clear]), [{ owner: id, state: 'removed' }, { owner: id, state: 'removed' }]);
  assert.ok(!f.docker.containers.has(f.computers.name(id)));
  assert.equal(f.docker.calls.filter(call => call.startsWith('DELETE /containers/')).length, 1, 'the container is deleted once');
});

test('creation fails clearly and leaves nothing behind', async t => {
  const f = fixture(t), id = f.owner(), missing = hex(16);
  await assert.rejects(f.acquire(missing, 't'), /assistant_home_missing/);
  // An owner directory replaced by a symlink is refused, not followed.
  const linked = hex(16); mkdirSync(join(f.homes, 'target', 'home-1'), { recursive: true }); symlinkSync(join(f.homes, 'target'), join(f.homes, linked));
  await assert.rejects(f.acquire(linked, 't'), /assistant_home_missing/);
  f.docker.failCreate = true;
  await assert.rejects(f.acquire(id, 't'), /docker_operation_failed/);
  assert.equal(f.computers.leases.size, 0);
  f.docker.failCreate = false;
  // Docker answers a missing image with 404, which reads as nothing: a clear creation failure, not container_missing later.
  const request = f.docker.request.bind(f.docker);
  f.docker.request = async (method, path, body) => method === 'POST' && path.startsWith('/containers/create') ? null : request(method, path, body);
  await assert.rejects(f.acquire(id, 't'), error => error.message === 'assistant_computer_create_failed' && /approved not found/.test(error.detail));
  assert.equal(f.computers.leases.size, 0);
  f.docker.request = request; f.docker.runner = async () => ({ ok: false });
  await assert.rejects(f.acquire(id, 't'), /runner_not_ready/);
  await new Promise(resolve => setImmediate(resolve)); await Promise.all([...f.computers.removing.values()]);
  assert.deepEqual([f.computers.leases.size, f.docker.containers.size], [0, 0]);
  const noVolume = fixture(t); noVolume.docker.homesMount = '/elsewhere';
  await assert.rejects(noVolume.acquire(noVolume.owner(), 't'), /assistant_homes_unavailable/);
});

test('settings are bounded and resources apply from the next turn; removal during creation removes the new container', async t => {
  const f = fixture(t);
  const view = await f.computers.settingsView();
  assert.deepEqual([view.settings, view.host], [assistantDefaults, { cpus: 8, memory_mb: 32768 }]);
  for (const bad of [{}, { idle_minutes: 0 }, { max_containers: 1.5 }, { max_lifetime_minutes: 5 }, { cpus: 0.1 }, { cpus: 1.234 }, { memory_mb: 100 }, { pids: 10 },
    { tmp_mb: 1.5 }, { workspace_mb: 20000 }, { runtime: 'runc' }, { other: 1 }])
    await assert.rejects(f.computers.setSettings(bad), /invalid_assistant_settings/, JSON.stringify(bad));
  await assert.rejects(f.computers.setSettings({ cpus: 12 }), /cpus_exceed_host/);
  // A runtime saved by an earlier version is dropped: every computer runs on Docker's default runtime.
  f.db.prepare("INSERT INTO settings VALUES('assistant_computers',?)").run(JSON.stringify({ idle_minutes: 7, runtime: 'io.containerd.runc.v2' }));
  assert.deepEqual(f.computers.settings(), { ...assistantDefaults, idle_minutes: 7 });
  assert.equal((await f.computers.setSettings({ idle_minutes: 10 })).settings.idle_minutes, 10);
  assert.ok(!JSON.parse(f.db.prepare("SELECT value FROM settings WHERE key='assistant_computers'").get().value).runtime);
  // New resources: the running turn keeps its computer; the owner's next turn replaces the idle one with the new limits.
  const id = f.owner(), host = () => f.docker.containers.get(f.computers.name(id)).HostConfig;
  await f.acquire(id, 't1');
  await f.computers.setSettings({ cpus: 2, memory_mb: 1024, pids: 256, tmp_mb: 256, workspace_mb: 1024 });
  assert.deepEqual((await f.acquire(id, 't1')).computer.resources, { cpus: 1, memory_mb: 2048, pids: 512, tmp_mb: 512, workspace_mb: 512 });
  await f.computers.release(id, { turn: 't1' });
  const next = await f.acquire(id, 't2');
  assert.deepEqual([next.reused, next.computer.resources], [false, { cpus: 2, memory_mb: 1024, pids: 256, tmp_mb: 256, workspace_mb: 1024 }]);
  assert.deepEqual([host().NanoCpus, host().Memory, host().MemorySwap, host().PidsLimit], [2e9, 1024 * 1024 ** 2, 1024 * 1024 ** 2, 256]);
  assert.match(host().Tmpfs['/tmp'], new RegExp(`size=${256 * 1024 ** 2},`)); assert.match(host().Tmpfs['/workspace'], new RegExp(`size=${1024 * 1024 ** 2},`));
  await f.computers.release(id, { turn: 't2' });
  assert.equal((await f.acquire(id, 't3')).reused, true, 'unchanged resources keep the idle computer');
  // A reconcile while the container is being created.
  const other = f.owner(), health = f.docker.runner.bind(f.docker);
  f.docker.runner = async (...args) => { await f.computers.reconcile({ turns: [] }); return health(...args); };
  await assert.rejects(f.acquire(other, 'late'), /assistant_computer_released/);
  await Promise.all([...f.computers.removing.values()]);
  assert.ok(!f.docker.containers.has(f.computers.name(other)));
});

test('the manager API serves assistant computers to the control plane', async t => {
  const f = fixture(t), directory = mkdtempSync(join(tmpdir(), 'assistant-api-'));
  const projects = new Projects({ database: join(directory, 'manager.sqlite'), docker: f.docker, deployment: 'fixture', image: 'approved' });
  t.after(() => { projects.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const token = randomBytes(32), created = createManagerServer({ projects, token, assistants: f.computers });
  created.server.listen(0, '127.0.0.1'); await new Promise(r => created.server.once('listening', r)); await created.recovered;
  t.after(() => created.server.close());
  const manager = new ManagerClient('http://127.0.0.1:' + created.server.address().port, token), id = f.owner();
  const ready = await manager.call('PUT', '/v1/assistant-computers/' + id, { turn: 'turn-1', fence, home_generation: 1, home_mode: 'rw' });
  assert.equal(ready.state, 'ready');
  assert.equal((await manager.call('POST', `/v1/assistant-computers/${id}/execute`, { turn: 'turn-1', operation_id: opId(), request: { type: 'command', command: 'true' } })).ok, true);
  assert.equal((await manager.call('POST', `/v1/assistant-computers/${id}/renew`, { turn: 'turn-1' })).state, 'busy');
  assert.equal((await manager.call('GET', '/v1/assistant-computers')).computers[0].owner, id);
  assert.equal((await manager.call('GET', '/v1/assistant-computers/' + id)).container.network_mode, 'none');
  assert.equal((await manager.call('POST', `/v1/assistant-computers/${id}/release`, { turn: 'turn-1' })).state, 'idle');
  assert.equal((await manager.call('PUT', '/v1/assistant-computers/settings', { max_containers: 3 })).settings.max_containers, 3);
  assert.equal((await manager.call('POST', '/v1/assistant-computers/reconcile', { turns: [] })).removed, 1);
  await assert.rejects(manager.call('PUT', '/v1/assistant-computers/not-an-owner', {}), /not_found/);
  await assert.rejects(manager.call('POST', `/v1/assistant-computers/${id}/execute`, { turn: 'turn-1', operation_id: opId(), request: { type: 'command', command: 'true' } }), /assistant_computer_released/);
});

test('in an assistant computer, HOME is the persistent mount and package caches go to /tmp', () => {
  const read = env => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./runner/command.mjs'); process.stdout.write(JSON.stringify(m.environment));"], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
  const assistant = read({ BOT_COMPUTER_KIND: 'assistant' }), project = read({});
  assert.deepEqual([assistant.HOME, assistant.XDG_CACHE_HOME, assistant.PIP_CACHE_DIR, assistant.UV_CACHE_DIR, assistant.npm_config_cache, assistant.TMPDIR],
    ['/home/assistant', '/tmp/.cache', '/tmp/.cache/pip', '/tmp/.cache/uv', '/tmp/.npm', '/tmp']);
  assert.match(assistant.PATH, /^\/home\/assistant\/\.local\/bin:/);
  assert.equal(project.HOME, '/workspace/home'); assert.equal(project.XDG_CACHE_HOME, undefined);
});
