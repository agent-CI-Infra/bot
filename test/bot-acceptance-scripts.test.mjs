// The scripts that set up and drive the AI scenario acceptance (bot-acceptance/) against the real control plane with a
// local GitHub and model fixture: they only use the console API, so a change to that API must not break them unseen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './helpers.mjs';
import { Onboarding } from '../dist/onboarding/service.js';
import { InstallationSync } from '../dist/app/installations.js';
import { appEvents, appPermissions } from '../dist/github/client.js';
import { taskGroupSQL } from '../dist/app/project-activity.js';
import { bootstrap, BASELINE_POLICY, FIXTURE } from '../bot-acceptance/bootstrap.mjs';
import { resetFixture } from '../bot-acceptance/reset.mjs';
import { BUSY, parse, waitFor } from '../bot-acceptance/wait.mjs';
import { call } from '../bot-acceptance/console.mjs';
import { readJson } from '../bot-acceptance/lib/state.mjs';
import { GitHub } from '../bot-acceptance/lib/github.mjs';

async function listen(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const read = async req => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : undefined; };
const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'bot-acceptance-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

// GitHub as the acceptance App sees it: one installation on the fixture's organization, holding the fixture repository.
async function githubFixture(t, app = {}) {
  const state = { hook: null, requests: [] }, owner = { id: 10, login: 'agent-CI-Infra', type: 'Organization' };
  const definition = { id: 4242, slug: 'bot-acceptance', owner, permissions: { ...appPermissions, workflows: 'write' },
    events: [...appEvents, 'workflow_run', 'organization'], ...app };
  const installation = { id: 77, app_id: 4242, account: owner, repository_selection: 'selected', permissions: definition.permissions, events: definition.events, suspended_at: null };
  state.url = await listen(t, async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname; state.requests.push(`${req.method} ${path}`);
    if (path === '/app/hook/config') { if (req.method === 'PATCH') state.hook = await read(req); return json(res, state.hook || {}); }
    if (path === '/app') return json(res, definition);
    if (path === '/rate_limit') return json(res, { resources: {} });
    if (path === '/app/installations') return json(res, [installation]);
    if (path === '/app/installations/77') return json(res, installation);
    if (path === '/app/installations/77/access_tokens') return json(res, { token: 'fixture-installation-token' }, 201);
    if (path === '/installation/token') return json(res, undefined, 204);
    if (path === '/installation/repositories') return json(res, { total_count: 1, repositories: [{ id: 501, full_name: FIXTURE, owner, private: false }] });
    return json(res, { message: 'Not Found' }, 404);
  });
  return state;
}

async function controlPlane(t, github) {
  let h;
  // The public-address check reaches this instance's own probe; here the "public origin" maps straight back to it.
  const probe = async url => { const target = new URL(url); const r = await fetch(h.admin + target.pathname + target.search); return { status: r.status, body: await r.text() }; };
  h = await harness(t, undefined, store => ({ onboarding: new Onboarding(store, { githubUrl: github.url, probe }), installations: new InstallationSync(store, github.url) }));
  const model = await listen(t, async (req, res) => {
    await read(req);
    json(res, { id: 'fixture', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  return { h, model };
}

const appKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const options = (h, github, model, overrides = {}) => ({ botUrl: h.admin, publicOrigin: 'https://bot-acceptance.example.com', githubApiUrl: github.url,
  app: { id: '4242', privateKey: appKey(), webhookSecret: 'fixture-webhook-secret' }, model: { url: `${model}/v1`, name: 'fixture-model', apiKey: 'fixture-model-key' },
  waitEnvironment: false, intervalMs: 50, ...overrides });

test('bootstrap sets up a fresh instance through the console API and hands the test AI only a project administrator', async t => {
  const github = await githubFixture(t), { h, model } = await controlPlane(t, github), dir = tempDir(t);
  const target = await bootstrap(options(h, github, model), { dir, log: () => {} });

  assert.equal(target.repository.full_name, FIXTURE); assert.equal(target.app.bot_login, 'bot-acceptance[bot]');
  assert.deepEqual(readJson(dir, 'target.json'), target);
  // The App's webhook now points at this run's own endpoint under the public origin.
  assert.equal(github.hook.url, target.app.webhook_url);
  assert.match(github.hook.url, /^https:\/\/bot-acceptance\.example\.com\/hooks\/github\/[^/]+\/[^/]+$/);
  for (const name of ['admin.json', 'operator.json', 'admin.session.json']) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
  // No credential reaches the file the test AI reads.
  const visible = JSON.stringify(target);
  for (const value of [readJson(dir, 'admin.json').password, readJson(dir, 'operator.json').password, 'fixture-webhook-secret', 'fixture-model-key']) assert.ok(!visible.includes(value));

  // console.mjs acts as the project administrator: it reads the project with the baseline policy, not deployment settings.
  const { policy } = await call(['GET', '/api/repositories/{repo}/policy'], dir);
  // SQLite flags come back as 0/1.
  for (const [key, value] of Object.entries(BASELINE_POLICY)) assert.equal(typeof value === 'boolean' ? !!policy[key] : policy[key], value, key);
  await assert.rejects(call(['GET', '/api/installations'], dir), error => error.status === 403);
  await assert.rejects(call(['GET', 'https://example.com/api/x'], dir), /must start with \/api\//);

  // Every run starts from an empty instance; an initialized one is refused before anything is changed.
  await assert.rejects(bootstrap(options(h, github, model), { dir: tempDir(t), log: () => {} }), /already initialized/);
});

test('bootstrap stops with a plain reason when the App lacks what the scenarios need', async t => {
  const github = await githubFixture(t, { events: [...appEvents, 'organization'] }), { h, model } = await controlPlane(t, github);
  await assert.rejects(bootstrap(options(h, github, model), { dir: tempDir(t), log: () => {} }), /lacks \{"permissions":\[\],"events":\["workflow_run"\]\}/);
  assert.equal(github.hook, null);
});

test('reset closes the last run, deletes its branches and rulesets and forces main back to the seed', async t => {
  const state = { rulesets: [{ id: 3, name: 'merge queue' }], protected: true, branches: ['main', 'bot/issue-4', 'feature/x y'],
    pulls: [{ number: 5 }], issues: [{ number: 4 }, { number: 5, pull_request: {} }], main: 'feedface', writes: [] };
  const base = `/repos/${FIXTURE}`;
  const url = await listen(t, async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://fixture').pathname), body = await read(req), write = req.method !== 'GET';
    if (write) state.writes.push(`${req.method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);
    if (path === `${base}/rulesets`) return json(res, state.rulesets);
    if (path === `${base}/branches/main/protection`) return state.protected ? json(res, req.method === 'GET' ? {} : undefined, req.method === 'GET' ? 200 : 204) : json(res, { message: 'Not Found' }, 404);
    if (path === `${base}/pulls`) return json(res, state.pulls);
    if (path === `${base}/issues`) return json(res, state.issues);
    if (path === `${base}/branches`) return json(res, state.branches.map(name => ({ name })));
    // An annotated seed tag points at a tag object, which points at the commit.
    if (path === `${base}/git/ref/tags/seed`) return json(res, { object: { type: 'tag', sha: 'aaaa' } });
    if (path === `${base}/git/tags/aaaa`) return json(res, { object: { type: 'commit', sha: 'seed0000seed' } });
    if (write) return json(res, req.method === 'DELETE' ? undefined : {}, req.method === 'DELETE' ? 204 : 200);
    return json(res, { message: 'Not Found' }, 404);
  });
  const github = new GitHub('fixture-token', { apiUrl: url });

  const planned = await resetFixture(github, { dryRun: true, log: () => {} });
  assert.deepEqual(state.writes, []);
  assert.deepEqual({ pulls: planned.pulls, issues: planned.issues, branches: planned.branches }, { pulls: [5], issues: [4], branches: ['bot/issue-4', 'feature/x y'] });

  const result = await resetFixture(github, { log: () => {} });
  assert.equal(result.seed_sha, 'seed0000seed');
  assert.deepEqual(state.writes, [
    `DELETE ${base}/rulesets/3`, `DELETE ${base}/branches/main/protection`,
    `POST ${base}/issues/5/comments {"body":"Closed by the acceptance reset."}`, `PATCH ${base}/pulls/5 {"state":"closed"}`,
    `POST ${base}/issues/4/comments {"body":"Closed by the acceptance reset."}`, `PATCH ${base}/issues/4 {"state":"closed","state_reason":"not_planned"}`,
    `DELETE ${base}/git/refs/heads/bot/issue-4`, `DELETE ${base}/git/refs/heads/feature/x y`,
    `PATCH ${base}/git/refs/heads/main {"sha":"seed0000seed","force":true}`,
  ]);
});

test('wait settles only after the matching tasks stop and stay unchanged, and reports a timeout as unsettled', async () => {
  // The statuses wait treats as busy are exactly the ones the console counts as running or queued.
  const listed = `${taskGroupSQL.active} ${taskGroupSQL.queued}`.match(/'[a-z_]+'/g).map(value => value.slice(1, -1));
  assert.deepEqual([...BUSY].sort(), [...new Set(listed)].sort());

  let clock = 0; const pages = [];
  const client = { request: async () => ({ tasks: pages.length > 1 ? pages.shift() : pages[0] }) };
  const task = (status, number = 12) => ({ id: `t${number}`, kind: 'review.issue', status, object_number: number, created_at: '2026-11-14T00:00:00Z', summary: 's', result: null, metrics: null });
  const run = (argv, sequence) => { clock = 0; pages.splice(0, pages.length, ...sequence);
    return waitFor(client, '501', { ...parse(argv), intervalMs: 10_000 }, { now: () => clock, sleep: async ms => { clock += ms; } }); };

  const settled = await run(['--number', '12', '--settle', '30'], [[], [task('queued')], [task('running')], [task('succeeded'), task('queued', 13)]]);
  assert.equal(settled.settled, true); assert.deepEqual(settled.tasks.map(t => [t.id, t.status]), [['t12', 'succeeded']]);
  // No task yet is not "done": without --allow-none the wait runs into its timeout.
  const timedOut = await run(['--number', '7', '--timeout', '1'], [[task('succeeded')]]);
  assert.deepEqual([timedOut.settled, timedOut.tasks.length], [false, 0]);
  const none = await run(['--number', '7', '--allow-none', '--settle', '20'], [[task('succeeded')]]);
  assert.deepEqual([none.settled, none.waited_seconds], [true, 20]);
  assert.throws(() => parse(['--number', 'x']), /--number/);
});
