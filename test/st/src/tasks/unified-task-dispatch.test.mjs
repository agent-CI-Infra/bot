// #1122: Retire src/work/* work types, unify generic task engine (task.request + target + deterministic deliveries),
// single-object persistent Manager thread (dispatch_threads), direct worker dispatch (reviewer / test / dev),
// two-layer model resolution (project default + per-role), and historical task read-only compatibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, setup, account, repository, testPassword } from '../../../fixtures/helpers.mjs';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { requestAnalysis } from '../../../../dist/actions/analysis.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { configureDispatch, Dispatcher, ruleDecider } from '../../../../dist/dispatch/worker.js';
import { managerDecision } from '../../../../dist/dispatch/manager.js';
import { queueWebhook } from '../../../../dist/review/queue.js';
import { nativeRoles } from '../../../fixtures/native-roles.mjs';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';

const gitObjHash = (type, data) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');

function createGitHubFixture(t) {
  const blobs = new Map(), trees = new Map(), commits = new Map();
  const putBlob = content => {
    const bytes = Buffer.from(content), sha = gitObjHash('blob', bytes);
    blobs.set(sha, bytes);
    return sha;
  };
  const putCommit = (filesMap, parent = null, message = 'commit') => {
    const entries = Object.entries(filesMap).map(([path, content]) => ({
      path,
      name: path,
      mode: '100644',
      type: 'blob',
      sha: putBlob(content),
      size: Buffer.byteLength(content),
    }));
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const treeBuf = Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
    const treeSha = gitObjHash('tree', treeBuf);
    trees.set(treeSha, entries);
    const sha = gitObjHash('commit', Buffer.from(JSON.stringify({ treeSha, parent, message })));
    commits.set(sha, { sha, tree: { sha: treeSha }, parents: parent ? [{ sha: parent }] : [] });
    return sha;
  };

  const baseSha = putCommit({
    'calc.mjs': 'export const add = (a, b) => a + b;\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  }, null, 'initial');
  const prHead1 = putCommit({
    'calc.mjs': 'export const add = (a, b) => a - b;\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  }, baseSha, 'pr head 1');
  const prHead2 = putCommit({
    'calc.mjs': 'export const add = (a, b) => a + b; // fixed\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  }, prHead1, 'pr head 2');

  const state = {
    baseSha,
    prHead1,
    prHead2,
    refs: { main: baseSha, 'feat/calc': prHead1 },
    prFiles: [{ filename: 'calc.mjs', status: 'modified', patch: '@@ -1 +1 @@\n-export const add = (a, b) => a + b;\n+export const add = (a, b) => a - b;' }],
    pulls: new Map([
      [123, {
        id: 5123,
        number: 123,
        title: 'Adjust calc arithmetic',
        body: 'Updates add implementation.',
        state: 'open',
        draft: false,
        user: { id: 800, login: 'contributor' },
        head: { sha: prHead1, ref: 'feat/calc', repo: { id: 101 } },
        base: { sha: baseSha, ref: 'main', repo: { id: 101 } },
        labels: [],
        html_url: 'https://github.invalid/101/pull/123',
      }],
    ]),
    issues: new Map([
      [42, {
        id: 1042,
        number: 42,
        title: 'Add multiply helper',
        body: 'Please add multiply(a, b).',
        state: 'open',
        user: { id: 800, login: 'contributor' },
        assignees: [],
        labels: [{ name: 'bot-develop' }],
        html_url: 'https://github.invalid/101/issues/42',
      }],
    ]),
    comments: new Map(),
    reviews: new Map(),
    reviewComments: new Map(),
    writes: [],
    commentEdits: [],
    resolvedThreads: [],
    availableLabels: ['bug', 'enhancement', 'bot-reviewed', 'bot-develop', 'bot-developing'],
  };

  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://github.fixture');
    const method = req.method;
    const body = raw ? JSON.parse(raw) : {};
    const send = (val, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(val));
    };

    const path = decodeURIComponent(url.pathname);
    if (method !== 'GET' && !path.endsWith('/access_tokens') && path !== '/installation/token') {
      state.writes.push({ method, path, body });
    }

    if (path === '/graphql' && method === 'POST') {
      const query = String(body.query || '');
      if (query.includes('reviewThreads')) {
        const inlineList = state.reviewComments.get(body.variables?.number) || [];
        return send({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: inlineList.map(c => ({
                    id: `PRRT_${c.id}`,
                    isResolved: state.resolvedThreads.includes(`PRRT_${c.id}`),
                    comments: { nodes: [{ databaseId: c.id }] },
                  })),
                },
              },
            },
          },
        });
      }
      if (query.includes('resolveReviewThread')) {
        state.resolvedThreads.push(body.variables.threadId);
        return send({ data: { resolveReviewThread: { thread: { id: body.variables.threadId, isResolved: true } } } });
      }
      return send({ data: {} });
    }

    if (path === '/app') return send({ id: 77, slug: 'dept-bot', name: 'dept-bot' });
    if (path === '/user' || path === '/users/dept-bot[bot]') return send({ id: 999, login: 'dept-bot[bot]' });
    if (path === '/repos/fixture/project-101/installation') {
      return send({
        id: 55,
        account: { id: 10, login: 'fixture' },
        permissions: { contents: 'write', issues: 'write', pull_requests: 'write', actions: 'write', checks: 'read', statuses: 'read', metadata: 'read' },
      });
    }
    if (path === '/app/installations/55/access_tokens') {
      state.tokenRequests = state.tokenRequests || [];
      state.tokenRequests.push(body.permissions || {});
      const tok = 'ghs_fixture_' + state.tokenRequests.length;
      state.tokenPerms = state.tokenPerms || new Map();
      state.tokenPerms.set(tok, body.permissions || {});
      return send({ token: tok, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions }, 201);
    }
    if (path === '/installation/token' && method === 'DELETE') {
      res.writeHead(204);
      return res.end();
    }
    if (path === '/repositories/101' || path === '/repos/fixture/project-101') {
      return send({ id: 101, full_name: 'fixture/project-101', owner: { id: 10, login: 'fixture' }, default_branch: 'main' });
    }

    const prefix = '/repos/fixture/project-101';
    if (!path.startsWith(prefix)) return send({ message: 'Not Found' }, 404);
    const sub = path.slice(prefix.length);
    const page = Number(url.searchParams.get('page') || 1);

    let m;
    if (sub === '/labels' && method === 'GET') return send(page === 1 ? state.availableLabels.map(name => ({ name })) : []);
    if ((m = /^\/pulls\/(\d+)$/.exec(sub)) && method === 'GET') {
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const perms = state.tokenPerms?.get(auth);
      if (perms && !perms.pull_requests) {
        return send({ message: 'Resource not accessible by integration' }, 403);
      }
      const pr = state.pulls.get(Number(m[1]));
      return send(pr || { message: 'Not Found' }, pr ? 200 : 404);
    }
    if ((m = /^\/pulls\/(\d+)\/files$/.exec(sub)) && method === 'GET') {
      return send(page === 1 ? state.prFiles : []);
    }
    if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(sub))) {
      const num = Number(m[1]), list = state.reviews.get(num) || [];
      if (method === 'GET') return send(page === 1 ? list : []);
      const reviewId = 300 + list.length + 1;
      const created = { id: reviewId, state: body.event || 'COMMENTED', body: body.body || '', commit_id: body.commit_id, user: { id: 999, login: 'dept-bot[bot]' }, html_url: `https://github.invalid/review/${reviewId}`, comments: body.comments || [] };
      list.push(created);
      state.reviews.set(num, list);
      const inlines = state.reviewComments.get(num) || [];
      for (const [idx, c] of (body.comments || []).entries()) {
        inlines.push({
          id: reviewId * 100 + idx + 1,
          path: c.path,
          line: c.line,
          side: c.side || 'RIGHT',
          body: c.body,
          commit_id: body.commit_id,
          original_commit_id: body.commit_id,
          user: { id: 999, login: 'dept-bot[bot]' },
          html_url: `https://github.invalid/inline/${reviewId * 100 + idx + 1}`,
        });
      }
      state.reviewComments.set(num, inlines);
      return send(created, 200);
    }
    if ((m = /^\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/.exec(sub)) && method === 'GET') {
      const num = Number(m[1]), rId = Number(m[2]);
      const inlines = (state.reviewComments.get(num) || []).filter(c => Math.floor(c.id / 100) === rId);
      return send(page === 1 ? inlines : []);
    }
    if ((m = /^\/pulls\/(\d+)\/comments$/.exec(sub)) && method === 'GET') {
      return send(page === 1 ? (state.reviewComments.get(Number(m[1])) || []) : []);
    }
    if ((m = /^\/issues\/(\d+)$/.exec(sub)) && method === 'GET') {
      const num = Number(m[1]);
      const obj = state.issues.get(num) || state.pulls.get(num);
      return send(obj || { message: 'Not Found' }, obj ? 200 : 404);
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(sub))) {
      const num = Number(m[1]), list = state.comments.get(num) || [];
      if (method === 'GET') return send(page === 1 ? list : []);
      const comment = { id: 700 + list.length + 1, body: body.body, user: { id: 999, login: 'dept-bot[bot]' }, html_url: `https://github.invalid/comment/${700 + list.length + 1}` };
      list.push(comment);
      state.comments.set(num, list);
      return send(comment, 201);
    }
    if ((m = /^\/issues\/comments\/(\d+)$/.exec(sub)) && method === 'PATCH') {
      const id = Number(m[1]);
      const comment = [...state.comments.values()].flat().find(c => c.id === id);
      if (!comment) return send({ message: 'Not Found' }, 404);
      comment.body = body.body;
      state.commentEdits.push({ id, body: body.body });
      return send(comment, 200);
    }
    if ((m = /^\/issues\/(\d+)\/labels$/.exec(sub)) && method === 'POST') {
      const num = Number(m[1]);
      const obj = state.pulls.get(num) || state.issues.get(num);
      const existing = (obj?.labels || []).map(l => typeof l === 'string' ? l : l.name);
      for (const name of body.labels || []) if (!existing.includes(name)) existing.push(name);
      if (obj) obj.labels = existing.map(name => ({ name }));
      return send((obj?.labels) || [], 200);
    }
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(sub)) && method === 'GET') {
      const sha = state.refs[m[1]];
      return sha ? send({ ref: `refs/heads/${m[1]}`, object: { sha } }) : send({ message: 'Not Found' }, 404);
    }
    if ((m = /^\/git\/commits\/(.+)$/.exec(sub)) && method === 'GET') {
      const c = commits.get(m[1]);
      return send(c || { message: 'Not Found' }, c ? 200 : 404);
    }
    if ((m = /^\/git\/trees\/(.+)$/.exec(sub)) && method === 'GET') {
      const tree = trees.get(m[1]);
      return send(tree ? { sha: m[1], tree, truncated: false } : { message: 'Not Found' }, tree ? 200 : 404);
    }
    if ((m = /^\/git\/blobs\/(.+)$/.exec(sub)) && method === 'GET') {
      const b = blobs.get(m[1]);
      return send(b ? { sha: m[1], size: b.length, encoding: 'base64', content: b.toString('base64') } : { message: 'Not Found' }, b ? 200 : 404);
    }
    if (sub.startsWith('/compare/') && method === 'GET') {
      return send({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [], files: [{ filename: 'calc.mjs', status: 'modified', additions: 1, deletions: 1 }] });
    }
    return send({ message: 'Unhandled ' + method + ' ' + path }, 404);
  });

  return { server, state, privateKey, putCommit };
}

const toolCall = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

test('#1122 GitHub PR webhook & Feishu review/test requests run unified task.request directly on reviewer/test, enforce diff precheck, edit summary in place, and resolve fixed threads', { timeout: 180000 }, async t => {
  configureDispatch(null);
  t.after(() => configureDispatch(ruleDecider));

  const root = mkdtempSync(join(tmpdir(), 'bot-1122-'));
  const computer = new LocalManager('101', root);
  const ghFixture = createGitHubFixture(t);
  ghFixture.server.listen(0, '127.0.0.1');
  await once(ghFixture.server, 'listening');
  const ghUrl = `http://127.0.0.1:${ghFixture.server.address().port}`;

  let outOfDiffAttempted = false;
  let writesWhenOutOfDiffRejected = -1;
  const modelCalls = [];

  const modelServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const messages = body.messages;
    const tools = (body.tools || []).map(x => x.function.name);
    const called = messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(c => c.function.name);
    const toolOutputs = messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });
    modelCalls.push({ system: String(messages[0]?.content || '').slice(0, 120), tools });

    let reply;
    if (tools.includes('submit_acceptance')) {
      reply = toolCall('submit_acceptance', {
        pass: true,
        issues: [],
      });
    } else if (tools.includes('post_review')) {
      const userPrompt = JSON.parse(messages[1].content);
      const isRound2 = Boolean(userPrompt.continuation);
      if (!called.includes('read_file')) {
        reply = toolCall('read_file', { path: '../context/files.json' });
      } else if (!isRound2 && !outOfDiffAttempted) {
        outOfDiffAttempted = true;
        reply = toolCall('post_review', {
          target: { type: 'pr', number: 123 },
          summary: 'Checked PR #123.',
          findings: [{
            body: 'Out-of-diff inline anchor test.',
            format: 'inline',
            path: 'calc.mjs',
            line: 999,
            side: 'RIGHT',
            selection_reason: 'Test out-of-diff rejection',
            actionable: true,
            within_goal: true,
            requires_human_decision: false,
          }],
        });
      } else if (!isRound2) {
        writesWhenOutOfDiffRejected = ghFixture.state.writes.length;
        const errFeedback = toolOutputs.at(-1);
        assert.equal(errFeedback?.error, 'invalid_submission');
        assert.match(JSON.stringify(errFeedback), /review_inline_out_of_diff|inline_line_not_in_diff/, 'out-of-diff inline line must be rejected locally before any GitHub request');
        reply = toolCall('post_review', {
          target: { type: 'pr', number: 123 },
          summary: 'add() subtracts instead of adding on line 1.',
          labels: ['bug'],
          findings: [{
            body: 'calc.mjs subtracts b from a instead of adding.',
            format: 'inline',
            path: 'calc.mjs',
            line: 1,
            side: 'RIGHT',
            selection_reason: 'Directly on changed line 1',
            actionable: true,
            within_goal: true,
            requires_human_decision: false,
          }],
        });
      } else if (!called.includes('read_file_r2')) {
        // Round 2: read inline comments to find the bot's earlier comment id and resolve it!
        const existingInlines = ghFixture.state.reviewComments.get(123) || [];
        reply = toolCall('post_review', {
          target: { type: 'pr', number: 123 },
          summary: 'Follow-up commit fixed add(a, b); all checks pass.',
          findings: [],
          resolved_comments: existingInlines.map(c => c.id),
        });
      }
    } else if (tools.includes('create_task')) {
      assert.equal(JSON.parse(messages[1].content).event.type, 'actions.run_failed');
      reply = toolCall('create_task', { role: 'test', writes: ['github'], reason: 'Investigate the CI failure.' });
    } else if (tools.includes('submit_report') && tools.includes('github_write')) {
      const prompt = JSON.parse(messages[1].content);
      assert.match(prompt.actions_failure_guidance, /search open Issues/);
      assert.match(prompt.actions_failure_guidance, /\.github\/ISSUE_TEMPLATE\//);
      assert.match(prompt.actions_failure_guidance, /a useful short report can include/);
      assert.ok(!tools.includes('report_failure'));
      if (!called.includes('read_file')) {
        reply = toolCall('read_file', { path: '../context/run.json' });
      } else {
        assert.match(JSON.stringify(toolOutputs.at(-1)), /assertion failed/);
        reply = toolCall('submit_report', { summary: 'Read the failed attempt and its assertion output.', artifacts: [] });
      }
    } else if (tools.includes('submit_report')) {
      if (!called.includes('run_command')) {
        reply = toolCall('run_command', { command: 'node --test' });
      } else {
        const cmdOut = toolOutputs.at(-1);
        reply = toolCall('submit_report', {
          summary: `Ran node --test on PR #123 head: exit_code=${cmdOut.exit_code}. Failure localized to calc.mjs:1.`,
          artifacts: ['calc.mjs'],
          evidence: [{ source: 'node --test', observation: String(cmdOut.stdout || cmdOut.stderr || 'exit ' + cmdOut.exit_code).slice(0, 300) }],
        });
      }
    } else {
      throw new Error('Unexpected model request with tools: ' + tools.join(','));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: reply }], usage: { prompt_tokens: 30, completion_tokens: 15 } }));
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');

  const h = await harness(undefined, computer);
  const engine = new TaskEngine(h.store, computer, ghUrl);
  const dispatcher = new Dispatcher(h.store);
  t.after(async () => {
    await dispatcher.close();
    await engine.close();
    await computer.recover();
    await h.stop();
    await new Promise(r => { modelServer.close(r); modelServer.closeAllConnections(); });
    await new Promise(r => { ghFixture.server.close(r); ghFixture.server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  });

  const { admin } = await setup(h);
  const appAcct = (await admin('/api/accounts', 'POST', {
    name: 'dept-app',
    type: 'github_app',
    app_id: '77',
    private_key: ghFixture.privateKey,
    webhook_secret: 'hook-secret',
  })).value.account;
  h.store.run(
    "INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at) VALUES(?,?,?,?,?,0,1,?)",
    appAcct.id, '101', 'fixture/project-101', '10', 'fixture', new Date().toISOString(),
  );
  const model = (await admin('/api/models', 'POST', {
    repository_id: null,
    model_name: 'unified-fixture-model',
    api_url: `http://127.0.0.1:${modelServer.address().port}/v1`,
    api_key: testPassword(),
  })).value.model;
  await admin('/api/installations/101/activate', 'POST', { model_id: model.id, capability_ceiling: 'develop' });
  nativeRoles(h.store, '101');

  const runTaskToCompletion = async taskId => {
    h.store.run("UPDATE tasks SET status='running',claim_token='claim-1122',next_run_at=0 WHERE id=?", taskId);
    h.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim-1122','now')", taskId);
    authorizeKnowledgeTask(h.store, taskId);
    await engine.run(taskId, 'claim-1122');
    h.store.run('DELETE FROM task_claims WHERE task_id=?', taskId);
    return h.store.get('SELECT * FROM tasks WHERE id=?', taskId);
  };

  // 1) GitHub PR #123 opened -> standing rule dispatches generic `task.request` directly to `reviewer` (0 Manager model calls!)
  queueWebhook(h.store, '101', 'pull_request', {
    action: 'opened',
    sender: { id: 800, login: 'contributor', type: 'User' },
    pull_request: ghFixture.state.pulls.get(123),
  }, 'pr-open-123');
  dispatcher.tick();
  await dispatcher.idle();

  assert.equal(modelCalls.length, 0, 'standing rule dispatches routine PR review with 0 Manager model calls');
  const prReviewTask = h.store.get("SELECT * FROM tasks WHERE repository_id='101' ORDER BY created_at DESC LIMIT 1");
  assert.equal(prReviewTask.kind, 'task.request');
  const prReviewInput = JSON.parse(prReviewTask.input);
  assert.equal(prReviewInput.executor_role, 'reviewer');
  assert.deepEqual(prReviewInput.target, { type: 'pr', number: 123, ref: ghFixture.state.prHead1 });

  const finishedRound1 = await runTaskToCompletion(prReviewTask.id);
  assert.ok(['succeeded', 'completed'].includes(finishedRound1.status), finishedRound1.error_code || finishedRound1.status);
  assert.equal(writesWhenOutOfDiffRejected, 0, '0 GitHub writes occurred when out-of-diff inline line 999 was rejected');

  const round1Roles = h.store.all("SELECT role FROM task_runs WHERE task_id=? AND role IS NOT NULL ORDER BY rowid", prReviewTask.id).map(r => r.role);
  assert.deepEqual(round1Roles, ['reviewer', 'qa'], 'PR review executes directly as reviewer -> qa without dev wrapper or double Manager nomination');
  assert.equal((ghFixture.state.comments.get(123) || []).length, 1, 'one summary comment created on PR #123');
  assert.equal((ghFixture.state.reviews.get(123) || []).length, 1, 'one inline COMMENT review created on PR #123');
  assert.ok((ghFixture.state.pulls.get(123).labels || []).some(l => l.name === 'bot-reviewed'));
  assert.ok((ghFixture.state.pulls.get(123).labels || []).some(l => l.name === 'bug'));

  const firstSummaryCommentId = ghFixture.state.comments.get(123)[0].id;

  // 2) Push new commit (pull_request.synchronize) -> continues SAME review task (Round 2), edits SAME summary comment in-place & resolves fixed inline thread!
  ghFixture.state.pulls.get(123).head.sha = ghFixture.state.prHead2;
  ghFixture.state.prFiles = [{ filename: 'calc.mjs', status: 'modified', patch: '@@ -1 +1 @@\n-export const add = (a, b) => a + b;\n+export const add = (a, b) => a + b; // fixed' }];
  queueWebhook(h.store, '101', 'pull_request', {
    action: 'synchronize',
    sender: { id: 800, login: 'contributor', type: 'User' },
    pull_request: ghFixture.state.pulls.get(123),
  }, 'pr-sync-123');
  dispatcher.tick();
  await dispatcher.idle();

  const round2Queued = h.store.get('SELECT * FROM tasks WHERE id=?', prReviewTask.id);
  assert.equal(round2Queued.status, 'queued', 'finished generic review reopens for Round 2');
  assert.equal(JSON.parse(round2Queued.input).round, 2);

  const finishedRound2 = await runTaskToCompletion(prReviewTask.id);
  assert.ok(['succeeded', 'completed'].includes(finishedRound2.status), finishedRound2.error_code || finishedRound2.status);
  assert.equal(finishedRound2.head_sha, ghFixture.state.prHead2, 'Round 2 checked out new PR head');
  assert.equal((ghFixture.state.comments.get(123) || []).length, 1, 'still exactly 1 summary comment (no duplicate comment posted)');
  assert.equal(ghFixture.state.commentEdits.length, 1, 'summary comment edited in place via PATCH');
  assert.equal(ghFixture.state.commentEdits[0].id, firstSummaryCommentId);
  assert.equal(ghFixture.state.resolvedThreads.length, 1, 'fixed inline review thread automatically resolved');

  // 3) Feishu/API: "正式检视一下 PR #123" & "拉一下 PR #123 的分支跑测试看看哪挂了"
  ghFixture.state.pulls.get(123).head.sha = ghFixture.state.prHead1;
  const feishuReviewRes = await admin('/api/tasks', 'POST', {
    repository_id: '101',
    request: '正式检视一下 PR #123',
    contract: { goal: '正式检视一下 PR #123', scope: ['PR #123'], criteria: ['发布检视结论'], endpoint: 'review' },
    intent: 'review',
    target: { type: 'pr', number: 123 },
    writes: ['review'],
  });
  assert.equal(feishuReviewRes.status, 201, JSON.stringify(feishuReviewRes.value));
  const feishuReviewRow = h.store.get('SELECT * FROM tasks WHERE id=?', feishuReviewRes.value.id);
  assert.equal(feishuReviewRow.kind, 'task.request');
  assert.equal(JSON.parse(feishuReviewRow.input).executor_role, 'reviewer');

  const feishuTestRes = await admin('/api/tasks', 'POST', {
    repository_id: '101',
    request: '拉一下 PR #123 的分支跑测试看看哪挂了',
    contract: { goal: '拉一下 PR #123 的分支跑测试看看哪挂了', scope: ['PR #123'], criteria: ['跑测试并定位失败原因'], endpoint: 'report' },
    intent: 'test',
    target: { type: 'pr', number: 123 },
  });
  assert.equal(feishuTestRes.status, 201, JSON.stringify(feishuTestRes.value));
  const feishuTestDone = await runTaskToCompletion(feishuTestRes.value.id);
  assert.equal(feishuTestDone.status, 'completed', feishuTestDone.error_code || '');
  assert.equal(feishuTestDone.head_sha, ghFixture.state.prHead1, 'test role checked out PR #123 head');
  const testRoles = h.store.all("SELECT role FROM task_runs WHERE task_id=? AND role IS NOT NULL ORDER BY rowid", feishuTestRes.value.id).map(r => r.role);
  assert.deepEqual(testRoles, ['test'], 'read-only PR test diagnosis runs in 1 hop as role=test with 0 redundant QA');
  assert.match(JSON.parse(feishuTestDone.result).summary, /Failure localized to calc\.mjs:1/);

  // A default-branch Actions event reaches the same task executor with failure-specific guidance and context.
  await admin('/api/repositories/101/policy', 'PATCH', { actions_failures_enabled: true });
  requestAnalysis(h.store, { repository: { id: '101' }, fullName: 'fixture/project-101', redactor: new Redactor() },
    { id: 801, run_attempt: 1, name: 'CI', event: 'push', head_branch: 'main', head_sha: ghFixture.state.baseSha },
    [{ job: { id: 91, name: 'check' }, output: { lines: ['assertion failed'] } }], null);
  dispatcher.tick();
  await dispatcher.idle();
  const actionTask = h.store.get("SELECT t.* FROM tasks t JOIN task_events l ON l.task_id=t.id JOIN dispatch_events e ON e.id=l.event_id WHERE e.type='actions.run_failed'");
  assert.equal(actionTask.kind, 'task.request');
  const actionDone = await runTaskToCompletion(actionTask.id);
  assert.equal(actionDone.status, 'completed', JSON.stringify(h.store.all('SELECT content FROM task_logs WHERE task_id=?', actionTask.id)));
  assert.equal(actionDone.head_sha, ghFixture.state.baseSha);
  assert.match(JSON.parse(actionDone.result).summary, /failed attempt/);

});

test('#1122 persistent Object Manager thread links follow-up PR comments & Issue-linked bot PRs, and retired endpoints/historical tasks stay clean', async t => {
  configureDispatch(null);
  t.after(() => configureDispatch(ruleDecider));

  const seenContexts = [];
  const managerServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const ctx = JSON.parse(body.messages[1].content);
    seenContexts.push(ctx);
    const call = {
      id: 'call-' + seenContexts.length,
      type: 'function',
      function: {
        name: 'create_task',
        arguments: JSON.stringify({
          role: seenContexts.length === 1 ? 'reviewer' : 'dev',
          writes: seenContexts.length === 1 ? ['review'] : ['github'],
          reason: seenContexts.length === 1 ? 'Review PR discussion request.' : 'Follow up in same object thread.',
        }),
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });
  managerServer.listen(0, '127.0.0.1');
  await once(managerServer, 'listening');
  t.after(() => new Promise(r => { managerServer.close(r); managerServer.closeAllConnections(); }));

  let engine2;
  const h = await harness(t, undefined, store => ({ engine: (engine2 = new TaskEngine(store)) }));
  t.after(() => engine2.close());
  const { admin } = await setup(h);
  const a = await account(admin);
  await repository(admin, a.id, '101');
  const m = (await admin('/api/models', 'POST', {
    repository_id: '101',
    model_name: 'mgr-model',
    api_url: `http://127.0.0.1:${managerServer.address().port}/v1`,
    api_key: testPassword(),
  })).value.model;
  const policyRes = await admin('/api/repositories/101/policy', 'PATCH', { model_id: m.id, capability_ceiling: 'develop' });
  assert.equal(policyRes.status, 200, JSON.stringify(policyRes.value));
  nativeRoles(h.store, '101');
  const mgrInit = (await admin('/api/repositories/101/manager')).value.manager;
  await admin('/api/repositories/101/manager', 'PUT', {
    expected_revision: mgrInit.prompt.revision,
    events: { 'pull_request.opened': true, 'pull_request.mention': true, 'issue.opened': true, 'issue.mention': true },
    standing_rules: [],
  });

  const dispatcher = new Dispatcher(h.store, (s, context) => managerDecision(s, context));
  t.after(() => dispatcher.close());

  const pr50 = { number: 50, state: 'open', draft: false, title: 'PR 50', head: { sha: 'a'.repeat(40), ref: 'feat-50' }, base: { ref: 'main' } };
  // Event 1 on PR #50: @bot mention
  queueWebhook(h.store, '101', 'issue_comment', {
    action: 'created',
    sender: { id: 5, login: 'alice', type: 'User' },
    issue: { number: 50, state: 'open', title: 'PR 50', pull_request: {} },
    comment: { id: 901, body: '@bot please review this PR', author_association: 'MEMBER', user: { id: 5, login: 'alice', type: 'User' } },
  }, 'pr50-m1', pr50);
  dispatcher.tick();
  await dispatcher.idle();

  // Event 2 on PR #50: follow-up @bot mention continues the SAME persistent object thread (`101:pr:50`)
  queueWebhook(h.store, '101', 'issue_comment', {
    action: 'created',
    sender: { id: 5, login: 'alice', type: 'User' },
    issue: { number: 50, state: 'open', title: 'PR 50', pull_request: {} },
    comment: { id: 902, body: '@bot also summarize the migration risk', author_association: 'MEMBER', user: { id: 5, login: 'alice', type: 'User' } },
  }, 'pr50-m2', pr50);
  dispatcher.tick();
  await dispatcher.idle();

  assert.equal(seenContexts.length, 2);
  assert.equal(seenContexts[0].object_thread.thread_key, '101:pr:50');
  assert.equal(seenContexts[1].object_thread.thread_key, '101:pr:50');
  assert.equal(seenContexts[1].object_thread.turns.length, 1, 'second event receives first turn in persistent object_thread');
  assert.match(seenContexts[1].object_thread.turns[0].reason, /Review PR discussion request/);

  // Root Issue <-> bot PR thread continuity: bot PR #88 opened for Issue #42 resolves to thread `101:issue:42`!
  const pr88 = { number: 88, state: 'open', draft: false, title: 'Bot PR for #42', head: { sha: 'b'.repeat(40), ref: 'bot/issue-42' }, base: { ref: 'main' } };
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('src-issue-42','101','task.request','pr_opened','Dev #42',?,42)", JSON.stringify({ target: { type: 'issue', number: 42 } }));
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',88,'8800','999','101','bot/issue-42','a1b2c3d4','src-issue-42',0)");
  queueWebhook(h.store, '101', 'issue_comment', {
    action: 'created',
    sender: { id: 5, login: 'alice', type: 'User' },
    issue: { number: 88, state: 'open', title: 'Bot PR for #42', pull_request: {} },
    comment: { id: 903, body: '@bot please rename the helper on this PR', author_association: 'MEMBER', user: { id: 5, login: 'alice', type: 'User' } },
  }, 'pr88-m1', pr88);
  dispatcher.tick();
  await dispatcher.idle();
  assert.equal(seenContexts[2].object_thread.thread_key, '101:issue:42', 'bot PR shares persistent Manager thread with its source Issue');

  // Unified configuration API surface & retired endpoints
  const mgrApi = (await admin('/api/repositories/101/manager')).value.manager;
  assert.equal(mgrApi.work, undefined, '/api/repositories/:id/manager no longer exposes work switches');
  assert.equal(mgrApi.sections, undefined, '/api/repositories/:id/manager no longer exposes 11 sections');
  assert.ok(Array.isArray(mgrApi.standing_rules.rules));

  const rolesApi = (await admin('/api/repositories/101/roles')).value;
  assert.deepEqual(rolesApi.required_roles, ['manager', 'qa'], 'coordinator is no longer a required role');

  assert.equal((await admin('/api/automation')).status, 410);
  assert.equal((await admin('/api/automation')).value.error, 'automation_removed');

  // Historical finished tasks (`review.pr`, `development.issue`, `workflow.issue`) remain read-only compatible in board, task detail & costs
  const now = new Date().toISOString();
  h.store.run("INSERT OR REPLACE INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','pr',11,'Historical PR','open',0,?),('101','issue',12,'Historical Issue','open',0,?),('101','issue',13,'Historical Reply','open',0,?)", now, now, now);
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,object_number,created_at,updated_at) VALUES('hist-rev','101','review.pr','succeeded','done','Historical PR review',11,?,?)", now, now);
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,object_number,created_at,updated_at) VALUES('hist-dev','101','development.issue','pr_opened','done','Historical Issue dev',12,?,?)", now, now);
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,object_number,created_at,updated_at) VALUES('hist-wf','101','workflow.issue','succeeded','done','Historical reply',13,?,?)", now, now);

  for (const id of ['hist-rev', 'hist-dev', 'hist-wf']) {
    const detail = await admin(`/api/tasks/${id}`);
    assert.equal(detail.status, 200, id);
    assert.equal(detail.value.task.id, id);
  }
  const board = await admin('/api/board/cards?repository_id=101');
  assert.equal(board.status, 200);
  assert.ok(board.value.cards.some(c => c.object_number === 11 && c.card_category === 'review.pr'));
  assert.ok(board.value.cards.some(c => c.object_number === 12 && c.card_category === 'development.issue'));
  assert.ok(board.value.cards.some(c => c.object_number === 13 && c.card_category === 'reply'));

  const costs = await admin('/api/costs?timezone=UTC');
  assert.equal(costs.status, 200);
  const summaryWorkflows = costs.value.tasks.summary.map(s => s.workflow);
  assert.ok(summaryWorkflows.includes('review.pr'));
  assert.ok(summaryWorkflows.includes('development.issue'));
  assert.ok(summaryWorkflows.includes('reply'));
});

test('#1122 Issue-targeted dev revision reads existing open bot PR head under strict github_app installation token and bot_account', { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-1122-prread-'));
  const computer = new LocalManager('101', root);
  const ghFixture = createGitHubFixture(t);
  ghFixture.state.refs['bot/issue-42'] = ghFixture.state.prHead2;
  ghFixture.state.pulls.set(88, {
    id: 5088,
    number: 88,
    title: 'Implement Issue #42',
    body: 'Fixes #42',
    state: 'open',
    draft: false,
    user: { id: 999, login: 'dept-bot[bot]' },
    head: { sha: ghFixture.state.prHead2, ref: 'bot/issue-42', repo: { id: 101 } },
    base: { sha: ghFixture.state.baseSha, ref: 'main', repo: { id: 101 } },
    labels: [],
    html_url: 'https://github.invalid/101/pull/88',
  });
  ghFixture.server.listen(0, '127.0.0.1');
  await once(ghFixture.server, 'listening');
  const ghUrl = `http://127.0.0.1:${ghFixture.server.address().port}`;

  const modelServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const tools = (body.tools || []).map(x => x.function.name);
    const called = body.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(c => c.function.name);
    let reply;
    if (tools.includes('submit_acceptance')) {
      reply = toolCall('submit_acceptance', { pass: true, issues: [] });
    } else if (!called.includes('read_file')) {
      reply = toolCall('read_file', { path: 'calc.mjs' });
    } else {
      const lastTool = JSON.parse(body.messages.filter(m => m.role === 'tool').at(-1).content);
      assert.match(String(lastTool.content || ''), /\/\/ fixed/, 'workspace must check out open bot PR head, not base branch');
      reply = toolCall('submit_report', {
        summary: 'Verified existing open bot PR #88 head is checked out.',
        artifacts: [{ path: 'calc.mjs', description: 'Checked out bot PR head file' }],
        evidence: [{ source: 'calc.mjs', result: 'Contains // fixed from prHead2' }],
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: reply }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');

  const h = await harness(undefined, computer);
  const engine = new TaskEngine(h.store, computer, ghUrl);
  t.after(async () => {
    await engine.close();
    await computer.recover();
    await h.stop();
    await new Promise(r => { modelServer.close(r); modelServer.closeAllConnections(); });
    await new Promise(r => { ghFixture.server.close(r); ghFixture.server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  });

  const { admin } = await setup(h);
  const appAcct = (await admin('/api/accounts', 'POST', {
    name: 'dept-app-strict',
    type: 'github_app',
    app_id: '77',
    private_key: ghFixture.privateKey,
    webhook_secret: 'hook-secret',
  })).value.account;
  h.store.run(
    "INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at) VALUES(?,?,?,?,?,0,1,?)",
    appAcct.id, '101', 'fixture/project-101', '10', 'fixture', new Date().toISOString(),
  );
  const model = (await admin('/api/models', 'POST', {
    repository_id: null,
    model_name: 'prread-model',
    api_url: `http://127.0.0.1:${modelServer.address().port}/v1`,
    api_key: testPassword(),
  })).value.model;
  await admin('/api/installations/101/activate', 'POST', { model_id: model.id, capability_ceiling: 'develop' });
  nativeRoles(h.store, '101');

  // Seed initial Issue #42 task + open bot PR #88
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at,updated_at) VALUES('first-42','101','task.request','pr_opened','Initial #42',?,42,'2026-11-19T00:00:00Z','2026-11-19T00:00:00Z')",
    JSON.stringify({ target: { type: 'issue', number: 42 }, delivery: 'pull_request' }),
  );
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',88,'5088','999','101','bot/issue-42',?,'first-42',0)", ghFixture.state.prHead2);

  // 1) Run under strict github_app (returns 403 on GET /pulls/88 unless pull_requests:read was requested!)
  const appTaskRes = await admin('/api/tasks', 'POST', {
    repository_id: '101',
    request: 'Revise Issue #42 implementation on existing bot PR',
    contract: { goal: 'Revise Issue #42', scope: ['calc.mjs'], criteria: ['Inspect open bot PR head'], endpoint: 'reviewable_pull_request' },
    intent: 'development',
    executor_role: 'dev',
    target: { type: 'issue', number: 42 },
    writes: ['pull_request'],
  });
  assert.equal(appTaskRes.status, 201, JSON.stringify(appTaskRes.value));
  const tokensBefore = (ghFixture.state.tokenRequests || []).length;
  h.store.run("UPDATE tasks SET status='running',claim_token='claim-app',next_run_at=0 WHERE id=?", appTaskRes.value.id);
  h.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim-app','now')", appTaskRes.value.id);
  authorizeKnowledgeTask(h.store, appTaskRes.value.id);
  await engine.run(appTaskRes.value.id, 'claim-app');
  h.store.run('DELETE FROM task_claims WHERE task_id=?', appTaskRes.value.id);

  const appDone = h.store.get('SELECT * FROM tasks WHERE id=?', appTaskRes.value.id);
  assert.equal(appDone.status, 'completed', appDone.error_code || '');
  assert.equal(appDone.head_sha, ghFixture.state.prHead2, 'github_app Issue dev task checked out open bot PR head');
  assert.ok(
    (ghFixture.state.tokenRequests || []).slice(tokensBefore).some(p => p.pull_requests === 'read'),
    'github_app token mint explicitly requested pull_requests:read',
  );

  // 2) Switch repository account to bot_account and verify identical open bot PR head checkout
  const botAcct = await account(admin);
  h.store.run(
    "INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at) VALUES(?,?,?,?,?,0,1,?)",
    botAcct.id, '101', 'fixture/project-101', '10', 'fixture', new Date().toISOString(),
  );
  h.store.run('UPDATE repositories SET account_id=? WHERE id=?', botAcct.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop' });
  const patTaskRes = await admin('/api/tasks', 'POST', {
    repository_id: '101',
    request: 'Revise Issue #42 under bot_account',
    contract: { goal: 'Revise Issue #42', scope: ['calc.mjs'], criteria: ['Inspect open bot PR head'], endpoint: 'reviewable_pull_request' },
    intent: 'development',
    executor_role: 'dev',
    target: { type: 'issue', number: 42 },
    writes: ['pull_request'],
  });
  assert.equal(patTaskRes.status, 201, JSON.stringify(patTaskRes.value));
  h.store.run("UPDATE tasks SET status='running',claim_token='claim-pat',next_run_at=0 WHERE id=?", patTaskRes.value.id);
  h.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim-pat','now')", patTaskRes.value.id);
  authorizeKnowledgeTask(h.store, patTaskRes.value.id);
  await engine.run(patTaskRes.value.id, 'claim-pat');
  h.store.run('DELETE FROM task_claims WHERE task_id=?', patTaskRes.value.id);

  const patDone = h.store.get('SELECT * FROM tasks WHERE id=?', patTaskRes.value.id);
  assert.equal(patDone.status, 'completed', patDone.error_code || '');
  assert.equal(patDone.head_sha, ghFixture.state.prHead2, 'bot_account Issue dev task checked out open bot PR head');
});

test('#1122 bot PR comment continues active Issue development (blocking duplicate PR dev), recurring schedules share one thread, and migration records report & audit', async t => {
  configureDispatch(null);
  t.after(() => configureDispatch(ruleDecider));

  const { dispatchContext, genericRefusal, applyDecision } = await import('../../../../dist/dispatch/store.js');
  const { migrateRetireWorkTypes } = await import('../../../../dist/dispatch/migration.js');
  const { registerScheduledChecks } = await import('../../../../dist/dispatch/schedule.js');

  const h = await harness(t);
  const { admin } = await setup(h);
  const a = await account(admin);
  await repository(admin, a.id, '101');
  const m1 = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'm-default', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() })).value.model;
  const mPr = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'm-pr-rev', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() })).value.model;
  const mIssue = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'm-issue-rev', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() })).value.model;
  const mAct = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'm-actions-dev', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: m1.id, capability_ceiling: 'develop' });
  nativeRoles(h.store, '101');
  const mgrInit = (await admin('/api/repositories/101/manager')).value.manager;
  await admin('/api/repositories/101/manager', 'PUT', {
    expected_revision: mgrInit.prompt.revision,
    events: { 'pull_request.updated': true, 'pull_request.mention': true },
    standing_rules: [],
  });

  // 1) Active generic Issue #42 development + comment on its bot PR #88 -> continuations, related, duplicate refusal & join
  const now = new Date().toISOString();
  const createdIssueDev = await admin('/api/tasks', 'POST', {
    repository_id: '101',
    request: 'Implement Issue #42',
    contract: { goal: 'Implement Issue #42', scope: ['calc.mjs'], criteria: ['Open bot PR'], endpoint: 'reviewable_pull_request' },
    intent: 'development',
    executor_role: 'dev',
    target: { type: 'issue', number: 42 },
    writes: ['pull_request'],
  });
  assert.equal(createdIssueDev.status, 201, JSON.stringify(createdIssueDev.value));
  const activeIssueId = createdIssueDev.value.id;
  h.store.run("UPDATE tasks SET status='running' WHERE id=?", activeIssueId);
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',88,'8800','999','101','bot/issue-42',?,?,0)", 'c'.repeat(40), activeIssueId);

  const pr88 = { number: 88, state: 'open', draft: false, title: 'Bot PR #88', user: { id: 999, login: 'bot' }, head: { sha: 'c'.repeat(40), ref: 'bot/issue-42' }, base: { ref: 'main' } };
  queueWebhook(h.store, '101', 'issue_comment', {
    action: 'created',
    sender: { id: 5, login: 'alice', type: 'User' },
    issue: { number: 88, state: 'open', title: 'Bot PR #88', user: { id: 999, login: 'bot' }, pull_request: {} },
    comment: { id: 950, body: '@bot also export subtract()', author_association: 'MEMBER', user: { id: 5, login: 'alice', type: 'User' }, html_url: 'https://github.invalid/comment/950' },
  }, 'pr88-cont', pr88);

  const prEvent = h.store.get("SELECT * FROM dispatch_events WHERE repository_id='101' AND delivery_id='pr88-cont'");
  const ctx = dispatchContext(h.store, prEvent);
  assert.equal(ctx.thread.thread_key, '101:issue:42');
  assert.ok(ctx.continuations.some(c => c.id === 'continue:' + activeIssueId), 'bot PR event offers active Issue development in continuations');
  assert.ok(ctx.related.some(r => r.id === activeIssueId), 'bot PR event includes linked Issue task in related');

  const dupRefusal = genericRefusal(h.store, ctx, 'dev', ['pull_request'], { type: 'pr', number: 88 });
  assert.equal(dupRefusal?.code, 'development_active', 'creating duplicate PR dev while root Issue dev is active is refused');
  assert.equal(dupRefusal?.task_id, activeIssueId);

  const joined = applyDecision(h.store, prEvent, { decision: 'continue', option_ids: ['continue:' + activeIssueId], reason: 'Continue running Issue #42 development with PR comment.' }, null);
  assert.deepEqual(joined.continued, [activeIssueId]);
  const joinedInput = JSON.parse(h.store.get("SELECT input FROM tasks WHERE id=?", activeIssueId).input);
  assert.equal(joinedInput.merged_updates.length, 1);

  // 2) Two occurrences of one schedule share a single dispatch_threads row (`101:schedule:<schedule_id>`)
  let fakeNow = Date.parse('2026-11-20T01:00:00Z');
  let checkHandler;
  registerScheduledChecks({
    store: h.store,
    register(_name, handler) { checkHandler = handler; },
  });
  const adminActor = { principal_id: h.store.get("SELECT id FROM principals LIMIT 1")?.id || 'admin', tenant_id: '10', capabilities: new Set(['schedules.manage', 'config.write', 'tasks.write', 'tasks.read']), authorization_revision: 1 };
  for (const occ of ['occ_1', 'occ_2']) {
    checkHandler.dispatch(
      { schedule_id: 'sch_fixed_1', occurrence_id: occ, run_id: 'run_' + occ, project_id: '101', tenant_id: '10', workflow: 'manager.check', parameters: { instruction: 'Check flaky tests' }, logical_at: fakeNow, source: 'timer', authorization_revision: 1, config: {} },
      adminActor,
      () => {},
    );
    const ev = h.store.get("SELECT * FROM dispatch_events WHERE event_key=?", `101:schedule.due:${occ}`);
    applyDecision(h.store, ev, { decision: 'ignore', option_ids: [], reason: 'Checked occurrence ' + occ }, null);
    fakeNow += 3600_000;
  }
  const scheduleThreads = h.store.all("SELECT thread_key,messages FROM dispatch_threads WHERE repository_id='101' AND object_type='schedule'");
  assert.equal(scheduleThreads.length, 1, 'recurring schedule occurrences share a single dispatch_threads row');
  assert.equal(scheduleThreads[0].thread_key, '101:schedule:sch_fixed_1');
  assert.equal(JSON.parse(scheduleThreads[0].messages).length, 2, 'both occurrences appended to the shared schedule thread');

  // 3) One-time migration: preserves unmodified H1-stripped sections without duplicating, maps fallback models, and writes manager_migrations + audit
  h.store.run("DELETE FROM settings WHERE key='migration:1122:repo:101'");
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const strippedIssueReview = readFileSync(resolve('docs/prompts/issue-review.md'), 'utf8').trim().replace(/^#[ \t]+[^\n]+\n+/, '').trim();
  const legacyDoc = [
    `## 检视 Issue \`review.issue\`\n\n${strippedIssueReview}`,
    `## 检视 PR \`review.pr\`\n\nCustom PR rule: require benchmark numbers on parser changes.`,
  ].join('\n\n');
  const nextMgrRev = Number(h.store.get("SELECT coalesce(max(revision),0) AS r FROM manager_revisions WHERE repository_id='101'").r) + 1;
  h.store.run(
    "INSERT INTO manager_revisions VALUES('101',?,?,?,?,'legacy',NULL,?)",
    nextMgrRev, legacyDoc, '{"review.pr":{"enabled":false}}', '{}', now,
  );
  h.store.run(
    "UPDATE policies SET work_settings=?,task_models=? WHERE repository_id='101'",
    JSON.stringify({ 'review.pr': { enabled: false, writes: ['reply'] } }),
    JSON.stringify({ 'review.pr': mPr.id, 'review.issue': mIssue.id, 'actions.failures': mAct.id, 'custom.triage': mIssue.id }),
  );

  migrateRetireWorkTypes(h.store);

  const migRow = h.store.get("SELECT * FROM manager_migrations WHERE repository_id='101'");
  assert.ok(migRow, 'manager_migrations row recorded');
  const report = JSON.parse(migRow.report);
  const archive = JSON.parse(migRow.archive);
  assert.deepEqual(report.migrated_sections, ['review.pr'], 'unmodified H1-stripped review.issue was NOT misclassified as custom');
  assert.equal(report.mapped_models.reviewer.model_id, mPr.id);
  assert.equal(report.mapped_models.dev.model_id, mAct.id, 'actions.failures model mapped as fallback onto dev');
  assert.ok(report.model_conflicts.some(c => c.key === 'review.issue' && c.model_id === mIssue.id && c.kept_model_id === mPr.id), 'conflicting review.issue model recorded in report');
  assert.ok(report.unmapped_models.some(u => u.key === 'custom.triage' && u.reason === 'unrecognized_work_key'), 'unrecognized task_models key recorded in unmapped_models');
  assert.deepEqual(report.retired_work_settings, ['review.pr']);
  assert.equal(archive.task_models['custom.triage'], mIssue.id, 'raw task_models archived in manager_migrations');

  const auditRow = h.store.get("SELECT * FROM audit WHERE action='manager.work_types_migrated' AND repository_id='101' AND resource_id='101'");
  assert.ok(auditRow, 'audit entry written for work-type migration');
});
