import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Projects } from '../manager/projects.mjs';
import { ManagerError } from '../manager/docker.mjs';
import { FakeDocker } from './fake-docker.mjs';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { createServer } from 'node:http';
import { ManagerClient } from '../dist/projects/service.js';
import { fail } from '../dist/core/security.js';
const id = () => randomBytes(24).toString('hex');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'env-unit-'));
  const docker = new FakeDocker(), options = { database: join(directory, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' };
  let projects = new Projects(options);
  t.after(() => { projects.db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { docker, get projects() { return projects; }, restart: () => { projects.db.close(); projects = new Projects(options); } };
}
test('one persistent environment per repository and fully owned resources only', async t => {
  const f = fixture(t); await Promise.all(Array.from({ length: 5 }, () => f.projects.register('101')));
  assert.equal(f.docker.containers.size, 1); assert.equal(f.docker.volumes.size, 2); assert.equal(f.projects.get('101').state, 'ready');
  const name = f.projects.names('101', 1).container;
  f.docker.containers.get(name).Config.Labels['department.bot.repository'] = '202';
  await assert.rejects(f.projects.operate('101', 'stop', { operation_id: id(), generation: 1 }), /resource_ownership_mismatch/);
  assert.equal(f.docker.containers.get(name).State.Running, true);
});
test('reset fences the generation, preserves old volume, and never starts two writers', async t => {
  const f = fixture(t); await f.projects.register('101');
  const request = { operation_id: id(), generation: 1 };
  const result = await f.projects.operate('101', 'reset', request);
  assert.equal(result.generation, 2); assert.equal(f.docker.volumes.size, 3);
  assert.equal(f.docker.containers.get(f.projects.names('101', 1).container).State.Running, false);
  assert.equal([...f.docker.containers.values()].filter(c => c.State.Running).length, 1);
  assert.deepEqual(await f.projects.operate('101', 'reset', request), { ...result });
  await assert.rejects(f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'command', command: 'true' } }), /stale_generation/);
  await f.projects.operate('101', 'stop', { operation_id: id(), generation: 2 });
  await f.projects.operate('101', 'delete', { operation_id: id(), generation: 2 });
  assert.equal(f.docker.containers.size, 0); assert.equal(f.docker.networks.size, 0); assert.equal(f.docker.volumes.size, 3);
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

test('environment observation distinguishes an unreachable or absent manager record from the persisted lifecycle state', async t => {
  let mode='available';const rows=new Map();
  const manager={async call(method,path){const repo=path.split('/')[3];if(method==='PUT')rows.set(repo,{repository_id:repo,generation:1,state:'ready',desired:'ready',revision:1,computer:{image:'approved'}});
    if(mode==='unavailable')throw new Error('PRIVATE_MANAGER_SECRET');if(mode==='recovering')fail(503,'manager_not_ready');if(mode==='error')fail(403,'PRIVATE_MANAGER_SECRET');return mode==='absent'?null:rows.get(repo)||null;}};
  const h=await harness(t,manager),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const before=h.store.get("SELECT state FROM project_environments WHERE repository_id='101'").state;
  const ready=(await admin('/api/environments/101')).value;assert.equal(ready.observation.status,'available');assert.equal(ready.observation.state,'ready');
  assert.ok(Number.isFinite(Date.parse(ready.observation.checked_at)));
  rows.get('101').state='stopped';const fresh=(await admin('/api/environments/101')).value;
  assert.equal(fresh.observation.state,'stopped');assert.equal(fresh.environment.state,before);rows.get('101').state='ready';
  for(const value of ['unavailable','absent','recovering','error']){mode=value;const response=await admin('/api/environments/101');assert.equal(response.status,200);
    assert.equal(response.value.environment.state,before);assert.equal(response.value.observation.status,value);assert.equal(response.value.observation.state,null);
    assert.equal(response.value.environment.computer,null);assert.ok(!JSON.stringify(response.value).includes('PRIVATE_MANAGER_SECRET'));
    assert.equal(h.store.get("SELECT state FROM project_environments WHERE repository_id='101'").state,before);}
  mode='available';assert.equal((await admin('/api/environments/101')).value.observation.state,'ready');
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
  assert.equal(f.docker.containers.get(name).State.Running, true); assert.equal(f.docker.volumes.size, 2);
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
  for(const type of ['workspace_agent_history','workspace_agent_session','workspace_agent_boundary','workspace_agent_continue','workspace_reuse','workspace_cache','workspace_agent_progress']){
    await execute({type,workspace_id,request_id:id(),base64:Buffer.from('{}').toString('base64'),offset:0,final:true,sequence:1});
    assert.ok(f.docker.runs.some(r=>r.type===type),type);
  }
  await execute({ type: 'workspace_command', workspace_id, command: 'node --test', timeout_ms: null });
  assert.deepEqual([f.docker.runs.at(-1).type, f.docker.runs.at(-1).workspace_id, f.docker.runs.at(-1).keep_agent], ['reap', workspace_id, true]);
  await execute({ type: 'reap', workspace_id });
  assert.deepEqual([f.docker.runs.at(-1).type, f.docker.runs.at(-1).workspace_id, f.docker.runs.at(-1).keep_agent], ['reap', workspace_id, undefined]);
  await execute({ type: 'reap', workspace_id, idle: true });
  assert.deepEqual([f.docker.runs.at(-1).type, f.docker.runs.at(-1).workspace_id], ['reap', undefined]);
});

test('both databases cap their WAL file; a WAL past the cap is cut back to it after a checkpoint', async t => {
  const h = await harness(t); assert.equal(h.store.get('PRAGMA journal_size_limit').journal_size_limit, 512 * 1024 * 1024);
  const f = fixture(t); assert.equal(f.projects.db.prepare('PRAGMA journal_size_limit').get().journal_size_limit, 512 * 1024 * 1024);
  // The same mechanism on a small scale: this connection's cap is lowered to 64 KiB. A reader keeps the log from being
  // reused while writes grow it past the cap; once a checkpoint has copied everything back, the next write cuts it.
  const store = h.store, file = h.database + '-wal', limit = 64 * 1024, reader = new DatabaseSync(h.database);
  t.after(() => reader.close());
  store.db.exec(`PRAGMA journal_size_limit=${limit}; CREATE TABLE wal_probe(value BLOB)`);
  reader.exec('BEGIN'); reader.prepare('SELECT count(*) FROM wal_probe').get();
  for (let i = 0; i < 100; i++) store.run('INSERT INTO wal_probe VALUES(randomblob(10000))');
  assert.ok(statSync(file).size > 1024 * 1024); reader.exec('COMMIT');
  assert.equal(store.get('PRAGMA wal_checkpoint(PASSIVE)').busy, 0);
  store.run('INSERT INTO wal_probe VALUES(1)');
  assert.ok(statSync(file).size <= limit, String(statSync(file).size));
});

test('workspace cleanup calls name task directories only; removal has no time limit, and a failed cleanup call leaves the computer running', async t => {
  const f = fixture(t); await f.projects.register('101');
  const name = id(), started = f.projects.get('101').started_at, run = request => f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request });
  await run({ type: 'tasks_list' }); assert.deepEqual([f.docker.runs.at(-1).type, f.docker.runs.at(-1).wait], ['tasks_list', 300000]);
  await run({ type: 'tasks_remove', entries: [{ name, active_at: 1 }] });
  assert.deepEqual([f.docker.runs.at(-1).type, f.docker.runs.at(-1).wait, f.docker.runs.at(-1).entries], ['tasks_remove', 0, [{ name, active_at: 1 }]]);
  for (const request of [{ type: 'tasks_list', entries: [] }, { type: 'tasks_list', workspace_id: name }, { type: 'tasks_remove' }, { type: 'tasks_remove', entries: [] },
    { type: 'tasks_remove', entries: Array.from({ length: 21 }, () => ({ name: id(), active_at: 1 })) }, { type: 'tasks_remove', entries: [{ name: '../etc', active_at: 1 }] },
    { type: 'tasks_remove', entries: [{ name, active_at: -1 }] }, { type: 'tasks_remove', entries: [{ name, active_at: 1, path: '/' }] }, { type: 'tasks_remove', entries: [name] },
    { type: 'tasks_remove', entries: [{ name, active_at: 1 }], command: 'rm -rf /' }, { type: 'workspace_read', workspace_id: name, path: 'a', entries: [] }])
    await assert.rejects(run(request), /invalid_runner_request/, JSON.stringify(request));
  // An uncertain answer fails only that call: it started no project process, and a removal going on deletes only what it was sent.
  const runner = f.docker.runner; f.docker.runner = (container, input, wait) => input.type.startsWith('tasks_') ? Promise.reject(new ManagerError('runner_failed')) : runner.call(f.docker, container, input, wait);
  await assert.rejects(run({ type: 'tasks_remove', entries: [{ name, active_at: 1 }] }), /runner_failed/);
  await assert.rejects(run({ type: 'tasks_list' }), /runner_failed/);
  assert.equal(f.projects.get('101').state, 'ready'); assert.equal(f.projects.get('101').started_at, started);
  assert.equal(f.docker.containers.get(f.projects.names('101', 1).container).State.Running, true);
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

// The incident behind these two tests: on a computer running four tasks, a reap that could not end leftover processes
// restarted the container from its shared slot; another task's call then found the container changed, which stopped the
// computer as failed (recovery_required) and left every task waiting for it.
test('a failed call whose processes cannot be ended restarts the computer alone; the call beside it finishes', async t => {
  const lines = []; t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const f = fixture(t); await f.projects.register('101'); f.projects.parallelism('101', 2); const g = gatedRunner(f.docker);
  const gated = f.docker.runner, mine = id(), starts = f.docker.starts;
  f.docker.runner = (container, input, wait) => input.type === 'reap' && input.workspace_id === mine ? Promise.resolve({ ok: false, error: 'reap_incomplete' }) : gated(container, input, wait);
  const run = (workspace, command) => f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_command', workspace_id: workspace, command } });
  const long = run(id(), 'long'); await settle();
  await assert.rejects(run(mine, 'boom'), /runner_failed/); await settle();
  // The other task's call is untouched: the computer is not stopped under it, and the restart waits for it.
  assert.deepEqual([f.projects.get('101').state, f.docker.starts], ['busy', starts]);
  g.finish('long'); assert.equal((await long).ok, true); await settle();
  const project = f.projects.get('101');
  assert.deepEqual([f.docker.starts, project.state, project.desired, project.error], [starts + 1, 'ready', 'ready', null]);
  assert.deepEqual(lines, ['[manager] project 101 restart queued: a failed workspace_command left processes that could not be ended: runner_failed']);
});

test('a restart after leftover processes survive a reap runs alone, and calls around it keep the computer ready', async t => {
  const lines = []; t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const f = fixture(t); await f.projects.register('101'); f.projects.parallelism('101', 3); const g = gatedRunner(f.docker);
  const gated = f.docker.runner; let failures = 1;
  f.docker.runner = (container, input, wait) => input.type === 'reap' && input.workspace_id && failures-- > 0 ? Promise.resolve({ ok: false, error: 'reap_incomplete' }) : gated(container, input, wait);
  const run = command => f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_command', workspace_id: id(), command } });
  const starts = f.docker.starts, long = run('long'); await settle();
  const released = await f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'reap', workspace_id: id() } });
  assert.deepEqual(released, { ok: true, result: { restart_queued: true } });
  // The restart waits for the call that is running; a call that comes later waits behind the restart.
  const later = run('later'); await settle();
  assert.deepEqual([g.started, f.docker.starts, f.projects.get('101').state], [['long'], starts, 'busy']);
  g.finish('long'); assert.equal((await long).ok, true); await settle();
  assert.equal(f.docker.starts, starts + 1); assert.deepEqual(g.started, ['long', 'later']);
  g.finish('later'); assert.equal((await later).ok, true);
  const project = f.projects.get('101'), container = f.docker.containers.get(f.projects.names('101', 1).container);
  assert.deepEqual([project.state, project.error, project.started_at, project.generation], ['ready', null, container.State.StartedAt, 1]);
  assert.deepEqual(lines, ['[manager] project 101 restart queued: its leftover processes could not be ended: reap_incomplete']);
});

test('a call that finds its container restarted outside the manager fails alone, and the computer is brought back', async t => {
  const lines = []; t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const f = fixture(t); await f.projects.register('101'); f.projects.parallelism('101', 2);
  const container = () => f.docker.containers.get(f.projects.names('101', 1).container), run = () => f.projects.operate('101', 'execute', { operation_id: id(), generation: 1, request: { type: 'workspace_command', workspace_id: id(), command: 'true' } });
  container().State.StartedAt = 'restarted-by-someone-else';
  await assert.rejects(run(), /recovery_required/); await settle();
  assert.deepEqual([f.projects.get('101').state, f.projects.get('101').desired, f.projects.get('101').started_at], ['ready', 'ready', container().State.StartedAt]);
  assert.equal((await run()).ok, true);
  assert.deepEqual(lines, ['[manager] project 101 restart queued: its container stopped or restarted outside the manager: no detail']);
});

test('the control plane starts a failed computer of an enabled project again, waiting longer after each failed start', async t => {
  t.mock.method(console, 'error', () => {});
  // 101 fails and its first two starts fail too; 202's reset failed, which only a person may resolve.
  const states = { 101: 'ready', 202: 'ready' }, starts = { 101: 0, 202: 0 }; let failing = 2, revision = 0;
  const manager = { call: async (method, path) => {
    const repo = path.split('/')[3];
    if (method === 'POST' && path.endsWith('/start')) { starts[repo]++; if (failing-- > 0) fail(503, 'runner_not_ready'); states[repo] = 'ready'; }
    const state = states[repo];
    return { repository_id: repo, generation: 1, state, desired: state === 'ready' ? 'ready' : 'stopped', error: state === 'ready' ? null : 'recovery_required', revision: ++revision };
  } };
  const h = await harness(t, manager), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202'); await h.projects.reconcile();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  Object.assign(states, { 101: 'failed', 202: 'reset_failed' });
  const environment = () => h.store.get("SELECT state FROM project_environments WHERE repository_id='101'").state;
  await h.projects.reconcile(); assert.deepEqual([starts[101], environment()], [1, 'failed']);
  await h.projects.reconcile(); assert.equal(starts[101], 1, 'no second start within 30 s');
  t.mock.timers.tick(30_000); await h.projects.reconcile(); assert.equal(starts[101], 2);
  t.mock.timers.tick(30_000); await h.projects.reconcile(); assert.equal(starts[101], 2, 'the next start waits a minute');
  t.mock.timers.tick(30_000); await h.projects.reconcile(); assert.deepEqual([starts[101], environment()], [3, 'ready']);
  // Once it is up, a later failure starts again at once.
  states[101] = 'failed'; await h.projects.reconcile(); assert.deepEqual([starts[101], environment()], [4, 'ready']);
  assert.equal(starts[202], 0);
});

// A production computer had over a million journal records; reading them all in the start's health check outlasted the
// Docker request limit, so every start failed with docker_timeout.
test('a computer is ready without reading its journal, and old journal records are pruned in the background', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture(t); await f.projects.register('101');
  const prunes = () => f.docker.runs.filter(r => r.type === 'prune');
  // Started right after the computer is ready, without a time limit and outside the project lock.
  assert.deepEqual(prunes().map(r => r.wait), [0]); assert.equal(f.projects.gates.has('101'), false);
  await f.projects.check(); assert.equal(prunes().length, 1, 'not again within six hours');
  t.mock.timers.tick(6 * 3600 * 1000 + 1); await f.projects.check(); assert.equal(prunes().length, 2);
  // A failed prune is logged and leaves the computer as it was.
  const lines = []; t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const runner = f.docker.runner; f.docker.runner = (container, input, wait) => input.type === 'prune' ? Promise.resolve({ ok: false, error: 'prune_failed' }) : runner.call(f.docker, container, input, wait);
  t.mock.timers.tick(6 * 3600 * 1000 + 1); await f.projects.check(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([lines, f.projects.get('101').state], [['[manager] project 101 journal prune failed: prune_failed'], 'ready']);
});

test('Docker manager forwards versioned acceptance/recovery operations and rejects malformed cross-workspace requests before execution',async t=>{
 const f=fixture(t);await f.projects.register('101');const workspace='a'.repeat(48),source='b'.repeat(48),sha='c'.repeat(40),tree='d'.repeat(40);
 for(const type of ['workspace_acceptance','workspace_restore','workspace_source']){
  const request={type,workspace_id:workspace,...(type==='workspace_source'?{}:{source_workspace_id:source,sha,tree_sha:tree})};
  await f.projects.operate('101','execute',{operation_id:id(),generation:1,request});
  const call=f.docker.runs.at(-1);assert.equal(call.type,type);assert.equal(call.source_workspace_id,request.source_workspace_id);
  if(type!=='workspace_source')assert.equal(call.wait,0,'local Git copy/restore follows checkout’s unbounded execution timeout');
 }
 const count=f.docker.runs.length;
 for(const request of [{type:'workspace_restore',workspace_id:workspace,source_workspace_id:'../other'}, {type:'workspace_acceptance',workspace_id:workspace}, {type:'workspace_command',workspace_id:workspace,source_workspace_id:source,command:'true'}])
  await assert.rejects(f.projects.operate('101','execute',{operation_id:id(),generation:1,request}),/invalid_runner_request/);
 assert.equal(f.docker.runs.length,count);assert.equal(f.projects.get('101').state,'ready');
});
