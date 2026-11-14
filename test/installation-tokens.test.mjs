import { acceptanceFixture } from './acceptance-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { harness, setup, account, repository } from './helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { enqueue } from '../dist/review/queue.js';
import { GitHub, revokeInstallationToken } from '../dist/github/client.js';
import { ReadTokens } from '../dist/agent/read-token.js';
import { RepositoryExplorer } from '../dist/agent/exploration.js';
import { Redactor } from '../dist/agent/common.js';
import { createReadGrant } from '../runner/token-exchange.mjs';

// #711: GitHub answers 401 "Bad credentials" for an installation token that expired or was revoked. In production every
// review stopped this way had run 61-83 minutes on the token its attempt minted at the start (tokens live an hour), and a
// review session's runner kept handing commands a read token the control plane revoked when the previous round ended.

const head = 'a'.repeat(40), base = 'b'.repeat(40), tree = 'c'.repeat(40), repo = '/repos/fixture/project-101';
// A GitHub App installation that mints a new token for every request, refuses the App's JWT once it expired, and answers
// 401 for a token it never minted, one past its expires_at, one in `dead` (revoked, or expired by the test) or every token
// while `refuseAll` is set. `routes` answers the repository requests a token may make.
async function fakeGitHub(t, routes = () => false) {
  const state = { minted: [], dead: new Set(), refuseAll: false, requests: [], lifetime: 3600_000 };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = decodeURIComponent(new URL(req.url, 'http://fixture').pathname), method = req.method;
    const auth = String(req.headers.authorization || '').replace(/^Bearer /, ''), jwt = auth.startsWith('eyJ');
    const minted = state.minted.find(m => m.token === auth);
    const record = { method, path, credential: jwt ? 'jwt' : minted ? 'token-' + state.minted.indexOf(minted) : 'unknown' }; state.requests.push(record);
    const send = (value, status = 200) => { record.status = status; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (jwt) {
      if (JSON.parse(Buffer.from(auth.split('.')[1], 'base64url')).exp * 1000 <= Date.now()) return send({ message: 'Expired JWT' }, 401);
      if (path === '/app') return send({ id: 123, slug: 'fixture-app' });
      if (path === repo + '/installation') return send({ id: 55, account: { id: 10, login: 'fixture' },
        permissions: { contents: 'read', issues: 'write', pull_requests: 'write', actions: 'read', checks: 'read', statuses: 'read', metadata: 'read' } });
      if (path === '/app/installations/55/access_tokens' && method === 'POST') {
        const request = JSON.parse(raw), token = 'ghs_' + randomBytes(16).toString('hex'), expires = new Date(Date.now() + state.lifetime).toISOString();
        state.minted.push({ token, expires, request });
        return send({ token, expires_at: expires, permissions: request.permissions }, 201);
      }
      return send({ message: 'Not Found' }, 404);
    }
    if (!minted || state.dead.has(auth) || state.refuseAll || Date.parse(minted.expires) <= Date.now())
      return send({ message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' }, 401);
    if (path === '/installation/token' && method === 'DELETE') { state.dead.add(auth); return send(undefined, 204); }
    if (path === '/users/fixture-app[bot]') return send({ id: 999, login: 'fixture-app[bot]' });
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main' });
    if (routes(path, method, raw, send) !== false) return;
    return send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  return { state, url: 'http://127.0.0.1:' + server.address().port,
    // Which minted token each matching request carried (token-<n>, so assertions never need a value) and GitHub's answer.
    sent: filter => state.requests.filter(r => `${r.method} ${r.path}` === filter).map(r => `${r.credential} ${r.status}`) };
}

// The control plane with a GitHub App account on repository 101; `poll` answers the agent of a review task.
async function controlPlane(t, github, poll = async () => ({ state: 'completed', result: {} })) {
  const manager = { call: async (_method, path, body) => {
    if (path.endsWith('/parallel')) return { parallel: body.tasks };
    if (!path.endsWith('/execute')) return { repository_id: '101', state: 'ready', generation: 1, desired: 'ready', revision: 1, computer: {} };
    if (body.request.type === 'workspace_snapshot') return { ok: true, result: { tree_sha: body.request.tree_sha } };
    if (body.request.type === 'workspace_agent_poll') return { ok: true, result: await poll() };
    return { ok: true, result: {} };
  } };
  let engine;
  const h = await harness(t, manager, store => ({ engine: engine = new TaskEngine(store, manager, github.url, undefined, acceptanceFixture) }));
  t.after(() => engine.close());
  const { admin } = await setup(h), privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const a = await account(admin, { type: 'github_app', app_id: '123', private_key: privateKey, token: undefined }); await repository(admin, a.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: 'fixture-model-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, model_id: model.id });
  const repository101 = h.store.get("SELECT * FROM repositories WHERE id='101'");
  return { h, engine, admin, repository: repository101,
    client: purpose => { const client = new GitHub(h.store, repository101, new Redactor(), async () => {}, github.url); client.purpose = purpose; return client; } };
}

// One open PR the review reads, comments on and labels.
const pullRequest = (path, method, raw, send) => {
  if (path === repo + '/pulls/7') return send({ id: 7007, number: 7, state: 'open', draft: false, title: 'Change', body: 'Please review.', user: { id: 800, login: 'contributor' },
    head: { sha: head, ref: 'feature', repo: { id: 101 } }, base: { ref: 'main', sha: base }, labels: [] });
  if (path === repo + '/git/ref/heads/main') return send({ object: { sha: base } });
  if (/\/git\/commits\/[a-f0-9]{40}$/.test(path)) return send({ sha: path.slice(-40), tree: { sha: tree } });
  if (path === repo + '/git/trees/' + tree) return send({ sha: tree, tree: [], truncated: false });
  if (path === repo + '/pulls/7/files') return send([{ filename: 'a.js', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }]);
  if ([repo + '/pulls/7/reviews', repo + '/pulls/7/comments', repo + '/labels', repo + '/issues/7/labels'].includes(path))
    return send(method === 'POST' ? (JSON.parse(raw).labels || []).map(name => ({ name })) : []);
  if (path === repo + '/issues/7/comments') return method === 'POST' ? send({ id: 2, user: { id: 999 }, html_url: 'https://github.invalid/c/2' }, 201) : send([]);
  return false;
};
const review = { summary: 'Reviewed.', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' };
async function runReview(f) {
  f.h.store.transaction(() => enqueue(f.h.store, '101', 'review.pr', 7, head, { number: 7 }));
  const task = f.h.store.get("SELECT * FROM tasks WHERE kind='review.pr' AND object_number=7");
  f.engine.tick(); await f.engine.active.get(task.id);
  return f.h.store.get('SELECT * FROM tasks WHERE id=?', task.id);
}

test('#711 a review that outlives the token its attempt minted mints a new one instead of waiting for permission', async t => {
  const github = await fakeGitHub(t, pullRequest);
  // The agent finishes after the attempt's token stopped working, as it does when a review runs for more than an hour.
  const f = await controlPlane(t, github, async () => { for (const { token } of github.state.minted) github.state.dead.add(token); return { state: 'completed', result: review }; });
  const task = await runReview(f);
  assert.equal(task.status, 'succeeded', task.error_code);
  // The check after the agent finished was refused once and sent again with a new token, which the comment used too.
  const pulls = github.sent('GET /repos/fixture/project-101/pulls/7'), refused = pulls.findIndex(r => r.endsWith(' 401'));
  assert.ok(refused > 0 && pulls[refused + 1].endsWith(' 200') && pulls[refused + 1].split(' ')[0] !== pulls[refused].split(' ')[0], JSON.stringify(pulls));
  assert.deepEqual(github.sent('POST /repos/fixture/project-101/issues/7/comments'), [pulls[refused + 1].split(' ')[0] + ' 201']);
  assert.equal(f.h.store.get("SELECT count(*) n FROM task_logs WHERE task_id=? AND content LIKE '%github_permission_401%'", task.id).n, 0);
});

test('#711 a second 401 after minting again waits for permission and names both tokens without their values', async t => {
  const github = await fakeGitHub(t, pullRequest);
  const f = await controlPlane(t, github, async () => { github.state.refuseAll = true; return { state: 'completed', result: review }; });
  const task = await runReview(f);
  assert.deepEqual([task.status, task.error_code], ['waiting_permission', 'github_permission_401']);
  // Exactly one more token was minted for the refused request, and the request was sent once more.
  const after = github.state.requests.slice(github.state.requests.findIndex(r => r.status === 401));
  assert.deepEqual(after.map(r => `${r.method} ${r.path.replace(repo, '')} ${r.credential.startsWith('token') ? 'token' : r.credential} ${r.status}`),
    ['GET /pulls/7 token 401', 'POST /app/installations/55/access_tokens jwt 201', 'GET /pulls/7 token 401']);
  assert.notEqual(after[0].credential, after[2].credential);
  const fault = JSON.parse(f.h.store.get("SELECT content FROM task_logs WHERE task_id=? AND content LIKE '%\"fault\"%' ORDER BY rowid DESC LIMIT 1", task.id).content);
  assert.match(fault.detail, /^GitHub 请求 GET \/repos\/fixture\/project-101\/pulls\/7 返回 HTTP 401：Bad credentials。bot 签发的安装令牌被拒绝后已重新签发并重试一次，仍返回 401。/);
  assert.match(fault.detail, /被拒的令牌：task 客户端 \S+ 签发（connect），\S+ 到期，未被 bot 吊销；重新签发的令牌：task 客户端 \S+ 签发（after_401）/);
  for (const { token } of github.state.minted) assert.ok(!JSON.stringify(f.h.store.all('SELECT content FROM task_logs')).includes(token));
});

test('#711 two holders of one read token: the round that ends revokes it, and the session asks for a new one before its next command', async t => {
  const github = await fakeGitHub(t, (path, _method, _raw, send) => path === repo + '/issues/1' ? send({ number: 1 }) : false);
  const f = await controlPlane(t, github), redactor = new Redactor(), masked = [];
  // One review round: the control plane's read-token service, and the exchange the runner's grant calls (src/agent/loop.ts).
  const round = () => {
    const tokens = new ReadTokens(f.h.store, f.repository, redactor, async () => {}, github.url), explorer = new RepositoryExplorer(tokens, redactor, async () => {});
    return { tokens, exchange: async () => { const client = await explorer.connect(); return { token: client.token, expires_at: client.expiresAt, permissions: client.permissions, repository: client.fullName }; } };
  };
  let current = round();
  const grant = createReadGrant(signal => current.exchange(signal), token => masked.push(token));
  const read = async env => (await fetch(github.url + repo + '/issues/1', { headers: { Authorization: 'Bearer ' + env.GH_TOKEN } })).status;
  assert.ok((await grant.request()).token); const first = await grant.env();
  assert.equal(await read(first), 200);
  // The round ends: the control plane revokes its tokens while the waiting session still holds one of them.
  await current.tokens.revoke();
  assert.equal(await read(await grant.env()), 401, 'a held token stays revoked: this is what commands of the next round were given');
  current = round(); grant.resume();
  const next = await grant.env();
  assert.notEqual(next.GH_TOKEN, first.GH_TOKEN); assert.equal(await read(next), 200);
  assert.deepEqual(masked, [first.GH_TOKEN, next.GH_TOKEN], 'every token the session received is masked in its output');
  // Asking explicitly always goes to the control plane, which answers with the token it holds now.
  assert.equal((await grant.request()).token, next.GH_TOKEN);
  await current.tokens.revoke();
  assert.ok([first.GH_TOKEN, next.GH_TOKEN].every(token => github.state.dead.has(token)));
});

test('#711 an App client renews its token and its JWT before they expire, and shares one renewal between concurrent requests', async t => {
  const github = await fakeGitHub(t, (path, _method, _raw, send) => path === repo + '/issues/1' ? send({ number: 1 }) : false);
  const f = await controlPlane(t, github), client = f.client('task'), first = github.state.minted.length;
  await client.connect(false, undefined, { issues: 'read' }, false);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  // 46 minutes later the token has 14 minutes left and the JWT signed at connect expired long ago.
  t.mock.timers.tick(46 * 60_000);
  assert.deepEqual(await client.request('GET', client.path('/issues/1')), { number: 1 });
  assert.deepEqual(client.minted.map(m => m.reason), ['connect', 'expiring']);
  assert.deepEqual(github.sent('GET /repos/fixture/project-101/issues/1'), [`token-${first + 1} 200`], 'the expiring token is never sent');
  assert.equal(client.minted[1].expiresAt, github.state.minted[first + 1].expires);
  // Revoked elsewhere while this client still uses it: the parallel requests that GitHub refuses share one new token.
  await revokeInstallationToken(github.url, client.token, 'elsewhere');
  const replies = await Promise.all([1, 2, 3].map(() => client.request('GET', client.path('/issues/1'))));
  assert.deepEqual(replies, [{ number: 1 }, { number: 1 }, { number: 1 }]);
  assert.deepEqual(client.minted.map(m => m.reason), ['connect', 'expiring', 'after_401']);
  // Every token the client minted is revoked at the end, the renewed ones included.
  await client.revokeTokens('task');
  assert.equal(github.state.minted.slice(first).filter(m => github.state.dead.has(m.token)).length, 3);
});

test('#711 a read token that GitHub refuses after its holder revoked it says so in the diagnostics', async t => {
  const github = await fakeGitHub(t, (path, _method, _raw, send) => path === repo + '/issues/1' ? send({ number: 1 }) : false);
  const f = await controlPlane(t, github), tokens = new ReadTokens(f.h.store, f.repository, new Redactor(), async () => {}, github.url);
  const client = await tokens.issueRepository();
  await tokens.revoke(); github.state.refuseAll = true;
  await assert.rejects(client.request('GET', client.path('/issues/1')), error => {
    assert.equal(error.code, 'github_permission_401'); assert.equal(error.state, 'waiting_permission');
    assert.match(error.detail, /被拒的令牌：read_token 客户端 \S+ 签发（connect），\S+ 到期，已由 bot 的 read_token 在 \S+ 吊销；重新签发的令牌：read_token 客户端 \S+ 签发（after_401），\S+ 到期，未被 bot 吊销。$/);
    for (const { token } of github.state.minted) assert.ok(!error.detail.includes(token));
    return true;
  });
});

test('#711 a Pi session renews its read token before a command when under ten minutes remain, and keeps a good one when an exchange fails', async () => {
  let answer = 0, failing = false;
  const now = Date.now(), lifetimes = [5 * 60_000, 60 * 60_000, 60 * 60_000];
  const grant = createReadGrant(async () => failing ? { error: 'github_read_token_timeout' } : { token: 'token-' + answer, expires_at: new Date(now + lifetimes[answer++]).toISOString() }, () => {});
  assert.equal(await grant.env(), undefined, 'no token before the model asks for one');
  await grant.request();
  assert.equal((await grant.env()).GH_TOKEN, 'token-1', 'a token with five minutes left is exchanged before the command');
  failing = true;
  assert.equal((await grant.request()).error, 'github_read_token_timeout'); assert.equal((await grant.env()).GH_TOKEN, 'token-1');
  // A failed exchange never keeps a token from an ended round.
  grant.resume(); assert.equal(await grant.env(), undefined);
  failing = false; await grant.request(); assert.equal((await grant.env()).GH_TOKEN, 'token-2');
  // A policy that keeps tokens out of commands drops the one held.
  const structured = createReadGrant(async () => ({ structured_only: true }), () => {});
  await structured.request(); assert.equal(await structured.env(), undefined);
});
