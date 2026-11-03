import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { enqueue } from '../dist/review/queue.js';
import { InstallationSync } from '../dist/app/installations.js';
import { appBucket, installationBucket, observe, refused, blockedUntil, rateLimitView } from '../dist/github/rate-limits.js';

const head = 'a'.repeat(40), seconds = ms => Math.floor(ms / 1000);
const windowHeaders = (remaining, reset, extra = {}) => ({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-used': String(5000 - remaining),
  'x-ratelimit-reset': String(seconds(reset)), 'x-ratelimit-resource': 'core', ...extra });

// A GitHub App installed on one organization, whose responses carry rate-limit headers. `pullRemaining` is what GitHub says
// is left after a PR read; at 0 it refuses the read the way GitHub does. A stand-in computer answers the task.
async function fixture(t, { computer = 'ready' } = {}) {
  const requests = [], reset = Date.now() + 20 * 60_000, state = { pullRemaining: 4000, secondary: false, computer };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = decodeURIComponent(new URL(req.url, 'http://fixture').pathname), jwt = req.headers.authorization?.startsWith('Bearer eyJ');
    requests.push(`${req.method} ${path}`);
    const send = (value, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...windowHeaders(jwt ? 4990 : 4100, reset), ...headers }); res.end(JSON.stringify(value)); };
    const repo = '/repos/fixture/project-101';
    // GET /rate_limit refuses a JWT, and its 401 carries the anonymous window, which must not be recorded for the App.
    if (path === '/rate_limit') return jwt ? send({ message: 'A JSON web token could not be decoded' }, 401, windowHeaders(60, reset, { 'x-ratelimit-limit': '60' })) : send({ resources: { core: { limit: 5000, remaining: 4321, used: 679, reset: seconds(reset) }, graphql: { limit: 5000, remaining: 4999, used: 1, reset: seconds(reset) } } });
    if (path === '/app') return send({ id: 123, slug: 'fixture-app' });
    if (path === '/app/installations') return send([{ id: 55, account: { id: 10, login: 'fixture-org' }, permissions: { metadata: 'read' } }]);
    if (path === repo + '/installation') return send({ id: 55, account: { id: 10, login: 'fixture-org' }, permissions: { contents: 'read', issues: 'write', pull_requests: 'write', metadata: 'read' } });
    if (path === '/app/installations/55/access_tokens') return send({ token: 'ghs_fixture', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: 'read', issues: 'write', pull_requests: 'write' } }, 201);
    if (path === '/installation/token') return send({}, 204);
    if (path === '/installation/repositories') return send({ repositories: [] });
    if (path === '/users/fixture-app[bot]') return send({ id: 999, login: 'fixture-app[bot]' });
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main' });
    if (path === repo + '/pulls/7') {
      if (state.secondary) return send({ message: 'You have exceeded a secondary rate limit.' }, 403, { 'retry-after': '30' });
      if (state.pullRemaining === 0) return send({ message: 'API rate limit exceeded for installation ID 55.' }, 403, windowHeaders(0, reset));
      return send({ id: 7007, number: 7, state: 'open', draft: false, title: 'Change', body: '', head: { sha: head, ref: 'feature', repo: { id: 101 } }, base: { ref: 'main' }, labels: [] }, 200, windowHeaders(state.pullRemaining, reset));
    }
    return send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const manager = { call: async (_method, path, body) => {
    if (path.endsWith('/parallel')) return { parallel: body.tasks };
    if (!path.endsWith('/execute')) return { repository_id: '101', state: state.computer, generation: 1, desired: 'ready', revision: 1, computer: {} };
    return { ok: true, result: {} };
  } };
  let engine, sync;
  const h = await harness(t, manager, store => ({ engine: engine = new TaskEngine(store, manager, url), installations: sync = new InstallationSync(store, url) }));
  t.after(() => engine.close());
  const { admin } = await setup(h), privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const a = await account(admin, { type: 'github_app', app_id: '123', private_key: privateKey, token: undefined }); await repository(admin, a.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: 'fixture-model-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, model_id: model.id });
  h.store.transaction(() => enqueue(h.store, '101', 'review.pr', 7, head, { number: 7 }));
  const id = h.store.get("SELECT id FROM tasks WHERE kind='review.pr' AND object_number=7").id;
  const run = async () => { h.store.run('UPDATE tasks SET next_run_at=0 WHERE id=?', id); requests.length = 0; engine.tick(); await engine.active.get(id); return h.store.get('SELECT * FROM tasks WHERE id=?', id); };
  return { h, admin, account: a, state, reset, requests, run, sync };
}

test('every response updates its window; a used-up window is waited out until it resets, without using up retries', async t => {
  const f = await fixture(t); f.state.pullRemaining = 0;
  let task = await f.run();
  assert.deepEqual([task.status, task.error_code, task.retry_count], ['retry_wait', 'github_rate_limited', 0]);
  // It resumes a few seconds after the window resets, not after a fixed minute.
  // GitHub reports the reset in whole seconds.
  const resetAt = seconds(f.reset) * 1000;
  assert.ok(task.next_run_at >= resetAt && task.next_run_at <= resetAt + 6000, String(task.next_run_at - resetAt));
  const installation = f.h.store.get("SELECT * FROM github_rate_limits WHERE bucket='installation:55' AND resource='core'");
  assert.deepEqual([installation.kind, installation.owner, installation.quota, installation.remaining, installation.reset_at, installation.account_id], ['installation', 'fixture-org', 5000, 0, seconds(f.reset) * 1000, f.account.id]);
  assert.equal(f.h.store.get("SELECT remaining FROM github_rate_limits WHERE bucket=?", 'app:' + f.account.id).remaining, 4990);
  // Retried early (as after a restart), nothing more is sent with the installation's token; only the App's own requests go.
  for (let attempt = 0; attempt < 6; attempt++) task = await f.run();
  assert.deepEqual([task.status, task.retry_count], ['retry_wait', 0]);
  assert.ok(f.requests.every(request => ['GET /repos/fixture/project-101/installation', 'POST /app/installations/55/access_tokens'].includes(request)), f.requests.join());
  const fault = JSON.parse(f.h.store.get("SELECT content FROM task_logs WHERE task_id=? AND content LIKE '%未发送%' ORDER BY rowid DESC LIMIT 1", task.id).content);
  assert.match(fault.detail, /^GitHub 流控：安装 55（fixture-org）本小时的请求额度已用完，\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC 重置后继续（GET \/\S+ 未发送）。$/);
});

test('a secondary rate limit pauses the installation for as long as GitHub asks', async t => {
  const f = await fixture(t); f.state.secondary = true;
  const started = Date.now(), task = await f.run();
  assert.deepEqual([task.error_code, task.retry_count], ['github_rate_limited', 0]);
  assert.ok(task.next_run_at >= started + 30_000 && task.next_run_at <= Date.now() + 36_000);
  const until = blockedUntil(f.h.store, installationBucket(f.account.id, '55'));
  assert.ok(until >= started + 30_000 && until <= Date.now() + 30_000);
});

test('the same wait repeated waits twice as long each time; another stop or a manual retry starts over', async t => {
  const f = await fixture(t, { computer: 'failed' }), delays = [];
  for (let attempt = 0; attempt < 4; attempt++) { const before = Date.now(), task = await f.run(); delays.push(Math.round((task.next_run_at - before) / 1000)); assert.equal(task.status, 'waiting_environment'); }
  assert.deepEqual(delays.map(d => [5, 10, 20, 40].includes(d) || [6, 11, 21, 41].includes(d)), [true, true, true, true], delays.join());
  assert.ok(delays[3] >= 40);
  // A manual retry resets the counter.
  assert.equal((await f.admin(`/api/tasks/${f.h.store.get('SELECT id FROM tasks').id}/retry`, 'POST', {})).status, 201);
  assert.equal(f.h.store.get('SELECT wait_count FROM tasks').wait_count, 0);
  // A different stop starts over: the computer is back, GitHub refuses the PR read for a moment.
  f.state.computer = 'ready'; f.state.secondary = true;
  const task = await f.run(); assert.deepEqual([task.error_code, task.wait_count], ['github_rate_limited', 0]);
});

test('probing reads the App and installation windows without spending them, and only super administrators see them', async t => {
  const f = await fixture(t);
  const probed = await f.admin(`/api/accounts/${f.account.id}/rate-limits/probe`, 'POST', {});
  assert.equal(probed.status, 201);
  const [account] = probed.value.accounts, buckets = Object.fromEntries(account.buckets.map(b => [b.kind, b]));
  assert.deepEqual([account.name, account.type], ['Test account', 'github_app']);
  // The App's JWT window comes from the headers of its own requests; GET /rate_limit refuses a JWT.
  assert.deepEqual(buckets.app.windows.map(w => [w.resource, w.remaining]), [['core', 4990]]);
  assert.deepEqual([buckets.installation.owner, buckets.installation.installation_id, buckets.installation.windows.map(w => [w.resource, w.quota, w.remaining, w.used])],
    ['fixture-org', '55', [['core', 5000, 4321, 679], ['graphql', 5000, 4999, 1]]]);
  // The metadata token minted to read the window is revoked.
  assert.ok(f.requests.includes('DELETE /installation/token')); assert.equal((await f.admin('/api/github/rate-limits')).value.accounts[0].buckets.length, 2);
  const password = testPassword();
  await f.admin('/api/users', 'POST', { username: 'project-admin', password, role: 'project_admin', repository_ids: ['101'] });
  const member = f.h.client(); await member('/api/auth/login', 'POST', { username: 'project-admin', password });
  assert.equal((await member('/api/github/rate-limits')).status, 403);
  assert.equal((await member(`/api/accounts/${f.account.id}/rate-limits/probe`, 'POST', {})).status, 403);
});

test('the view groups windows by account and counts the tasks waiting for each to reset', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin), now = Date.now();
  const headers = remaining => new Headers(windowHeaders(remaining, now + 600_000));
  observe(h.store, appBucket(a.id), headers(4999));
  observe(h.store, installationBucket(a.id, '77', 'org-a'), headers(12));
  const until = refused(h.store, installationBucket(a.id, '78', 'org-b'), new Headers(windowHeaders(0, now + 300_000)), now);
  assert.equal(until, seconds(now + 300_000) * 1000);
  assert.equal(blockedUntil(h.store, installationBucket(a.id, '78'), now), until); assert.equal(blockedUntil(h.store, installationBucket(a.id, '77'), now), null);
  // A window whose reset has passed no longer blocks.
  assert.equal(blockedUntil(h.store, installationBucket(a.id, '78'), until + 1), null);
  await repository(admin, a.id, '101');
  h.store.run("UPDATE installed_repositories SET installation_id='78' WHERE repository_id='101'");
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,error_code) VALUES('w1','101','review.pr','retry_wait','',?)", 'github_rate_limited');
  const view = rateLimitView(h.store, now), buckets = view.accounts[0].buckets;
  assert.deepEqual(buckets.map(b => [b.kind, b.owner, b.windows[0].remaining, !!b.blocked_until, b.waiting_tasks]),
    [['app', null, 4999, false, 0], ['installation', 'org-a', 12, false, 0], ['installation', 'org-b', 0, true, 1]]);
});
