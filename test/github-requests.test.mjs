import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository } from './helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { enqueue } from '../dist/review/queue.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), tree = 'c'.repeat(40);
// One PR review with a GitHub App account, run to the end against a GitHub that records every request, and the credential
// it carried: the App's JWT or the installation token. The project computer is a stand-in whose agent returns a review.
async function reviewFixture(t) {
  const requests = [], reviews = [], comments = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fixture'), path = decodeURIComponent(url.pathname), method = req.method;
    requests.push({ request: `${method} ${path}`, credential: req.headers.authorization?.startsWith('Bearer eyJ') ? 'jwt' : 'installation' });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const repo = '/repos/fixture/project-101', pull = /\/(?:pulls|issues)\/(\d+)/.exec(path)?.[1], n = pull || '7';
    if (path === '/app') return send({ id: 123, slug: 'fixture-app' });
    if (path === repo + '/installation') return send({ id: 55, account: { id: 10 }, permissions: { contents: 'read', issues: 'write', pull_requests: 'write', metadata: 'read' } });
    if (path === '/app/installations/55/access_tokens') return send({ token: 'ghs_fixture', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: 'read', issues: 'write', pull_requests: 'write' } }, 201);
    if (path === '/users/fixture-app[bot]') return send({ id: 999, login: 'fixture-app[bot]' });
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main' });
    if (path === repo + '/pulls/' + n) return send({ id: 7000 + Number(n), number: Number(n), state: 'open', draft: false, title: 'Change', body: 'Please review.', user: { id: 800, login: 'contributor' },
      head: { sha: head, ref: 'feature', repo: { id: 101 } }, base: { ref: 'main', sha: base }, labels: [] });
    if (path === repo + '/git/ref/heads/main') return send({ object: { sha: base } });
    if (/\/git\/commits\/[a-f0-9]{40}$/.test(path)) return send({ sha: path.slice(-40), tree: { sha: tree } });
    if (path === repo + '/git/trees/' + tree) return send({ sha: tree, tree: [], truncated: false });
    if (path === repo + `/pulls/${n}/files`) return send([{ filename: 'a.js', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }]);
    if (path === repo + `/pulls/${n}/reviews`) { if (method === 'POST') { reviews.push(JSON.parse(raw)); return send({ id: 1, user: { id: 999 } }); } return send([]); }
    if (path === repo + `/pulls/${n}/reviews/1/comments`) return send([]);
    if (path === repo + `/issues/${n}/comments`) { if (method === 'POST') { comments.push(JSON.parse(raw)); return send({ id: 2, user: { id: 999 }, html_url: 'https://github.invalid/c/2' }, 201); } return send([]); }
    if (path === repo + '/labels') return send([]);
    if (path === repo + `/issues/${n}/labels`) return send(method === 'POST' ? JSON.parse(raw).labels.map(name => ({ name })) : []);
    return send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const review = { summary: 'Reviewed.', requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '',
    findings: [{ body: 'Check this line.', format: 'inline', actionable: true, within_goal: true, requires_human_decision: false, selection_reason: 'On the change', path: 'a.js', line: 1, side: 'RIGHT' }] };
  const manager = { call: async (_method, path, body) => {
    if (path.endsWith('/parallel')) return { parallel: body.tasks };
    if (!path.endsWith('/execute')) return { repository_id: '101', state, generation: 1, desired: 'ready', revision: 1, computer: {} };
    if (body.request.type === 'workspace_snapshot') return { ok: true, result: { tree_sha: body.request.tree_sha } };
    if (body.request.type === 'workspace_agent_poll') return { ok: true, result: { state: 'completed', result: review } };
    return { ok: true, result: {} };
  } };
  let engine, state = 'ready';
  const h = await harness(t, manager, store => ({ engine: engine = new TaskEngine(store, manager, 'http://127.0.0.1:' + server.address().port) }));
  t.after(() => engine.close());
  const { admin } = await setup(h), privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const a = await account(admin, { type: 'github_app', app_id: '123', private_key: privateKey, token: undefined }); await repository(admin, a.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: 'fixture-model-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, model_id: model.id });
  return { h, engine, requests, reviews, comments, computer: value => { state = value; }, run: async (number = 7) => {
    h.store.transaction(() => enqueue(h.store, '101', 'review.pr', number, head, { number }));
    const task = h.store.get("SELECT * FROM tasks WHERE kind='review.pr' AND object_number=?", number);
    requests.length = 0; engine.tick(); await engine.active.get(task.id);
    return h.store.get('SELECT * FROM tasks WHERE id=?', task.id);
  } };
}
const tally = requests => requests.reduce((counts, { request }) => ({ ...counts, [request]: (counts[request] || 0) + 1 }), {});

// Measured on the review above: 31 requests (28 with the installation token) before these limits were set. The git mirror
// that production uses replaces the three commit and tree reads.
test('a PR review stays within its GitHub request budget, and a second one skips the bot identity lookups', async t => {
  const f = await reviewFixture(t), budget = (requests, total, installation) => {
    const used = { total: requests.length, installation: requests.filter(r => r.credential === 'installation').length };
    assert.ok(used.total <= total && used.installation <= installation, JSON.stringify({ used, by_request: tally(requests) }));
  };
  let task = await f.run(7);
  assert.equal(task.status, 'succeeded', task.error_code); assert.equal(f.reviews.length, 1); assert.equal(f.comments.length, 1);
  budget(f.requests, 23, 20);
  // The PR is read once to prepare, once when the agent is done and once before each write (review, comment, labels).
  assert.equal(tally(f.requests)['GET /repos/fixture/project-101/pulls/7'], 7);
  task = await f.run(8); assert.equal(task.status, 'succeeded', task.error_code);
  budget(f.requests, 21, 19);
  assert.deepEqual(['GET /app', 'GET /users/fixture-app[bot]'].map(request => tally(f.requests)[request] || 0), [0, 0]);
});

test('a review waiting for its project computer asks GitHub for nothing', async t => {
  const f = await reviewFixture(t); f.computer('failed');
  const task = await f.run(7);
  assert.deepEqual([task.status, task.error_code, f.requests.length], ['waiting_environment', 'environment_not_ready', 0]);
});
