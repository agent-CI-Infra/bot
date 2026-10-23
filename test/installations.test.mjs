import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { InstallationSync } from '../dist/app/installations.js';
import { TaskEngine } from '../dist/agent/engine.js';
import { command } from '../runner/command.mjs';

const installation = { id: 77, account: { id: 10, login: 'fixture', type: 'Organization' } };
const added = (...ids) => ({ action: 'added', installation, repository_selection: 'all', repositories_removed: [],
  repositories_added: ids.map(id => ({ id, name: 'project-' + id, full_name: 'fixture/project-' + id, private: true })) });

test('installed repositories are listed but only work after an administrator starts them, and can be disabled', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin), events = { 'X-GitHub-Event': 'installation_repositories' };
  assert.equal((await h.hook(a.path, a.secret, 'install-1', added(101, 202), events)).status, 200);
  let list = (await admin('/api/installations')).value.repositories;
  assert.deepEqual(list.map(r => [r.id, r.installed, r.registered, r.owner_login, r.installation_id]), [['101', true, false, 'fixture', '77'], ['202', true, false, 'fixture', '77']]);
  const issue = (n) => ({ repository: { id: 101 }, action: 'opened', issue: { number: n, title: 'Review this', body: 'Review this' } });
  assert.equal((await h.hook(a.path, a.secret, 'before-start', issue(1))).value.tasks_created, 0);
  const shared = (await admin('/api/models', 'POST', { repository_id: null, api_url: 'https://model.invalid/v1', api_key: testPassword(), model_name: 'shared' })).value.model;
  const started = (await admin('/api/installations/101/activate', 'POST', { model_id: shared.id })).value.repository;
  assert.deepEqual([started.registered, started.enabled, started.review_enabled, started.development_enabled, started.model_id], [true, true, true, false, shared.id]);
  assert.ok(h.store.get('SELECT 1 FROM model_projects WHERE model_id=? AND repository_id=?', shared.id, '101'));
  assert.equal((await h.hook(a.path, a.secret, 'after-start', issue(2))).value.tasks_created, 1);
  assert.equal((await admin('/api/installations/101/disable', 'POST', {})).value.repository.enabled, false);
  assert.equal((await h.hook(a.path, a.secret, 'after-disable', issue(3))).value.tasks_created, 0);
  assert.equal((await admin('/api/installations/101/activate', 'POST', {})).value.repository.enabled, true);
  assert.equal((await admin('/api/installations/999/activate', 'POST', {})).status, 404);
  await h.hook(a.path, a.secret, 'remove-202', { ...added(), repositories_removed: [{ id: 202, full_name: 'fixture/project-202' }] }, events);
  list = (await admin('/api/installations')).value.repositories;
  assert.equal(list.find(r => r.id === '202').installed, false);
  const member = h.client(), memberPassword = testPassword();
  await admin('/api/users', 'POST', { username: 'member', password: memberPassword, repository_ids: ['101'] });
  await member('/api/auth/login', 'POST', { username: 'member', password: memberPassword });
  assert.equal((await member('/api/installations')).status, 403);
});

test('repositories cannot be registered by hand; they come from installation sync and are started from the console', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  const manual = await admin('/api/repositories', 'POST', { id: '101', full_name: 'fixture/project-101', owner_id: '10', account_id: a.id });
  assert.equal(manual.status, 404); assert.equal(h.store.get('SELECT count(*) AS n FROM repositories').n, 0);
  assert.equal((await admin('/api/installations/101/activate', 'POST', {})).status, 404);
});

test('a full sync lists every installation repository and marks the rest as no longer installed', async t => {
  const h = await harness(t), { admin } = await setup(h), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const a = await account(admin, { type: 'github_app', app_id: '123', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), token: undefined });
  await h.hook(a.path, a.secret, 'old', added(303), { 'X-GitHub-Event': 'installation_repositories' });
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake'); requests.push(req.method + ' ' + url.pathname); res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/app/installations') return res.end(JSON.stringify(url.searchParams.get('page') === '1' ? [{ id: 77 }, { id: 78, suspended_at: '2026-01-01' }] : []));
    if (url.pathname === '/app/installations/77/access_tokens') return res.end(JSON.stringify({ token: 'installation-token-fixture' }));
    if (url.pathname === '/installation/repositories') {
      assert.equal(req.headers.authorization, 'Bearer installation-token-fixture');
      const page = Number(url.searchParams.get('page')), ids = page === 1 ? Array.from({ length: 100 }, (_, i) => 1000 + i) : page === 2 ? [101] : [];
      return res.end(JSON.stringify({ total_count: 101, repositories: ids.map(id => ({ id, full_name: 'fixture/p' + id, private: false, owner: { id: 10, login: 'fixture' } })) }));
    }
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  const sync = new InstallationSync(h.store, `http://127.0.0.1:${server.address().port}`);
  assert.equal((await sync.sync(a.id)).repositories, 101);
  assert.ok(!requests.includes('POST /app/installations/78/access_tokens'));
  const rows = h.store.all('SELECT repository_id,installed FROM installed_repositories WHERE account_id=?', a.id);
  assert.equal(rows.filter(r => r.installed).length, 101); assert.equal(rows.find(r => r.repository_id === '303').installed, 0);
  assert.match(String((await admin('/api/installations')).value.syncs[0].synced_at), /^20/);
});

test('the console reads the output of the command a running task is executing', async t => {
  const calls = [], manager = { call: async (_method, path) => { calls.push(path); return { data: 'step 1\n', offset: 7, size: 7, state: 'running' }; } };
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES('t1','101','review.pr','running','pr',4)");
  const op = 'a'.repeat(48);
  h.store.run("INSERT INTO task_tools VALUES(?,?,?,NULL,'pending')", op, 't1', JSON.stringify({ operation_id: op, generation: 1, request: { type: 'workspace_command', command: 'npm test', timeout_ms: 600000, keep_background: false } }));
  const engine = new TaskEngine(h.store, manager), url = path => new URL('http://local' + path);
  const user = { id: 'x', role: 'super_admin', repositories: [] };
  assert.deepEqual(await engine.api(user, 'GET', url('/api/tasks/t1/live?offset=3'), {}),
    { running: true, operation_id: op, command: 'npm test', timeout_ms: 600000, keep_background: false, output: 'step 1\n', offset: 7, state: 'running' });
  assert.equal(calls[0], `/v1/projects/101/output/${op}?offset=3`);
  h.store.run("UPDATE tasks SET status='succeeded' WHERE id='t1'");
  assert.deepEqual(await engine.api(user, 'GET', url('/api/tasks/t1/live'), {}), { running: false });
  await assert.rejects(engine.api({ id: 'y', role: 'project_admin', repositories: ['202'] }, 'GET', url('/api/tasks/t1/live'), {}), /task_not_found/);
});

test('runner commands stream output while running and can keep background processes for the task', async t => {
  mkdirSync('.tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/command-')), out = join(dir, 'op.out'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const running = command('echo first; sleep 1; echo second', dir, 10000, { outputFile: out });
  await new Promise(r => setTimeout(r, 500)); assert.equal(readFileSync(out, 'utf8'), 'first\n');
  assert.deepEqual(await running, { exit_code: 0, signal: null, output: 'first\nsecond\n', timed_out: false, truncated: false });
  const kept = await command('sleep 30 & echo $! > pid', dir, 5000, { keepBackground: true });
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8')); assert.equal(kept.exit_code, 0);
  assert.doesNotThrow(() => process.kill(pid, 0)); process.kill(pid, 'SIGKILL');
  await command('sleep 30 & echo $! > pid2', dir, 5000);
  // Without keep_background the process group ends with the command (a zombie awaiting its reaper counts as ended).
  const ended = Number(readFileSync(join(dir, 'pid2'), 'utf8')), state = () => { try { return readFileSync(`/proc/${ended}/stat`, 'utf8').split(') ')[1][0]; } catch { return 'gone'; } };
  await new Promise(r => setTimeout(r, 100)); assert.ok(['gone', 'Z'].includes(state()));
});

test('runner commands without a timeout run until they end; an explicit timeout still stops them', async t => {
  mkdirSync('.tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/command-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await command('sleep 0.3; echo done', dir, null), { exit_code: 0, signal: null, output: 'done\n', timed_out: false, truncated: false });
  const stopped = await command('sleep 5; echo late', dir, 200); assert.equal(stopped.timed_out, true); assert.equal(stopped.output, '');
});
