import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { treeSha } from '../dist/agent/common.js';
import { loadConsole } from './console-page.mjs';

const commit = 'a'.repeat(40), tree = treeSha([]);
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
// Issue reviews on one repository whose agents keep working until the test lets each one finish.
async function fixture(t) {
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
  const calls = [];
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

test('the global settings page shows the running tag or a source run and saves the default concurrency', async () => {
  let version = { image_tag: 'v9.9.9', source: 'image' }, saved = null;
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/settings.js'], (method, path, body) => {
    if (path === '/api/settings' && method === 'PATCH') { saved = body; return [200, { settings: { task_concurrency: body.task_concurrency, task_concurrency_bounds: [1, 32] }, version }]; }
    if (path === '/api/settings') return [200, { settings: { task_concurrency: 1, task_concurrency_bounds: [1, 32] }, version }];
    throw new Error('Unexpected request: ' + path);
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
