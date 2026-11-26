// #1316: Strictly internal low-frequency open bot PR patrol, environment/capability/permission change re-evaluation,
// baseline-advance & unresolved CHANGES_REQUESTED recheck, dirty-conflict anti-burn suppression, restart persistence,
// and strict zero external notification guarantees under both `github_app` and `bot_account`.
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
import {
  BOT_PR_RECONCILE_MIN_MS,
  BotPrWakeScanner,
  computePatrolEnvironmentSnapshot,
  diffPatrolEnvironments,
  setBotPatrolConfigForTest,
  setBotWakeRecheckDelaysForTest,
} from '../../../../dist/review/bot-pr-wake.js';
import { appEvents, appPermissions } from '../../../../dist/github/client.js';
import { setGrant } from '../../../../dist/tasks/grants.js';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
import { botPrGraphql } from '../../../fixtures/bot-pr-graphql.mjs';

const gitObjHash = (type, data) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
const toolCall = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

async function createPatrolFixture(t, { accountType = 'github_app', initialPermissions } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map();
  const putBlob = content => {
    const bytes = Buffer.from(content), sha = gitObjHash('blob', bytes);
    blobs.set(sha, bytes);
    return sha;
  };
  const putCommit = (filesMap, parents = [], message = 'commit') => {
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
    const sha = gitObjHash('commit', Buffer.from(JSON.stringify({ treeSha, parents, message })));
    commits.set(sha, { sha, tree: { sha: treeSha }, parents: parents.map(p => ({ sha: p })), message });
    return sha;
  };

  const baseSha1 = putCommit({ 'app.mjs': 'export const ok = 1;\n', 'app.test.mjs': "import test from 'node:test'; test('ok', () => {});\n" }, [], 'base 1');
  const pr88Head1 = putCommit({ 'app.mjs': 'export const ok = 2;\n', 'app.test.mjs': "import test from 'node:test'; test('ok', () => {});\n" }, [baseSha1], 'pr 88 head 1');
  const pr89Head1 = putCommit({ 'app.mjs': 'export const ok = 3;\n', 'app.test.mjs': "import test from 'node:test'; test('ok', () => {});\n" }, [baseSha1], 'pr 89 head 1');

  const botActor = accountType === 'bot_account'
    ? { id: 777, login: 'ci-bot-user', type: 'User' }
    : { id: 999, login: 'dept-bot[bot]', type: 'Bot' };

  const state = {
    baseSha1,
    pr88Head1,
    pr89Head1,
    putCommit,
    installationPermissions: { ...(initialPermissions ?? appPermissions) },
    refs: { main: baseSha1, 'bot/issue-42': pr88Head1, 'bot/standalone-89': pr89Head1 },
    pulls: new Map([
      [88, {
        id: 5088,
        number: 88,
        title: 'feat: bot PR 88',
        body: 'Fixes #42',
        state: 'open',
        draft: false,
        mergeable: true,
        mergeable_state: 'clean',
        updated_at: '2026-11-24T00:00:00Z',
        user: botActor,
        head: { sha: pr88Head1, ref: 'bot/issue-42', repo: { id: 101 } },
        base: { sha: baseSha1, ref: 'main', repo: { id: 101 } },
        labels: [],
        html_url: 'https://github.com/fixture/project-101/pull/88',
      }],
      [89, {
        id: 5089,
        number: 89,
        title: 'chore: standalone bot PR 89',
        body: 'Standalone',
        state: 'open',
        draft: false,
        mergeable: true,
        mergeable_state: 'clean',
        updated_at: '2026-11-24T00:00:00Z',
        user: botActor,
        head: { sha: pr89Head1, ref: 'bot/standalone-89', repo: { id: 101 } },
        base: { sha: baseSha1, ref: 'main', repo: { id: 101 } },
        labels: [],
        html_url: 'https://github.com/fixture/project-101/pull/89',
      }],
    ]),
    comments: new Map(),
    reviews: new Map(),
    commitCheckRuns: new Map(),
    commitCheckSuites: new Map(),
    writes: [],
    feishuRequests: [],
    reviewReads: 0,
    commentReads: 0,
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
    if (path === '/app') return send({ id: 77, slug: 'dept-bot', name: 'dept-bot', permissions: state.installationPermissions, events: appEvents });
    if (path === '/user' || path === '/users/dept-bot[bot]') return send(botActor);
    if (path === '/repos/fixture/project-101/installation') {
      return send({
        id: 55,
        account: { id: 10, login: 'fixture' },
        permissions: { ...state.installationPermissions },
        events: appEvents,
      });
    }
    if (path === '/app/installations/55/access_tokens') {
      return send({ token: 'ghs_patrol_fixture', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions }, 201);
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
    if ((m = /^\/pulls\/(\d+)$/.exec(sub)) && method === 'GET') {
      const pr = state.pulls.get(Number(m[1]));
      return send(pr || { message: 'Not Found' }, pr ? 200 : 404);
    }
    if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(sub)) && method === 'GET') {
      state.reviewReads++;
      return send(page === 1 ? (state.reviews.get(Number(m[1])) || []) : []);
    }
    if ((m = /^\/pulls\/(\d+)\/(files|comments)$/.exec(sub)) && method === 'GET') {
      return send([]);
    }
    if ((m = /^\/issues\/(\d+)$/.exec(sub)) && method === 'GET') {
      const pr = state.pulls.get(Number(m[1]));
      return send(pr || { id: 1000 + Number(m[1]), number: Number(m[1]), title: `Issue #${m[1]}`, body: '', state: 'open', user: { id: 800, login: 'alice', type: 'User' }, labels: [] }, 200);
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(sub))) {
      const num = Number(m[1]);
      const list = state.comments.get(num) || [];
      if (method === 'GET') {
        state.commentReads++;
        return send(page === 1 ? list : []);
      }
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
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(sub)) && method === 'GET') {
      const sha = state.refs[m[1]];
      return sha ? send({ ref: `refs/heads/${m[1]}`, object: { sha } }) : send({ message: 'Not Found' }, 404);
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
      const b = blobs.get(m[1]);
      return b ? send({ sha: m[1], size: b.length, content: b.toString('base64'), encoding: 'base64' }) : send({ message: 'Not Found' }, 404);
    }
    return send({ message: `Unhandled ${method} ${path}` }, 404);
  });
  ghServer.listen(0, '127.0.0.1');
  await once(ghServer, 'listening');
  const githubUrl = `http://127.0.0.1:${ghServer.address().port}`;

  // Spy server standing in for any Feishu / external notification endpoint.
  const feishuSpy = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    state.feishuRequests.push({ method: req.method, url: req.url, body: raw });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, msg: 'ok' }));
  });
  feishuSpy.listen(0, '127.0.0.1');
  await once(feishuSpy, 'listening');

  const modelCalls = [];
  let modelHandler = null;
  const modelServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    modelCalls.push(body);
    const reply = modelHandler ? await modelHandler(body, modelCalls.length - 1) : null;
    if (!reply) throw new Error(`Unexpected model request #${modelCalls.length}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-' + modelCalls.length,
      choices: [{ index: 0, message: reply, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    }));
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;

  const workDir = mkdtempSync(join(tmpdir(), 'bot-pr-patrol-'));
  const localManager = new LocalManager('101', workDir);

  let engine;
  configureDispatch(null);
  const h = await harness(undefined, localManager, store => {
    engine = new TaskEngine(store, localManager, githubUrl);
    return { engine, githubUrl };
  });
  t.after(async () => {
    setBotPatrolConfigForTest(null);
    setBotWakeRecheckDelaysForTest(null);
    configureDispatch(null);
    await engine.close();
    await localManager.recover();
    await h.stop();
    await new Promise(r => { modelServer.close(r); modelServer.closeAllConnections(); });
    await new Promise(r => { ghServer.close(r); ghServer.closeAllConnections(); });
    await new Promise(r => { feishuSpy.close(r); feishuSpy.closeAllConnections(); });
    rmSync(workDir, { recursive: true, force: true });
  });

  const { admin } = await setup(h);
  const acc = accountType === 'bot_account'
    ? await account(admin, { type: 'bot_account', token: 'ghp_bot_patrol_token_123456' })
    : await account(admin, { type: 'github_app', app_id: '77', private_key: privateKey, token: undefined });
  await repository(admin, acc.id, '101', { full_name: 'fixture/project-101', owner_id: '10', default_branch: 'main' });

  const mod = (await admin('/api/models', 'POST', {
    repository_id: null,
    api_url: modelUrl,
    api_key: testPassword(),
    model_name: 'patrol-test-model',
  })).value.model;
  await admin(`/api/models/${mod.id}/projects`, 'PUT', { repository_ids: ['101'] });
  await admin('/api/repositories/101/policy', 'PATCH', {
    model_id: mod.id,
    capability_ceiling: 'develop',
    test_command: 'node --test app.test.mjs',
  });
  h.store.run("UPDATE policies SET automation=? WHERE repository_id='101'", JSON.stringify({ pull_request_qa_gate: false }));
  scriptedRoles(h.store, '101');
  await localManager.call('PUT', '/v1/projects/101');

  const seedAt = '2026-11-20T08:00:00.000Z';
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at) VALUES('src-issue-42','101','task.request','pr_opened','Implement #42',?,42,?,?,?)",
    JSON.stringify({ generic: true, target: { type: 'issue', number: 42 } }),
    pr88Head1,
    seedAt,
    seedAt,
  );
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at) VALUES('src-pr-89','101','task.request','pr_opened','Standalone #89',?,NULL,?,?,?)",
    JSON.stringify({ generic: true }),
    pr89Head1,
    seedAt,
    seedAt,
  );
  h.store.run("INSERT INTO bot_branches VALUES('101','bot/issue-42','src-issue-42')");
  h.store.run("INSERT INTO bot_branches VALUES('101','bot/standalone-89','src-pr-89')");
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',88,'5088',?,'101','bot/issue-42',?,'src-issue-42',0)", String(botActor.id), pr88Head1);
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',89,'5089',?,'101','bot/standalone-89',?,'src-pr-89',0)", String(botActor.id), pr89Head1);
  h.store.run('INSERT OR REPLACE INTO github_actors VALUES(?,?,?,?)', acc.id, String(botActor.id), botActor.login, seedAt);

  if (accountType === 'github_app') {
    h.store.run(
      `INSERT OR REPLACE INTO github_installations(ref,github_host,app_id,installation_id,account_id,target_id,target_type,target_login,status,completeness,permissions,events,revision,scope_version,permissions_version,scope_pending,updated_at)
       VALUES('github.com/77/55','github.com','77','55',?,'10','Organization','fixture','active','complete',?,?,1,1,1,0,?)`,
      acc.id,
      JSON.stringify(state.installationPermissions),
      JSON.stringify(appEvents),
      seedAt,
    );
    h.store.run(
      `INSERT OR REPLACE INTO installation_repositories(installation_ref,repository_id,full_name,owner_id,owner_login,private,present,last_success_at)
       VALUES('github.com/77/55','101','fixture/project-101','10','fixture',0,1,?)`,
      seedAt,
    );
  }

  // Register an active external notification subscription to prove patrol NEVER triggers external notifications.
  h.store.run(
    `INSERT INTO notification_subscriptions(id,tenant_id,project_id,principal_id,spec,revision,state,reason,event_cursor,created_at,updated_at)
     VALUES('sub-feishu-1','default','101','admin',?,1,'active',NULL,0,1,1)`,
    JSON.stringify({ name: 'Ops Group', destination_id: 'feishu:oc_test_group', events: ['ci.failed', 'task.failed'], projects: ['101'], aggregate_ms: 0, timezone: 'UTC', enabled: true }),
  );

  const assertZeroExternalNotifications = label => {
    assert.equal(h.store.get('SELECT count(*) n FROM schedule_events').n, 0, `${label}: zero schedule_events`);
    assert.equal(h.store.get('SELECT count(*) n FROM notification_outbox').n, 0, `${label}: zero notification_outbox`);
    assert.equal(state.feishuRequests.length, 0, `${label}: zero Feishu/external requests`);
  };

  const drainDispatch = async () => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      engine.dispatcher.tick();
      await engine.dispatcher.idle();
      if (!h.store.get("SELECT 1 FROM dispatch_events WHERE repository_id='101' AND state IN ('pending','dispatching')")) break;
      await new Promise(r => setTimeout(r, 15));
    }
  };

  return {
    h,
    admin,
    acc,
    engine,
    state,
    botActor,
    githubUrl,
    modelCalls,
    setModelHandler: fn => { modelHandler = fn; },
    assertZeroExternalNotifications,
    drainDispatch,
  };
}

test('pure green open bot PRs update persisted patrol metadata with zero events, zero model calls, zero GitHub writes, zero external notifications, and survive restart without re-scanning early', async t => {
  let clockMs = Date.parse('2026-11-24T00:00:00.000Z');
  setBotPatrolConfigForTest({
    intervalMs: 6 * 3600_000,
    cooldownMs: 24 * 3600_000,
    now: () => clockMs,
  });

  const fx = await createPatrolFixture(t);
  const { h, engine, state, modelCalls, githubUrl, assertZeroExternalNotifications } = fx;

  state.commitCheckRuns.set(state.pr88Head1, [
    { id: 101, name: 'ci', status: 'completed', conclusion: 'success', check_suite: { id: 501, run_attempt: 1 } },
  ]);
  state.commitCheckSuites.set(state.pr88Head1, [
    { id: 501, status: 'completed', conclusion: 'success', run_attempt: 1 },
  ]);

  // First patrol pass baselines clean green PRs #88 and #89.
  await engine.botPrWake.tick();

  assert.equal(h.store.get('SELECT count(*) n FROM dispatch_events').n, 0, 'clean green PRs emit zero dispatch events');
  assert.equal(modelCalls.length, 0, 'clean green PRs trigger zero model calls');
  assert.equal(state.writes.length, 0, 'clean green PRs trigger zero GitHub writes/comments');
  assertZeroExternalNotifications('green PR baseline patrol');

  const st88 = h.store.get("SELECT * FROM bot_pr_states WHERE repository_id='101' AND number=88");
  assert.equal(st88.last_patrol_at, '2026-11-24T00:00:00.000Z');
  assert.equal(st88.patrol_status, 'clean');
  assert.equal(st88.patrol_head_sha, state.pr88Head1);
  assert.equal(st88.patrol_base_sha, state.baseSha1);
  assert.ok(st88.patrol_env_fingerprint && st88.patrol_env_fingerprint.length === 64);

  // Volatile `ready` <-> `busy` project-computer transitions must NOT flip the patrol environment fingerprint,
  // whereas an actual `unavailable` -> `ready` recovery or generation bump MUST flip it.
  h.store.run("INSERT OR REPLACE INTO project_environments(repository_id,generation,state,desired,revision) VALUES('101',1,'ready','running',1)");
  const envReady = computePatrolEnvironmentSnapshot(h.store, '101', state.installationPermissions);
  h.store.run("UPDATE project_environments SET state='busy',revision=2 WHERE repository_id='101'");
  const envBusy = computePatrolEnvironmentSnapshot(h.store, '101', state.installationPermissions);
  assert.equal(envReady.fingerprint, envBusy.fingerprint, 'ready <-> busy transition keeps identical fingerprint');
  h.store.run("UPDATE project_environments SET state='unavailable',revision=3 WHERE repository_id='101'");
  const envUnavailable = computePatrolEnvironmentSnapshot(h.store, '101', state.installationPermissions);
  assert.notEqual(envReady.fingerprint, envUnavailable.fingerprint, 'unavailable state changes fingerprint');
  assert.ok(diffPatrolEnvironments(envUnavailable.summary, envReady.summary).includes('environment.availability: unavailable -> available'));
  h.store.run("UPDATE project_environments SET state='ready',generation=2,revision=4 WHERE repository_id='101'");
  const envGen2 = computePatrolEnvironmentSnapshot(h.store, '101', state.installationPermissions);
  assert.notEqual(envReady.fingerprint, envGen2.fingerprint, 'project computer generation rebuild changes fingerprint');
  assert.ok(diffPatrolEnvironments(envReady.summary, envGen2.summary).includes('environment.generation: 1 -> 2'));
  h.store.run("DELETE FROM project_environments WHERE repository_id='101'");

  // Even when main advances AND env changes on a pure green PR with NO prior obstacle, patrol stays silent.
  const baseSha2 = state.putCommit({ 'main-note.txt': 'v2\n' }, [state.baseSha1], 'main v2');
  state.refs.main = baseSha2;
  state.pulls.get(88).base.sha = baseSha2;
  state.installationPermissions.workflows = 'write';
  h.store.run("UPDATE github_installations SET permissions=?,permissions_version=permissions_version+1 WHERE ref='github.com/77/55'", JSON.stringify(state.installationPermissions));

  clockMs += 10 * 60_000;
  await engine.botPrWake.tick();
  assert.equal(h.store.get('SELECT count(*) n FROM dispatch_events').n, 0, 'clean PR with no obstacle stays silent even after env/base change');
  assert.equal(modelCalls.length, 0);
  assert.equal(state.writes.length, 0);
  assertZeroExternalNotifications('green PR after env/base change');

  // Simulate control-plane restart with a brand-new BotPrWakeScanner on the same persisted SQLite database.
  const readsBeforeRestart = state.reviewReads;
  clockMs += 60 * 60_000; // only 1 hour elapsed (< 6h intervalMs)
  const restartedScanner = new BotPrWakeScanner(h.store, githubUrl);
  await restartedScanner.tick();
  assert.equal(state.reviewReads, readsBeforeRestart, 'restarted scanner honors persisted last_patrol_at and skips review API reads before intervalMs');
  assert.equal(h.store.get('SELECT count(*) n FROM dispatch_events').n, 0);
  assertZeroExternalNotifications('after restart before interval');

  // Verify `pull_request.patrol` is accepted in standing rules (while still rejecting `writes: ['pull_request']`).
  const mgrBefore = (await fx.admin('/api/repositories/101/manager')).value.manager;
  const badRuleRes = await fx.admin('/api/repositories/101/manager', 'PUT', {
    expected_revision: mgrBefore.prompt.revision,
    standing_rules: [{ id: 'patrol-no-dev', event: 'pull_request.patrol', action: 'create', role: 'dev', writes: ['pull_request'], reason: 'must reject dev' }],
  });
  assert.equal(badRuleRes.status, 400);
  const okRuleRes = await fx.admin('/api/repositories/101/manager', 'PUT', {
    expected_revision: mgrBefore.prompt.revision,
    standing_rules: [{ id: 'patrol-audit', event: 'pull_request.patrol', action: 'ignore', reason: 'fixture test rule' }],
  });
  assert.equal(okRuleRes.status, 200);

  // Project deletion cleans up extended bot_pr_states columns without foreign-key or SQL errors.
  deleteProjectRecords(h.store, '101', { files: false });
  assert.equal(h.store.get("SELECT count(*) n FROM bot_pr_states WHERE repository_id='101'").n, 0);
});

test('environment, permission, and capability changes wake previously blocked or report-degraded bot PRs (including legacy workflow_changes_not_confirmed and waiting_permission resume) with zero external notifications', async t => {
  let clockMs = Date.parse('2026-11-24T01:00:00.000Z');
  setBotPatrolConfigForTest({
    intervalMs: 6 * 3600_000,
    cooldownMs: 24 * 3600_000,
    stalledTaskAgeMs: 2 * 3600_000,
    capabilityVersion: '2026-11-24.v1',
    now: () => clockMs,
  });

  // Start WITHOUT `workflows: write` permission.
  const permsWithoutWorkflows = { ...appPermissions };
  delete permsWithoutWorkflows.workflows;
  const fx = await createPatrolFixture(t, { accountType: 'github_app', initialPermissions: permsWithoutWorkflows });
  const { h, engine, state, setModelHandler, assertZeroExternalNotifications, drainDispatch } = fx;

  // Seed PR #88 with a historical revision task that degraded to report (`completed` without pushing PR) like sciencediscovery#1325.
  const revAt = '2026-11-23T20:00:00.000Z';
  h.store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,head_sha,error_code,created_at,updated_at)
     VALUES('rev-degraded-88','101','task.request','completed','Revise CI workflow on PR #88',?,?,88,?,'github_workflows_permission_missing',?,?)`,
    JSON.stringify({ generic: true, target: { type: 'pr', number: 88 }, contract: { endpoint: 'reviewable_pull_request' } }),
    JSON.stringify({ status: 'no_changes', delivery: 'report', summary: 'Blocked by missing workflows: write permission; closed as report.' }),
    state.pr88Head1,
    revAt,
    revAt,
  );
  setGrant(h.store, { id: 'rev-degraded-88', repository_id: '101' }, ['pull_request'], 'role:manager', null);

  // Baseline PR #88 patrol state at env1 (before workflows: write is granted).
  const env1 = computePatrolEnvironmentSnapshot(h.store, '101', permsWithoutWorkflows, '2026-11-24.v1');
  h.store.run(
    `INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,base_sha,head_sha,mergeable,mergeable_state,title,updated_at,last_patrol_at,last_patrol_event_at,patrol_env_fingerprint,patrol_env_summary,patrol_head_sha,patrol_base_sha,patrol_status)
     VALUES('101',88,'open',0,'main',?,?,1,'clean','feat: bot PR 88',?,?,?,?,?,?,?,'ignored')`,
    state.baseSha1,
    state.pr88Head1,
    '2026-11-24T00:50:00.000Z',
    '2026-11-24T00:50:00.000Z',
    '2026-11-24T00:50:00.000Z',
    env1.fingerprint,
    JSON.stringify(env1.summary),
    state.pr88Head1,
    state.baseSha1,
  );

  // Seed PR #89 with a legacy `workflow_changes_not_confirmed` task and NO prior patrol_env_fingerprint (upgrade scenario).
  h.store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,head_sha,error_code,created_at,updated_at)
     VALUES('rev-legacy-89','101','task.request','failed','Update workflow on PR #89',?,?,89,?,'workflow_changes_not_confirmed',?,?)`,
    JSON.stringify({ generic: true, target: { type: 'pr', number: 89 }, contract: { endpoint: 'reviewable_pull_request' } }),
    JSON.stringify({ summary: 'Stopped on legacy workflow_changes_not_confirmed gate.' }),
    state.pr89Head1,
    revAt,
    revAt,
  );

  // 1. Before permission change: PR #88 is within patrol interval & cooldown -> stays quiet; PR #89 wakes ONCE on legacy blocker!
  await engine.botPrWake.tick();
  const pr88Before = h.store.all("SELECT * FROM dispatch_events WHERE object_number=88 AND type='pull_request.patrol'");
  const pr89Legacy = h.store.all("SELECT * FROM dispatch_events WHERE object_number=89 AND type='pull_request.patrol'");
  assert.equal(pr88Before.length, 0, 'PR #88 does not wake before env/permission change');
  assert.equal(pr89Legacy.length, 1, 'PR #89 wakes on first patrol after upgrade when legacy workflow_changes_not_confirmed is retired');
  const pr89Facts = JSON.parse(pr89Legacy[0].facts);
  assert.ok(pr89Facts.changes_since_last_check.includes('environment_or_policy_changed'));
  assert.ok(pr89Facts.environment_changes.some(line => line.includes('workflow_changes_not_confirmed')));
  assert.equal(pr89Facts.no_external_notifications, true);
  assertZeroExternalNotifications('legacy blocker patrol');

  // 2. Now grant `workflows: write` on the installation -> PR #88 wakes IMMEDIATELY (bypassing 24h cooldown)!
  state.installationPermissions.workflows = 'write';
  h.store.run(
    "UPDATE github_installations SET permissions=?,permissions_version=permissions_version+1 WHERE ref='github.com/77/55'",
    JSON.stringify(state.installationPermissions),
  );
  const env2 = computePatrolEnvironmentSnapshot(h.store, '101', state.installationPermissions, '2026-11-24.v1');
  assert.notEqual(env2.fingerprint, env1.fingerprint);
  assert.ok(diffPatrolEnvironments(env1.summary, env2.summary).includes('installation.permissions.workflows: none -> write'));

  clockMs += BOT_PR_RECONCILE_MIN_MS; // the next read allowed, 5 minutes later (well inside 6h interval and 24h cooldown!)
  await engine.botPrWake.tick();

  const pr88Patrol = h.store.all("SELECT * FROM dispatch_events WHERE object_number=88 AND type='pull_request.patrol'");
  assert.equal(pr88Patrol.length, 1, 'permission grant bypasses cooldown and immediately wakes blocked PR #88');
  assert.equal(pr88Patrol[0].source, 'control_plane');
  assert.equal(pr88Patrol[0].thread_key, '101:issue:42', 'patrol routes to root Issue Object Manager thread');
  const pr88Facts = JSON.parse(pr88Patrol[0].facts);
  assert.ok(pr88Facts.changes_since_last_check.includes('environment_or_policy_changed'));
  assert.ok(pr88Facts.environment_changes.includes('installation.permissions.workflows: none -> write'));
  assert.equal(pr88Facts.patrol.last_pr_task.degraded_to_report, true);
  assertZeroExternalNotifications('permission grant patrol wakeup');

  // Verify Manager receives `changes_since_last_check` + `environment_changes` and dispatches `dev` (`writes: ["pull_request"]`).
  const observedEvents = [];
  setModelHandler(async body => {
    const sys = String(body.messages?.[0]?.content || '');
    const userPayload = (() => { try { return JSON.parse(String(body.messages?.[1]?.content || '{}')); } catch { return null; } })();
    if (sys.includes('# Project Manager prompt') && userPayload?.event) {
      observedEvents.push(userPayload.event);
      if (userPayload.event.object?.number === 88) {
        return toolCall('mgr_dev_88', 'create_task', {
          role: 'dev',
          writes: ['pull_request'],
          target: { type: 'pr', number: 88 },
          brief: { goal: 'Retry workflow revision on PR #88 now that workflows: write is granted', criteria: ['Push workflow update and pass tests'] },
          reason: '安装权限已补齐 workflows: write，重新派 dev 修订 PR #88。',
        });
      }
      return toolCall('mgr_dev_89', 'create_task', {
        role: 'dev',
        writes: ['pull_request'],
        target: { type: 'pr', number: 89 },
        brief: { goal: 'Retry legacy workflow revision on PR #89', criteria: ['Verify and update PR #89'] },
        reason: '旧版 workflow_changes_not_confirmed 限制已取消，重新派 dev 修订 PR #89。',
      });
    }
    return toolCall('wk_done', 'submit_report', { summary: 'Revision turn settled in test fixture.', artifacts: [] });
  });
  await drainDispatch();
  await Promise.allSettled(engine.working('101'));

  const ev88Payload = observedEvents.find(e => e.object?.number === 88);
  assert.ok(ev88Payload, 'Manager processed PR #88 patrol event');
  assert.ok(ev88Payload.facts.environment_changes.includes('installation.permissions.workflows: none -> write'));
  const createdDev = h.store.get("SELECT * FROM tasks WHERE repository_id='101' AND object_number=88 AND id NOT IN ('src-issue-42','rev-degraded-88')");
  assert.ok(createdDev, 'Manager created new dev revision task for PR #88');
  assert.ok(['queued', 'running', 'preparing', 'implementing', 'completed', 'pr_opened'].includes(createdDev.status), `unexpected task status: ${createdDev.status} (${createdDev.error_code})`);
  const createdDev89 = h.store.get("SELECT * FROM tasks WHERE repository_id='101' AND object_number=89 AND id NOT IN ('src-pr-89','rev-legacy-89')");
  assert.ok(createdDev89, 'Manager created real dev revision task for PR #89');
  assertZeroExternalNotifications('after Manager dispatched dev for PR #88 and PR #89');

  // 3. Park the real Manager-dispatched `dev` task on PR #89 in `waiting_permission` (`github_workflows_permission_missing`),
  //    then trigger an env/capability change patrol so Manager calls `continue_task` and resumes it!
  h.store.run(
    "UPDATE tasks SET status='waiting_permission',error_code='github_workflows_permission_missing',updated_at=? WHERE id=?",
    new Date(clockMs).toISOString(),
    createdDev89.id,
  );

  // Bump control-plane capability version to trigger an env-change patrol while createdDev89 sits in waiting_permission.
  setBotPatrolConfigForTest({
    intervalMs: 6 * 3600_000,
    cooldownMs: 24 * 3600_000,
    stalledTaskAgeMs: 2 * 3600_000,
    capabilityVersion: '2026-11-24.v2',
    now: () => clockMs,
  });
  clockMs += 5 * 60_000;
  await engine.botPrWake.tick();

  const patrol89List = h.store.all("SELECT * FROM dispatch_events WHERE object_number=89 AND type='pull_request.patrol' ORDER BY created_at, rowid");
  assert.equal(patrol89List.length, 2, 'env change wakes PR #89 even when task is parked in waiting_permission');
  let continuedWaitTask = false;
  setModelHandler(async body => {
    const sys = String(body.messages?.[0]?.content || '');
    const userPayload = (() => { try { return JSON.parse(String(body.messages?.[1]?.content || '{}')); } catch { return null; } })();
    if (sys.includes('# Project Manager prompt') && userPayload?.event) {
      if (userPayload.event.object?.number === 89) {
        assert.ok(userPayload.work.continue.some(c => c.task_id === createdDev89.id), 'waiting_permission task is continuable');
        continuedWaitTask = true;
        return toolCall('mgr_cont_89', 'continue_task', {
          task_id: createdDev89.id,
          reason: '能力版本变化，续接并恢复等待权限的修订任务。',
        });
      }
      return toolCall('mgr_ign_other', 'ignore_event', { reason: '已处理。' });
    }
    return toolCall('wk_resumed_done', 'submit_report', { summary: 'Resumed waiting_permission task ran.', artifacts: [] });
  });
  await drainDispatch();
  await Promise.allSettled(engine.working('101'));

  assert.equal(continuedWaitTask, true);
  const resumed = h.store.get('SELECT status,error_code,next_run_at FROM tasks WHERE id=?', createdDev89.id);
  assert.notEqual(resumed.status, 'waiting_permission', 'continue_task on pull_request.patrol resumes waiting_permission task');
  assert.equal(resumed.error_code, null);
  const resumedLog = h.store.get("SELECT 1 FROM task_logs WHERE task_id=? AND json_extract(content,'$.type')='resumed' AND json_extract(content,'$.reason')='bot_pr_patrol'", createdDev89.id);
  assert.ok(resumedLog, 'task_logs records bot_pr_patrol resumption');
  assertZeroExternalNotifications('after resuming waiting_permission task via patrol');
});

test('baseline advance rechecks previously failed checks, unresolved CHANGES_REQUESTED respects APPROVED/DISMISSED/COMMENTED state machine & bot-self exclusion, and long-stalled tasks wake patrol', async t => {
  let clockMs = Date.parse('2026-11-24T02:00:00.000Z');
  setBotPatrolConfigForTest({
    intervalMs: 6 * 3600_000,
    cooldownMs: 24 * 3600_000,
    stalledTaskAgeMs: 2 * 3600_000,
    now: () => clockMs,
  });

  const fx = await createPatrolFixture(t, { accountType: 'bot_account' });
  const { h, engine, state, botActor, assertZeroExternalNotifications } = fx;

  // 1. PR #88 has an ALREADY-RECORDED failed check suite (so 60s pull_request.checks_failed will not fire again).
  state.commitCheckRuns.set(state.pr88Head1, [
    { id: 7001, name: 'integration', status: 'completed', conclusion: 'failure', check_suite: { id: 7055, run_attempt: 1 }, html_url: 'https://github.com/fixture/project-101/actions/runs/77001/job/7001', output: { title: 'Baseline broken', summary: 'main fixture 500' } },
  ]);
  state.commitCheckSuites.set(state.pr88Head1, [
    { id: 7055, status: 'completed', conclusion: 'failure', run_attempt: 1, app: { name: 'GitHub Actions' } },
  ]);
  h.store.run(
    `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,thread_key,state,decision,reason,created_at,decided_at)
     VALUES('prev-fail-88','101',?,'pull_request.checks_failed','github','pr',88,'prev fail',?,'[]','101:issue:42','decided','ignore','baseline issue',?,?)`,
    `101:pull_request.checks_failed:88:${state.pr88Head1}:run:77001:1`,
    JSON.stringify({ head_sha: state.pr88Head1, check: { workflow_run_id: 77001, check_suite_id: 7055, attempt: 1 } }),
    '2026-11-23T12:00:00.000Z',
    '2026-11-23T12:00:05.000Z',
  );
  // Seed prior patrol at baseSha1 so advancing to baseSha2 is detected as `base_moved`.
  const env0 = computePatrolEnvironmentSnapshot(h.store, '101');
  h.store.run(
    `INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,base_sha,head_sha,mergeable,mergeable_state,title,updated_at,last_patrol_at,patrol_env_fingerprint,patrol_env_summary,patrol_head_sha,patrol_base_sha,patrol_status)
     VALUES('101',88,'open',0,'main',?,?,1,'clean','feat: bot PR 88',?,?,?,?,?,?,?)`,
    state.baseSha1,
    state.pr88Head1,
    '2026-11-23T18:00:00.000Z',
    '2026-11-23T18:00:00.000Z',
    env0.fingerprint,
    JSON.stringify(env0.summary),
    state.pr88Head1,
    state.baseSha1,
    'ignored',
  );

  // Advance `main` to baseSha2 (baseline fix landed!) while PR #88 stays mergeable (no conflict).
  const baseSha2 = state.putCommit({ 'app.mjs': 'export const ok = 1; // fixed ci\n' }, [state.baseSha1], 'fix baseline ci');
  state.refs.main = baseSha2;
  state.pulls.get(88).base.sha = baseSha2;

  // 2. PR #89 has an unresolved CHANGES_REQUESTED on current head_sha, followed by a COMMENTED review (must NOT dismiss it),
  //    plus a second reviewer whose CHANGES_REQUESTED was subsequently APPROVED (MUST be excluded),
  //    plus a review authored by the bot itself under `bot_account` (`user.type === 'User'`, MUST be excluded).
  state.reviews.set(89, [
    { id: 301, state: 'CHANGES_REQUESTED', commit_id: state.pr89Head1, submitted_at: '2026-11-23T10:00:00Z', body: 'Fix null check', user: { id: 801, login: 'bob', type: 'User' }, html_url: 'https://github.com/fixture/project-101/pull/89#pullrequestreview-301' },
    { id: 302, state: 'COMMENTED', commit_id: state.pr89Head1, submitted_at: '2026-11-23T11:00:00Z', body: 'Also check edge case', user: { id: 801, login: 'bob', type: 'User' } },
    { id: 303, state: 'CHANGES_REQUESTED', commit_id: state.pr89Head1, submitted_at: '2026-11-23T09:00:00Z', body: 'Typo', user: { id: 802, login: 'carol', type: 'User' } },
    { id: 304, state: 'APPROVED', commit_id: state.pr89Head1, submitted_at: '2026-11-23T12:00:00Z', body: 'Looks good now', user: { id: 802, login: 'carol', type: 'User' } },
    { id: 305, state: 'CHANGES_REQUESTED', commit_id: state.pr89Head1, submitted_at: '2026-11-23T12:30:00Z', body: 'Self test', user: botActor },
  ]);

  await engine.botPrWake.tick();

  // PR #88 woke with base_moved + checks_failed!
  const patrol88 = h.store.all("SELECT * FROM dispatch_events WHERE object_number=88 AND type='pull_request.patrol'");
  assert.equal(patrol88.length, 1, 'baseline advance triggers patrol recheck for previously failed checks');
  const f88 = JSON.parse(patrol88[0].facts);
  assert.deepEqual(f88.changes_since_last_check, ['base_moved', 'checks_failed']);
  assert.equal(f88.patrol.previous_base_sha, state.baseSha1);
  assert.equal(f88.patrol.current_base_sha, baseSha2);
  assert.equal(f88.patrol.failed_checks.length, 1);
  assert.equal(f88.patrol.failed_checks[0].workflow_run_id, 77001);

  // PR #89 woke with ONLY bob's unresolved CHANGES_REQUESTED!
  const patrol89 = h.store.all("SELECT * FROM dispatch_events WHERE object_number=89 AND type='pull_request.patrol'");
  assert.equal(patrol89.length, 1, 'unresolved CHANGES_REQUESTED triggers patrol');
  const f89 = JSON.parse(patrol89[0].facts);
  assert.ok(f89.changes_since_last_check.includes('unresolved_changes_requested'));
  assert.equal(f89.patrol.unresolved_changes_requested.length, 1);
  assert.equal(f89.patrol.unresolved_changes_requested[0].author, 'bob');
  assert.equal(f89.patrol.unresolved_changes_requested[0].id, '301');
  assertZeroExternalNotifications('baseline + unresolved review patrol');

  // Mark PR #89 patrol decided, advance past cooldown, and have bob APPROVE -> PR #89 is now clean -> 0 new patrol events!
  h.store.run("UPDATE dispatch_events SET state='decided',decision='ignore',decided_at=? WHERE id=?", new Date(clockMs).toISOString(), patrol89[0].id);
  state.reviews.get(89).push({ id: 306, state: 'APPROVED', commit_id: state.pr89Head1, submitted_at: '2026-11-24T03:00:00Z', body: 'Approved', user: { id: 801, login: 'bob', type: 'User' } });
  clockMs += 25 * 3600_000;
  await engine.botPrWake.tick();
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=89 AND type='pull_request.patrol'").n, 1, 'approved review resolves CHANGES_REQUESTED so PR #89 stays quiet');

  // 3. Long-stalled task (`retry_wait` older than stalledTaskAgeMs) triggers `stalled_task` patrol!
  h.store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,error_code,created_at,updated_at)
     VALUES('stalled-89','101','task.request','retry_wait','Stalled revision on #89',?,89,?,'environment_not_ready',?,?)`,
    JSON.stringify({ generic: true, target: { type: 'pr', number: 89 } }),
    state.pr89Head1,
    new Date(clockMs - 4 * 3600_000).toISOString(),
    new Date(clockMs - 3 * 3600_000).toISOString(),
  );
  clockMs += 25 * 3600_000;
  await engine.botPrWake.tick();
  const patrol89After = h.store.all("SELECT * FROM dispatch_events WHERE object_number=89 AND type='pull_request.patrol' ORDER BY created_at, rowid");
  assert.equal(patrol89After.length, 2, 'long-stalled retry_wait task triggers stalled_task patrol');
  const f89Stalled = JSON.parse(patrol89After[1].facts);
  assert.ok(f89Stalled.changes_since_last_check.includes('stalled_task'));
  assert.equal(f89Stalled.patrol.stalled_tasks[0].id, 'stalled-89');
  assertZeroExternalNotifications('stalled task patrol');
});

for (const accountType of ['github_app', 'bot_account']) {
  test(`dirty conflict suppression stops repeated pull_request.conflicted burn on main advances under ${accountType}, ignores bot own comments, and unsuppresses on env/human/head change`, async t => {
    let clockMs = Date.parse('2026-11-24T04:00:00.000Z');
    setBotPatrolConfigForTest({
      intervalMs: 6 * 3600_000,
      cooldownMs: 24 * 3600_000,
      suppressedDirtyCooldownMs: 7 * 24 * 3600_000,
      capabilityVersion: '2026-11-24.v1',
      now: () => clockMs,
    });

    const fx = await createPatrolFixture(t, { accountType });
    const { h, acc, engine, state, botActor, modelCalls, setModelHandler, assertZeroExternalNotifications, drainDispatch } = fx;

    // 1. Main advances to baseSha2 and PR #88 becomes dirty -> initial pull_request.conflicted fires ONCE.
    const baseSha2 = state.putCommit({ 'app.mjs': 'export const retired = true;\n' }, [state.baseSha1], 'retire target');
    state.refs.main = baseSha2;
    state.pulls.get(88).base.sha = baseSha2;
    state.pulls.get(88).mergeable = false;
    state.pulls.get(88).mergeable_state = 'dirty';

    await engine.botPrWake.tick();
    assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.conflicted'").n, 1);

    // Manager investigates, posts a one-time retired-target comment, and calls ignore_event.
    setModelHandler(async body => {
      const lastMsg = body.messages.at(-1);
      if (lastMsg?.role === 'tool') {
        return toolCall('mgr_ignore_dirty', 'ignore_event', {
          reason: '目标模块已在主干退役，已一次性留言建议维护者关闭，等待人工决策。',
        });
      }
      return toolCall('mgr_comment_once', 'github_write', {
        key: 'retired-target-88',
        method: 'POST',
        path: '/issues/88/comments',
        body: { body: 'The target module has been retired on main; recommending closing this PR unless you want to port it.' },
      });
    });
    await drainDispatch();

    const modelCallsAfterInitial = modelCalls.length;
    const writesAfterInitial = state.writes.length;
    const suppressedState = h.store.get("SELECT * FROM bot_pr_states WHERE repository_id='101' AND number=88");
    assert.equal(suppressedState.conflict_suppressed_head_sha, state.pr88Head1);
    assert.ok(suppressedState.conflict_suppressed_env);
    assert.ok(suppressedState.conflict_suppressed_at);
    assert.equal(suppressedState.patrol_status, 'suppressed_dirty');
    assertZeroExternalNotifications('after initial conflict ignore');

    // 2. Main advances 3 MORE times via BOTH 60s scanner AND push webhook, and bot posts its own comment under bot_account:
    //    ZERO new pull_request.conflicted, ZERO new pull_request.patrol, ZERO model calls, ZERO new GitHub comments!
    let prevBase = baseSha2;
    for (let i = 3; i <= 5; i++) {
      const nextBase = state.putCommit({ 'app.mjs': `export const retired = ${i};\n` }, [prevBase], `main advance ${i}`);
      prevBase = nextBase;
      state.refs.main = nextBase;
      state.pulls.get(88).base.sha = nextBase;
      clockMs += 10 * 60_000;

      // Bot's own comment webhook (even under bot_account where user.type === 'User') must NOT clear suppression!
      if (i === 3) {
        await h.hook(acc.path, acc.secret, `bot-self-comment-${i}`, {
          action: 'created',
          repository: { id: 101 },
          issue: { number: 88, title: 'feat: bot PR 88', pull_request: {} },
          comment: { id: 8800 + i, body: 'Bot internal note.', user: botActor, created_at: new Date(clockMs).toISOString() },
          sender: botActor,
        }, { 'X-GitHub-Event': 'issue_comment' });
      }

      // Push webhook for main advance
      await h.hook(acc.path, acc.secret, `push-main-${i}`, {
        ref: 'refs/heads/main',
        before: state.baseSha1,
        after: nextBase,
        deleted: false,
        repository: { id: 101 },
        sender: { login: 'maintainer' },
      }, { 'X-GitHub-Event': 'push' });

      // 60s scanner tick
      await engine.botPrWake.tick();
    }

    // Even after 6h patrol interval elapses (< 7d suppressedDirtyCooldownMs), suppressed dirty PR stays quiet!
    clockMs += 7 * 3600_000;
    await engine.botPrWake.tick();
    await drainDispatch();

    assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.conflicted'").n, 1, 'repeated main advances produced ZERO extra pull_request.conflicted events');
    assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.patrol'").n, 0, 'suppressed dirty PR produced ZERO patrol burn within cooldown');
    assert.equal(modelCalls.length, modelCallsAfterInitial, 'ZERO extra model calls during main advances');
    assert.equal(state.writes.length, writesAfterInitial, 'ZERO extra GitHub comments during main advances');
    assertZeroExternalNotifications('after repeated main advances on suppressed dirty PR');

    // 3. Environment/capability change unsuppresses via pull_request.patrol with `environment_or_policy_changed` + `conflicted`!
    setBotPatrolConfigForTest({
      intervalMs: 6 * 3600_000,
      cooldownMs: 24 * 3600_000,
      suppressedDirtyCooldownMs: 7 * 24 * 3600_000,
      capabilityVersion: '2026-11-24.v2',
      now: () => clockMs,
    });
    clockMs += BOT_PR_RECONCILE_MIN_MS; // a PR is read at most every 5 minutes (#1396)
    await engine.botPrWake.tick();

    const envPatrol = h.store.all("SELECT * FROM dispatch_events WHERE object_number=88 AND type='pull_request.patrol'");
    assert.equal(envPatrol.length, 1, 'capability change immediately wakes suppressed dirty PR via pull_request.patrol');
    const envPatrolFacts = JSON.parse(envPatrol[0].facts);
    assert.ok(envPatrolFacts.changes_since_last_check.includes('environment_or_policy_changed'));
    assert.ok(envPatrolFacts.changes_since_last_check.includes('conflicted'));
    assert.ok(envPatrolFacts.environment_changes.some(c => c.includes('capability_version: 2026-11-24.v1 -> 2026-11-24.v2')));

    // Manager ignores again under v2 -> re-suppressed under v2!
    setModelHandler(async () => toolCall('mgr_ignore_v2', 'ignore_event', { reason: '目标模块仍已退役，继续静默等待人工关闭。' }));
    await drainDispatch();
    const reSuppressed = h.store.get("SELECT conflict_suppressed_env FROM bot_pr_states WHERE repository_id='101' AND number=88");
    assert.notEqual(reSuppressed.conflict_suppressed_env, suppressedState.conflict_suppressed_env);

    // 4. Real human comment arrives -> clears suppression so the next base advance wakes conflict handling again!
    clockMs += 2 * 60_000;
    await h.hook(acc.path, acc.secret, 'human-comment-unsuppress', {
      action: 'created',
      repository: { id: 101 },
      issue: { number: 88, title: 'feat: bot PR 88', pull_request: {} },
      comment: { id: 9101, body: 'Please port it to the new module path and rebase.', user: { id: 800, login: 'alice', type: 'User' }, created_at: new Date(clockMs).toISOString() },
      sender: { id: 800, login: 'alice', type: 'User' },
    }, { 'X-GitHub-Event': 'issue_comment' });
    const afterHuman = h.store.get("SELECT conflict_suppressed_head_sha FROM bot_pr_states WHERE repository_id='101' AND number=88");
    assert.equal(afterHuman.conflict_suppressed_head_sha, null, 'human comment immediately clears conflict suppression');

    const baseSha6 = state.putCommit({ 'app.mjs': 'export const ported = 6;\n' }, [prevBase], 'main advance 6');
    state.refs.main = baseSha6;
    state.pulls.get(88).base.sha = baseSha6;
    clockMs += BOT_PR_RECONCILE_MIN_MS;
    await engine.botPrWake.tick();
    assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.conflicted'").n, 2, 'after human comment clears suppression, next base advance resumes conflict wakeup');

    // 5. Pushing a new head_sha also clears any conflict suppression!
    h.store.run(
      "UPDATE bot_pr_states SET conflict_suppressed_head_sha=?,conflict_suppressed_env='x',conflict_suppressed_at=? WHERE repository_id='101' AND number=88",
      state.pr88Head1,
      new Date(clockMs).toISOString(),
    );
    const pr88Head2 = state.putCommit({ 'app.mjs': 'export const ok = 99;\n' }, [baseSha6], 'pr 88 head 2');
    state.pulls.get(88).head.sha = pr88Head2;
    clockMs += BOT_PR_RECONCILE_MIN_MS;
    await engine.botPrWake.tick();
    const afterHeadChange = h.store.get("SELECT conflict_suppressed_head_sha,head_sha FROM bot_pr_states WHERE repository_id='101' AND number=88");
    assert.equal(afterHeadChange.head_sha, pr88Head2);
    assert.equal(afterHeadChange.conflict_suppressed_head_sha, null, 'new head_sha clears conflict suppression');
    assertZeroExternalNotifications(`end of ${accountType} suppression lifecycle`);
  });
}
