import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Projects } from '../manager/projects.mjs';
import { ManagerError } from '../manager/docker.mjs';
import { FakeDocker } from './fake-docker.mjs';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { createServer } from 'node:http';
import { ManagerClient } from '../dist/projects/service.js';
const id = () => randomBytes(24).toString('hex');

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

test('the project computer spec is validated by the manager, survives restarts and is applied by recreating the container', async t => {
  const f = fixture(t); await f.projects.register('101');
  const name = f.projects.names('101', 1).container, created = f.docker.created;
  assert.deepEqual(['cpus', 'memory_mb', 'pids', 'tmp_mb', 'network_policy'].map(k => f.projects.describe('101').computer[k]), [2, 4096, 1024, 1024, 'internet egress']);
  assert.equal(f.projects.describe('101').computer.max_command_minutes, undefined); assert.equal(f.projects.describe('101').computer.bounds.max_command_minutes, undefined);
  for (const spec of [{ memory_mb: 100000 }, { cpus: 0.1 }, { pids: 100.5 }, { egress: 'yes' }, { image: 'other' }, null])
    await assert.rejects(f.projects.operate('101', 'configure', { operation_id: id(), generation: 1, request: spec }), /invalid_spec/);
  assert.equal(f.docker.created, created); assert.equal(f.projects.get('101').state, 'ready');
  const result = await f.projects.operate('101', 'configure', { operation_id: id(), generation: 1, request: { cpus: 0.5, memory_mb: 1024, pids: 256, tmp_mb: 128, egress: false } });
  const host = f.docker.containers.get(name).HostConfig;
  assert.deepEqual([host.NanoCpus, host.Memory, host.PidsLimit, host.Tmpfs['/tmp'].includes(`size=${128 * 1024 * 1024}`)], [5e8, 1024 * 1024 * 1024, 256, true]);
  assert.equal(f.docker.networks.get(f.projects.names('101', 1).network).Internal, true);
  assert.equal(result.computer.network_policy, 'internal, no egress'); assert.equal(f.docker.created, created + 1);
  assert.equal(f.docker.containers.get(name).State.Running, true); assert.equal(f.docker.volumes.size, 1);
  f.restart(); assert.equal(f.projects.spec('101').memory_mb, 1024);
  await f.projects.provision('101'); assert.equal(f.docker.created, created + 1);
});

test('packages build a derived image once, variables reach the container, and the setup script runs when it changes', async t => {
  const f = fixture(t); await f.projects.register('101');
  const name = f.projects.names('101', 1).container, configure = request => f.projects.operate('101', 'configure', { operation_id: id(), generation: 1, request });
  for (const request of [{ packages: ['ok', '-rf'] }, { packages: ['a'.repeat(120)] }, { env: { PATH: '/tmp' } }, { env: { BOT_TOKEN: 'x' } }, { env: { GOOD: 1 } },
    { setup_script: 'x'.repeat(20000) }, { max_command_minutes: 500 }, { rerun_setup: 'yes' }])
    await assert.rejects(configure(request), /invalid_(spec|packages|env|setup_script)/);
  await assert.rejects(configure({ packages: ['broken-package'] }), /image_build_failed/);
  assert.equal(f.projects.spec('101').packages.length, 0); assert.equal(f.projects.get('101').state, 'ready');
  assert.equal(f.projects.describe('101').computer.build.state, 'failed');
  const result = await configure({ packages: ['ffmpeg', 'libpq-dev'], env: { PIP_INDEX_URL: 'https://mirror.invalid/simple' }, setup_script: 'echo setup' });
  assert.equal(f.docker.builds.length, 2); assert.match(f.docker.builds[1], /apt-get install -y --no-install-recommends -- ffmpeg libpq-dev/);
  const container = f.docker.containers.get(name);
  assert.match(container.Image, /^sha256:[0-9a-f]{16}$/); assert.ok(container.Config.Env.includes('PIP_INDEX_URL=https://mirror.invalid/simple'));
  assert.ok(container.Config.Env.includes('BOT_PROJECT_ENV_KEYS=PIP_INDEX_URL'));
  assert.deepEqual([result.computer.build.state, result.computer.build.toolchain, result.computer.setup.state, result.computer.setup.exit_code], ['ready', 'fixture toolchain', 'succeeded', 0]);
  const setupRuns = () => f.docker.runs.filter(r => r.type === 'command' && r.command === 'echo setup').length;
  assert.equal(setupRuns(), 1);
  // The setup script has no time limit: no runner timer and no Docker wait limit.
  assert.deepEqual(['timeout_ms', 'wait'].map(k => f.docker.runs.find(r => r.command === 'echo setup')[k]), [null, 0]);
  await configure({ cpus: 3 }); assert.equal(setupRuns(), 1); assert.equal(f.docker.builds.length, 2);
  await configure({ rerun_setup: true }); assert.equal(setupRuns(), 2); assert.equal(f.projects.spec('101').rerun_setup, undefined);
  // Commands are not capped by the project: a caller's own timeout is kept, and none means the command runs until it ends.
  await f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'command', command: 'sleep 1', timeout_ms: 3600000 } });
  assert.deepEqual(['timeout_ms', 'wait'].map(k => f.docker.runs.find(r => r.command === 'sleep 1')[k]), [3600000, 3600000 + 60000]);
  await f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_command', workspace_id: id(), command: 'npm test' } });
  assert.deepEqual(['timeout_ms', 'wait'].map(k => f.docker.runs.find(r => r.command === 'npm test')[k]), [null, 0]);
  await assert.rejects(f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'command', command: 'true', timeout_ms: -1 } }), /invalid_runner_request/);
  // A max_command_minutes saved by an earlier version is no longer part of the spec.
  f.projects.db.prepare('UPDATE projects SET spec=? WHERE repository_id=?').run(JSON.stringify({ ...f.projects.spec('101'), max_command_minutes: 15 }), '101');
  assert.equal(f.projects.spec('101').max_command_minutes, undefined); assert.equal(f.projects.describe('101').computer.max_command_minutes, undefined);
});

test('the manager client waits as long as a command runs when no timeout is given', async t => {
  // The manager answers a command only when it ends; the client must not give up on its own (fetch stops after 5 minutes of no headers).
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => setTimeout(() => { res.statusCode = req.url.endsWith('/fail') ? 409 : 200; res.end(JSON.stringify(req.url.endsWith('/fail') ? { error: 'stale_generation' } : { result: { auth: req.headers.authorization, body: JSON.parse(body || 'null') } })); }, 300));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const client = new ManagerClient(`http://127.0.0.1:${server.address().port}`, Buffer.from('token'));
  assert.deepEqual(await client.call('POST', '/v1/projects/101/execute', { a: 1 }, 0), { auth: 'Bearer ' + Buffer.from('token').toString('base64'), body: { a: 1 } });
  await assert.rejects(client.call('GET', '/v1/projects/101', undefined, 50), /manager_unavailable/);
  await assert.rejects(client.call('POST', '/v1/projects/101/fail', {}), /stale_generation/);
});

test('both databases use default temporary storage so large sorts can spill to the container tmpfs', async t => {
  const h = await harness(t); assert.equal(h.store.get('PRAGMA temp_store').temp_store, 0);
  const f = fixture(t); assert.equal(f.projects.db.prepare('PRAGMA temp_store').get().temp_store, 0);
});

test('publication replies are allowed and policy cleanup preserves the waiting agent until task release', async t => {
  // Cleanup after a policy command and a task's release end only that task's processes; the last task clears the computer.
  const f = fixture(t); await f.projects.register('101');
  const workspace_id = id(), execute = request => f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request });
  await execute({ type: 'workspace_agent_pull_request', workspace_id, request_id: id(), base64: Buffer.from('{}').toString('base64'), offset: 0, final: true });
  assert.ok(f.docker.runs.some(r => r.type === 'workspace_agent_pull_request'));
  await execute({ type: 'workspace_command', workspace_id, command: 'node --test', timeout_ms: null });
  assert.deepEqual([f.docker.runs.at(-1).type, f.docker.runs.at(-1).workspace_id, f.docker.runs.at(-1).keep_agent], ['reap', workspace_id, true]);
  await execute({ type: 'reap', workspace_id });
  assert.deepEqual([f.docker.runs.at(-1).type, f.docker.runs.at(-1).workspace_id, f.docker.runs.at(-1).keep_agent], ['reap', workspace_id, undefined]);
  await execute({ type: 'reap', workspace_id, idle: true });
  assert.deepEqual([f.docker.runs.at(-1).type, f.docker.runs.at(-1).workspace_id], ['reap', undefined]);
});

test('Git snapshot plumbing waits for completion without changing other runner operation timeouts', async t => {
  const f=fixture(t);await f.projects.register('101');
  for(const type of ['workspace_snapshot','workspace_finalize','workspace_blob','workspace_read']){
    await f.projects.operate('101','execute',{operation_id:id(),generation:1,request:{type,workspace_id:id()}});
    assert.equal(f.docker.runs.at(-1).wait,type==='workspace_read'?90000:0);
  }
});

// Task commands that wait until the test finishes them; a stopped container fails the ones still running, as Docker does.
function gatedRunner(docker) {
  const waiting = new Map(), started = [], runner = docker.runner.bind(docker), request = docker.request.bind(docker);
  docker.runner = async (container, input, wait) => {
    if (input.type !== 'workspace_command') return runner(container, input, wait);
    docker.runs.push({ ...input, wait }); started.push(input.command);
    if (input.command === 'boom') throw new ManagerError('runner_failed');
    await new Promise((resolve, reject) => waiting.set(input.command, { resolve, reject }));
    return { ok: true, result: { exit_code: 0, output: input.command } };
  };
  docker.request = async (method, path, body) => {
    if (path.endsWith('/stop?t=2')) for (const [command, call] of waiting) { waiting.delete(command); call.reject(new ManagerError('runner_failed')); }
    return request(method, path, body);
  };
  return { started, finish: command => { waiting.get(command).resolve(); waiting.delete(command); } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('runner calls share a computer up to its parallel setting; a busy computer still takes calls and extra ones wait', async t => {
  const f = fixture(t); await f.projects.register('101'); const g = gatedRunner(f.docker);
  const run = command => f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_command', workspace_id: id(), command } });
  assert.equal(f.projects.describe('101').parallel, 1);
  // Unchanged settings keep one call at a time, as before.
  const a = run('a'), b = run('b'); await settle();
  assert.deepEqual(g.started, ['a']); assert.equal(f.projects.get('101').state, 'busy');
  g.finish('a'); await a; await settle(); assert.deepEqual(g.started, ['a', 'b']);
  // Raising the limit admits a waiting call at once; a busy computer does not refuse new calls.
  const c = run('c'); await settle(); assert.deepEqual(g.started, ['a', 'b']);
  assert.equal(f.projects.parallelism('101', 2).parallel, 2); await settle(); assert.deepEqual(g.started, ['a', 'b', 'c']);
  const d = run('d'); await settle(); assert.deepEqual(g.started, ['a', 'b', 'c']);
  g.finish('b'); await b; await settle(); assert.deepEqual(g.started, ['a', 'b', 'c', 'd']); assert.equal(f.projects.get('101').state, 'busy');
  g.finish('c'); g.finish('d'); await Promise.all([c, d]); assert.equal(f.projects.get('101').state, 'ready');
  for (const value of [0, 33, 1.5, '2']) assert.throws(() => f.projects.parallelism('101', value), /invalid_parallel/);
  assert.throws(() => f.projects.parallelism('202', 2), /project_not_registered/);
  // A malformed request is refused before it can touch the computer.
  await assert.rejects(f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_command', workspace_id: 'w1', command: 'x' } }), /invalid_runner_request/);
  assert.equal(f.projects.get('101').state, 'ready');
});

test('a stop interrupts every running command and runs alone; a configure waits for running commands and holds back new ones', async t => {
  const f = fixture(t); await f.projects.register('101'); f.projects.parallelism('101', 3); const g = gatedRunner(f.docker);
  const run = command => f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_command', workspace_id: id(), command } });
  const configured = [];
  const first = run('first'); await settle();
  const configure = f.projects.operate('101', 'configure', { operation_id: id(), generation: 1, request: { cpus: 3 } }).then(value => { configured.push('configure'); return value; });
  const later = run('later'); await settle();
  // The configure waits for the running command; the call that came after it waits behind the configure.
  assert.deepEqual(g.started, ['first']); assert.deepEqual(configured, []);
  g.finish('first'); await first; await configure; await settle(); assert.deepEqual(configured, ['configure']);
  assert.deepEqual(g.started, ['first', 'later']); g.finish('later'); await later;
  const one = run('one'), two = run('two'); await settle(); assert.deepEqual(g.started.slice(-2), ['one', 'two']);
  const stopped = await f.projects.operate('101', 'stop', { operation_id: id(), generation: 1 });
  await assert.rejects(one, /runner_failed/); await assert.rejects(two, /runner_failed/);
  assert.equal(stopped.state, 'stopped'); assert.equal(f.projects.get('101').state, 'stopped');
  await assert.rejects(run('after'), /environment_not_ready/);
});

test('a failed runner call ends only its own task workspace; the computer and the other task keep running', async t => {
  const f = fixture(t); await f.projects.register('101'); f.projects.parallelism('101', 2); const g = gatedRunner(f.docker);
  const mine = id(), other = id(), started = f.projects.get('101').started_at;
  const long = f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_command', workspace_id: other, command: 'long' } });
  await settle();
  await assert.rejects(f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_command', workspace_id: mine, command: 'boom' } }), /runner_failed/);
  const reaps = f.docker.runs.filter(r => r.type === 'reap');
  assert.deepEqual(reaps.map(r => r.workspace_id), [mine]); assert.equal(f.projects.get('101').state, 'busy'); assert.equal(f.projects.get('101').started_at, started);
  assert.equal(f.docker.containers.get(f.projects.names('101', 1).container).State.Running, true);
  g.finish('long'); assert.equal((await long).ok, true); assert.equal(f.projects.get('101').state, 'ready');
});
