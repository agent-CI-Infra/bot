// #1167: Automatic Object Manager wakeup for open bot PR check failures (`pull_request.checks_failed`) and merge
// conflicts (`pull_request.conflicted`), with no hard retry cap, full revision & human-comment facts, strict
// deduplication (collapsing multi-job check_run + check_suite + workflow_run per attempt), reachable base-advance
// detection (merged PRs + BotPrWakeScanner without requiring push/check_suite subscriptions), end-to-end
// `continue_task` consumption + carry-over, and verified 2-parent fast-forward conflict resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, setup, account, repository, testPassword } from '../../../fixtures/helpers.mjs';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { configureDispatch } from '../../../../dist/dispatch/worker.js';
import { setBotWakeRecheckDelaysForTest, carryUnconsumedTaskUpdates } from '../../../../dist/review/bot-pr-wake.js';
import { appEvents, appPermissions } from '../../../../dist/github/client.js';
import { accessGaps } from '../../../../dist/app/access.js';
import { setGrant } from '../../../../dist/tasks/grants.js';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
import { botPrGraphql } from '../../../fixtures/bot-pr-graphql.mjs';

const gitObjHash = (type, data) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');

async function createBotPrWakeFixture(t, { accountType = 'github_app', installationEvents } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map();
  const putBlob = content => {
    const bytes = Buffer.from(content), sha = gitObjHash('blob', bytes);
    blobs.set(sha, bytes);
    return sha;
  };
  const putCommit = (filesMap, parents = [], message = 'commit') => {
    const entries = Object.entries(filesMap).map(([path, content]) =>
      typeof content === 'object' && content !== null && content.type === 'commit'
        ? { path, name: path, mode: '160000', type: 'commit', sha: content.sha }
        : typeof content === 'object' && content !== null && content.type === 'blob'
          ? {
              path,
              name: path,
              mode: content.mode || '100644',
              type: 'blob',
              sha: putBlob(content.content),
              size: Buffer.byteLength(content.content),
            }
          : {
              path,
              name: path,
              mode: '100644',
              type: 'blob',
              sha: putBlob(content),
              size: Buffer.byteLength(content),
            },
    );
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const treeBuf = Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
    const treeSha = gitObjHash('tree', treeBuf);
    trees.set(treeSha, entries);
    const sha = gitObjHash('commit', Buffer.from(JSON.stringify({ treeSha, parents, message })));
    commits.set(sha, { sha, tree: { sha: treeSha }, parents: parents.map(p => ({ sha: p })), message });
    return sha;
  };

  const baseSha1 = putCommit({
    'calc.mjs': 'export const add = (a, b) => a + b;\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  }, [], 'base 1');
  const prHead1 = putCommit({
    'calc.mjs': 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, mul } from './calc.mjs';\ntest('calc', () => { assert.equal(add(2, 3), 5); assert.equal(mul(2, 3), 6); });\n",
  }, [baseSha1], 'bot pr head 1');
  const pr89Head1 = putCommit({
    'calc.mjs': 'export const add = (a, b) => a + b;\nexport const id = x => x;\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  }, [baseSha1], 'standalone pr head 1');
  const pr90Head1 = putCommit({
    'calc.mjs': 'export const add = (a, b) => a + b;\n',
    'alice.txt': 'human contribution\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  }, [baseSha1], 'human pr 90 head');
  const baseSha2 = putCommit({
    'calc.mjs': 'export const add = (a, b) => Number(a) + Number(b);\nexport const sub = (a, b) => a - b;\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, sub } from './calc.mjs';\ntest('calc', () => { assert.equal(add(2, 3), 5); assert.equal(sub(5, 3), 2); });\n",
    'main-only.mjs': 'export const version = 2;\n',
  }, [baseSha1], 'main advanced');

  const botActor = accountType === 'bot_account'
    ? { id: 777, login: 'ci-bot-user', type: 'User' }
    : { id: 999, login: 'dept-bot[bot]', type: 'Bot' };

  const subscribedEvents = installationEvents ?? [...appEvents, 'check_run', 'status'];

  const state = {
    baseSha1,
    prHead1,
    pr89Head1,
    pr90Head1,
    baseSha2,
    putCommit,
    commits,
    refs: { main: baseSha1, 'bot/issue-42': prHead1, 'bot/task-standalone': pr89Head1 },
    pulls: new Map([
      [88, {
        id: 5088,
        number: 88,
        title: 'feat: add mul helper',
        body: 'Fixes #42',
        state: 'open',
        draft: false,
        mergeable: true,
        mergeable_state: 'clean',
        user: botActor,
        head: { sha: prHead1, ref: 'bot/issue-42', repo: { id: 101 } },
        base: { sha: baseSha1, ref: 'main', repo: { id: 101 } },
        labels: [],
        html_url: 'https://github.com/fixture/project-101/pull/88',
      }],
      [89, {
        id: 5089,
        number: 89,
        title: 'chore: standalone bot cleanup',
        body: 'Standalone bot PR.',
        state: 'open',
        draft: false,
        mergeable: true,
        mergeable_state: 'clean',
        user: botActor,
        head: { sha: pr89Head1, ref: 'bot/task-standalone', repo: { id: 101 } },
        base: { sha: baseSha1, ref: 'main', repo: { id: 101 } },
        labels: [],
        html_url: 'https://github.com/fixture/project-101/pull/89',
      }],
      [90, {
        id: 5090,
        number: 90,
        title: 'feat: human contributor PR',
        body: 'Opened by human.',
        state: 'open',
        draft: false,
        mergeable: false,
        mergeable_state: 'dirty',
        user: { id: 800, login: 'alice', type: 'User' },
        head: { sha: pr90Head1, ref: 'alice/feat', repo: { id: 101 } },
        base: { sha: baseSha1, ref: 'main', repo: { id: 101 } },
        labels: [],
        html_url: 'https://github.com/fixture/project-101/pull/90',
      }],
    ]),
    issues: new Map([
      [42, {
        id: 1042,
        number: 42,
        title: 'Add mul helper',
        body: 'Please add mul(a, b).',
        state: 'open',
        user: { id: 800, login: 'alice', type: 'User' },
        assignees: [],
        labels: [{ name: 'bot-develop' }],
        html_url: 'https://github.com/fixture/project-101/issues/42',
      }],
    ]),
    comments: new Map(),
    runs: new Map(),
    runJobs: new Map(),
    commitCheckRuns: new Map(),
    commitCheckSuites: new Map(),
    reruns: [],
    createdCommits: [],
    refUpdates: [],
    writes: [],
    onPullGet: null,
    failInstallationToken: false,
    skippedBlobs: new Set(),
  };

  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

  const ghServer = createServer(async (req, res) => {
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
    // The scheduled reconcile's batched read (#1396) is a query, not a write.
    if (path === '/graphql' && method === 'POST') return send(botPrGraphql(body, { pulls: state.pulls, refs: state.refs, checkSuites: state.commitCheckSuites }));
    if (method !== 'GET' && !path.endsWith('/access_tokens') && path !== '/installation/token') {
      state.writes.push({ method, path, body });
    }

    if (path === '/app') return send({ id: 77, slug: 'dept-bot', name: 'dept-bot', permissions: appPermissions, events: subscribedEvents });
    if (path === '/user' || path === '/users/dept-bot[bot]') return send(botActor);
    if (path === '/repos/fixture/project-101/installation') {
      return send({
        id: 55,
        account: { id: 10, login: 'fixture' },
        permissions: { ...appPermissions },
        events: subscribedEvents,
      });
    }
    if (path === '/app/installations/55/access_tokens') {
      if (state.failInstallationToken) return send({ message: 'Installation suspended' }, 403);
      return send({ token: 'ghs_fixture_tok', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions }, 201);
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
    if (sub === '/labels' && method === 'GET') return send(page === 1 ? [{ name: 'bug' }, { name: 'bot-develop' }] : []);
    if ((m = /^\/pulls\/(\d+)$/.exec(sub))) {
      const num = Number(m[1]);
      if (method === 'GET') {
        state.onPullGet?.(num);
        const pr = state.pulls.get(num);
        return send(pr || { message: 'Not Found' }, pr ? 200 : 404);
      }
      if (method === 'PATCH') {
        const pr = state.pulls.get(num);
        if (!pr) return send({ message: 'Not Found' }, 404);
        Object.assign(pr, { title: body.title ?? pr.title, body: body.body ?? pr.body });
        return send(pr, 200);
      }
    }
    if ((m = /^\/pulls\/(\d+)\/(files|reviews|comments)$/.exec(sub)) && method === 'GET') {
      return send([]);
    }
    if ((m = /^\/issues\/(\d+)$/.exec(sub)) && method === 'GET') {
      const num = Number(m[1]);
      const obj = state.issues.get(num) || state.pulls.get(num);
      return send(obj || { message: 'Not Found' }, obj ? 200 : 404);
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(sub))) {
      const num = Number(m[1]), list = state.comments.get(num) || [];
      if (method === 'GET') return send(page === 1 ? list : []);
      const created = {
        id: 900 + list.length + 1,
        body: body.body,
        user: botActor,
        created_at: new Date().toISOString(),
        html_url: `https://github.com/fixture/project-101/pull/${num}#issuecomment-${900 + list.length + 1}`,
      };
      list.push(created);
      state.comments.set(num, list);
      return send(created, 201);
    }
    if ((m = /^\/commits\/([a-f0-9]{40})\/check-runs$/.exec(sub)) && method === 'GET') {
      return send({ check_runs: state.commitCheckRuns.get(m[1]) || [] });
    }
    if ((m = /^\/commits\/([a-f0-9]{40})\/check-suites$/.exec(sub)) && method === 'GET') {
      return send({ check_suites: state.commitCheckSuites.get(m[1]) || [] });
    }
    if ((m = /^\/actions\/runs\/(\d+)$/.exec(sub)) && method === 'GET') {
      const runId = Number(m[1]);
      const custom = state.runs.get(runId);
      return send(custom || { id: runId, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: prHead1, html_url: `https://github.com/fixture/project-101/actions/runs/${runId}` });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(sub)) && method === 'GET') {
      return send({ jobs: state.runJobs.get(Number(m[1])) || [] });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(sub)) && method === 'POST') {
      state.reruns.push(Number(m[1]));
      res.writeHead(201);
      return res.end('{}');
    }
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(sub)) && method === 'GET') {
      const sha = state.refs[m[1]];
      return sha ? send({ ref: `refs/heads/${m[1]}`, object: { sha } }) : send({ message: 'Not Found' }, 404);
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(sub)) && method === 'PATCH') {
      state.refs[m[1]] = body.sha;
      state.refUpdates.push({ branch: m[1], sha: body.sha, force: body.force });
      for (const pr of state.pulls.values()) {
        if (pr.head.ref === m[1]) {
          pr.head.sha = body.sha;
          pr.mergeable = true;
          pr.mergeable_state = 'clean';
        }
      }
      return send({ ref: `refs/heads/${m[1]}`, object: { sha: body.sha } });
    }
    if ((m = /^\/git\/commits\/([a-f0-9]{40})$/.exec(sub)) && method === 'GET') {
      const c = commits.get(m[1]);
      return c ? send(c) : send({ message: 'Not Found' }, 404);
    }
    if ((m = /^\/git\/trees\/([a-f0-9]{40})$/.exec(sub)) && method === 'GET') {
      const tree = trees.get(m[1]);
      return tree ? send({ sha: m[1], tree, truncated: false }) : send({ message: 'Not Found' }, 404);
    }
    if ((m = /^\/git\/blobs\/([a-f0-9]{40})$/.exec(sub)) && method === 'GET') {
      if (state.skippedBlobs.has(m[1])) return send({ message: 'This API returns blobs up to 100 MB', errors: [{ resource: 'Blob', field: 'data', code: 'too_large' }] }, 403);
      const b = blobs.get(m[1]);
      return b ? send({ sha: m[1], size: b.length, content: b.toString('base64'), encoding: 'base64' }) : send({ message: 'Not Found' }, 404);
    }
    if (sub === '/git/blobs' && method === 'POST') {
      const buf = Buffer.from(body.content, body.encoding || 'base64');
      const sha = gitObjHash('blob', buf);
      blobs.set(sha, buf);
      return send({ sha }, 201);
    }
    if (sub === '/git/trees' && method === 'POST') {
      const baseEntries = body.base_tree ? [...(trees.get(body.base_tree) || [])] : [];
      const map = new Map(baseEntries.map(e => [e.path, e]));
      for (const item of body.tree || []) {
        if (item.sha === null) map.delete(item.path);
        else map.set(item.path, { path: item.path, name: item.path, mode: item.mode || '100644', type: 'blob', sha: item.sha, size: blobs.get(item.sha)?.length ?? 0 });
      }
      const list = [...map.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      const treeBuf = Buffer.concat(list.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.path}\0`), Buffer.from(e.sha, 'hex')])));
      const sha = gitObjHash('tree', treeBuf);
      trees.set(sha, list);
      return send({ sha, tree: list }, 201);
    }
    if (sub === '/git/commits' && method === 'POST') {
      const sha = gitObjHash('commit', Buffer.from(JSON.stringify({ tree: body.tree, parents: body.parents, message: body.message })));
      const commitObj = { sha, tree: { sha: body.tree }, parents: (body.parents || []).map(p => ({ sha: p })), message: body.message };
      commits.set(sha, commitObj);
      state.createdCommits.push({ sha, parents: body.parents || [], tree: body.tree, message: body.message });
      return send(commitObj, 201);
    }
    return send({ message: `Unhandled ${method} ${path}` }, 404);
  });

  ghServer.listen(0, '127.0.0.1');
  await once(ghServer, 'listening');
  const githubUrl = `http://127.0.0.1:${ghServer.address().port}`;

  const modelQueue = [];
  const modelCalls = [];
  let modelHandler = null;
  const modelServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    modelCalls.push(body);
    let reply = modelHandler ? await modelHandler(body, modelCalls.length - 1) : null;
    if (!reply) reply = modelQueue.shift();
    if (!reply) throw new Error(`Unexpected model request #${modelCalls.length}: ${JSON.stringify(body.messages?.at(-1)).slice(0, 300)}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-' + modelCalls.length,
      choices: [{ index: 0, message: reply, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    }));
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;

  const workDir = mkdtempSync(join(tmpdir(), 'bot-pr-wake-'));
  const localManager = new LocalManager('101', workDir);

  let engine;
  configureDispatch(null);
  const h = await harness(undefined, localManager, store => {
    engine = new TaskEngine(store, localManager, githubUrl);
    return { engine, githubUrl };
  });
  t.after(async () => {
    await engine.close();
    await localManager.recover();
    await h.stop();
    await new Promise(r => { modelServer.close(r); modelServer.closeAllConnections(); });
    await new Promise(r => { ghServer.close(r); ghServer.closeAllConnections(); });
    rmSync(workDir, { recursive: true, force: true });
  });
  const { admin } = await setup(h);
  const acc = accountType === 'bot_account'
    ? await account(admin, { type: 'bot_account', token: 'ghp_bot_account_token_123456' })
    : await account(admin, { type: 'github_app', app_id: '77', private_key: privateKey, token: undefined });

  await repository(admin, acc.id, '101', { full_name: 'fixture/project-101', owner_id: '10', default_branch: 'main' });
  const mod = (await admin('/api/models', 'POST', {
    repository_id: null,
    api_url: modelUrl,
    api_key: testPassword(),
    model_name: 'wake-test-model',
  })).value.model;
  await admin(`/api/models/${mod.id}/projects`, 'PUT', { repository_ids: ['101'] });
  await admin('/api/repositories/101/policy', 'PATCH', {
    model_id: mod.id,
    capability_ceiling: 'develop',
    test_command: 'node --test calc.test.mjs',
  });
  h.store.run("UPDATE policies SET automation=? WHERE repository_id='101'", JSON.stringify({ pull_request_qa_gate: false }));
  scriptedRoles(h.store, '101');
  await localManager.call('PUT', '/v1/projects/101');

  const now = '2026-11-20T08:00:00.000Z';
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at) VALUES('src-issue-42','101','task.request','pr_opened','Implement Issue #42',?,42,?,?,?)",
    JSON.stringify({ generic: true, target: { type: 'issue', number: 42 }, manager: { brief: { goal: 'Add mul helper' } } }),
    prHead1,
    now,
    now,
  );
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at) VALUES('bot-task-standalone','101','task.request','pr_opened','Standalone cleanup',?,NULL,?,?,?)",
    JSON.stringify({ generic: true }),
    pr89Head1,
    now,
    now,
  );
  h.store.run("INSERT INTO bot_branches VALUES('101','bot/issue-42','src-issue-42')");
  h.store.run("INSERT INTO bot_branches VALUES('101','bot/task-standalone','bot-task-standalone')");
  h.store.run(
    "INSERT INTO bot_pull_requests VALUES('101',88,'5088',?,'101','bot/issue-42',?,'src-issue-42',0)",
    String(botActor.id),
    prHead1,
  );
  h.store.run(
    "INSERT INTO bot_pull_requests VALUES('101',89,'5089',?,'101','bot/task-standalone',?,'bot-task-standalone',0)",
    String(botActor.id),
    pr89Head1,
  );
  h.store.run(
    'INSERT OR REPLACE INTO github_actors VALUES(?,?,?,?)',
    acc.id,
    String(botActor.id),
    botActor.login,
    now,
  );

  return {
    h,
    admin,
    acc,
    engine,
    state,
    botActor,
    githubUrl,
    modelQueue,
    modelCalls,
    setModelHandler: fn => { modelHandler = fn; },
  };
}

const toolCall = (id, name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

for (const accountType of ['github_app', 'bot_account']) {
  test(`check failures wake open non-draft bot and non-bot PRs under ${accountType}, route to root Issue or standalone PR thread, and collapse multi-job check_run + check_suite + workflow_run into one event per attempt`, async t => {
    const fx = await createBotPrWakeFixture(t, { accountType });
    const { h, acc, state } = fx;
    state.runJobs.set(7001, [
      {
        id: 8801,
        name: 'unit-tests',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/fixture/project-101/actions/runs/7001/job/8801',
        steps: [{ name: 'Run npm test', conclusion: 'failure' }],
      },
    ]);

    // 1. Passing workflow_run, stale-SHA failure, and spoofed fork run are all ignored; open non-draft non-bot PR #90
    //    wakes with `bot_pull_request: false` and NO `development.pr` option (#1427).
    await h.hook(acc.path, acc.secret, 'wf-pass', {
      action: 'completed',
      repository: { id: 101 },
      workflow_run: { id: 7000, name: 'CI', status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: state.prHead1, pull_requests: [{ number: 88 }] },
    }, { 'X-GitHub-Event': 'workflow_run' });

    await h.hook(acc.path, acc.secret, 'wf-stale-sha', {
      action: 'completed',
      repository: { id: 101 },
      workflow_run: { id: 7004, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: 'f'.repeat(40), head_branch: 'bot/issue-42', pull_requests: [{ number: 88 }] },
    }, { 'X-GitHub-Event': 'workflow_run' });

    await h.hook(acc.path, acc.secret, 'wf-spoofed-fork', {
      action: 'completed',
      repository: { id: 101 },
      workflow_run: { id: 7005, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: state.prHead1, head_repository: { id: 99999 }, pull_requests: [{ number: 88 }] },
    }, { 'X-GitHub-Event': 'workflow_run' });

    assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE type='pull_request.checks_failed'").n, 0);

    await h.hook(acc.path, acc.secret, 'wf-non-bot', {
      action: 'completed',
      repository: { id: 101 },
      workflow_run: { id: 7003, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: state.pr90Head1, head_branch: 'alice/feat', pull_requests: [{ number: 90 }] },
    }, { 'X-GitHub-Event': 'workflow_run' });
    const pr90Events = h.store.all("SELECT * FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed'");
    assert.equal(pr90Events.length, 1, 'open non-draft non-bot PR #90 wakes for read-only analysis');
    assert.equal(pr90Events[0].thread_key, '101:pr:90');
    assert.equal(JSON.parse(pr90Events[0].facts).bot_pull_request, false);
    const pr90Opts = JSON.parse(pr90Events[0].options);
    assert.deepEqual(pr90Opts.map(o => o.id), ['reply'], 'non-bot PR only offers reply option, never development.pr');

    // 2. workflow_run failure on Issue-linked bot PR #88 (even with empty pull_requests[], matched by sha/branch)
    //    routes to root Issue thread `101:issue:42` and carries rich job & PR facts.
    state.pulls.get(89).draft = true;
    await h.hook(acc.path, acc.secret, 'wf-fail-1', {
      action: 'completed',
      repository: { id: 101 },
      workflow_run: {
        id: 7001,
        check_suite_id: 5001,
        name: 'CI',
        run_number: 18,
        run_attempt: 1,
        status: 'completed',
        conclusion: 'failure',
        head_sha: state.prHead1,
        head_branch: 'bot/issue-42',
        html_url: 'https://github.com/fixture/project-101/actions/runs/7001',
        pull_requests: [],
      },
    }, { 'X-GitHub-Event': 'workflow_run' });

    const events1 = h.store.all("SELECT * FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'");
    assert.equal(events1.length, 1, 'only open non-draft PR #88 wakes; draft PR #89 is skipped');
    assert.equal(events1[0].thread_key, '101:issue:42');
    assert.equal(events1[0].object_type, 'pr');
    assert.equal(events1[0].object_number, 88);
    const facts1 = JSON.parse(events1[0].facts);
    assert.equal(facts1.bot_pull_request, true);
    assert.equal(facts1.pr_number, 88);
    assert.equal(facts1.head_sha, state.prHead1);
    assert.equal(facts1.check.name, 'CI');
    assert.equal(facts1.check.run_or_suite_id, '7001');
    assert.equal(facts1.check.workflow_run_id, 7001);
    assert.equal(facts1.check.check_suite_id, 5001);
    assert.equal(facts1.check.attempt, 1);
    assert.equal(facts1.check.url, 'https://github.com/fixture/project-101/actions/runs/7001');
    assert.match(facts1.check.summary, /unit-tests.*Run npm test/);
    assert.equal(facts1.check.failed_jobs.length, 1);

    // 3. Re-delivering the same attempt via `workflow_run`, `check_suite` (suite 5001), or `check_run` (job 8801) collapses
    //    to 0 extra wakeups; attempt 2 (`timed_out`) creates a new event!
    await h.hook(acc.path, acc.secret, 'wf-fail-1-dup', {
      action: 'completed',
      repository: { id: 101 },
      workflow_run: { id: 7001, check_suite_id: 5001, name: 'CI', run_attempt: 1, status: 'completed', conclusion: 'failure', head_sha: state.prHead1, pull_requests: [{ number: 88 }] },
    }, { 'X-GitHub-Event': 'workflow_run' });
    await h.hook(acc.path, acc.secret, 'cs-fail-1-dup', {
      action: 'completed',
      repository: { id: 101 },
      check_suite: { id: 5001, status: 'completed', conclusion: 'failure', head_sha: state.prHead1, pull_requests: [{ number: 88 }] },
    }, { 'X-GitHub-Event': 'check_suite' });
    await h.hook(acc.path, acc.secret, 'cr-fail-1-dup', {
      action: 'completed',
      repository: { id: 101 },
      check_run: { id: 8801, name: 'unit-tests', status: 'completed', conclusion: 'failure', head_sha: state.prHead1, check_suite: { id: 5001 }, details_url: 'https://github.com/fixture/project-101/actions/runs/7001/job/8801', pull_requests: [{ number: 88 }] },
    }, { 'X-GitHub-Event': 'check_run' });
    assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'").n, 1);

    await h.hook(acc.path, acc.secret, 'wf-fail-attempt-2', {
      action: 'completed',
      repository: { id: 101 },
      workflow_run: { id: 7001, check_suite_id: 5001, name: 'CI', run_attempt: 2, status: 'completed', conclusion: 'timed_out', head_sha: state.prHead1, pull_requests: [{ number: 88 }] },
    }, { 'X-GitHub-Event': 'workflow_run' });
    assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'").n, 2);

    // 4. Multi-job workflow on undrafted standalone bot PR #89:
    //    Job 1 (`lint`) fails while Job 2 (`e2e`) is still `in_progress` -> deferred (0 premature events);
    //    Job 2 (`e2e`) fails (`completed`) -> 1 aggregated event on `101:pr:89` carrying BOTH failed jobs;
    //    subsequent `check_suite` and `workflow_run` for the same run/suite produce 0 duplicate events!
    const pr89Sha = state.putCommit({ 'standalone.mjs': 'export default 1;\n' }, [state.baseSha1], 'pr 89');
    state.pulls.get(89).draft = false;
    state.pulls.get(89).head.sha = pr89Sha;
    h.store.run("UPDATE bot_pull_requests SET sha=? WHERE repository_id='101' AND number=89", pr89Sha);
    h.store.run("DELETE FROM bot_pr_states WHERE repository_id='101' AND number=89");

    state.runs.set(7099, {
      id: 7099,
      check_suite_id: 9101,
      name: 'Checks',
      status: 'in_progress',
      conclusion: null,
      run_attempt: 1,
      head_sha: pr89Sha,
      html_url: 'https://github.com/fixture/project-101/actions/runs/7099',
    });
    state.runJobs.set(7099, [
      { id: 9201, name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/7099/job/9201', steps: [{ name: 'ESLint', conclusion: 'failure' }] },
      { id: 9202, name: 'e2e', status: 'in_progress', conclusion: null, html_url: 'https://github.com/fixture/project-101/actions/runs/7099/job/9202', steps: [] },
    ]);

    await h.hook(acc.path, acc.secret, 'cr-job1-while-job2-running', {
      action: 'completed',
      repository: { id: 101 },
      check_run: {
        id: 9201,
        name: 'lint',
        status: 'completed',
        conclusion: 'failure',
        head_sha: pr89Sha,
        details_url: 'https://github.com/fixture/project-101/actions/runs/7099/job/9201',
        check_suite: { id: 9101, run_attempt: 1 },
        output: { title: 'ESLint failed', summary: '2 errors in standalone.mjs' },
        pull_requests: [{ number: 89 }],
      },
    }, { 'X-GitHub-Event': 'check_run' });

    assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=89 AND type='pull_request.checks_failed'").n, 0, 'deferred until sibling job in suite completes');

    state.runs.set(7099, { ...state.runs.get(7099), status: 'completed', conclusion: 'failure' });
    state.runJobs.set(7099, [
      { id: 9201, name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/7099/job/9201', steps: [{ name: 'ESLint', conclusion: 'failure' }] },
      { id: 9202, name: 'e2e', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/7099/job/9202', steps: [{ name: 'Playwright', conclusion: 'failure' }] },
    ]);

    await h.hook(acc.path, acc.secret, 'cr-job2-completes-suite', {
      action: 'completed',
      repository: { id: 101 },
      check_run: {
        id: 9202,
        name: 'e2e',
        status: 'completed',
        conclusion: 'failure',
        head_sha: pr89Sha,
        details_url: 'https://github.com/fixture/project-101/actions/runs/7099/job/9202',
        check_suite: { id: 9101, run_attempt: 1 },
        output: { title: 'Playwright failed', summary: '1 spec failed' },
        pull_requests: [{ number: 89 }],
      },
    }, { 'X-GitHub-Event': 'check_run' });

    await h.hook(acc.path, acc.secret, 'cs-same-suite-89', {
      action: 'completed',
      repository: { id: 101 },
      check_suite: { id: 9101, status: 'completed', conclusion: 'failure', head_sha: pr89Sha, pull_requests: [{ number: 89 }] },
    }, { 'X-GitHub-Event': 'check_suite' });

    await h.hook(acc.path, acc.secret, 'wf-same-run-89', {
      action: 'completed',
      repository: { id: 101 },
      workflow_run: { id: 7099, check_suite_id: 9101, name: 'Checks', run_attempt: 1, status: 'completed', conclusion: 'failure', head_sha: pr89Sha, pull_requests: [{ number: 89 }] },
    }, { 'X-GitHub-Event': 'workflow_run' });

    const pr89Events = h.store.all("SELECT * FROM dispatch_events WHERE object_number=89 AND type='pull_request.checks_failed'");
    assert.equal(pr89Events.length, 1, '2 failed check_runs + check_suite + workflow_run collapsed to 1 event');
    assert.equal(pr89Events[0].thread_key, '101:pr:89');
    const pr89Facts = JSON.parse(pr89Events[0].facts);
    assert.deepEqual(pr89Facts.check.failed_jobs.map(j => j.name), ['lint', 'e2e']);
    assert.match(pr89Facts.check.summary, /lint.*ESLint.*e2e.*Playwright/);
  });
}

test('standard App installation without push/check_suite webhooks detects base-branch advances (merged PR + BotPrWakeScanner) and check suites once per (pr_number, head_sha, base_sha)', async t => {
  setBotWakeRecheckDelaysForTest([40, 80]);
  t.after(() => setBotWakeRecheckDelaysForTest(null));

  const standardEvents = [...appEvents, 'check_run', 'status'];
  assert.ok(!standardEvents.includes('push') && !standardEvents.includes('check_suite'));
  // Readiness: a standard App installation has zero baseline gaps (and zero feature gaps once check_suite/workflow_run/workflows are added).
  const fullSubscribedGaps = accessGaps('github_app', JSON.stringify({ ...appPermissions, workflows: 'write' }), JSON.stringify([...standardEvents, 'check_suite', 'workflow_run']));
  assert.deepEqual(fullSubscribedGaps, []);

  const fx = await createBotPrWakeFixture(t, { installationEvents: standardEvents });
  const { h, acc, state, engine } = fx;

  // 1. Human PR #90 merges into `main` (`pull_request` `closed` + `merged: true`, which is in baseline `appEvents`!):
  //    PR #88 initially reports `mergeable: null` and resolves to `mergeable: false` on recheck poll.
  state.refs.main = state.baseSha2;
  state.pulls.get(90).state = 'closed';
  state.pulls.get(90).merged = true;
  state.pulls.get(90).merge_commit_sha = state.baseSha2;
  state.pulls.get(88).base.sha = state.baseSha2;
  state.pulls.get(88).mergeable = null;
  state.pulls.get(88).mergeable_state = 'unknown';
  state.pulls.get(89).base.sha = state.baseSha2;
  state.pulls.get(89).mergeable = true;
  state.pulls.get(89).mergeable_state = 'clean';

  let pr88Reads = 0;
  state.onPullGet = num => {
    if (num === 88) {
      pr88Reads++;
      if (pr88Reads >= 2) {
        state.pulls.get(88).mergeable = false;
        state.pulls.get(88).mergeable_state = 'dirty';
      }
    }
  };

  await h.hook(acc.path, acc.secret, 'pr-90-merged-advances-main', {
    action: 'closed',
    repository: { id: 101 },
    pull_request: state.pulls.get(90),
    sender: { id: 800, login: 'alice', type: 'User' },
  }, { 'X-GitHub-Event': 'pull_request' });

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !h.store.get("SELECT 1 FROM dispatch_events WHERE type='pull_request.conflicted'")) {
    await new Promise(r => setTimeout(r, 25));
  }

  const conflictEvents = h.store.all("SELECT * FROM dispatch_events WHERE type='pull_request.conflicted'");
  assert.equal(conflictEvents.length, 1);
  assert.equal(conflictEvents[0].thread_key, '101:issue:42');
  const conflictFacts = JSON.parse(conflictEvents[0].facts);
  assert.equal(conflictFacts.pr_number, 88);
  assert.equal(conflictFacts.head_sha, state.prHead1);
  assert.equal(conflictFacts.base_sha, state.baseSha2);
  assert.equal(conflictFacts.conflict.mergeable, false);
  assert.equal(conflictFacts.revisions.for_this_author, 0);

  // Subsequent `pull_request` `dequeued` or `synchronize` on the same `(pr_number, head_sha, base_sha)` is deduplicated,
  // and a deduplicated `synchronize` (`wakeCreated === 0`) still records its `filtered` (`bot_own_pull_request`) audit row!
  await h.hook(acc.path, acc.secret, 'pr-dequeued-dup', {
    action: 'dequeued',
    reason: 'MERGE_CONFLICT',
    repository: { id: 101 },
    pull_request: state.pulls.get(88),
    sender: fx.botActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  await h.hook(acc.path, acc.secret, 'pr-sync-dup-filtered', {
    action: 'synchronize',
    repository: { id: 101 },
    pull_request: state.pulls.get(88),
    sender: fx.botActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE type='pull_request.conflicted'").n, 1);
  assert.ok(h.store.get("SELECT 1 FROM dispatch_events WHERE repository_id='101' AND state='filtered' AND type='pull_request.synchronize'"));

  // 2. Direct commit advances `main` to `baseSha3` with ZERO webhooks delivered (`push` unsubscribed), and standalone PR #89
  //    both conflicts with `baseSha3` and has BOTH a 2-job failed check suite AND a runless `startup_failure` check suite:
  //    `engine.botPrWake.tick()` detects all of them without `push` or `check_suite` webhooks!
  const baseSha3 = state.putCommit({ 'calc.mjs': 'export const add = () => 0;\n' }, [state.baseSha2], 'direct push to main');
  state.refs.main = baseSha3;
  state.pulls.get(89).base.sha = baseSha3;
  state.pulls.get(89).mergeable = false;
  state.pulls.get(89).mergeable_state = 'dirty';
  state.commitCheckRuns.set(state.pr89Head1, [
    { id: 9901, name: 'build', status: 'completed', conclusion: 'failure', check_suite: { id: 9955, run_attempt: 1 }, output: { title: 'Compile error', summary: 'broken import' }, html_url: 'https://github.com/fixture/project-101/runs/9901' },
    { id: 9902, name: 'test', status: 'completed', conclusion: 'failure', check_suite: { id: 9955, run_attempt: 1 }, output: { title: 'Test error', summary: '1 failed' }, html_url: 'https://github.com/fixture/project-101/runs/9902' },
  ]);
  state.commitCheckSuites.set(state.pr89Head1, [
    { id: 9955, status: 'completed', conclusion: 'failure', run_attempt: 1, app: { name: 'GitHub Actions' } },
    { id: 9966, status: 'completed', conclusion: 'startup_failure', run_attempt: 1, latest_check_runs_count: 0, app: { name: 'Broken Workflow YAML' } },
  ]);

  await engine.botPrWake.tick();

  const pr89Conflicted = h.store.all("SELECT * FROM dispatch_events WHERE object_number=89 AND type='pull_request.conflicted'");
  assert.equal(pr89Conflicted.length, 1);
  assert.equal(JSON.parse(pr89Conflicted[0].facts).base_sha, baseSha3);

  const pr89Checks = h.store.all("SELECT * FROM dispatch_events WHERE object_number=89 AND type='pull_request.checks_failed' ORDER BY created_at, rowid");
  assert.equal(pr89Checks.length, 2, 'scanner aggregated suite 9955 (2 failed jobs) + detected runless startup_failure suite 9966');
  assert.equal(JSON.parse(pr89Checks[0].facts).check.failed_jobs.length, 2);
  assert.equal(JSON.parse(pr89Checks[1].facts).check.conclusion, 'startup_failure');
  assert.equal(JSON.parse(pr89Checks[1].facts).check.check_suite_id, 9966);

  // Idempotent on next scanner pass
  await engine.botPrWake.tick();
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=89").n, 3);
});

test('no hard retry cap: >5 failure/conflict rounds still wake Manager with full round summaries & human-comment facts, allowing autonomous stop or rerun', async t => {
  configureDispatch({ pollMs: 30, retryBaseMs: 30 });
  t.after(() => configureDispatch(null));

  const fx = await createBotPrWakeFixture(t, { accountType: 'bot_account' });
  const { h, acc, state, engine } = fx;
  const dispatcher = engine.dispatcher;

  // Bot's own comment on PR #88 (under `bot_account` where `user.type === 'User'`) must NOT be mistaken for a human comment!
  state.comments.set(88, [
    { id: 501, body: 'Automated progress note.', user: fx.botActor, created_at: '2026-11-20T08:05:00.000Z', html_url: 'https://github.com/fixture/project-101/pull/88#issuecomment-501' },
  ]);

  const currentSha = state.prHead1;
  const observedManagerInputs = [];

  fx.setModelHandler(async body => {
    const sys = String(body.messages?.[0]?.content || '');
    const toolNames = (body.tools || []).map(tool => tool.function?.name);
    if (toolNames.includes('submit_acceptance')) {
      return toolCall('qa_pass', 'submit_acceptance', { pass: true, issues: [] });
    }
    const userPayload = (() => { try { return JSON.parse(String(body.messages?.[1]?.content || '{}')); } catch { return null; } })();

    if (sys.includes('# Project Manager prompt') && userPayload?.event) {
      const lastMsg = body.messages.at(-1);
      if (lastMsg?.role === 'tool') {
        return toolCall('mgr_stop', 'ignore_event', { reason: '已连续 5 轮自动修订仍失败且无新的人类评论，已在 PR 留言说明阻塞原因并等待人工介入。' });
      }
      observedManagerInputs.push(userPayload);
      const rev = userPayload.event.facts.revisions;
      if (rev.for_checks_or_conflicts === 5 && !rev.has_new_human_comments) {
        return toolCall('mgr_comment', 'github_write', {
          key: 'explain-loop-88',
          method: 'POST',
          path: '/issues/88/comments',
          body: { body: 'Automatic repair attempted 5 rounds without new human guidance; pausing for human review.' },
        });
      }
      if (rev.has_new_human_comments) {
        return toolCall('mgr_rerun', 'create_task', {
          role: 'reviewer',
          writes: ['actions_rerun'],
          target: { type: 'pr', number: 88 },
          brief: { goal: 'Rerun transient CI failure #' + userPayload.event.facts.check.workflow_run_id, criteria: ['Call rerun_failed_run once and submit report.'] },
          reason: '维护者已留言说明为偶发网络抖动，重跑失败 workflow。',
        });
      }
      if (userPayload.work?.continue?.length) {
        return toolCall('mgr_cont_' + rev.for_checks_or_conflicts, 'continue_task', {
          task_id: userPayload.work.continue[0].task_id,
          reason: `续接同一 PR 任务进行第 ${rev.for_checks_or_conflicts + 1} 轮自动修复检查失败或冲突。`,
        });
      }
      return toolCall('mgr_dev_' + rev.for_checks_or_conflicts, 'create_task', {
        writes: ['pull_request'],
        target: { type: 'pr', number: 88 },
        brief: { goal: `Repair round ${rev.for_checks_or_conflicts + 1}`, criteria: ['Attempt fix and report honestly.'] },
        reason: `第 ${rev.for_checks_or_conflicts + 1} 次自动尝试修复检查失败或冲突。`,
      });
    }

    if (toolNames.includes('delegate_role')) {
      const lastUserIdx = body.messages.findLastIndex(m => m.role === 'user');
      const toolResults = body.messages.slice(lastUserIdx + 1).filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });
      const delegated = [...toolResults].reverse().find(r => typeof r.result_ref === 'string');
      if (delegated) {
        return toolCall('tm_nom_' + Date.now(), 'nominate_delivery', { result_ref: delegated.result_ref });
      }
      return toolCall('tm_del_' + Date.now(), 'delegate_role', { role: 'dev', purpose: 'Diagnose and fix PR #88 wake event.', refs: [] });
    }

    const promptObj = (() => { try { return JSON.parse(String(body.messages?.[1]?.content || '{}')); } catch { return {}; } })();
    const sourcePrompt = (() => { try { return JSON.parse(String(promptObj.source_context || '{}')); } catch { return {}; } })();
    if (toolNames.includes('rerun_failed_run')) {
      const hasRerunResult = body.messages.some(m => m.role === 'tool' && String(m.content).includes('rerun_requested'));
      if (!hasRerunResult) {
        return toolCall('wk_rerun', 'rerun_failed_run', {
          run_id: promptObj.wake_event?.check?.workflow_run_id || sourcePrompt.wake_event?.check?.workflow_run_id || 8107,
          job_ids: [8807],
          reason: 'Transient failure confirmed by maintainer',
          evidence: ['ETIMEDOUT connecting to fixture registry'],
        });
      }
      return toolCall('wk_report_rerun', 'submit_report', { summary: 'Triggered rerun for workflow run.', artifacts: [] });
    }
    return toolCall('wk_report', 'submit_report', {
      summary: `Attempted diagnosis in ${promptObj.task?.contract?.goal || promptObj.contract?.goal || 'round'}; external fixture service still unreachable.`,
      artifacts: [],
    });
  });

  const drainAll = async () => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      dispatcher.tick();
      await dispatcher.idle();
      engine.tick();
      if (engine.working('101').length) await Promise.allSettled(engine.working('101'));
      const pendingEvents = h.store.get("SELECT 1 FROM dispatch_events WHERE repository_id='101' AND state IN ('pending','dispatching')");
      const activeTasks = h.store.get("SELECT 1 FROM tasks WHERE repository_id='101' AND status NOT IN ('pr_opened','completed','succeeded','failed','cancelled','superseded')");
      if (!pendingEvents && !activeTasks) break;
      await new Promise(r => setTimeout(r, 20));
    }
  };

  for (let round = 1; round <= 4; round++) {
    await h.hook(acc.path, acc.secret, `loop-wf-${round}`, {
      action: 'completed',
      repository: { id: 101 },
      workflow_run: { id: 8100 + round, name: 'Integration CI', run_attempt: 1, status: 'completed', conclusion: 'failure', head_sha: currentSha, pull_requests: [{ number: 88 }] },
    }, { 'X-GitHub-Event': 'workflow_run' });
    await drainAll();
  }

  // Round 5: conflicted PR where worker makes NO edits and delivers diagnosis via `submit_report` -> `no_changes` / 0 commits created!
  const nextBase = state.putCommit({ 'README.md': 'updated\n' }, [state.baseSha1], 'base move');
  state.pulls.get(88).base.sha = nextBase;
  state.pulls.get(88).mergeable = false;
  state.pulls.get(88).mergeable_state = 'dirty';
  await h.hook(acc.path, acc.secret, 'loop-conflict-5', {
    action: 'synchronize',
    repository: { id: 101 },
    pull_request: state.pulls.get(88),
    sender: { id: 800, login: 'alice', type: 'User' },
  }, { 'X-GitHub-Event': 'pull_request' });
  await drainAll();
  assert.equal(state.createdCommits.length, 0, 'no-edit conflict round must never mint a 2-parent commit reverting main');

  await h.hook(acc.path, acc.secret, 'loop-wf-6', {
    action: 'completed',
    repository: { id: 101 },
    workflow_run: { id: 8106, name: 'Integration CI', run_attempt: 1, status: 'completed', conclusion: 'failure', head_sha: currentSha, pull_requests: [{ number: 88 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });
  await drainAll();

  assert.equal(observedManagerInputs.length, 6);
  const sixth = observedManagerInputs[5].event.facts.revisions;
  assert.equal(sixth.for_checks_or_conflicts, 5);
  assert.equal(sixth.for_checks_failed, 4);
  assert.equal(sixth.for_conflicts, 1);
  assert.equal(sixth.rounds.length, 5);
  assert.match(sixth.rounds[0].summary, /Attempted diagnosis in Repair round 1/);
  assert.equal(sixth.has_new_human_comments, false, 'bot_account comment was excluded from human comments');
  assert.ok((state.comments.get(88) || []).some(c => /Automatic repair attempted 5 rounds/.test(c.body)));

  state.comments.get(88).push({
    id: 502,
    body: 'Fixture registry is back up now; transient failure.',
    user: { id: 800, login: 'alice', type: 'User' },
    created_at: new Date(Date.now() + 5000).toISOString(),
    html_url: 'https://github.com/fixture/project-101/pull/88#issuecomment-502',
  });
  await h.hook(acc.path, acc.secret, 'loop-wf-7-after-human', {
    action: 'completed',
    repository: { id: 101 },
    workflow_run: { id: 8107, name: 'Integration CI', run_attempt: 1, status: 'completed', conclusion: 'failure', head_sha: currentSha, pull_requests: [{ number: 88 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });
  await drainAll();

  assert.equal(observedManagerInputs.length, 7);
  const seventh = observedManagerInputs[6].event.facts.revisions;
  assert.equal(seventh.has_new_human_comments, true);
  assert.equal(seventh.new_human_comments[0].author, 'alice');
  assert.deepEqual(state.reruns, [8107]);
});

test('continue_task merges mid-run conflict & check failure into running task, refuses unmerged/no-edit conflict commits, verifies real 2-parent merge, and carries all late unconsumed updates', async t => {
  configureDispatch({ pollMs: 25, retryBaseMs: 25 });
  t.after(() => configureDispatch(null));

  const fx = await createBotPrWakeFixture(t);
  const { h, acc, state, engine } = fx;
  const dispatcher = engine.dispatcher;

  // Seed a finished review on PR #88 to prove `continuations()` does NOT offer a finished `review.pr` for check failures.
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at) VALUES('old-review-88','101','review.pr','succeeded','Old review','{}',88,?,'2026-11-20T08:01:00Z','2026-11-20T08:02:00Z')",
    state.prHead1,
  );

  let releaseFirstTurn;
  const firstTurnGate = new Promise(resolve => { releaseFirstTurn = resolve; });
  let workerTurn = 0;
  let secondTurnMessages = null;
  const repairReasons = [];

  fx.setModelHandler(async body => {
    const sys = String(body.messages?.[0]?.content || '');
    const toolNames = (body.tools || []).map(tool => tool.function?.name);
    if (toolNames.includes('submit_acceptance')) {
      return toolCall('qa_pass', 'submit_acceptance', { pass: true, issues: [] });
    }
    const userPayload = (() => { try { return JSON.parse(String(body.messages?.[1]?.content || '{}')); } catch { return null; } })();

    if (sys.includes('# Project Manager prompt') && userPayload?.event) {
      if (userPayload.work?.continue?.length) {
        return toolCall('mgr_cont', 'continue_task', {
          task_id: userPayload.work.continue[0].task_id,
          reason: '合并同一 bot PR 上的新增冲突与检查失败到当前运行中的修订任务。',
        });
      }
      assert.ok(!userPayload.work.continue.some(c => c.task_id === 'old-review-88'), 'finished review must never be offered as dev continuation');
      return toolCall('mgr_new_dev', 'create_task', {
        role: 'dev',
        writes: ['pull_request'],
        target: { type: 'pr', number: 88 },
        brief: { goal: 'Fix failed check and any base conflict on PR #88', criteria: ['Pass node --test calc.test.mjs and update PR #88.'] },
        reason: '派 dev 修复 PR #88 的检查失败并合并主干冲突。',
      });
    }

    if (toolNames.includes('delegate_role')) {
      const toolResults = body.messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });
      const delegated = [...toolResults].reverse().find(r => typeof r.result_ref === 'string');
      if (delegated) return toolCall('tm_nom_cont', 'nominate_delivery', { result_ref: delegated.result_ref });
      return toolCall('tm_del_cont', 'delegate_role', { role: 'dev', purpose: 'Fix PR #88 checks and merge conflicts.', refs: [] });
    }

    workerTurn++;
    if (workerTurn === 1) {
      await firstTurnGate;
      return toolCall('dev_read', 'read_file', { path: 'calc.mjs' });
    }
    if (workerTurn === 2) {
      secondTurnMessages = body.messages;
      // Attempt 1: try calling `open_pull_request` with ZERO edits while PR conflicts with `baseSha2` -> MUST be refused!
      return toolCall('dev_premature_no_edit', 'open_pull_request', {
        change_title: 'premature no-edit attempt',
        summary: 'Did not edit anything yet.',
        test_command: 'node --test calc.test.mjs',
        artifacts: [{ path: 'calc.mjs', description: 'Unchanged' }],
        evidence: [],
      });
    }
    if (workerTurn === 3) {
      const lastToolMsg = String(body.messages.at(-1)?.content || '');
      repairReasons.push(lastToolMsg);
      // Verify the late conflict commit `baseSha2` was transferred into the workspace git store so git can read `main-only.mjs`!
      return toolCall('dev_check_imported_base', 'run_command', { command: `git show refs/bot/base/${state.baseSha2}:main-only.mjs` });
    }
    if (workerTurn === 4) {
      const baseOnlyOut = String(body.messages.at(-1)?.content || '');
      assert.match(baseOnlyOut, /version = 2/, 'late conflict base commit was transferred into the running workspace');
      // Write a file with unresolved conflict markers -> `open_pull_request` MUST refuse (`conflict_markers_present`)!
      return toolCall('dev_write_calc_markers', 'write_file', {
        path: 'calc.mjs',
        content: '<<<<<<< HEAD\nexport const mul = (a, b) => a * b;\n=======\nexport const sub = (a, b) => a - b;\n>>>>>>> bot-conflict-base\n',
      });
    }
    if (workerTurn === 5) {
      return toolCall('dev_try_markers', 'open_pull_request', {
        change_title: 'unresolved markers',
        summary: 'Left conflict markers in calc.mjs.',
        test_command: 'node --test calc.test.mjs',
        artifacts: [{ path: 'calc.mjs', description: 'Calc' }],
        evidence: [],
      });
    }
    if (workerTurn === 6) {
      const markersMsg = String(body.messages.at(-1)?.content || '');
      repairReasons.push(markersMsg);
      return toolCall('dev_write_calc', 'write_file', {
        path: 'calc.mjs',
        content: 'export const add = (a, b) => Number(a) + Number(b);\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n',
      });
    }
    if (workerTurn === 7) {
      return toolCall('dev_write_test', 'write_file', {
        path: 'calc.test.mjs',
        content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, sub, mul } from './calc.mjs';\ntest('all', () => { assert.equal(add(2, 3), 5); assert.equal(sub(5, 3), 2); assert.equal(mul(2, 3), 6); });\n",
      });
    }
    if (workerTurn === 8) {
      return toolCall('dev_write_main_only', 'write_file', {
        path: 'main-only.mjs',
        content: 'export const version = 2;\n',
      });
    }
    if (workerTurn === 9) {
      return toolCall('dev_cmd', 'run_command', { command: 'node --test calc.test.mjs' });
    }
    return toolCall('dev_open_pr', 'open_pull_request', {
      change_title: 'fix: resolve main conflict and unit test failure',
      summary: 'Integrated main (`sub` and `main-only.mjs`) with `mul` and verified all unit tests pass.',
      test_command: 'node --test calc.test.mjs',
      artifacts: [{ path: 'calc.mjs', description: 'Merged calc helpers' }, { path: 'main-only.mjs', description: 'Preserved main addition' }],
      evidence: [{ source: 'node --test calc.test.mjs', result: 'pass' }],
    });
  });

  // 1. Trigger initial `pull_request.checks_failed` -> creates `dev` task and enters workerTurn 1 (`running`).
  await h.hook(acc.path, acc.secret, 'cont-wf-1', {
    action: 'completed',
    repository: { id: 101 },
    workflow_run: { id: 9501, name: 'Unit Tests', run_attempt: 1, status: 'completed', conclusion: 'failure', head_sha: state.prHead1, pull_requests: [{ number: 88 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });

  dispatcher.tick();
  await dispatcher.idle();
  engine.tick();
  const waitRunning = Date.now() + 5000;
  while (Date.now() < waitRunning && workerTurn < 1) await new Promise(r => setTimeout(r, 20));
  assert.equal(workerTurn, 1);

  // 2. While `dev` is actively running in turn 1, BOTH a base-branch conflict (`baseSha2`) AND a second failed check suite arrive!
  state.refs.main = state.baseSha2;
  state.pulls.get(88).base.sha = state.baseSha2;
  state.pulls.get(88).mergeable = false;
  state.pulls.get(88).mergeable_state = 'dirty';

  await h.hook(acc.path, acc.secret, 'cont-push-conflict', {
    ref: 'refs/heads/main',
    before: state.baseSha1,
    after: state.baseSha2,
    deleted: false,
    repository: { id: 101 },
    sender: { login: 'maintainer' },
  }, { 'X-GitHub-Event': 'push' });

  await h.hook(acc.path, acc.secret, 'cont-cr-2', {
    action: 'completed',
    repository: { id: 101 },
    check_run: { id: 9502, name: 'typecheck', status: 'completed', conclusion: 'failure', head_sha: state.prHead1, check_suite: { id: 9599, run_attempt: 1 }, output: { title: 'TS error', summary: 'sub missing' }, pull_requests: [{ number: 88 }] },
  }, { 'X-GitHub-Event': 'check_run' });

  const waitCont = Date.now() + 5000;
  while (Date.now() < waitCont && h.store.get("SELECT 1 FROM dispatch_events WHERE repository_id='101' AND state IN ('pending','dispatching')")) {
    dispatcher.tick();
    await dispatcher.idle();
    await new Promise(r => setTimeout(r, 20));
  }

  const continuedRows = h.store.all("SELECT type,decision FROM dispatch_events WHERE repository_id='101' ORDER BY created_at, rowid");
  assert.deepEqual(continuedRows.map(r => [r.type, r.decision]), [
    ['pull_request.checks_failed', 'create'],
    ['pull_request.conflicted', 'continue'],
    ['pull_request.checks_failed', 'continue'],
  ]);

  releaseFirstTurn();
  await Promise.allSettled(engine.working('101'));

  assert.ok(secondTurnMessages, 'worker executed turn 2');
  const injectedMsg = secondTurnMessages.find(m => m.role === 'user' && String(m.content).includes('New events continued into this task while it was running'));
  assert.ok(injectedMsg, 'running task received continued check failure and conflict in its live model transcript');
  assert.match(injectedMsg.content, /pull_request\.conflicted/);
  assert.match(injectedMsg.content, /typecheck/);

  assert.equal(repairReasons.length, 2, 'both no-edit conflict publish and conflict-marker publish were refused');
  assert.match(repairReasons[0], /tree_unchanged_from_pr_head/);
  assert.match(repairReasons[1], /conflict_markers_present.*calc\.mjs/);

  const devTask = h.store.get("SELECT * FROM tasks WHERE repository_id='101' AND kind='task.request' AND id NOT IN ('src-issue-42','bot-task-standalone')");
  assert.equal(devTask.status, 'pr_opened', JSON.stringify([devTask.status, devTask.error_code]));
  assert.equal(state.createdCommits.length, 1, 'only the verified merge commit was created');
  assert.deepEqual(state.createdCommits[0].parents, [state.baseSha2, state.prHead1]);
  assert.equal(state.refUpdates[0].force, false);
  assert.equal(h.store.get("SELECT sha FROM bot_pull_requests WHERE repository_id='101' AND number=88").sha, state.createdCommits[0].sha);

  // 3. Verify late/unconsumed carry-over carries BOTH unconsumed conflict/check updates AND late comment updates!
  const newHead = state.createdCommits[0].sha;
  const baseSha3 = state.putCommit({ 'extra.txt': 'v3\n' }, [state.baseSha2], 'main v3');
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,review_update_cursor,claim_token,created_at,updated_at) VALUES('late-task','101','task.request','running','Late test',?,88,?,0,'tok',?,?)",
    JSON.stringify({ generic: true, target: { type: 'pr', number: 88 }, executor_role: 'dev' }),
    newHead,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  setGrant(h.store, { id: 'late-task', repository_id: '101' }, ['pull_request'], 'role:manager', null);
  h.store.run(
    "INSERT INTO review_updates(task_id,event_key,data) VALUES('late-task','late-conflict-key',?)",
    JSON.stringify({
      reason: 'pull_request.conflicted',
      wake_type: 'pull_request.conflicted',
      pr_number: 88,
      head_sha: newHead,
      base_sha: baseSha3,
      base_ref: 'main',
      conflict: { pr_number: 88, head_sha: newHead, base_sha: baseSha3, base_ref: 'main', mergeable: false, mergeable_state: 'dirty', summary: 'Late conflict' },
    }),
  );
  h.store.run(
    "INSERT INTO review_updates(task_id,event_key,data) VALUES('late-task','late-comment-key',?)",
    JSON.stringify({
      reason: 'comment',
      actor: 'alice',
      source: { type: 'issue_comment', id: '7788' },
      comment: { id: 7788, body: 'Please also export div(a, b).', user: { login: 'alice' }, html_url: 'https://github.com/fixture/project-101/pull/88#issuecomment-7788' },
    }),
  );
  h.store.run("UPDATE tasks SET status='failed',error_code='model_unavailable' WHERE id='late-task'");
  carryUnconsumedTaskUpdates(h.store, 'late-task', newHead);

  const carriedConflict = h.store.get("SELECT * FROM dispatch_events WHERE source='control_plane' AND type='pull_request.conflicted'");
  assert.ok(carriedConflict, 'unconsumed conflict update on failed task was carried back to Manager');
  assert.equal(JSON.parse(carriedConflict.facts).carried_from, 'late-task');
  assert.equal(JSON.parse(carriedConflict.facts).base_sha, baseSha3);

  const carriedComment = h.store.get("SELECT * FROM dispatch_events WHERE source='control_plane' AND type='pull_request.updated'");
  assert.ok(carriedComment, 'unconsumed late comment update was also carried back to Manager');
  assert.equal(JSON.parse(carriedComment.facts).carried_from, 'late-task');
  assert.match(JSON.parse(carriedComment.facts).comment.body, /export div/);
});

test('conflict-base import fails closed on skipped base blobs, resolves >4-hop base advances, deduplicates revision.carried comments, and guards suite-flush polls', async t => {
  configureDispatch({ pollMs: 25, retryBaseMs: 25 });
  setBotWakeRecheckDelaysForTest([25, 50]);
  t.after(() => {
    configureDispatch(null);
    setBotWakeRecheckDelaysForTest(null);
  });

  const fx = await createBotPrWakeFixture(t);
  const { h, acc, state, engine } = fx;
  const dispatcher = engine.dispatcher;

  // 1. Suite-flush background poll must NEVER reject unhandled when installation auth or DB fails mid-poll!
  const unhandled = [];
  const onUnhandled = err => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  state.commitCheckRuns.set(state.pr89Head1, [
    { id: 9601, name: 'job-a', status: 'completed', conclusion: 'failure', check_suite: { id: 9650, run_attempt: 1 }, output: { title: 'Fail', summary: 'err' } },
    { id: 9602, name: 'job-b', status: 'in_progress', conclusion: null, check_suite: { id: 9650, run_attempt: 1 } },
  ]);
  await h.hook(acc.path, acc.secret, 'suite-flush-poll-err', {
    action: 'completed',
    repository: { id: 101 },
    check_run: { id: 9601, name: 'job-a', status: 'completed', conclusion: 'failure', head_sha: state.pr89Head1, check_suite: { id: 9650, run_attempt: 1 }, output: { title: 'Fail', summary: 'err' }, pull_requests: [{ number: 89 }] },
  }, { 'X-GitHub-Event': 'check_run' });
  state.failInstallationToken = true;
  await new Promise(r => setTimeout(r, 120));
  state.failInstallationToken = false;
  assert.deepEqual(unhandled, [], 'suite-flush background poll caught token/connect failure cleanly without unhandledRejection');

  // 2. Build a 6-hop (>4 hops!) advance on `main` from `baseSha1`:
  //    hop1 adds `hop1-only.mjs`, hops 2..5 add `hop2..5.txt`, hop6 (`base6`) edits `calc.mjs` and adds `hop6-asset.bin`.
  const hop1 = state.putCommit({
    'calc.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
    'hop1-only.mjs': 'export const hop = 1;\n',
  }, [state.baseSha1], 'main hop 1');
  let prevHop = hop1;
  for (let i = 2; i <= 5; i++) {
    prevHop = state.putCommit({
      'calc.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n',
      'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
      'hop1-only.mjs': 'export const hop = 1;\n',
      [`hop${i}.txt`]: `commit ${i}\n`,
    }, [prevHop], `main hop ${i}`);
  }
  const base6Files = {
    'calc.mjs': 'export const add = (a, b) => Number(a) + Number(b);\nexport const sub = (a, b) => a - b;\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, sub } from './calc.mjs';\ntest('add/sub', () => { assert.equal(add(2, 3), 5); assert.equal(sub(5, 3), 2); });\n",
    'hop1-only.mjs': 'export const hop = 1;\n',
    'hop5.txt': 'commit 5\n',
    'hop6-asset.bin': 'important-base-asset-v6\n',
  };
  const base6Sha = state.putCommit(base6Files, [prevHop], 'main hop 6');
  const assetBlobSha = Buffer.from('blob 24\0important-base-asset-v6\n');
  const assetGitSha = (await import('node:crypto')).createHash('sha1').update(assetBlobSha).digest('hex');

  // First, mark `hop6-asset.bin` as skipped/too_large on GitHub -> conflict import MUST fail closed (`candidate_blob_unavailable`)!
  state.skippedBlobs.add(assetGitSha);
  state.refs.main = base6Sha;
  state.pulls.get(88).base.sha = base6Sha;
  state.pulls.get(88).mergeable = false;
  state.pulls.get(88).mergeable_state = 'dirty';

  let devTurn = 0;
  const sixHopRefusals = [];
  fx.setModelHandler(async body => {
    const sys = String(body.messages?.[0]?.content || '');
    const toolNames = (body.tools || []).map(tool => tool.function?.name);
    if (toolNames.includes('submit_acceptance')) {
      return toolCall('qa_pass', 'submit_acceptance', { pass: true, issues: [] });
    }
    const userPayload = (() => { try { return JSON.parse(String(body.messages?.[1]?.content || '{}')); } catch { return null; } })();
    if (sys.includes('# Project Manager prompt') && userPayload?.event) {
      return toolCall('mgr_dev_6hop', 'create_task', {
        role: 'dev',
        writes: ['pull_request'],
        target: { type: 'pr', number: 88 },
        brief: { goal: 'Merge 6-hop main into PR #88', criteria: ['Integrate all main changes and pass tests.'] },
        reason: '派 dev 解决 6 跳基线冲突。',
      });
    }
    if (toolNames.includes('delegate_role')) {
      const toolResults = body.messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });
      const delegated = [...toolResults].reverse().find(r => typeof r.result_ref === 'string');
      if (delegated) return toolCall('tm_nom_6hop', 'nominate_delivery', { result_ref: delegated.result_ref });
      return toolCall('tm_del_6hop', 'delegate_role', { role: 'dev', purpose: 'Resolve 6-hop conflict on PR #88.', refs: [] });
    }
    devTurn++;
    if (devTurn === 1) {
      // Verify the 6-hop history was imported into the workspace git store so `hop1-only.mjs` is readable from `bot-conflict-base`.
      return toolCall('check_6hop', 'run_command', { command: `git show refs/bot/base/${base6Sha}:hop1-only.mjs` });
    }
    if (devTurn === 2) {
      sixHopRefusals.push(String(body.messages.at(-1)?.content || ''));
      return toolCall('w1', 'write_file', { path: 'calc.mjs', content: 'export const add = (a, b) => Number(a) + Number(b);\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n' });
    }
    if (devTurn === 3) {
      return toolCall('w2', 'write_file', { path: 'calc.test.mjs', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, sub, mul } from './calc.mjs';\ntest('all', () => { assert.equal(add(2, 3), 5); assert.equal(sub(5, 3), 2); assert.equal(mul(2, 3), 6); });\n" });
    }
    if (devTurn === 4) {
      return toolCall('w3', 'write_file', { path: 'hop5.txt', content: 'commit 5\n' });
    }
    if (devTurn === 5) {
      return toolCall('w4', 'write_file', { path: 'hop6-asset.bin', content: 'important-base-asset-v6\n' });
    }
    if (devTurn === 6) {
      return toolCall('w5', 'write_file', { path: 'hop1-only.mjs', content: 'export const hop = 1;\n' });
    }
    if (devTurn === 7) {
      return toolCall('t1', 'run_command', { command: 'node --test calc.test.mjs' });
    }
    return toolCall('pub_ok', 'open_pull_request', {
      change_title: 'fix: integrate full 6-hop main history',
      summary: 'Integrated all 6 hops of main including hop1-only.mjs and hop6-asset.bin.',
      test_command: 'node --test calc.test.mjs',
      artifacts: [{ path: 'calc.mjs', description: 'calc' }, { path: 'hop1-only.mjs', description: 'hop1' }],
      evidence: [{ source: 'node --test calc.test.mjs', result: 'pass' }],
    });
  });

  await h.hook(acc.path, acc.secret, 'push-6hop-conflict', {
    ref: 'refs/heads/main',
    before: state.baseSha1,
    after: base6Sha,
    deleted: false,
    repository: { id: 101 },
    sender: { login: 'maintainer' },
  }, { 'X-GitHub-Event': 'push' });

  const waitDecided = Date.now() + 5000;
  while (Date.now() < waitDecided && h.store.get("SELECT 1 FROM dispatch_events WHERE repository_id='101' AND state IN ('pending','dispatching')")) {
    dispatcher.tick();
    await dispatcher.idle();
    await new Promise(r => setTimeout(r, 20));
  }
  engine.tick();
  await Promise.allSettled(engine.working('101'));

  const pausedTask = h.store.get("SELECT * FROM tasks WHERE repository_id='101' AND kind='task.request' AND id NOT IN ('src-issue-42','bot-task-standalone')");
  assert.equal(pausedTask.status, 'retry_wait', 'skipped base blob fails closed into retry_wait');
  assert.equal(pausedTask.error_code, 'candidate_blob_unavailable');
  assert.equal(devTurn, 0, 'model never ran on an incomplete conflict base');
  assert.equal(state.createdCommits.length, 0);

  // Unblock the blob and let the retry run: now the >4-hop LCA (`baseSha1`) is found, `hop1-only.mjs` is enforced, and merge succeeds!
  state.skippedBlobs.clear();
  h.store.run("UPDATE tasks SET next_run_at=0 WHERE id=?", pausedTask.id);
  const finishDeadline = Date.now() + 10000;
  while (Date.now() < finishDeadline) {
    engine.tick();
    const working = engine.working('101');
    if (working.length) await Promise.allSettled(working);
    const cur = h.store.get('SELECT status FROM tasks WHERE id=?', pausedTask.id);
    if (cur?.status === 'pr_opened') break;
    await new Promise(r => setTimeout(r, 25));
  }

  const finalTask = h.store.get('SELECT status,error_code FROM tasks WHERE id=?', pausedTask.id);
  assert.equal(finalTask.status, 'pr_opened', JSON.stringify(finalTask));
  assert.equal(sixHopRefusals.length, 1, '6-hop conflict base was imported into workspace');
  assert.match(sixHopRefusals[0], /hop = 1/);
  assert.equal(state.createdCommits.length, 1);
  assert.deepEqual(state.createdCommits[0].parents, [base6Sha, state.prHead1]);

  // 3. Verify `carryUnconsumedTaskUpdates` skips comments already carried by `carryRevisionRequests` (`revision.carried:<taskId>`).
  h.store.run(
    `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,created_at)
     VALUES('rev-carried-ev','101','101:revision.carried:dedup-task','pull_request.updated','control_plane','pr',88,'carried',?,'[]','pending',?)`,
    JSON.stringify({ bot_pull_request: true, carried_from: 'dedup-task', requests: [{ type: 'comment', id: '9988', author: 'alice' }] }),
    new Date().toISOString(),
  );
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,review_update_cursor,claim_token,created_at,updated_at) VALUES('dedup-task','101','task.request','pr_opened','Dedup test',?,88,?,0,'tok',?,?)",
    JSON.stringify({ generic: true, target: { type: 'pr', number: 88 }, executor_role: 'dev' }),
    state.createdCommits[0].sha,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  setGrant(h.store, { id: 'dedup-task', repository_id: '101' }, ['pull_request'], 'role:manager', null);
  h.store.run(
    "INSERT INTO review_updates(task_id,event_key,data) VALUES('dedup-task','dup-comment-9988',?)",
    JSON.stringify({
      reason: 'comment',
      actor: 'alice',
      revision_request: { type: 'comment', id: '9988', author: 'alice' },
      source: { type: 'comment', id: 9988 },
      comment: { id: 9988, body: 'Already carried by carryRevisionRequests', user: { login: 'alice' } },
    }),
  );
  carryUnconsumedTaskUpdates(h.store, 'dedup-task', state.createdCommits[0].sha);
  assert.equal(
    h.store.get("SELECT count(*) n FROM dispatch_events WHERE event_key LIKE '101:carried:dedup-task:%'").n,
    0,
    'comment already carried in 101:revision.carried:dedup-task was not duplicated',
  );
});

test('workspace_verify_merge rejects unmerged index & conflict markers while allowing clean single-commit rebase onto bot-conflict-base with force-with-lease, submodule gitlinks, and merged-PR base ref resolution', async t => {
  configureDispatch({ pollMs: 25, retryBaseMs: 25 });
  t.after(() => configureDispatch(null));

  const fx = await createBotPrWakeFixture(t);
  const { h, acc, state, engine } = fx;
  const dispatcher = engine.dispatcher;

  const submoduleSha = '1111111111111111111111111111111111111111';
  const commonBase = state.putCommit({
    'calc.mjs': 'export const add = (a, b) => a + b;\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
    'base-existing.mjs': 'export const baseConfig = 1;\n',
    'pr-existing.mjs': 'export const prConfig = 1;\n',
    'check.sh': '#!/bin/sh\necho ok\n',
    'vendor-sub': { type: 'commit', sha: submoduleSha },
  }, [], 'common base with submodule');

  const prSubHead = state.putCommit({
    'calc.mjs': 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, mul } from './calc.mjs';\ntest('calc', () => { assert.equal(add(2, 3), 5); assert.equal(mul(2, 3), 6); });\n",
    'base-existing.mjs': 'export const baseConfig = 1;\n',
    'pr-existing.mjs': 'export const prConfig = 2;\n',
    'check.sh': '#!/bin/sh\necho ok\n',
    'pr-extra-stale.mjs': 'export const strayFromEarlierCommit = true;\n',
    'vendor-sub': { type: 'commit', sha: submoduleSha },
  }, [commonBase], 'bot PR head with extra stale file');

  const conflictBase = state.putCommit({
    'calc.mjs': 'export const add = (a, b) => Number(a) + Number(b);\nexport const sub = (a, b) => a - b;\n',
    'calc.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, sub } from './calc.mjs';\ntest('calc', () => { assert.equal(add(2, 3), 5); assert.equal(sub(5, 3), 2); });\n",
    'base-existing.mjs': 'export const baseConfig = 2;\n',
    'pr-existing.mjs': 'export const prConfig = 1;\n',
    'check.sh': { type: 'blob', mode: '100755', content: '#!/bin/sh\necho ok\n' },
    'main-only.mjs': 'export const version = 2;\n',
    'vendor-sub': { type: 'commit', sha: submoduleSha },
  }, [commonBase], 'main advanced with sub, modified base-existing, and +x check.sh');

  state.refs.main = conflictBase;
  state.refs['bot/issue-42'] = prSubHead;
  state.pulls.get(88).head.sha = prSubHead;
  state.pulls.get(88).base.sha = conflictBase;
  state.pulls.get(88).mergeable = false;
  state.pulls.get(88).mergeable_state = 'dirty';
  h.store.run("UPDATE bot_pull_requests SET sha=? WHERE repository_id='101' AND number=88", prSubHead);

  state.pulls.get(90).state = 'closed';
  state.pulls.get(90).merged = true;
  state.pulls.get(90).merge_commit_sha = null;

  let turn = 0;
  const refusals = [];
  fx.setModelHandler(async body => {
    const sys = String(body.messages?.[0]?.content || '');
    const toolNames = (body.tools || []).map(tool => tool.function?.name);
    if (toolNames.includes('submit_acceptance')) {
      return toolCall('qa_pass', 'submit_acceptance', { pass: true, issues: [] });
    }
    const userPayload = (() => { try { return JSON.parse(String(body.messages?.[1]?.content || '{}')); } catch { return null; } })();
    if (sys.includes('# Project Manager prompt') && userPayload?.event) {
      assert.equal(userPayload.event.facts.base_sha, conflictBase, 'merged PR without merge_commit_sha resolved live main SHA');
      assert.notEqual(userPayload.event.facts.base_sha, state.pr90Head1);
      return toolCall('mgr_rebase_dev', 'create_task', {
        role: 'dev',
        writes: ['pull_request'],
        target: { type: 'pr', number: 88 },
        brief: { goal: 'Rebuild PR #88 cleanly on top of latest main as a single linear commit without stray files', criteria: ['Pass node --test calc.test.mjs and update PR #88.'] },
        reason: '派 dev 变基到最新 main 并清理多余文件。',
      });
    }

    if (toolNames.includes('delegate_role')) {
      const toolResults = body.messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });
      const delegated = [...toolResults].reverse().find(r => typeof r.result_ref === 'string');
      if (delegated) return toolCall('tm_nom_rebase', 'nominate_delivery', { result_ref: delegated.result_ref });
      return toolCall('tm_del_rebase', 'delegate_role', { role: 'dev', purpose: 'Rebase PR #88 cleanly onto latest main.', refs: [] });
    }

    turn++;
    // 1. Unmerged git index from a conflicted merge MUST be refused (`unmerged_index`).
    if (turn === 1) {
      return toolCall('t1_start_merge', 'run_command', {
        command: '{ git -c user.useConfigOnly=true merge --no-commit bot-conflict-base; rc=$?; [ "$rc" -le 1 ]; }',
      });
    }
    if (turn === 2) {
      return toolCall('t2_try_unmerged', 'open_pull_request', {
        change_title: 'unmerged index attempt',
        summary: 'Tried publishing with unresolved merge index.',
        test_command: 'node --test calc.test.mjs',
        artifacts: [{ path: 'calc.mjs', description: 'calc' }],
        evidence: [],
      });
    }
    // 2. Abort merge, checkout `bot-conflict-base` (single linear rebase dropping stray `pr-extra-stale.mjs`!),
    //    leave conflict markers in `calc.mjs` -> MUST be refused (`conflict_markers_present`).
    if (turn === 3) {
      refusals.push(JSON.parse(String(body.messages.at(-1)?.content || '{}')));
      return toolCall('t3_checkout_base', 'run_command', { command: 'git merge --abort && git checkout -f bot-conflict-base' });
    }
    if (turn === 4) {
      return toolCall('t4_write_markers', 'write_file', {
        path: 'calc.mjs',
        content: '<<<<<<< HEAD\nexport const sub = (a, b) => a - b;\n=======\nexport const mul = (a, b) => a * b;\n>>>>>>> pr\n',
      });
    }
    if (turn === 5) {
      return toolCall('t5_try_markers', 'open_pull_request', {
        change_title: 'rebase with conflict markers',
        summary: 'Left markers in calc.mjs.',
        test_command: 'node --test calc.test.mjs',
        artifacts: [{ path: 'calc.mjs', description: 'calc' }],
        evidence: [],
      });
    }
    // 3. Cleanly rebuild only the intended PR changes on top of `bot-conflict-base` (dropping `pr-extra-stale.mjs`!),
    //    run tests, and deliver as a single linear commit (`parents: [conflictBase]`, `force: true` on bot branch).
    if (turn === 6) {
      refusals.push(JSON.parse(String(body.messages.at(-1)?.content || '{}')));
      return toolCall('t6_clean_calc', 'write_file', {
        path: 'calc.mjs',
        content: 'export const add = (a, b) => Number(a) + Number(b);\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n',
      });
    }
    if (turn === 7) {
      return toolCall('t7_clean_test', 'write_file', {
        path: 'calc.test.mjs',
        content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, sub, mul } from './calc.mjs';\ntest('all', () => { assert.equal(add(2, 3), 5); assert.equal(sub(5, 3), 2); assert.equal(mul(2, 3), 6); });\n",
      });
    }
    if (turn === 8) {
      return toolCall('t8_run_tests', 'run_command', { command: 'node --test calc.test.mjs' });
    }
    return toolCall('t9_publish_rebased', 'open_pull_request', {
      change_title: 'fix: rebase PR #88 cleanly onto main',
      summary: 'Rebased onto latest main as a single linear commit without stray files.',
      test_command: 'node --test calc.test.mjs',
      artifacts: [{ path: 'calc.mjs', description: 'Clean rebased calc' }],
      evidence: [{ source: 'node --test calc.test.mjs', result: 'pass' }],
    });
  });

  await h.hook(acc.path, acc.secret, 'pr-90-merged-no-merge-sha', {
    action: 'closed',
    repository: { id: 101 },
    pull_request: state.pulls.get(90),
    sender: { id: 800, login: 'alice', type: 'User' },
  }, { 'X-GitHub-Event': 'pull_request' });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    dispatcher.tick();
    await dispatcher.idle();
    engine.tick();
    const working = engine.working('101');
    if (working.length) await Promise.allSettled(working);
    const done = h.store.get("SELECT status,error_code FROM tasks WHERE repository_id='101' AND kind='task.request' AND id NOT IN ('src-issue-42','bot-task-standalone')");
    if (done?.status === 'pr_opened' || done?.status === 'failed') break;
    await new Promise(r => setTimeout(r, 25));
  }

  assert.equal(refusals.length, 2, 'unmerged index and conflict markers were refused before any write');
  for (const r of refusals) assert.equal(r.code, 'conflict_not_integrated');
  assert.equal(JSON.parse(refusals[0].detail).reason, 'unmerged_index');
  assert.equal(JSON.parse(refusals[1].detail).reason, 'conflict_markers_present');

  const devTask = h.store.get("SELECT status,error_code FROM tasks WHERE repository_id='101' AND kind='task.request' AND id NOT IN ('src-issue-42','bot-task-standalone')");
  assert.equal(devTask.status, 'pr_opened', JSON.stringify(devTask));
  assert.equal(state.createdCommits.length, 1);
  assert.deepEqual(state.createdCommits[0].parents, [conflictBase], 'rebased PR published a single linear commit on conflictBase');
  assert.equal(state.refUpdates[0].force, true, 'bot-owned branch updated with force-with-lease after expected_sha CAS check');
});
