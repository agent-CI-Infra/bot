import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { InstallationSync } from '../dist/app/installations.js';
import { IntegrationChecker } from '../dist/projects/integrations.js';
import { loadConsole } from './console-page.mjs';
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
  await h.hook(a.path, a.secret, 'old', added(303, 101), { 'X-GitHub-Event': 'installation_repositories' });
  // A failed App check is still cached as unknown with the time of the check; the caller does not see an error.
  const checker = new IntegrationChecker(h.store, 'http://127.0.0.1:9'), cached = id => h.store.get('SELECT * FROM repo_integrations WHERE repository_id=?', id);
  await checker.check('303'); await checker.check('101');
  assert.deepEqual([cached('303').gate_detail, cached('101').dashboard_detail], ['github_unavailable', 'github_unavailable']);
  assert.deepEqual([cached('303').gate_state, cached('101').dashboard_state], ['unknown', 'unknown']);
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
  // The repository the listing no longer has loses its cached status in the same write; the one still listed keeps it.
  assert.equal(cached('303'), undefined); assert.ok(cached('101'));
  const expired = '2026-01-01T00:00:00.000Z';
  h.store.run('UPDATE repo_integrations SET checked_at=? WHERE repository_id=?', expired, '101');
  await checker.check('101');
  assert.equal(cached('101').gate_detail, 'github_unavailable'); assert.ok(cached('101').checked_at > expired);
  assert.equal(await checker.check('303'), null); assert.equal(cached('303'), undefined);
});

// A GitHub without any files: gates come back as not connected and the dashboard source list as unreadable.
async function emptyGitHub(t) {
  const requests = [], server = createServer((req, res) => {
    requests.push(new URL(req.url, 'http://fake').pathname); res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// A GitHub that knows one App installation on fixture/project-101 and the dashboard repository. Every read must use the
// minted installation token; the App JWT only resolves the installation and mints/revokes tokens.
async function appGitHub(t, { installed = true, mint = 201 } = {}) {
  const requests = [], revoked = [], keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), token = 'installation-token-fixture';
  const file = text => ({ type: 'file', content: Buffer.from(text).toString('base64'), sha: 'sha-' + text.length });
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fake'), path = decodeURIComponent(url.pathname);
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    requests.push({ method: req.method, path, auth, body: raw ? JSON.parse(raw) : undefined });
    const send = (status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(value === undefined ? '' : JSON.stringify(value)); };
    const jwt = auth.split('.').length === 3;
    if (path === '/repos/fixture/project-101/installation') return jwt && installed ? send(200, { id: 77, account: { id: 10, login: 'fixture' } }) : send(404, {});
    if (path === '/app/installations/77/access_tokens' && req.method === 'POST') {
      return !jwt ? send(401, {}) : mint !== 201 ? send(mint, {}) : send(201, { token, expires_at: '2099-01-01T00:00:00Z' });
    }
    if (path === '/installation/token' && req.method === 'DELETE') { if (auth === token) revoked.push(auth); return send(204); }
    if (auth !== token) return send(auth ? 401 : 404, {});
    const contents = {
      '/repos/fixture/project-101/contents/.github/ci-gates.json': '{"version":1}',
      '/repos/fixture/project-101/contents/.github/workflows/ci.yml': 'name: CI\n',
      '/repos/fixture/dashboard/contents/config/gate-sources.json': JSON.stringify({ sources: [{ id: 'fixture/project-101', owner: 'fixture', name: 'project-101' }] }),
      '/repos/fixture/dashboard/contents/public/data/gate/index.json': JSON.stringify({ sources: [{ id: 'fixture/project-101' }] }),
    };
    if (contents[path]) return send(200, file(contents[path]));
    if (path === '/repos/fixture/project-101/actions/workflows') return send(200, { workflows: [{ id: 5, name: 'CI', path: '.github/workflows/ci.yml' }] });
    if (path === '/repos/fixture/project-101/actions/workflows/5/runs') return send(200, { workflow_runs: [{ conclusion: 'success', created_at: new Date().toISOString() }] });
    return send(404, {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}`, privateKey, token, requests, revoked };
}

test('a GitHub App project is checked with a repository-scoped read-only token that is revoked afterwards', async t => {
  const github = await appGitHub(t), h = await harness(t), { admin } = await setup(h);
  const a = await account(admin, { type: 'github_app', app_id: '123', private_key: github.privateKey, token: undefined });
  await h.hook(a.path, a.secret, 'app-install', added(101), { 'X-GitHub-Event': 'installation_repositories' });
  const checker = new IntegrationChecker(h.store, github.url, 'fixture/dashboard');
  await checker.check('101');
  const row = h.store.get('SELECT * FROM repo_integrations WHERE repository_id=?', '101');
  assert.deepEqual([row.gate_state, row.dashboard_state], ['live', 'published']);
  assert.match(row.gate_detail, /最近一次 CI 通过/);
  // Exactly one token, limited to this repository and read-only, then revoked through GitHub.
  const minted = github.requests.filter(r => r.path === '/app/installations/77/access_tokens');
  assert.deepEqual(minted.map(r => r.body), [{ repository_ids: [101], permissions: { contents: 'read', actions: 'read', metadata: 'read' } }]);
  assert.equal(minted[0].auth.split('.').length, 3);
  const installation = github.requests.find(r => r.path === '/repos/fixture/project-101/installation');
  assert.equal(installation.auth, minted[0].auth);
  for (const request of github.requests.filter(r => r.path.includes('/contents/') || r.path.includes('/actions/'))) assert.equal(request.auth, github.token, request.path);
  assert.deepEqual(github.revoked, [github.token]);
  assert.deepEqual(github.requests.filter(r => r.method !== 'GET').map(r => r.method + ' ' + r.path),
    ['POST /app/installations/77/access_tokens', 'DELETE /installation/token']);
});

test('an App that is not installed, or refuses a token, leaves both states unknown without throwing', async t => {
  const h = await harness(t), { admin } = await setup(h);
  for (const [options, detail] of [[{ installed: false }, 'GitHub App 没有安装到该仓库'], [{ mint: 403 }, 'github_http_403']]) {
    const github = await appGitHub(t, options), a = await account(admin, { type: 'github_app', app_id: '123', private_key: github.privateKey, token: undefined });
    await h.hook(a.path, a.secret, options.installed === false ? 'app-missing' : 'app-refused', added(101), { 'X-GitHub-Event': 'installation_repositories' });
    const checker = new IntegrationChecker(h.store, github.url, 'fixture/dashboard');
    await checker.check('101');
    const row = h.store.get('SELECT * FROM repo_integrations WHERE repository_id=?', '101');
    assert.deepEqual([row.gate_state, row.dashboard_state, row.gate_detail], ['unknown', 'unknown', detail]);
    assert.deepEqual(github.revoked, []);
    // No token was minted, so nothing is revoked either; the only non-read is the refused token request.
    assert.ok(github.requests.every(r => r.method === 'GET' || r.path === '/app/installations/77/access_tokens'), detail);
  }
});

test('a repository that leaves the installation drops its cached integration status and is not checked again', async t => {
  const github = await emptyGitHub(t);
  const h = await harness(t, undefined, store => ({ integrations: new IntegrationChecker(store, github.url, 'fixture/dashboard') }));
  const { admin } = await setup(h), a = await account(admin), events = { 'X-GitHub-Event': 'installation_repositories' };
  const cached = id => h.store.get('SELECT * FROM repo_integrations WHERE repository_id=?', id), ids = list => list.map(item => item.repository_id);
  const checks = id => github.requests.filter(path => path === `/repos/fixture/project-${id}/contents/.github/ci-gates.json`).length;
  await h.hook(a.path, a.secret, 'install', added(101, 202, 303), events);
  assert.equal((await admin('/api/installations/202/activate', 'POST', {})).status, 201);
  assert.deepEqual(ids((await admin('/api/integrations/check', 'POST', {})).value.integrations), ['101', '202', '303']);
  assert.deepEqual([checks('101'), checks('202')], [1, 1]);
  // 101 stays installed with a status older than the cache allows; the started project 202 leaves the installation.
  const expired = '2026-01-01T00:00:00.000Z';
  h.store.run('UPDATE repo_integrations SET checked_at=? WHERE repository_id=?', expired, '101');
  await h.hook(a.path, a.secret, 'remove-202', { ...added(), action: 'removed', repositories_removed: [{ id: 202, full_name: 'fixture/project-202' }] }, events);
  assert.equal(cached('202'), undefined);
  assert.deepEqual((await admin('/api/integrations')).value.integrations.map(i => [i.repository_id, i.stale]), [['101', true], ['303', false]]);
  const integrations = (await admin('/api/integrations/check', 'POST', {})).value.integrations;
  assert.deepEqual(integrations.map(i => [i.repository_id, i.stale]), [['101', false], ['303', false]]);
  assert.ok(integrations[0].checked_at > expired);
  assert.deepEqual([checks('101'), checks('202')], [2, 1]); assert.equal(cached('202'), undefined);
  assert.equal((await admin('/api/integrations/check', 'POST', { repository_id: '202' })).value.integrations.length, 2); assert.equal(cached('202'), undefined);
  // The project keeps its registration and policy; only the cached status went.
  assert.ok(h.store.get('SELECT 1 FROM policies WHERE repository_id=?', '202'));
  const removed = (await admin('/api/installations')).value.repositories.find(r => r.id === '202');
  assert.deepEqual([removed.registered, removed.installed], [true, false]);
  // A row an older version left behind is not listed, and the next check drops it.
  h.store.run('INSERT INTO repo_integrations(repository_id,checked_at) VALUES(?,?)', '202', expired);
  assert.deepEqual(ids((await admin('/api/integrations')).value.integrations), ['101', '303']);
  await admin('/api/integrations/check', 'POST', {}); assert.equal(cached('202'), undefined);
  // Deleting or suspending the installation drops every repository it covered.
  await h.hook(a.path, a.secret, 'suspend', { action: 'suspend', installation }, { 'X-GitHub-Event': 'installation' });
  assert.deepEqual([cached('101'), cached('303')], [undefined, undefined]);
  assert.deepEqual((await admin('/api/integrations')).value.integrations, []);
});

test('a background check of stale integration chips updates them in place and never reloads the project list', async () => {
  const integration = (gate_state, stale) => ({ repository_id: '101', gate_state, gate_detail: '', dashboard_state: 'none', dashboard_detail: '', checked_at: '', stale });
  let check = () => [200, { integrations: [integration('live', true)] }];
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path === '/api/integrations') return [200, { integrations: [integration('configured', true)] }];
    if (path === '/api/installations') return [200, { syncs: [], repositories: [{ id: '101', full_name: 'fixture/project-101', owner_id: '10', installed: true,
      registered: true, enabled: true, review_enabled: true, development_enabled: false, model_id: 'm', running_tasks: 0, queued_tasks: 0 }] }];
    if (method === 'POST' && path === '/api/integrations/check') return check();
    return [404, { error: 'not_found' }];
  });
  page.run("var startCalls = 0; start = async () => { startCalls++; }; me = { role: 'super_admin', csrf_token: 'csrf' }; tab = 'projects';");
  const settle = () => new Promise(r => setTimeout(r, 50)), gate = line => line.querySelectorAll('[data-integration]').map(chip => chip.textContent);
  const once = ['GET /api/integrations', 'GET /api/installations', 'POST /api/integrations/check'];
  await page.run('render()'); const [line] = page.$('rows').children;
  assert.deepEqual(gate(line), ['门禁已配置', '看板未接入']);
  await settle();
  // The check ran once and only the chips changed, although the answer is still stale: the same row stays on the list.
  assert.equal(page.run('startCalls'), 0); assert.deepEqual(page.requests, once);
  assert.equal(page.$('rows').children[0], line); assert.deepEqual(gate(line), ['门禁已生效', '看板未接入']);
  // A failed check leaves the chips as they are and is not retried either.
  check = () => [502, { error: 'github_unavailable' }]; page.requests.length = 0;
  await page.run('render()'); const [next] = page.$('rows').children; await settle();
  assert.equal(page.run('startCalls'), 0); assert.deepEqual(page.requests, once);
  assert.equal(page.$('rows').children[0], next); assert.deepEqual(gate(next), ['门禁已配置', '看板未接入']);
  // Refresh and "check integrations" still reload the page.
  page.$('refresh').listeners.click[0](); page.$('check').listeners.click[0]();
  assert.equal(page.run('startCalls'), 2);
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

test('a task read token reaches runner commands only as GH_TOKEN and GITHUB_TOKEN and is masked in their output', async t => {
  mkdirSync('.tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/token-')), out = join(dir, 'op.out'), token = 'ghs_' + 'x'.repeat(36); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await command('echo "$GH_TOKEN|$GITHUB_TOKEN|$OTHER"', dir, 10000, { outputFile: out, secretEnv: { GH_TOKEN: token, GITHUB_TOKEN: token, OTHER: 'not-a-token-variable' } });
  assert.equal(result.output, '[REDACTED]|[REDACTED]|\n'); assert.equal(readFileSync(out, 'utf8'), '[REDACTED]|[REDACTED]|\n');
  assert.equal((await command('echo "$GH_TOKEN"', dir, 10000)).output, '\n');
  // The answer to a token request goes to the request it was made for, and only that one.
  const { agentOperation } = await import('../runner/agent.mjs'), id = 'a'.repeat(48);
  mkdirSync(join(dir, 'agent')); writeFileSync(join(dir, 'agent/token-request.json'), JSON.stringify({ id }));
  assert.deepEqual((await agentOperation({ type: 'workspace_agent_poll' }, dir)).token_request, { id });
  const base64 = Buffer.from(JSON.stringify({ token })).toString('base64');
  await assert.rejects(agentOperation({ type: 'workspace_agent_token', request_id: 'b'.repeat(48), base64 }, dir), /agent_request_changed/);
  assert.deepEqual(await agentOperation({ type: 'workspace_agent_token', request_id: id, base64 }, dir), { written: true });
  assert.equal(JSON.parse(readFileSync(join(dir, `agent/token-reply-${id}.json`), 'utf8')).token, token);
});

test('the permission check lists what an App and its installations lack and links the GitHub pages that fix it', async t => {
  const full = { contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'write', actions: 'write', checks: 'write', metadata: 'read' };
  const app = { slug: 'fixture-app', html_url: 'https://github.com/apps/fixture-app', owner: { login: 'fixture', type: 'Organization' },
    permissions: { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read', statuses: 'read' } };
  const installations = [{ id: 7, account: { login: 'fixture' }, html_url: 'https://github.com/organizations/fixture/settings/installations/7', permissions: { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' } },
    { id: 8, account: { login: 'paused' }, suspended_at: '2026-01-01', permissions: {} }];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake'); res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/app') return res.end(JSON.stringify(app));
    if (url.pathname === '/app/installations') return res.end(JSON.stringify(url.searchParams.get('page') === '1' ? installations : []));
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  const h = await harness(t, undefined, store => ({ installations: new InstallationSync(store, `http://127.0.0.1:${server.address().port}`) })), { admin } = await setup(h);
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), bot = await account(admin);
  const a = await account(admin, { type: 'github_app', app_id: '123', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), token: undefined });
  const check = async () => (await admin(`/api/accounts/${a.id}/permissions`)).value;
  let report = await check();
  assert.equal(report.ok, false); assert.deepEqual(report.required, full);
  assert.deepEqual(report.app.missing.map(m => [m.permission, m.required, m.current]), [['statuses', 'write', 'read'], ['actions', 'write', null], ['checks', 'write', null]]);
  assert.equal(report.app.settings_url, 'https://github.com/organizations/fixture/settings/apps/fixture-app/permissions');
  assert.deepEqual(report.installations.map(i => [i.account, i.suspended, i.missing.map(m => m.permission).join(','), i.review_url]),
    [['fixture', false, 'statuses,actions,checks', 'https://github.com/organizations/fixture/settings/installations/7'], ['paused', true, Object.keys(full).join(','), null]]);
  // After the App owner saves and the installation accepts, the check passes; a suspended installation does not hold it back.
  app.permissions = full; installations[0].permissions = full; report = await check();
  assert.equal(report.ok, true); assert.deepEqual(report.app.missing, []);
  // A personal App links the personal settings page; a review link on another host is never shown.
  app.owner = { login: 'someone', type: 'User' }; installations[0].html_url = 'https://elsewhere.example/settings'; report = await check();
  assert.equal(report.app.settings_url, 'https://github.com/settings/apps/fixture-app/permissions'); assert.equal(report.installations[0].review_url, null);
  assert.equal((await admin(`/api/accounts/${bot.id}/permissions`)).status, 409);
});
