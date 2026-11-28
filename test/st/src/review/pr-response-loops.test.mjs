// #1427: End-to-end ST coverage for Merge Queue (`merge_group`) Actions failure loops, `pull_request.dequeued`
// dual-insurance + exclusions + reconcile freshness, and other authors' PR (same-repo & fork) CI/Check Run/Merge Queue
// failure analysis with control-plane `non_bot_pr_write_forbidden` enforcement and policy/filter boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, setup, account, repository, saveManager, testPassword } from '../../../fixtures/helpers.mjs';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { configureDispatch } from '../../../../dist/dispatch/worker.js';
import { setBotWakeRecheckDelaysForTest } from '../../../../dist/review/bot-pr-wake.js';
import { appPermissions } from '../../../../dist/github/client.js';
import { accessGaps, allEvents } from '../../../../dist/app/access.js';
import { Onboarding } from '../../../../dist/onboarding/service.js';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
import { botPrGraphql } from '../../../fixtures/bot-pr-graphql.mjs';

const shaOf = (...parts) => createHash('sha1').update(parts.join(':')).digest('hex');

const toolCall = (id, name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

async function createPrResponseFixture(t) {
  const botActor = { id: 999, login: 'dept-bot[bot]', type: 'Bot' };
  const baseMainSha = shaOf('base', 'main', 1);
  const baseReleaseSha = shaOf('base', 'release/v1', 1);
  const pr88Head = shaOf('pr', 88, 1);
  const pr89Head = shaOf('pr', 89, 1);
  const pr90Head = shaOf('pr', 90, 1);
  const pr91Head = shaOf('pr', 91, 1);

  const state = {
    botActor,
    baseMainSha,
    baseReleaseSha,
    pr88Head,
    pr89Head,
    pr90Head,
    pr91Head,
    refs: { main: baseMainSha, 'release/v1': baseReleaseSha, 'bot/issue-42': pr88Head, 'bot/standalone-89': pr89Head },
    commitDates: new Map([
      [pr88Head, '2026-11-26T08:00:00Z'],
      [pr89Head, '2026-11-26T08:00:00Z'],
      [pr90Head, '2026-11-26T08:00:00Z'],
      [pr91Head, '2026-11-26T08:00:00Z'],
    ]),
    pulls: new Map([
      [88, {
        id: 5088, number: 88, title: 'feat: release fix', body: 'Fixes #42', state: 'open', draft: false,
        mergeable: true, mergeable_state: 'clean', created_at: '2026-11-26T08:00:00Z', updated_at: '2026-11-26T08:00:00Z',
        user: botActor, head: { sha: pr88Head, ref: 'bot/issue-42', repo: { id: 101 } },
        base: { sha: baseReleaseSha, ref: 'release/v1', repo: { id: 101 } }, labels: [],
        html_url: 'https://github.com/fixture/project-101/pull/88',
      }],
      [89, {
        id: 5089, number: 89, title: 'chore: standalone bot pr', body: 'Standalone', state: 'open', draft: false,
        mergeable: true, mergeable_state: 'clean', created_at: '2026-11-26T08:00:00Z', updated_at: '2026-11-26T08:00:00Z',
        user: botActor, head: { sha: pr89Head, ref: 'bot/standalone-89', repo: { id: 101 } },
        base: { sha: baseMainSha, ref: 'main', repo: { id: 101 } }, labels: [],
        html_url: 'https://github.com/fixture/project-101/pull/89',
      }],
      [90, {
        id: 5090, number: 90, title: 'feat: alice same-repo pr', body: 'Same-repo PR.', state: 'open', draft: false,
        mergeable: true, mergeable_state: 'clean', created_at: '2026-11-26T08:00:00Z', updated_at: '2026-11-26T08:00:00Z',
        user: { id: 800, login: 'alice', type: 'User' }, head: { sha: pr90Head, ref: 'alice/feat', repo: { id: 101 } },
        base: { sha: baseMainSha, ref: 'main', repo: { id: 101 } }, labels: [],
        html_url: 'https://github.com/fixture/project-101/pull/90',
      }],
      [91, {
        id: 5091, number: 91, title: 'fix: bob fork pr', body: 'Fork PR.', state: 'open', draft: false,
        mergeable: true, mergeable_state: 'clean', created_at: '2026-11-26T08:00:00Z', updated_at: '2026-11-26T08:00:00Z',
        user: { id: 801, login: 'bob', type: 'User' }, head: { sha: pr91Head, ref: 'bob/fork-fix', repo: { id: 55555 } },
        base: { sha: baseMainSha, ref: 'main', repo: { id: 101 } }, labels: [],
        html_url: 'https://github.com/fixture/project-101/pull/91',
      }],
    ]),
    commitPulls: new Map(),
    mergeGroupRuns: [],
    runs: new Map(),
    runJobs: new Map(),
    commitCheckRuns: new Map(),
    commitCheckSuites: new Map(),
    comments: new Map(),
  };

  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  let subscribedEvents = [...allEvents];

  const ghServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://github.fixture');
    const path = decodeURIComponent(url.pathname);
    const method = req.method;
    const body = raw ? JSON.parse(raw) : {};
    const send = (val, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(val));
    };

    if (path === '/graphql' && method === 'POST') return send(botPrGraphql(body, { pulls: state.pulls, refs: state.refs, checkSuites: state.commitCheckSuites }));
    if (path === '/app') return send({ id: 77, slug: 'dept-bot', name: 'dept-bot', permissions: appPermissions, events: subscribedEvents });
    if (path === '/user' || path === '/users/dept-bot[bot]') return send(botActor);
    if (path === '/repos/fixture/project-101/installation') {
      return send({ id: 55, account: { id: 10, login: 'fixture' }, permissions: { ...appPermissions }, events: subscribedEvents });
    }
    if (path === '/app/installations/55/access_tokens') {
      return send({ token: 'ghs_fixture_tok', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions }, 201);
    }
    if (path === '/installation/token' && method === 'DELETE') { res.writeHead(204); return res.end(); }
    if (path === '/repositories/101' || path === '/repos/fixture/project-101') {
      return send({ id: 101, full_name: 'fixture/project-101', owner: { id: 10, login: 'fixture' }, default_branch: 'main' });
    }

    const prefix = '/repos/fixture/project-101';
    if (!path.startsWith(prefix)) return send({ message: 'Not Found' }, 404);
    const sub = path.slice(prefix.length);
    const page = Number(url.searchParams.get('page') || 1);
    let m;

    if (sub === '/labels' && method === 'GET') return send(page === 1 ? [{ name: 'bug' }] : []);
    if ((m = /^\/pulls\/(\d+)$/.exec(sub)) && method === 'GET') {
      const pr = state.pulls.get(Number(m[1]));
      return send(pr || { message: 'Not Found' }, pr ? 200 : 404);
    }
    if ((m = /^\/issues\/(\d+)$/.exec(sub)) && method === 'GET') {
      const obj = state.pulls.get(Number(m[1]));
      return send(obj || { message: 'Not Found' }, obj ? 200 : 404);
    }
    if (/^\/pulls\/\d+\/(files|reviews|comments)$/.test(sub) && method === 'GET') return send([]);
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(sub))) {
      const num = Number(m[1]), list = state.comments.get(num) || [];
      if (method === 'GET') return send(page === 1 ? list : []);
      const created = { id: 900 + list.length + 1, body: body.body, user: botActor, created_at: new Date().toISOString(), html_url: `https://github.com/fixture/project-101/pull/${num}#issuecomment-${900 + list.length + 1}` };
      list.push(created);
      state.comments.set(num, list);
      return send(created, 201);
    }
    if ((m = /^\/commits\/([a-f0-9]{40})\/pulls$/.exec(sub)) && method === 'GET') {
      return send(state.commitPulls.get(m[1]) || []);
    }
    if ((m = /^\/commits\/([a-f0-9]{40})\/check-runs$/.exec(sub)) && method === 'GET') {
      return send({ check_runs: state.commitCheckRuns.get(m[1]) || [] });
    }
    if ((m = /^\/commits\/([a-f0-9]{40})\/check-suites$/.exec(sub)) && method === 'GET') {
      return send({ check_suites: state.commitCheckSuites.get(m[1]) || [] });
    }
    if (sub === '/actions/runs' && method === 'GET') {
      const ev = url.searchParams.get('event');
      const runs = ev === 'merge_group' ? state.mergeGroupRuns : [...state.runs.values()];
      return send({ workflow_runs: runs });
    }
    if ((m = /^\/actions\/runs\/(\d+)$/.exec(sub)) && method === 'GET') {
      const id = Number(m[1]);
      const found = state.runs.get(id) || state.mergeGroupRuns.find(r => r.id === id);
      return send(found || { id, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: pr88Head, html_url: `https://github.com/fixture/project-101/actions/runs/${id}` });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(sub)) && method === 'GET') {
      return send({ jobs: state.runJobs.get(Number(m[1])) || [] });
    }
    if ((m = /^\/git\/commits\/([a-f0-9]{40})$/.exec(sub)) && method === 'GET') {
      const d = state.commitDates.get(m[1]);
      return d ? send({ sha: m[1], committer: { date: d }, author: { date: d } }) : send({ message: 'Not Found' }, 404);
    }
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(sub)) && method === 'GET') {
      const sha = state.refs[m[1]];
      return sha ? send({ ref: `refs/heads/${m[1]}`, object: { sha } }) : send({ message: 'Not Found' }, 404);
    }
    return send({ message: `Unhandled ${method} ${path}` }, 404);
  });

  ghServer.listen(0, '127.0.0.1');
  await once(ghServer, 'listening');
  const githubUrl = `http://127.0.0.1:${ghServer.address().port}`;

  let modelHandler = null;
  const modelCalls = [];
  const modelServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    modelCalls.push(body);
    const reply = modelHandler ? await modelHandler(body, modelCalls.length - 1) : null;
    if (!reply) throw new Error(`Unexpected model call #${modelCalls.length}`);
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

  const workDir = mkdtempSync(join(tmpdir(), 'pr-response-loops-'));
  const localManager = new LocalManager('101', workDir);
  let engine, onboarding;
  configureDispatch(null);
  const h = await harness(undefined, localManager, store => {
    engine = new TaskEngine(store, localManager, githubUrl);
    onboarding = new Onboarding(store);
    return { engine, onboarding, githubUrl };
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
  const acc = await account(admin, { type: 'github_app', app_id: '77', private_key: privateKey, token: undefined });
  await repository(admin, acc.id, '101');
  const mod = (await admin('/api/models', 'POST', { repository_id: null, api_url: modelUrl, api_key: testPassword(), model_name: 'pr-loop-model' })).value.model;
  await admin(`/api/models/${mod.id}/projects`, 'PUT', { repository_ids: ['101'] });
  const polRes = await admin('/api/repositories/101/policy', 'PATCH', { model_id: mod.id, enabled: true, capability_ceiling: 'develop' });
  assert.equal(polRes.status, 200, JSON.stringify(polRes.value));
  scriptedRoles(h.store, '101');

  const now = '2026-11-26T08:00:00.000Z';
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at) VALUES('src-issue-42','101','task.request','pr_opened','Implement Issue #42',?,42,?,?,?)",
    JSON.stringify({ generic: true, target: { type: 'issue', number: 42 } }), pr88Head, now, now,
  );
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',88,'5088','999','101','bot/issue-42',?,'src-issue-42',0)", pr88Head);
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',89,'5089','999','101','bot/standalone-89',?,'src-standalone-89',0)", pr89Head);
  h.store.run('INSERT OR REPLACE INTO github_actors VALUES(?,?,?,?)', acc.id, '999', 'dept-bot[bot]', now);

  return { h, admin, acc, engine, onboarding, state, modelCalls, setModelHandler: fn => { modelHandler = fn; }, setSubscribedEvents: ev => { subscribedEvents = [...ev]; } };
}

test('Merge Queue Actions failure loop: merge_group webhook + slashed base ref + cross-source dedup + pull_request.dequeued dual-insurance + reconcile freshness (#1427)', async t => {
  setBotWakeRecheckDelaysForTest([25, 50]);
  t.after(() => setBotWakeRecheckDelaysForTest(null));

  const fx = await createPrResponseFixture(t);
  const { h, acc, engine, state } = fx;

  // 1. Merge Queue workflow_run on slashed base branch `release/v1` for bot PR #88:
  //    `head_sha` is the synthetic Merge Queue SHA (differs from `pr88Head`), `pull_requests: []`.
  const mqSha1 = shaOf('merge_group', 88, 1);
  const mqBranch1 = `gh-readonly-queue/release/v1/pr-88-${state.pr88Head.slice(0, 12)}`;
  const mqRun1 = {
    id: 7101,
    check_suite_id: 5101,
    name: 'Merge Queue CI',
    event: 'merge_group',
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 1,
    head_sha: mqSha1,
    head_branch: mqBranch1,
    created_at: '2026-11-26T09:00:00Z',
    updated_at: '2026-11-26T09:03:00Z',
    html_url: 'https://github.com/fixture/project-101/actions/runs/7101',
    pull_requests: [],
  };
  state.runs.set(7101, mqRun1);
  state.mergeGroupRuns.push(mqRun1);
  state.runJobs.set(7101, [
    { id: 8901, name: 'mq-unit', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/7101/job/8901', steps: [{ name: 'Run tests', conclusion: 'failure' }] },
  ]);

  await h.hook(acc.path, acc.secret, 'mq-wf-88-1', {
    action: 'completed',
    repository: { id: 101 },
    workflow_run: mqRun1,
  }, { 'X-GitHub-Event': 'workflow_run' });

  const pr88Events = h.store.all("SELECT * FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'");
  assert.equal(pr88Events.length, 1);
  assert.equal(pr88Events[0].thread_key, '101:issue:42', 'Issue-linked bot PR routes to root Issue thread');
  const f88 = JSON.parse(pr88Events[0].facts);
  assert.equal(f88.bot_pull_request, true);
  assert.equal(f88.head_sha, state.pr88Head, 'facts.head_sha remains the real PR head SHA, never ephemeral merge_group_sha');
  assert.equal(f88.merge_group, true);
  assert.equal(f88.merge_group_sha, mqSha1);
  assert.equal(f88.merge_group_branch, mqBranch1);
  assert.equal(f88.check.workflow_run_id, 7101);
  assert.equal(f88.check.check_suite_id, 5101);
  assert.equal(f88.check.merge_group, true);
  assert.equal(f88.check.merge_group_sha, mqSha1);
  assert.equal(f88.check.failed_jobs[0].name, 'mq-unit');
  const opts88 = JSON.parse(pr88Events[0].options);
  assert.equal(opts88[0].spec.head, state.pr88Head, 'development.pr option spec.head stays real PR head SHA');

  // 2. Same-source dedup: subsequent check_suite, check_run, and pull_request.dequeued (CI_FAILURE) for run #7101 produce 0 duplicates!
  await h.hook(acc.path, acc.secret, 'mq-cs-88-dup', {
    action: 'completed',
    repository: { id: 101 },
    check_suite: { id: 5101, status: 'completed', conclusion: 'failure', head_sha: mqSha1, head_branch: mqBranch1, pull_requests: [] },
  }, { 'X-GitHub-Event': 'check_suite' });
  await h.hook(acc.path, acc.secret, 'mq-cr-88-dup', {
    action: 'completed',
    repository: { id: 101 },
    check_run: { id: 8901, name: 'mq-unit', status: 'completed', conclusion: 'failure', head_sha: mqSha1, check_suite: { id: 5101, head_branch: mqBranch1 }, details_url: 'https://github.com/fixture/project-101/actions/runs/7101/job/8901', pull_requests: [] },
  }, { 'X-GitHub-Event': 'check_run' });
  await h.hook(acc.path, acc.secret, 'mq-deq-88-dup', {
    action: 'dequeued',
    reason: 'CI_FAILURE',
    repository: { id: 101 },
    pull_request: state.pulls.get(88),
    sender: state.botActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'").n, 1);

  // 2b. A second DISTINCT merge_group run (#7103, new synthetic merge_group_sha) on the SAME unchanged PR head within
  //     10 minutes (e.g. PR re-enqueued without pushing) MUST still wake (never suppressed by head-only dedup).
  const mqSha1b = shaOf('merge_group', 88, 'requeue-2');
  const mqBranch1b = `gh-readonly-queue/release/v1/pr-88-${state.pr88Head.slice(0, 12)}`;
  const mqRun1b = {
    id: 7103,
    check_suite_id: 5103,
    name: 'Merge Queue CI',
    event: 'merge_group',
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 1,
    head_sha: mqSha1b,
    head_branch: mqBranch1b,
    created_at: '2026-11-26T09:05:00Z',
    updated_at: '2026-11-26T09:07:00Z',
    html_url: 'https://github.com/fixture/project-101/actions/runs/7103',
    pull_requests: [],
  };
  state.runs.set(7103, mqRun1b);
  state.mergeGroupRuns.push(mqRun1b);
  await h.hook(acc.path, acc.secret, 'mq-wf-88-distinct-run-2', {
    action: 'completed',
    repository: { id: 101 },
    workflow_run: mqRun1b,
  }, { 'X-GitHub-Event': 'workflow_run' });
  assert.equal(
    h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'").n,
    2,
    'second distinct merge_group run on the same unchanged PR head wakes Manager',
  );

  // 3. Non-CI dequeue reasons (`MERGE`, `MANUAL`, `PR_CLOSED`) produce ZERO check-failure and ZERO conflict wakeups.
  for (const reason of ['MERGE', 'MANUAL', 'PR_CLOSED']) {
    await h.hook(acc.path, acc.secret, `deq-ignore-${reason}`, {
      action: 'dequeued',
      reason,
      repository: { id: 101 },
      pull_request: state.pulls.get(88),
      sender: state.botActor,
    }, { 'X-GitHub-Event': 'pull_request' });
  }
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'").n, 2);
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.conflicted'").n, 0);

  //    `MERGE_CONFLICT` routes to `pull_request.conflicted` (never `pull_request.checks_failed`).
  state.pulls.get(88).mergeable = false;
  state.pulls.get(88).mergeable_state = 'dirty';
  await h.hook(acc.path, acc.secret, 'deq-merge-conflict', {
    action: 'dequeued',
    reason: 'MERGE_CONFLICT',
    repository: { id: 101 },
    pull_request: state.pulls.get(88),
    sender: state.botActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.conflicted'").n, 1);
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'").n, 2);
  state.pulls.get(88).mergeable = true;
  state.pulls.get(88).mergeable_state = 'clean';

  // 4. Reverse ordering on standalone bot PR #89: `pull_request.dequeued` (`CHECKS_FAILED`) arrives BEFORE `workflow_run`.
  //    Preflight matches run #7102, emits 1 event with `dequeued_reason: 'CHECKS_FAILED'`, and subsequent `workflow_run` deduplicates!
  const mqSha2 = shaOf('merge_group', 89, 1);
  const mqBranch2 = `gh-readonly-queue/main/pr-89-${state.pr89Head.slice(0, 10)}`;
  const mqRun2 = {
    id: 7102,
    check_suite_id: 5102,
    name: 'Merge Queue CI',
    event: 'merge_group',
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 1,
    head_sha: mqSha2,
    head_branch: mqBranch2,
    created_at: '2026-11-26T09:10:00Z',
    updated_at: '2026-11-26T09:12:00Z',
    html_url: 'https://github.com/fixture/project-101/actions/runs/7102',
    pull_requests: [],
  };
  state.runs.set(7102, mqRun2);
  state.mergeGroupRuns.push(mqRun2);
  state.runJobs.set(7102, [
    { id: 8902, name: 'mq-e2e', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/7102/job/8902', steps: [{ name: 'E2E', conclusion: 'failure' }] },
  ]);

  await h.hook(acc.path, acc.secret, 'mq-deq-89-first', {
    action: 'dequeued',
    reason: 'CHECKS_FAILED',
    repository: { id: 101 },
    pull_request: state.pulls.get(89),
    sender: state.botActor,
  }, { 'X-GitHub-Event': 'pull_request' });

  await h.hook(acc.path, acc.secret, 'mq-wf-89-after', {
    action: 'completed',
    repository: { id: 101 },
    workflow_run: mqRun2,
  }, { 'X-GitHub-Event': 'workflow_run' });

  const pr89Events1 = h.store.all("SELECT * FROM dispatch_events WHERE object_number=89 AND type='pull_request.checks_failed'");
  assert.equal(pr89Events1.length, 1, 'dequeued-first + workflow_run-second collapsed into 1 event');
  assert.equal(pr89Events1[0].thread_key, '101:pr:89');
  const f89 = JSON.parse(pr89Events1[0].facts);
  assert.equal(f89.dequeued_reason, 'CHECKS_FAILED');
  assert.equal(f89.merge_group, true);
  assert.equal(f89.merge_group_sha, mqSha2);
  assert.equal(f89.check.workflow_run_id, 7102);
  assert.equal(f89.check.failed_jobs[0].name, 'mq-e2e');

  // 5. Runless `pull_request.dequeued` (`TIMEOUT`) when no matching merge_group workflow_run exists still emits fallback event.
  const pr88Head2 = shaOf('pr', 88, 2);
  state.pulls.get(88).head.sha = pr88Head2;
  state.commitDates.set(pr88Head2, '2026-11-26T10:00:00Z');
  h.store.run("UPDATE bot_pull_requests SET sha=? WHERE repository_id='101' AND number=88", pr88Head2);
  state.mergeGroupRuns = [];
  await h.hook(acc.path, acc.secret, 'mq-deq-88-timeout-fallback', {
    action: 'dequeued',
    reason: 'TIMEOUT',
    repository: { id: 101 },
    pull_request: state.pulls.get(88),
    sender: state.botActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  const pr88Fallback = h.store.get("SELECT facts FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed' ORDER BY rowid DESC LIMIT 1");
  const fFallback = JSON.parse(pr88Fallback.facts);
  assert.equal(fFallback.dequeued_reason, 'TIMEOUT');
  assert.equal(fFallback.merge_group, true);
  assert.equal(fFallback.check.conclusion, 'timed_out');
  assert.equal(fFallback.head_sha, pr88Head2);

  // 5b. Fallback -> delayed workflow_run / check_suite / reconcile for the same PR head deduplicates to 0 duplicates!
  const mqShaFallbackLate = shaOf('merge_group', 88, 'fallback-late');
  const mqBranchFallbackLate = `gh-readonly-queue/release/v1/pr-88-${pr88Head2.slice(0, 12)}`;
  const mqRunFallbackLate = {
    id: 7199,
    check_suite_id: 5199,
    name: 'Merge Queue CI',
    event: 'merge_group',
    status: 'completed',
    conclusion: 'timed_out',
    run_attempt: 1,
    head_sha: mqShaFallbackLate,
    head_branch: mqBranchFallbackLate,
    created_at: '2026-11-26T10:02:00Z',
    updated_at: '2026-11-26T10:05:00Z',
    html_url: 'https://github.com/fixture/project-101/actions/runs/7199',
    pull_requests: [],
  };
  state.runs.set(7199, mqRunFallbackLate);
  state.mergeGroupRuns = [mqRunFallbackLate];
  const pr88CountAfterFallback = h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'").n;
  await h.hook(acc.path, acc.secret, 'mq-wf-88-after-fallback', {
    action: 'completed',
    repository: { id: 101 },
    workflow_run: mqRunFallbackLate,
  }, { 'X-GitHub-Event': 'workflow_run' });
  await h.hook(acc.path, acc.secret, 'mq-cs-88-after-fallback', {
    action: 'completed',
    repository: { id: 101 },
    check_suite: { id: 5199, status: 'completed', conclusion: 'timed_out', head_sha: mqShaFallbackLate, head_branch: mqBranchFallbackLate, created_at: '2026-11-26T10:02:00Z', updated_at: '2026-11-26T10:05:00Z', pull_requests: [] },
  }, { 'X-GitHub-Event': 'check_suite' });
  h.store.run("UPDATE bot_pr_states SET reconcile_at=0, reconcile_due_at=0, reconcile_fingerprint=NULL WHERE repository_id='101' AND number=88");
  await engine.botPrWake.tick();
  assert.equal(
    h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'").n,
    pr88CountAfterFallback,
    'fallback -> delayed workflow_run/check_suite/reconcile produces 0 duplicate events',
  );

  // 5c. Delayed `pull_request.dequeued` after a new commit push (payload head_sha != live PR head_sha) is rejected
  //     for BOTH runless fallback and matched-run paths, and never regresses `bot_pr_states.head_sha`.
  const pr88Head3 = shaOf('pr', 88, 3);
  const staleDequeueSnapshot = structuredClone(state.pulls.get(88)); // still carries pr88Head2!
  state.pulls.get(88).head.sha = pr88Head3;
  state.pulls.get(88).updated_at = '2026-11-26T11:30:00Z';
  state.commitDates.set(pr88Head3, '2026-11-26T11:30:00Z');
  h.store.run("UPDATE bot_pull_requests SET sha=? WHERE repository_id='101' AND number=88", pr88Head3);
  state.mergeGroupRuns = [];
  await h.hook(acc.path, acc.secret, 'mq-deq-88-stale-head-fallback', {
    action: 'dequeued',
    reason: 'CI_FAILURE',
    repository: { id: 101 },
    pull_request: staleDequeueSnapshot,
    sender: state.botActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  assert.equal(
    h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'").n,
    pr88CountAfterFallback,
    'delayed runless dequeue carrying old head_sha is ignored after a push',
  );
  assert.equal(
    h.store.get("SELECT head_sha FROM bot_pr_states WHERE repository_id='101' AND number=88").head_sha,
    pr88Head3,
    'stale pull_request.dequeued payload does not overwrite fresher live preflight head_sha in bot_pr_states',
  );

  // 6. Reconcile (`engine.botPrWake.tick()`) discovers unseen fresh failed `merge_group` runs while ignoring stale runs
  //    predating the PR's `head_updated_at`, and stays idempotent on subsequent ticks.
  const pr89Head2 = shaOf('pr', 89, 2);
  state.pulls.get(89).head.sha = pr89Head2;
  state.pulls.get(89).updated_at = '2026-11-26T12:00:00Z';
  state.commitDates.set(pr89Head2, '2026-11-26T12:00:00Z');
  h.store.run("UPDATE bot_pull_requests SET sha=? WHERE repository_id='101' AND number=89", pr89Head2);
  h.store.run(
    "UPDATE bot_pr_states SET head_sha=?, head_updated_at='2026-11-26T12:00:00Z', reconcile_at=0, reconcile_due_at=0, reconcile_fingerprint=NULL WHERE repository_id='101' AND number=89",
    pr89Head2,
  );
  const mqShaStale = shaOf('merge_group', 89, 'stale');
  const mqShaFresh = shaOf('merge_group', 89, 'fresh');
  state.mergeGroupRuns = [
    {
      id: 7201, check_suite_id: 5201, name: 'Merge Queue CI', event: 'merge_group', status: 'completed', conclusion: 'failure',
      run_attempt: 1, head_sha: mqShaStale, head_branch: `gh-readonly-queue/main/pr-89-${state.pr89Head.slice(0, 10)}`,
      created_at: '2026-11-26T11:00:00Z', updated_at: '2026-11-26T11:02:00Z',
      html_url: 'https://github.com/fixture/project-101/actions/runs/7201', pull_requests: [],
    },
    {
      id: 7202, check_suite_id: 5202, name: 'Merge Queue CI', event: 'merge_group', status: 'completed', conclusion: 'failure',
      run_attempt: 1, head_sha: mqShaFresh, head_branch: `gh-readonly-queue/main/pr-89-${pr89Head2.slice(0, 10)}`,
      created_at: '2026-11-26T12:05:00Z', updated_at: '2026-11-26T12:08:00Z',
      html_url: 'https://github.com/fixture/project-101/actions/runs/7202', pull_requests: [],
    },
  ];
  state.runJobs.set(7202, [
    { id: 8922, name: 'mq-lint', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/7202/job/8922', steps: [{ name: 'Lint', conclusion: 'failure' }] },
  ]);

  await engine.botPrWake.tick();
  const pr89AfterTick = h.store.all("SELECT facts FROM dispatch_events WHERE object_number=89 AND type='pull_request.checks_failed' ORDER BY rowid ASC");
  assert.equal(pr89AfterTick.length, 2, 'reconcile woke only the fresh run #7202 and ignored stale run #7201');
  const fFresh = JSON.parse(pr89AfterTick[1].facts);
  assert.equal(fFresh.check.workflow_run_id, 7202);
  assert.equal(fFresh.merge_group_sha, mqShaFresh);
  assert.equal(fFresh.head_sha, pr89Head2);
  assert.equal(fFresh.check.failed_jobs[0].name, 'mq-lint');

  // Re-running tick is idempotent.
  h.store.run("UPDATE bot_pr_states SET reconcile_at=0, reconcile_due_at=0 WHERE repository_id='101' AND number=89");
  await engine.botPrWake.tick();
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=89 AND type='pull_request.checks_failed'").n, 2);

  // 6b. Late-observed `head_updated_at` (e.g. missed `synchronize` webhook discovered on a later comment) does not drop
  //     a genuine `merge_group` failure whose timestamp is >= authoritative `headCommitDate`.
  const pr89Head3 = shaOf('pr', 89, 3);
  state.pulls.get(89).head.sha = pr89Head3;
  state.pulls.get(89).updated_at = '2026-11-26T13:30:00Z';
  state.commitDates.set(pr89Head3, '2026-11-26T13:00:00Z');
  h.store.run("UPDATE bot_pull_requests SET sha=? WHERE repository_id='101' AND number=89", pr89Head3);
  h.store.run(
    "UPDATE bot_pr_states SET head_sha=?, head_updated_at='2026-11-26T13:30:00Z', reconcile_at=0, reconcile_due_at=0, reconcile_fingerprint=NULL WHERE repository_id='101' AND number=89",
    pr89Head3,
  );
  const mqShaHead3Stale = shaOf('merge_group', 89, 'head3-stale');
  const mqShaHead3Genuine = shaOf('merge_group', 89, 'head3-genuine');
  state.mergeGroupRuns = [
    {
      id: 7204, check_suite_id: 5204, name: 'Merge Queue CI', event: 'merge_group', status: 'completed', conclusion: 'failure',
      run_attempt: 1, head_sha: mqShaHead3Stale, head_branch: `gh-readonly-queue/main/pr-89-${pr89Head2.slice(0, 10)}`,
      created_at: '2026-11-26T12:55:00Z', updated_at: '2026-11-26T12:58:00Z',
      html_url: 'https://github.com/fixture/project-101/actions/runs/7204', pull_requests: [],
    },
    {
      id: 7203, check_suite_id: 5203, name: 'Merge Queue CI', event: 'merge_group', status: 'completed', conclusion: 'failure',
      run_attempt: 1, head_sha: mqShaHead3Genuine, head_branch: `gh-readonly-queue/main/pr-89-${pr89Head3.slice(0, 10)}`,
      created_at: '2026-11-26T13:05:00Z', updated_at: '2026-11-26T13:08:00Z',
      html_url: 'https://github.com/fixture/project-101/actions/runs/7203', pull_requests: [],
    },
  ];
  await engine.botPrWake.tick();
  const pr89LateObserved = h.store.all("SELECT facts FROM dispatch_events WHERE object_number=89 AND type='pull_request.checks_failed' ORDER BY rowid ASC");
  assert.equal(pr89LateObserved.length, 3, 'genuine run #7203 wakes even when head_updated_at was observed later than headCommitDate');
  assert.equal(JSON.parse(pr89LateObserved[2].facts).check.workflow_run_id, 7203);
});

test('other authors PR CI/Check Run/Merge Queue failure wakes Manager read-only (same-repo + fork), enforces non_bot_pr_write_forbidden, and respects filter/ceiling/state guards (#1427)', async t => {
  configureDispatch({ pollMs: 25, retryBaseMs: 25 });
  t.after(() => configureDispatch(null));

  const fx = await createPrResponseFixture(t);
  const { h, admin, acc, engine, state } = fx;
  const dispatcher = engine.dispatcher;

  // 1. Same-repo non-bot PR #90 multi-job check_run deferral -> aggregated wakeup with `bot_pull_request: false` & 0 options.
  state.runs.set(7301, { id: 7301, check_suite_id: 5301, name: 'PR Checks', status: 'in_progress', conclusion: null, run_attempt: 1, head_sha: state.pr90Head, html_url: 'https://github.com/fixture/project-101/actions/runs/7301' });
  state.runJobs.set(7301, [
    { id: 9301, name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/7301/job/9301', steps: [{ name: 'Lint', conclusion: 'failure' }] },
    { id: 9302, name: 'unit', status: 'in_progress', conclusion: null, html_url: 'https://github.com/fixture/project-101/actions/runs/7301/job/9302', steps: [] },
  ]);
  await h.hook(acc.path, acc.secret, 'nonbot-90-job1', {
    action: 'completed',
    repository: { id: 101 },
    check_run: { id: 9301, name: 'lint', status: 'completed', conclusion: 'failure', head_sha: state.pr90Head, details_url: 'https://github.com/fixture/project-101/actions/runs/7301/job/9301', check_suite: { id: 5301, run_attempt: 1 }, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'check_run' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed'").n, 0, 'deferred while sibling job runs');

  state.runs.set(7301, { ...state.runs.get(7301), status: 'completed', conclusion: 'failure' });
  state.runJobs.set(7301, [
    { id: 9301, name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/7301/job/9301', steps: [{ name: 'Lint', conclusion: 'failure' }] },
    { id: 9302, name: 'unit', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/7301/job/9302', steps: [{ name: 'Unit', conclusion: 'failure' }] },
  ]);
  await h.hook(acc.path, acc.secret, 'nonbot-90-job2', {
    action: 'completed',
    repository: { id: 101 },
    check_run: { id: 9302, name: 'unit', status: 'completed', conclusion: 'failure', head_sha: state.pr90Head, details_url: 'https://github.com/fixture/project-101/actions/runs/7301/job/9302', check_suite: { id: 5301, run_attempt: 1 }, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'check_run' });

  const ev90 = h.store.all("SELECT * FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed'");
  assert.equal(ev90.length, 1);
  assert.equal(ev90[0].thread_key, '101:pr:90');
  assert.deepEqual(JSON.parse(ev90[0].options).map(o => o.id), ['reply'], 'no development.pr option for non-bot PR');
  const f90 = JSON.parse(ev90[0].facts);
  assert.equal(f90.bot_pull_request, false);
  assert.deepEqual(f90.check.failed_jobs.map(j => j.name), ['lint', 'unit']);

  // 2. End-to-end Manager dispatch on PR #90:
  //    Attempt 1: Manager tries `create_task` with `writes: ['pull_request']` -> control plane refuses (`non_bot_pr_write_forbidden`).
  //    Attempt 2: Manager posts concise root-cause reply via `github_write`, then finishes with `ignore_event`.
  let mgrStep = 0;
  let observedRefusal = '';
  fx.setModelHandler(async body => {
    mgrStep++;
    if (mgrStep === 1) {
      return toolCall('try_dev_nonbot', 'create_task', {
        writes: ['pull_request'],
        target: { type: 'pr', number: 90 },
        brief: { goal: 'Fix lint on PR #90', criteria: ['Push fix to PR #90'] },
        reason: '尝试直接修改他人 PR 分支。',
      });
    }
    if (mgrStep === 2) {
      observedRefusal = String(body.messages.at(-1)?.content || '');
      return toolCall('reply_nonbot', 'github_write', {
        key: 'ci-analysis-pr-90',
        method: 'POST',
        path: '/issues/90/comments',
        body: { body: 'CI failed on `lint` and `unit` (run #7301). Please fix the lint violation and rerun tests.' },
      });
    }
    return toolCall('done_nonbot', 'ignore_event', { reason: '已在 PR #90 评论回复失败原因与修复建议。' });
  });

  const until = Date.now() + 8000;
  while (Date.now() < until) {
    dispatcher.tick();
    await dispatcher.idle();
    const row = h.store.get('SELECT state FROM dispatch_events WHERE id=?', ev90[0].id);
    if (row?.state === 'decided') break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.match(observedRefusal, /non_bot_pr_write_forbidden/, 'control plane refused pull_request write on non-bot PR');
  assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE object_number=90").n, 0, 'zero write tasks created for non-bot PR');
  assert.ok((state.comments.get(90) || []).some(c => /CI failed on `lint` and `unit`/.test(c.body)), 'Manager posted concise CI analysis reply on PR #90');

  // 3. Fork PR #91 (`pull_requests: []`, `event: 'pull_request'`, `head_repository.id: 55555`) discovered via `/commits/:sha/pulls`.
  state.commitPulls.set(state.pr91Head, [state.pulls.get(91)]);
  await h.hook(acc.path, acc.secret, 'fork-91-wf', {
    action: 'completed',
    repository: { id: 101 },
    workflow_run: {
      id: 7311, check_suite_id: 5311, name: 'Fork CI', event: 'pull_request', status: 'completed', conclusion: 'failure',
      run_attempt: 1, head_sha: state.pr91Head, head_branch: 'bob/fork-fix', head_repository: { id: 55555 }, pull_requests: [],
    },
  }, { 'X-GitHub-Event': 'workflow_run' });
  const ev91 = h.store.all("SELECT * FROM dispatch_events WHERE object_number=91 AND type='pull_request.checks_failed'");
  assert.equal(ev91.length, 1, 'fork PR with empty pull_requests[] resolved via /commits/:sha/pulls');
  assert.equal(JSON.parse(ev91[0].facts).bot_pull_request, false);
  assert.deepEqual(JSON.parse(ev91[0].options).map(o => o.id), ['reply']);

  // 4. Non-bot PR #90 Merge Queue failure wakes with `bot_pull_request: false`, `merge_group: true`, real PR head SHA.
  const mqSha90 = shaOf('merge_group', 90, 1);
  await h.hook(acc.path, acc.secret, 'nonbot-90-mq', {
    action: 'completed',
    repository: { id: 101 },
    workflow_run: {
      id: 7312, check_suite_id: 5312, name: 'MQ CI', event: 'merge_group', status: 'completed', conclusion: 'failure',
      run_attempt: 1, head_sha: mqSha90, head_branch: `gh-readonly-queue/main/pr-90-${state.pr90Head.slice(0, 10)}`,
      created_at: '2026-11-26T09:00:00Z', updated_at: '2026-11-26T09:01:00Z', pull_requests: [],
    },
  }, { 'X-GitHub-Event': 'workflow_run' });
  const ev90Mq = h.store.get("SELECT facts,options FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed' ORDER BY rowid DESC LIMIT 1");
  const f90Mq = JSON.parse(ev90Mq.facts);
  assert.equal(f90Mq.bot_pull_request, false);
  assert.equal(f90Mq.merge_group, true);
  assert.equal(f90Mq.merge_group_sha, mqSha90);
  assert.equal(f90Mq.head_sha, state.pr90Head);
  assert.deepEqual(JSON.parse(ev90Mq.options).map(o => o.id), ['reply']);

  // 4b. Second distinct Merge Queue run (#7313) on the SAME unchanged non-bot PR #90 head within 10 minutes also wakes!
  const mqSha90b = shaOf('merge_group', 90, 2);
  await h.hook(acc.path, acc.secret, 'nonbot-90-mq-2', {
    action: 'completed',
    repository: { id: 101 },
    workflow_run: {
      id: 7313, check_suite_id: 5313, name: 'MQ CI', event: 'merge_group', status: 'completed', conclusion: 'failure',
      run_attempt: 1, head_sha: mqSha90b, head_branch: `gh-readonly-queue/main/pr-90-${state.pr90Head.slice(0, 10)}`,
      created_at: '2026-11-26T09:04:00Z', updated_at: '2026-11-26T09:05:00Z', pull_requests: [],
    },
  }, { 'X-GitHub-Event': 'workflow_run' });
  assert.equal(
    h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed'").n,
    3,
    'second distinct merge_group run on non-bot PR #90 wakes even while prior merge_group event is pending',
  );

  // 5. Strict filtering & security matrix for non-bot PRs:
  const count90 = () => h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed'").n;
  const beforeGuards = count90();

  // 5a. Spoofed fork head_repository.id != pr.head.repo.id (101)
  await h.hook(acc.path, acc.secret, 'guard-spoof-90', {
    action: 'completed', repository: { id: 101 },
    workflow_run: { id: 7401, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: state.pr90Head, head_repository: { id: 99999 }, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });

  // 5b. Stale head_sha
  await h.hook(acc.path, acc.secret, 'guard-stale-90', {
    action: 'completed', repository: { id: 101 },
    workflow_run: { id: 7402, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: 'f'.repeat(40), pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });

  // 5c. Draft PR and Closed PR
  state.pulls.get(90).draft = true;
  await h.hook(acc.path, acc.secret, 'guard-draft-90', {
    action: 'completed', repository: { id: 101 },
    workflow_run: { id: 7403, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: state.pr90Head, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });
  state.pulls.get(90).draft = false;
  state.pulls.get(90).state = 'closed';
  await h.hook(acc.path, acc.secret, 'guard-closed-90', {
    action: 'completed', repository: { id: 101 },
    workflow_run: { id: 7404, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: state.pr90Head, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });
  state.pulls.get(90).state = 'open';

  // 5d. capability_ceiling = 'read'
  await admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'read' });
  await h.hook(acc.path, acc.secret, 'guard-read-ceiling-90', {
    action: 'completed', repository: { id: 101 },
    workflow_run: { id: 7405, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: state.pr90Head, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });
  await admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop' });

  // 5e. review_pull_requests = false (default filter off)
  await admin('/api/repositories/101/policy', 'PATCH', { review_pull_requests: false });
  await h.hook(acc.path, acc.secret, 'guard-review-pr-off-90', {
    action: 'completed', repository: { id: 101 },
    workflow_run: { id: 7406, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: state.pr90Head, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });
  await admin('/api/repositories/101/policy', 'PATCH', { review_pull_requests: true });

  // 5f. Explicit events['pull_request.checks_failed'] = false suppresses non-bot PR #90 while bot PR #88 STILL wakes!
  await saveManager(admin, '101', { events: { 'pull_request.checks_failed': false } });
  await h.hook(acc.path, acc.secret, 'guard-filter-off-90', {
    action: 'completed', repository: { id: 101 },
    workflow_run: { id: 7407, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: state.pr90Head, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });
  assert.equal(count90(), beforeGuards, 'all non-bot PR guard cases produced 0 extra events');

  await h.hook(acc.path, acc.secret, 'bot-88-still-wakes', {
    action: 'completed', repository: { id: 101 },
    workflow_run: { id: 7408, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: state.pr88Head, pull_requests: [{ number: 88 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=88 AND type='pull_request.checks_failed'").n, 1, 'bot PR still wakes even when non-bot filter is disabled');

  // 5g. policy.enabled = 0 suppresses both bot and non-bot PRs.
  await saveManager(admin, '101', { events: { 'pull_request.checks_failed': true } });
  await admin('/api/repositories/101/policy', 'PATCH', { enabled: false });
  await h.hook(acc.path, acc.secret, 'guard-disabled-90', {
    action: 'completed', repository: { id: 101 },
    workflow_run: { id: 7409, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: state.pr90Head, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'workflow_run' });
  assert.equal(count90(), beforeGuards);
});

test('onboarding manifest default_events covers check_run/check_suite/workflow_run; empty pull_requests[] attributes same-repo & fork PRs with review disabled; non-bot re-run bursts are throttled (#1427)', async t => {
  const fx = await createPrResponseFixture(t);
  const { h, admin, acc, onboarding, state, setSubscribedEvents } = fx;

  // 1. Derive the installation's subscribed event set directly from `/api/onboarding/manifest`.
  onboarding.save('public', { origin: 'https://hooks.invalid' });
  const prepared = await admin('/api/onboarding/manifest', 'POST', { organization: 'fixture', name: 'Fixture Bot' });
  assert.equal(prepared.status, 201);
  const manifestEvents = prepared.value.manifest.default_events;
  assert.ok(manifestEvents.includes('check_run') && manifestEvents.includes('check_suite') && manifestEvents.includes('workflow_run'));
  assert.deepEqual(
    accessGaps('github_app', JSON.stringify({ ...prepared.value.manifest.default_permissions, workflows: 'write' }), JSON.stringify(manifestEvents)),
    [],
    'onboarding manifest default_events has zero event gaps across all features',
  );
  setSubscribedEvents(manifestEvents);

  // 2. Disable PR review completely (`review_pull_requests: false`, PR review filters false), keep ONLY `pull_request.checks_failed: true`,
  //    and verify ZERO local PR tasks exist on PR #90/#91/#92.
  assert.equal((await admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'comment', review_pull_requests: false })).status, 200);
  await saveManager(admin, '101', {
    events: {
      'pull_request.opened': false,
      'pull_request.synchronize': false,
      'pull_request.updated': false,
      'pull_request.mention': false,
      'pull_request.checks_failed': true,
    },
  });
  assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE object_number IN (90,91,92)").n, 0);

  const pr92Head = shaOf('pr', 92, 1);
  state.pulls.set(92, {
    id: 5092, number: 92, title: 'ci: broken workflow yaml', body: 'Same-repo PR with startup_failure suite.', state: 'open', draft: false,
    mergeable: true, mergeable_state: 'clean', created_at: '2026-11-26T08:00:00Z', updated_at: '2026-11-26T08:00:00Z',
    user: { id: 802, login: 'carol', type: 'User' }, head: { sha: pr92Head, ref: 'carol/ci-fix', repo: { id: 101 } },
    base: { sha: state.baseMainSha, ref: 'main', repo: { id: 101 } }, labels: [],
    html_url: 'https://github.com/fixture/project-101/pull/92',
  });
  state.commitPulls.set(state.pr90Head, [state.pulls.get(90)]);
  state.commitPulls.set(state.pr91Head, [state.pulls.get(91)]);
  state.commitPulls.set(pr92Head, [state.pulls.get(92)]);

  // 3. Same-repo non-bot PR #90 `check_run` with `pull_requests: []` and NO local task wakes via `/commits/:sha/pulls`.
  await h.hook(acc.path, acc.secret, 'empty-prs-same-repo-cr-90', {
    action: 'completed',
    repository: { id: 101 },
    check_run: {
      id: 9401, name: 'unit', status: 'completed', conclusion: 'failure', head_sha: state.pr90Head,
      check_suite: { id: 5401, head_branch: 'alice/feat', run_attempt: 1 }, pull_requests: [],
    },
  }, { 'X-GitHub-Event': 'check_run' });
  const ev90 = h.store.all("SELECT * FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed'");
  assert.equal(ev90.length, 1, 'same-repo check_run with pull_requests: [] attributed with review off');
  assert.equal(JSON.parse(ev90[0].facts).bot_pull_request, false);

  // 4. Same-repo non-bot PR #92 `check_suite` (`startup_failure`, 0 check runs, `pull_requests: []`) wakes via `/commits/:sha/pulls`.
  await h.hook(acc.path, acc.secret, 'empty-prs-same-repo-cs-92', {
    action: 'completed',
    repository: { id: 101 },
    check_suite: {
      id: 5402, status: 'completed', conclusion: 'startup_failure', head_sha: pr92Head,
      head_branch: 'carol/ci-fix', app: { name: 'GitHub Actions' }, pull_requests: [],
    },
  }, { 'X-GitHub-Event': 'check_suite' });
  const ev92 = h.store.all("SELECT * FROM dispatch_events WHERE object_number=92 AND type='pull_request.checks_failed'");
  assert.equal(ev92.length, 1, 'same-repo check_suite startup_failure with pull_requests: [] attributed on default onboarding events');
  assert.equal(JSON.parse(ev92[0].facts).check.conclusion, 'startup_failure');

  // 5. Fork non-bot PR #91 `check_run` AND (on new head) `check_suite` with `pull_requests: []` and review off both wake via `/commits/:sha/pulls`.
  await h.hook(acc.path, acc.secret, 'empty-prs-fork-cr-91', {
    action: 'completed',
    repository: { id: 101 },
    check_run: {
      id: 9403, name: 'fork-build', status: 'completed', conclusion: 'failure', head_sha: state.pr91Head,
      check_suite: { id: 5403, head_branch: 'bob/fork-fix', run_attempt: 1 }, pull_requests: [],
    },
  }, { 'X-GitHub-Event': 'check_run' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=91 AND type='pull_request.checks_failed'").n, 1);

  const pr91Head2 = shaOf('pr', 91, 2);
  state.pulls.get(91).head.sha = pr91Head2;
  state.commitPulls.set(pr91Head2, [state.pulls.get(91)]);
  await h.hook(acc.path, acc.secret, 'empty-prs-fork-cs-91', {
    action: 'completed',
    repository: { id: 101 },
    check_suite: {
      id: 5404, status: 'completed', conclusion: 'startup_failure', head_sha: pr91Head2,
      head_branch: 'bob/fork-fix', app: { name: 'GitHub Actions' }, pull_requests: [],
    },
  }, { 'X-GitHub-Event': 'check_suite' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=91 AND type='pull_request.checks_failed'").n, 2);

  // 6. Direct push to `main` (commit has no open PR in `/commits/:sha/pulls`) produces 0 wakeups.
  const mainDirectSha = shaOf('main', 'direct', 1);
  state.commitPulls.set(mainDirectSha, [{ ...state.pulls.get(90), state: 'closed', head: { sha: mainDirectSha, ref: 'alice/feat', repo: { id: 101 } } }]);
  await h.hook(acc.path, acc.secret, 'direct-main-cr', {
    action: 'completed',
    repository: { id: 101 },
    check_run: { id: 9405, name: 'ci', status: 'completed', conclusion: 'failure', head_sha: mainDirectSha, check_suite: { id: 5405, head_branch: 'main' }, pull_requests: [] },
  }, { 'X-GitHub-Event': 'check_run' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE type='pull_request.checks_failed'").n, 4);

  // 7. Non-bot PR throttling (F2): a DIFFERENT suite (#5499) on the same head wakes even while #5401 is `pending`,
  //    whereas repeated Re-runs (`attempt: 2, 3`) of the SAME suite (#5401) on the unchanged head are throttled both
  //    while `pending` and within the 10-minute cooldown window; a NEW commit push wakes immediately!
  await h.hook(acc.path, acc.secret, 'distinct-suite-while-pending-90', {
    action: 'completed',
    repository: { id: 101 },
    check_suite: { id: 5499, status: 'completed', conclusion: 'failure', head_sha: state.pr90Head, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'check_suite' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed'").n, 2, 'distinct workflow/suite on same head wakes even while another suite is pending');

  await h.hook(acc.path, acc.secret, 'throttle-rerun-while-pending-90', {
    action: 'completed',
    repository: { id: 101 },
    check_run: { id: 9410, name: 'unit', status: 'completed', conclusion: 'failure', head_sha: state.pr90Head, check_suite: { id: 5401, run_attempt: 2 }, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'check_run' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed'").n, 2, 'same-suite Re-run while pending is throttled');

  h.store.run("UPDATE dispatch_events SET state='decided' WHERE object_number=90 AND type='pull_request.checks_failed'");
  await h.hook(acc.path, acc.secret, 'throttle-rerun-attempt3-90', {
    action: 'completed',
    repository: { id: 101 },
    check_run: { id: 9411, name: 'unit', status: 'completed', conclusion: 'failure', head_sha: state.pr90Head, check_suite: { id: 5401, run_attempt: 3 }, pull_requests: [{ number: 90 }] },
  }, { 'X-GitHub-Event': 'check_run' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed'").n, 2, 'same-suite Re-run attempt 3 on unchanged head is throttled within cooldown');

  const pr90Head2 = shaOf('pr', 90, 2);
  state.pulls.get(90).head.sha = pr90Head2;
  state.commitPulls.set(pr90Head2, [state.pulls.get(90)]);
  await h.hook(acc.path, acc.secret, 'new-head-wakes-90', {
    action: 'completed',
    repository: { id: 101 },
    check_run: { id: 9412, name: 'unit', status: 'completed', conclusion: 'failure', head_sha: pr90Head2, check_suite: { id: 5406, run_attempt: 1 }, pull_requests: [] },
  }, { 'X-GitHub-Event': 'check_run' });
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=90 AND type='pull_request.checks_failed'").n, 3, 'new commit push wakes immediately');
});
