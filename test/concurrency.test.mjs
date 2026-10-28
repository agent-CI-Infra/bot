import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { treeSha } from '../dist/agent/common.js';
import { Onboarding } from '../dist/onboarding/service.js';
import { loadConsole } from './console-page.mjs';

const commit = 'a'.repeat(40), tree = treeSha([]);
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
// Issue reviews on one repository whose agents keep working until the test lets each one finish.
// holdReaps: release requests wait until that many have arrived, so tasks finishing together overlap in their release.
async function fixture(t, { holdReaps = 0 } = {}) {
  const comments = new Map();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://fixture').pathname, send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const issue = /\/issues\/(\d+)(\/.*)?$/.exec(path);
    if (path === '/user') return send({ id: 999, login: 'fixture-bot' });
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main' });
    if (path.endsWith('/git/ref/heads/main')) return send({ object: { sha: commit } });
    if (path.endsWith('/git/commits/' + commit)) return send({ sha: commit, tree: { sha: tree } });
    if (path.endsWith('/git/trees/' + tree)) return send({ sha: tree, tree: [], truncated: false });
    if (path.endsWith('/labels')) return send([]);
    if (issue && !issue[2]) return send({ id: Number(issue[1]), number: Number(issue[1]), state: 'open', title: 'Issue ' + issue[1], body: 'Please review.' });
    if (issue?.[2] === '/comments') {
      const list = comments.get(issue[1]) || []; comments.set(issue[1], list);
      if (req.method !== 'POST') return send(list);
      const value = { id: Number(issue[1]) * 100 + list.length, body: JSON.parse(raw).body, user: { id: 999 }, html_url: 'https://github.invalid/c' }; list.push(value); return send(value, 201);
    }
    if (issue?.[2] === '/labels') return send([]);
    return send({}, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  // Each task's first agent poll waits for finish(issue); reached(issue) resolves once that task's agent is working.
  const gates = new Map(), gate = number => { if (!gates.has(number)) { let reach, release; gates.set(number, { reached: new Promise(r => { reach = r; }), released: new Promise(r => { release = r; }), reach, release }); } return gates.get(number); };
  const calls = [], heldReaps = [];
  let h;
  const manager = { call: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith('/parallel')) return { parallel: body.tasks };
    if (!path.endsWith('/execute')) return { repository_id: '101', state: 'ready', generation: 1, desired: 'ready', revision: 1 };
    const request = body.request;
    if (request.type === 'workspace_snapshot') return { ok: true, result: { tree_sha: request.tree_sha } };
    if (request.type === 'workspace_agent_poll') {
      const number = h.store.get('SELECT object_number FROM tasks WHERE workspace_id=?', request.workspace_id).object_number, g = gate(number);
      g.reach(); await g.released;
      return { ok: true, result: { state: 'completed', result: { summary: 'Reviewed.', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' } } };
    }
    if (request.type === 'reap' && holdReaps) {
      await new Promise(resolve => { heldReaps.push(resolve); if (heldReaps.length >= holdReaps) heldReaps.forEach(release => release()); setTimeout(resolve, 3000); });
    }
    return { ok: true, result: {} };
  } };
  let engine;
  h = await harness(t, manager, store => ({ engine: engine = new TaskEngine(store, manager, 'http://127.0.0.1:' + server.address().port) }));
  t.after(() => engine.close());
  const { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: 'fixture-model-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, model_id: model.id });
  for (const number of [1, 2, 3]) await h.hook(a.path, a.secret, 'issue-' + number, { repository: { id: 101 }, action: 'opened', issue: { number, title: 'Issue ' + number, body: 'Please review.' } });
  const task = number => h.store.get('SELECT * FROM tasks WHERE object_number=?', number);
  const statuses = () => [1, 2, 3].map(number => task(number).status);
  const finish = async number => { const id = task(number).id; gate(number).release(); await engine.active.get(id); };
  return { h, admin, engine, calls, task, statuses, finish, reached: number => gate(number).reached };
}

test('with nothing configured a repository runs one task at a time and the next waits for the first to end', async t => {
  const f = await fixture(t);
  f.engine.tick(); await f.reached(1); f.engine.tick(); await settle();
  assert.deepEqual(f.statuses(), ['running', 'queued', 'queued']); assert.equal(f.engine.active.size, 1);
  assert.deepEqual(f.calls.filter(c => c.path.endsWith('/parallel')).map(c => c.body), [{ tasks: 1 }]);
  await f.finish(1); f.engine.tick(); await f.reached(2);
  assert.deepEqual(f.statuses(), ['succeeded', 'running', 'queued']);
  // A task alone on its computer clears it when it ends.
  const reaps = f.calls.filter(c => c.body?.request?.type === 'reap');
  assert.deepEqual(reaps.map(c => [c.body.request.workspace_id, c.body.request.idle]), [[f.task(1).workspace_id, true]]);
  await f.finish(2); f.engine.tick(); await f.reached(3); await f.finish(3);
  assert.deepEqual(f.statuses(), ['succeeded', 'succeeded', 'succeeded']);
});

test('a project concurrency of 2 runs two tasks at once in their own workspaces and keeps the third queued', async t => {
  const f = await fixture(t);
  assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { task_concurrency: 2 })).status, 200);
  f.engine.tick(); await Promise.all([f.reached(1), f.reached(2)]); f.engine.tick(); await settle();
  assert.deepEqual(f.statuses(), ['running', 'running', 'queued']);
  assert.equal(f.h.store.get("SELECT count(*) AS n FROM tasks WHERE status='running' AND phase='model'").n, 2);
  assert.notEqual(f.task(1).workspace_id, f.task(2).workspace_id);
  assert.deepEqual(f.h.store.all('SELECT task_id FROM task_claims ORDER BY task_id').map(r => r.task_id), [f.task(1).id, f.task(2).id].sort());
  // The manager was told to admit two runner calls before the second task's first one.
  const parallel = f.calls.findIndex(c => c.path.endsWith('/parallel') && c.body.tasks === 2);
  const secondTask = f.calls.findIndex(c => c.body?.request?.workspace_id === f.task(2).workspace_id);
  assert.ok(parallel >= 0 && parallel < secondTask);
  // The first to end leaves the other running and ends only its own processes; the third then starts.
  await f.finish(1);
  assert.deepEqual(f.calls.filter(c => c.body?.request?.type === 'reap').map(c => [c.body.request.workspace_id, c.body.request.idle]), [[f.task(1).workspace_id, undefined]]);
  f.engine.tick(); await f.reached(3);
  assert.deepEqual(f.statuses(), ['succeeded', 'running', 'running']);
  await f.finish(2); await f.finish(3);
  assert.deepEqual(f.calls.filter(c => c.body?.request?.type === 'reap').map(c => c.body.request.idle), [undefined, undefined, true]);
  assert.equal(f.h.store.get('SELECT count(*) AS n FROM task_claims').n, 0);
});

test('of two tasks that finish together, exactly one clears the computer', async t => {
  const f = await fixture(t, { holdReaps: 2 });
  assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { task_concurrency: 2 })).status, 200);
  f.engine.tick(); await Promise.all([f.reached(1), f.reached(2)]);
  // Both releases are in flight at the same time: each task still sees the other as running.
  await Promise.all([f.finish(1), f.finish(2)]);
  const reaps = f.calls.filter(c => c.body?.request?.type === 'reap').map(c => c.body.request);
  assert.equal(reaps.length, 2); assert.deepEqual(reaps.map(r => r.idle).sort(), [true, undefined]);
  assert.deepEqual(reaps.map(r => r.workspace_id).sort(), [f.task(1).workspace_id, f.task(2).workspace_id].sort());
  assert.deepEqual(f.statuses(), ['succeeded', 'succeeded', 'queued']);
});

test('a project without its own value follows the global default, and each task checks only its own claim', async t => {
  const f = await fixture(t);
  assert.equal((await f.admin('/api/settings', 'PATCH', { task_concurrency: 2 })).status, 200);
  assert.equal((await f.admin('/api/repositories/101')).value.policy.task_concurrency, null);
  f.engine.tick(); await Promise.all([f.reached(1), f.reached(2)]);
  assert.deepEqual(f.statuses(), ['running', 'running', 'queued']);
  // Revoking one task's claim stops that task only.
  f.h.store.run('DELETE FROM task_claims WHERE task_id=?', f.task(2).id);
  await f.finish(2); await f.finish(1);
  assert.deepEqual([f.task(1).status, f.task(2).status, f.task(2).error_code], ['succeeded', 'cancelled', 'task_claim_revoked']);
  // An explicit project value wins over the default; clearing it returns to the default.
  assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { task_concurrency: 1 })).value.policy.task_concurrency, 1);
  assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { task_concurrency: null })).value.policy.task_concurrency, null);
  for (const value of [0, 33, 2.5, '2']) assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { task_concurrency: value })).status, 400);
});

test('only super administrators read and change global settings; project administrators set their own project only', async t => {
  const h = await harness(t, undefined, { imageTag: 'v9.9.9' }), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  assert.deepEqual((await admin('/api/settings')).value, { settings: { task_concurrency: 1, task_concurrency_bounds: [1, 32] }, version: { image_tag: 'v9.9.9', source: 'image' } });
  for (const value of [0, 33, 1.5, '2', null]) assert.equal((await admin('/api/settings', 'PATCH', { task_concurrency: value })).status, 400);
  assert.equal((await admin('/api/settings', 'PATCH', { task_concurrency: 4 })).value.settings.task_concurrency, 4);
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='settings.updated'"));
  const password = testPassword();
  await admin('/api/users', 'POST', { username: 'project-admin', password, role: 'project_admin', repository_ids: ['101'] });
  const member = h.client(); assert.equal((await member('/api/auth/login', 'POST', { username: 'project-admin', password })).status, 200);
  assert.equal((await member('/api/settings')).status, 403);
  assert.equal((await member('/api/settings', 'PATCH', { task_concurrency: 8 })).status, 403);
  assert.equal((await member('/api/version')).status, 403);
  assert.equal((await admin('/api/settings')).value.settings.task_concurrency, 4);
  const own = await member('/api/repositories/101/policy', 'PATCH', { task_concurrency: 3 });
  assert.equal(own.status, 200); assert.equal(own.value.policy.task_concurrency, 3); assert.equal(own.value.task_concurrency_default, 4);
  assert.equal((await member('/api/repositories/202/policy', 'PATCH', { task_concurrency: 3 })).status, 403);
  assert.equal((await member('/api/repositories/202')).status, 403);
});

test('the version comes from the image tag; a source run reports no tag instead of the package version', async t => {
  const tagged = await harness(t, undefined, { imageTag: 'sha-0123456789ab' }), { admin } = await setup(tagged);
  assert.deepEqual((await admin('/api/version')).value, { image_tag: 'sha-0123456789ab', source: 'image' });
  for (const imageTag of [undefined, '', '  ']) {
    const source = await harness(t, undefined, { imageTag }), { admin: other } = await setup(source), response = await other('/api/version');
    assert.deepEqual(response.value, { image_tag: null, source: 'source' }); assert.doesNotMatch(JSON.stringify(response.value), /0\.1\.0/);
  }
});

const settingsScripts = ['static/app.js', 'static/views.js', 'static/project.js', 'static/settings.js', 'static/onboarding.js'];
// What a fresh deployment answers: nothing verified, no tunnel token, no App and no models.
function emptyDeployment(path) {
  if (path === '/api/onboarding') return [200, { public_address: null, tunnel: { available: true, token_configured: false, origin: 'http://webhook:8791', state: 'waiting_token', routes: [] }, app: null, model_id: null }];
  if (path === '/api/accounts') return [200, { accounts: [] }];
  if (path === '/api/models') return [200, { models: [] }];
  throw new Error('Unexpected request: ' + path);
}
test('the global settings page shows the running tag or a source run and saves the default concurrency', async () => {
  let version = { image_tag: 'v9.9.9', source: 'image' }, saved = null;
  const page = loadConsole(settingsScripts, (method, path, body) => {
    if (path === '/api/settings' && method === 'PATCH') { saved = body; return [200, { settings: { task_concurrency: body.task_concurrency, task_concurrency_bounds: [1, 32] }, version }]; }
    if (path === '/api/settings') return [200, { settings: { task_concurrency: 1, task_concurrency_bounds: [1, 32] }, version }];
    return emptyDeployment(path);
  });
  const text = node => [node.textContent, ...node.children.flatMap(text)].join(' ');
  await page.run('renderSettings(renderVersion)');
  assert.match(text(page.$('settings-panel')), /v9\.9\.9/); assert.doesNotMatch(text(page.$('settings-panel')), /0\.1\.0/);
  const form = page.$('settings-panel').querySelector('form'), value = form.querySelectorAll('input').find(input => input.name === 'task_concurrency');
  assert.equal(String(value.value), '1'); value.value = '3'; value.checkValidity = () => true;
  await form.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(saved, { task_concurrency: 3 });
  version = { image_tag: null, source: 'source' }; await page.run('renderSettings(renderVersion)');
  assert.match(text(page.$('settings-panel')), /源码运行/); assert.doesNotMatch(text(page.$('settings-panel')), /0\.1\.0|v0\.1\.3/);
});

test('global settings switch to a registered App through the wizard API, updating its webhook without returning credentials', async t => {
  let hook = null;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/app/hook/config' && init.method === 'PATCH') { hook = JSON.parse(init.body); return new Response('{}'); }
    if (path === '/app/hook/config') return new Response(JSON.stringify(hook));
    if (path === '/app') return new Response(JSON.stringify({ id: 456, slug: 'second-app' }));
    if (path === '/app/installations') return new Response(JSON.stringify([{ id: 1 }, { id: 2 }]));
    return new Response('{}', { status: 404 });
  };
  const h = await harness(t, undefined, store => ({ onboarding: new Onboarding(store, { fetcher }) })), { admin } = await setup(h);
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), webhookSecret = randomBytes(24).toString('hex');
  const app = (await admin('/api/accounts', 'POST', { name: 'Second App', type: 'github_app', app_id: '456', private_key: privateKey, webhook_secret: webhookSecret })).value.account;
  // The webhook goes to the verified address, so an App is not switched before one exists.
  assert.notEqual((await admin('/api/onboarding/use-app', 'POST', { account_id: app.id, update_webhook: true })).status, 201);
  assert.equal((await admin('/api/onboarding')).value.app, null); assert.equal(hook, null);
  h.store.run("INSERT INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://hooks.example.com', checked_at: new Date().toISOString() }));
  const used = await admin('/api/onboarding/use-app', 'POST', { account_id: app.id, update_webhook: true });
  assert.equal(used.status, 201);
  assert.deepEqual(hook, { url: `https://hooks.example.com${app.endpoints[0].webhook_path}`, content_type: 'json' });
  assert.deepEqual(used.value.app, { account_id: app.id, app_id: '456', slug: 'second-app', installations: 2, webhook_url: hook.url, install_url: 'https://github.com/apps/second-app/installations/new' });
  const visible = JSON.stringify([used.value, (await admin('/api/onboarding')).value, (await admin('/api/accounts')).value]);
  for (const secret of [privateKey, webhookSecret]) assert.ok(!visible.includes(secret));
});

// One deployment as the global settings page sees it; every request that changes something is recorded in `sent`.
function deployment() {
  const state = {
    onboarding: { public_address: { origin: 'https://hooks.example.com', checked_at: '2026-10-27T00:00:00.000Z' },
      tunnel: { available: true, token_configured: true, origin: 'http://webhook:8791', state: 'connected', routes: [] },
      app: { account_id: 'a1', app_id: '123', slug: 'first-app', installations: 1, webhook_url: 'https://old.example.com/hooks/github/a1/e1' }, model_id: 'm1' },
    accounts: [{ id: 'a1', name: 'First App', type: 'github_app', app_id: '123', credentials_configured: true, endpoints: [{ webhook_path: '/hooks/github/a1/e1' }] },
      { id: 'a2', name: 'Second App', type: 'github_app', app_id: '456', credentials_configured: true, endpoints: [] },
      { id: 'b1', name: 'Token account', type: 'bot_account', app_id: null, credentials_configured: false, endpoints: [] }],
    models: [{ id: 'm1', repository_id: null, model_name: 'default-model', api_url: 'https://one.example.com/v1', key_configured: true, version: 1 },
      { id: 'm2', repository_id: null, model_name: 'second-model', api_url: 'https://two.example.com/v1', key_configured: true, version: 1 },
      { id: 'p1', repository_id: '101', model_name: 'project-model', api_url: 'https://three.example.com/v1', key_configured: true, version: 1 }] };
  const sent = [];
  const respond = (method, path, body) => {
    if (method !== 'GET') sent.push([method, path, body]);
    const { onboarding } = state;
    if (path === '/api/settings') return [200, { settings: { task_concurrency: 2, task_concurrency_bounds: [1, 32] }, version: { image_tag: 'v9.9.9', source: 'image' } }];
    if (path === '/api/onboarding') return [200, onboarding];
    if (path === '/api/accounts') return [200, { accounts: state.accounts }];
    if (path === '/api/models' && method === 'GET') return [200, { models: state.models }];
    if (path === '/api/onboarding/address') { onboarding.public_address = { origin: body.origin, checked_at: '2026-10-27T01:00:00.000Z' }; return [201, { public_address: onboarding.public_address }]; }
    if (path === '/api/onboarding/tunnel') { onboarding.tunnel = { ...onboarding.tunnel, token_configured: !body.revoke, state: body.revoke ? 'waiting_token' : 'connected' }; return [201, { tunnel: onboarding.tunnel }]; }
    if (path === '/api/onboarding/use-app') { onboarding.app = { account_id: body.account_id, app_id: '456', slug: 'second-app', installations: 2, webhook_url: onboarding.public_address.origin + '/hooks/github/a2/e2' }; return [201, { app: onboarding.app }]; }
    if (path === '/api/onboarding/model') { onboarding.model_id = body.model_id; return [201, { model_id: body.model_id }]; }
    if (path === '/api/models' && method === 'POST') { const model = { id: 'm3', ...body, key_configured: true, version: 1 }; delete model.api_key; state.models.push(model); return [201, { model }]; }
    const id = /^\/api\/models\/(\w+)$/.exec(path)?.[1], model = state.models.find(row => row.id === id);
    if (model && method === 'GET') return [200, { model: { ...model, used_by: [{ repository_id: '101', full_name: 'fixture/one' }] } }];
    if (model && method === 'PATCH') { Object.assign(model, { api_url: body.api_url, model_name: body.model_name, version: model.version + 1 }); return [200, { model }]; }
    if (model && method === 'DELETE') {
      state.models = state.models.filter(row => row !== model); if (onboarding.model_id === id) onboarding.model_id = null;
      return [200, { ok: true, cleared_repository_ids: ['101'] }];
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { state, sent, respond };
}

test('global settings change the wizard settings and shared models without a project page or token echo', async () => {
  const { sent, respond } = deployment(), page = loadConsole(settingsScripts, respond);
  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; var reloads = 0; reloadProject = async () => { reloads++; };");
  const panel = page.$('settings-panel'), text = node => [node.textContent, ...node.children.flatMap(text)].join(' ');
  // Each category has its own address and draws only its own cards.
  const open = async key => { page.run(`location.hash = '#/settings/${key}'`); await page.run('renderSettings(renderVersion)'); };
  const cards = () => panel.querySelectorAll('h3').map(node => node.textContent);
  const section = title => panel.querySelectorAll('section').find(node => node.querySelector('h3')?.textContent === title);
  const buttons = (node, caption) => node.querySelectorAll('button').filter(b => b.textContent === caption);
  const submit = form => form.listeners.submit[0]({ preventDefault() {} }), view = page.run('confirmView');
  const confirm = async opening => { await settle(); await submit(view.querySelector('form')); await opening; };
  await page.run('renderSettings(renderVersion)');
  assert.deepEqual(panel.querySelectorAll('nav a').map(node => [node.textContent, node.href]), [['常规', '#/settings/general'], ['公网接入', '#/settings/access'], ['机器人账号', '#/settings/accounts'], ['模型', '#/settings/models'], ['用户', '#/settings/users']]);
  assert.deepEqual(cards(), ['当前运行版本', '同时运行的任务']);
  assert.equal(panel.querySelector('nav a[aria-current=page]').textContent, '常规');
  assert.match(text(section('当前运行版本')), /v9\.9\.9/);
  assert.equal(String(section('同时运行的任务').querySelector('input').value), '2');
  await open('access'); assert.deepEqual(cards(), ['公网 HTTPS 地址', 'Cloudflare Tunnel']);
  // One-time wizard steps stay in the wizard: nothing here creates an App or installs one.
  assert.ok(!panel.querySelectorAll('button').some(b => /创建|安装|跳过|manifest/i.test(b.textContent)));

  // The public address is checked again through the wizard API; the App card then flags the webhook left on the old address.
  const origin = section('公网 HTTPS 地址').querySelector('input'); origin.value = 'https://new.example.com';
  await submit(section('公网 HTTPS 地址').querySelector('form'));
  assert.deepEqual(sent.at(-1), ['POST', '/api/onboarding/address', { origin: 'https://new.example.com' }]);
  assert.match(text(section('公网 HTTPS 地址')), /已检查并保存 https:\/\/new\.example\.com/);

  // A pasted command is sent once and never drawn back; revoking asks first.
  const token = Buffer.from(JSON.stringify({ a: 'account', t: 'tunnel', s: 'secret-part' })).toString('base64');
  section('Cloudflare Tunnel').querySelector('input').value = `cloudflared tunnel run --token ${token}`;
  await submit(section('Cloudflare Tunnel').querySelector('form'));
  assert.deepEqual(sent.at(-1), ['POST', '/api/onboarding/tunnel', { token: `cloudflared tunnel run --token ${token}` }]);
  assert.ok(!text(panel).includes(token)); assert.ok(panel.querySelectorAll('input').every(node => !String(node.value).includes(token)));
  assert.match(text(section('Cloudflare Tunnel')), /已保存 tunnel token/);
  await confirm(buttons(section('Cloudflare Tunnel'), '撤销 token')[0].listeners.click[0]());
  assert.deepEqual(sent.at(-1), ['POST', '/api/onboarding/tunnel', { revoke: true }]);
  assert.match(text(section('Cloudflare Tunnel')), /未配置/); assert.equal(buttons(section('Cloudflare Tunnel'), '撤销 token').length, 0);

  // The accounts category shows the wizard's App, which now flags the webhook left on the old address, and every account.
  await open('accounts'); assert.deepEqual(cards(), ['接入向导使用的 GitHub App', '已登记的账号']);
  const app = () => section('接入向导使用的 GitHub App');
  assert.match(text(app()), /webhook 不在当前公网地址下/);
  assert.deepEqual(section('已登记的账号').querySelectorAll('.row strong').map(node => node.textContent), ['First App', 'Second App', 'Token account']);
  assert.match(text(section('已登记的账号')), /凭据已撤销/); assert.ok(buttons(section('已登记的账号'), '新增账号').length);
  // Only registered GitHub Apps are offered; switching writes the webhook to the verified address.
  const apps = app().querySelectorAll('li');
  assert.deepEqual(apps.map(row => row.querySelector('button').textContent), ['重新检查', '改用此 App']);
  await confirm(apps[1].querySelector('button').listeners.click[0]());
  assert.deepEqual(sent.at(-1), ['POST', '/api/onboarding/use-app', { account_id: 'a2', update_webhook: true }]);
  assert.match(text(app()), /已改用 Second App/); assert.match(text(app()), /second-app/);
  assert.doesNotMatch(text(app()), /webhook 不在当前公网地址下/);

  // The default is picked among shared models with a key; project models are not offered or listed.
  await open('models'); assert.deepEqual(cards(), ['默认共享模型', '部署共享模型']);
  const choices = () => section('默认共享模型').querySelector('select').children.map(option => option.value);
  assert.deepEqual(choices(), ['', 'm1', 'm2']); assert.doesNotMatch(text(panel), /project-model/);
  section('默认共享模型').querySelector('select').value = 'm2'; await submit(section('默认共享模型').querySelector('form'));
  assert.deepEqual(sent.at(-1), ['POST', '/api/onboarding/model', { model_id: 'm2' }]);
  assert.match(text(section('默认共享模型')), /second-model · https:\/\/two\.example\.com\/v1/);

  // Shared model rows edit, delete and add in place: no project is loaded or reloaded.
  const row = name => section('部署共享模型').querySelectorAll('li').find(node => text(node).includes(name));
  buttons(row('second-model'), '修改 URL 和模型名')[0].listeners.click[0]();
  const edit = page.run("document.body.querySelector('#model-edit')"), [url, name] = edit.querySelectorAll('input');
  url.value = 'https://two.example.com/v2'; name.value = 'renamed-model'; await submit(edit.querySelector('form'));
  assert.deepEqual(sent.at(-1), ['PATCH', '/api/models/m2', { version: 1, api_url: 'https://two.example.com/v2', model_name: 'renamed-model' }]);
  assert.match(text(section('部署共享模型')), /已保存 renamed-model 的接口 URL 和模型名/);
  const deleting = buttons(row('renamed-model'), '删除')[0].listeners.click[0](); await settle();
  assert.match(view.querySelectorAll('p').map(node => node.textContent).join('\n'), /所有项目都不能再选/);
  assert.deepEqual(view.querySelectorAll('li').map(node => node.textContent), ['fixture/one']);
  await confirm(deleting);
  assert.deepEqual(sent.at(-1), ['DELETE', '/api/models/m2', {}]);
  assert.match(text(section('部署共享模型')), /已删除模型 renamed-model/); assert.doesNotMatch(text(section('部署共享模型')), /renamed-model ·/);
  assert.match(text(section('默认共享模型')), /未设置/);
  const add = section('部署共享模型').querySelector('details form'), fields = Object.fromEntries(add.querySelectorAll('input').map(node => [node.name, node]));
  fields.api_url.value = 'https://four.example.com/v1'; fields.api_key.value = 'sk-fixture'; fields.model_name.value = 'added-model';
  add.querySelectorAll('input').forEach(node => { node.checkValidity = () => true; }); add.elements = fields;
  await submit(add);
  assert.deepEqual(sent.at(-1), ['POST', '/api/models', { repository_id: null, api_url: 'https://four.example.com/v1', model_name: 'added-model', api_key: 'sk-fixture' }]);
  assert.match(text(section('部署共享模型')), /已添加 added-model/); assert.ok(row('added-model'));
  assert.equal(page.run('reloads'), 0); assert.equal(page.run('current'), null);
});
