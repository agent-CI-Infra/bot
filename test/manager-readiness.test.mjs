import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Projects } from '../manager/projects.mjs';
import { createManagerServer } from '../manager/server.mjs';
import { FakeDocker } from './fake-docker.mjs';
import { ManagerClient, ProjectService } from '../dist/projects/service.js';
import { Store } from '../dist/storage/database.js';

async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the manager stays fenced until every saved project has recovered and uncertain work has stopped', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'readiness-'));
  const docker = new FakeDocker(), options = { database: join(directory, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' };
  let projects = new Projects(options);
  for (const repo of ['101', '202']) {
    await projects.register(repo);
    projects.db.prepare("INSERT INTO operations VALUES(?,?, 'execute',1,'{}','running',NULL)").run('old-' + repo, repo);
  }
  const starts = docker.starts;
  projects.db.close(); projects = new Projects(options);
  const entered = [Promise.withResolvers(), Promise.withResolvers()], stopped = [Promise.withResolvers(), Promise.withResolvers()];
  const request = docker.request.bind(docker); let stopping = 0;
  docker.request = async (method, path, body) => {
    if (method === 'POST' && path.endsWith('/stop?t=2')) {
      const index = stopping++; entered[index].resolve(); await stopped[index].promise;
    }
    return request(method, path, body);
  };
  const token = Buffer.from('readiness-fixture'), { server, recovered } = createManagerServer({ projects, token });
  const base = await listen(t, server), client = new ManagerClient(base, token);
  t.after(async () => { stopped.forEach(gate => gate.resolve()); await recovered; projects.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const readiness = async () => { const response = await fetch(base + '/ready'); return [response.status, await response.json()]; };
  await entered[0].promise;
  assert.deepEqual(await readiness(), [503, { ready: false }]);
  assert.equal((await fetch(base + '/v1/projects')).status, 401, 'project data still requires authentication');
  for (const [method, path, input] of [
    ['GET', '/v1/projects'], ['GET', '/v1/projects/101'], ['PUT', '/v1/projects/303'],
    ['POST', '/v1/projects/101/reset', { operation_id: 'new-reset', generation: 1 }],
    ['PUT', '/v1/defaults', { cpus: 4 }], ['PUT', '/v1/projects/101/parallel', { tasks: 2 }],
    ['GET', '/v1/projects/101/notes']
  ]) await assert.rejects(client.call(method, path, input), error => error.status === 503 && error.code === 'manager_not_ready');
  assert.equal(projects.get('303'), undefined);
  assert.equal(projects.db.prepare("SELECT count(*) AS n FROM operations WHERE id='new-reset'").get().n, 0);
  assert.equal(docker.starts, starts, 'refused calls never start or reset a computer');

  stopped[0].resolve(); await entered[1].promise;
  assert.equal(projects.get('101').state, 'ready');
  assert.equal(docker.starts, starts + 1);
  assert.deepEqual(await readiness(), [503, { ready: false }], 'finishing one project does not open the gate');
  stopped[1].resolve(); await recovered;
  assert.deepEqual(await readiness(), [200, { ready: true }]);
  assert.equal(docker.starts, starts + 2, 'recovery stopped and restarted both old computers');
  assert.deepEqual(projects.db.prepare('SELECT state FROM operations ORDER BY id').all().map(row => row.state), ['interrupted', 'interrupted']);
  assert.deepEqual((await client.call('GET', '/v1/projects')).map(row => row.state), ['ready', 'ready']);
  assert.equal((await fetch(base + '/v1/projects')).status, 401);
});

test('a rejected startup recovery never reports readiness or admits project operations', async t => {
  const gate = Promise.withResolvers(), token = Buffer.from('fixture');
  const { server, recovered } = createManagerServer({ token, projects: { recover: () => gate.promise } });
  const base = await listen(t, server), rejected = assert.rejects(recovered, /recovery_failed/);
  gate.reject(new Error('recovery_failed')); await rejected;
  const response = await fetch(base + '/ready');
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ready: false });
  await assert.rejects(new ManagerClient(base, token).call('PUT', '/v1/projects/101'), /manager_not_ready/);
});

test('reconciliation preserves saved states and pending operation ids throughout manager recovery', async t => {
  const lines = []; t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const gate = Promise.withResolvers(), token = Buffer.from('fixture'), operations = [];
  const row = repo => ({ repository_id: repo, generation: 1, state: repo === '202' ? 'reset_failed' : 'ready', desired: 'ready', error: repo === '202' ? 'reset_interrupted' : null, revision: 2 });
  const { server, recovered } = createManagerServer({ token, projects: {
    recover: () => gate.promise, describe: row,
    operate: async (repo, action, input) => { operations.push({ repo, action, input }); return row(repo); }
  } });
  const base = await listen(t, server), store = new Store(':memory:', Buffer.alloc(32)); t.after(() => store.close());
  t.after(() => gate.resolve());
  store.run("INSERT INTO accounts VALUES('account','Fixture','bot_account',NULL,'{}','2026-01-01')");
  for (const repo of ['101', '202', '303']) {
    store.run('INSERT INTO repositories VALUES(?,?,?,?)', repo, 'fixture/project-' + repo, '10', 'account');
    store.run('INSERT INTO policies(repository_id,enabled) VALUES(?,1)', repo);
  }
  const projects = new ProjectService(store, new ManagerClient(base, token));
  projects.save({ ...row('101'), revision: 1 }); projects.save({ ...row('202'), revision: 1 });
  store.run("INSERT INTO environment_operations VALUES('saved-stop','101','stop',?,'pending',NULL)", JSON.stringify({ operation_id: 'saved-stop', generation: 1 }));
  const saved = store.all('SELECT * FROM project_environments ORDER BY repository_id');
  for (let i = 0; i < 3; i++) await projects.reconcile();
  assert.deepEqual(store.all('SELECT * FROM project_environments ORDER BY repository_id'), saved);
  assert.equal(store.get("SELECT state FROM environment_operations WHERE id='saved-stop'").state, 'pending');
  assert.deepEqual(operations, []);
  assert.ok(!lines.some(line => line.includes('manager_unavailable') || line.includes('works again') || line.includes('given up')));
  gate.resolve(); await recovered; await projects.reconcile();
  assert.deepEqual(operations, [{ repo: '101', action: 'stop', input: { operation_id: 'saved-stop', generation: 1 } }]);
  assert.equal(store.get("SELECT state FROM environment_operations WHERE id='saved-stop'").state, 'completed');
  assert.equal(store.get("SELECT state FROM project_environments WHERE repository_id='303'").state, 'ready');
  assert.deepEqual(store.all("SELECT state,error FROM project_environments WHERE repository_id='202'").map(row => ({ ...row })), [{ state: 'reset_failed', error: 'reset_interrupted' }]);
  assert.ok(!lines.some(line => line.includes('project 202: works again')), 'a reset_failed computer is not reported as fixed');
});

test('manager failures retain bounded connection diagnostics without credentials, paths or response bodies', async t => {
  const lines = []; t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const token = Buffer.from('private-manager-token'), secret = 'private-api-key';
  const server = createServer((req, res) => {
    if (req.url.startsWith('/timeout')) return;
    if (req.url.startsWith('/broken')) { res.end(`invalid JSON ${secret} ${token.toString('base64')}`); return; }
    res.end(JSON.stringify({ result: { ok: true } }));
  });
  const base = await listen(t, server), client = new ManagerClient(base.replace('http://', 'http://private-user:private-password@'), token);
  for (let i = 0; i < 2; i++) await assert.rejects(client.call('POST', '/broken?key=' + secret, { api_key: secret }), /manager_unavailable/);
  assert.deepEqual(lines, ['[manager] request: target=manager stage=response_json name=SyntaxError code=none timeout=false']);
  await assert.rejects(client.call('GET', '/timeout', undefined, 25), /manager_unavailable/);
  assert.equal(lines.at(-1), '[manager] request: target=manager stage=request name=Error code=ETIMEDOUT timeout=true');
  await client.call('GET', '/ok'); assert.equal(lines.at(-1), '[manager] request: works again');
  // Use a port with no pooled connections: closing a previously used server can reset a reused socket instead.
  const offlineServer = createServer(), offlineBase = await listen(t, offlineServer);
  await new Promise(resolve => offlineServer.close(resolve));
  await assert.rejects(new ManagerClient(offlineBase, token).call('GET', '/connect?key=' + secret), /manager_unavailable/);
  assert.equal(lines.at(-1), '[manager] request: target=manager stage=request name=Error code=ECONNREFUSED timeout=false');
  const logs = lines.join('\n');
  for (const value of [secret, token.toString(), token.toString('base64'), 'private-user', 'private-password', base, '/broken', 'invalid JSON']) assert.ok(!logs.includes(value), value);
});
