import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
import { ActionsFailures, scanPageSize } from '../../../../dist/actions/service.js';
import { failedStepOutput } from '../../../../dist/actions/classifier.js';
import { configureDispatch, ruleDecider } from '../../../../dist/dispatch/worker.js';
import { managerDecision } from '../../../../dist/dispatch/manager.js';
import { applyDecision, dispatchContext } from '../../../../dist/dispatch/store.js';
import { grantedWrites } from '../../../../dist/tasks/grants.js';
import { grantedTaskWrite } from '../../../../dist/tasks/github-write.js';
import { roleConfiguration, saveConfiguration } from '../../../../dist/roles/definition.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { appEvents } from '../../../../dist/github/client.js';
import { emptyRepositoryFixture } from '../../../fixtures/empty-repository-helpers.mjs';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const head = 'a'.repeat(40), at = '2026-11-04T01:00:00Z';
const job = (extra = {}) => ({ id: 91, run_id: 800, run_attempt: 1, name: 'test', conclusion: 'failure',
  steps: [{ number: 2, name: 'Check', conclusion: 'failure', started_at: at, completed_at: '2026-11-04T01:00:10Z' }], ...extra });
const log = text => text.split('\n').map(line => `2026-11-04T01:00:05.000Z ${line}`).join('\n');
const run = (extra = {}) => ({ id: 800, run_attempt: 1, repository: { id: 101 }, name: 'Nightly', workflow_id: 10, head_sha: head, head_branch: 'main',
  event: 'schedule', status: 'completed', conclusion: 'failure', created_at: new Date(Date.now() - 30_000).toISOString(), updated_at: new Date(Date.now() + 60_000).toISOString(), pull_requests: [], ...extra });

async function fixture(t, options = {}) {
  const state = { runs: [run()], jobs: [job()], log: log('HTTPError: HTTP 429 Too Many Requests'), requests: [], issues: [], comments: [],
    events: [...appEvents, 'workflow_run'], permissions: { metadata: 'read', contents: 'write', issues: 'write', actions: 'write', pull_requests: 'read' }, tokens: [],
    // Tag refs by name ({ type, sha } as GitHub's git ref object) and annotated tag objects by SHA.
    tags: {}, tagObjects: {}, ...options };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fixture'), path = url.pathname, body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({ method: req.method, path, query: url.search, body, authorization: req.headers.authorization });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (state.custom && await state.custom({ req, res, url, path, body, send })) return;
    if (path === '/app') return send({ slug: 'actions-fixture' });
    if (path === '/users/actions-fixture%5Bbot%5D') return send({ login: 'actions-fixture[bot]', id: 97 });
    if (path === '/repos/fixture/project-101/installation') return send({ id: 9, account: { id: 10 }, events: state.events, permissions: state.permissions });
    if (path.endsWith('/access_tokens')) {
      state.tokens.push(body);
      // state.tokenLife (ms): like GitHub, each token is new and says when it expires (#1411).
      if (!state.tokenLife) return send({ token: 'fixture-actions-installation-token' });
      return send({ token: 'fixture-actions-installation-token-' + state.tokens.length, expires_at: new Date(Date.now() + state.tokenLife).toISOString() });
    }
    if (path === '/installation/token') return send({});
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main' });
    if (path.endsWith('/actions/runs')) {
      const [from, until] = url.searchParams.get('created').split('..').map(Date.parse), page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('per_page'));
      const filtered = state.runs.filter(r => Date.parse(r.created_at) >= from && Date.parse(r.created_at) <= until).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return send({ total_count: filtered.length, workflow_runs: filtered.slice((page - 1) * size, page * size) });
    }
    const jobs = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(path);
    if (jobs) { const items = state.jobs.map(j => ({ ...j, run_id: Number(jobs[1]), run_attempt: Number(jobs[2]) })); return send({ total_count: items.length, jobs: items }); }
    if (/\/actions\/jobs\/\d+\/logs$/.test(path)) { if (state.log === null) return send({}, 404); res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(state.log); }
    const single = /\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/.exec(path);
    if (single) { const r = state.runs.find(r => r.id === Number(single[1])); return r ? send({ ...r, run_attempt: Number(single[2] || r.run_attempt) }) : send({}, 404); }
    if (path.includes('/compare/')) return send({ merge_base_commit: { sha: state.runs[0].head_sha } });
    const tagRef = /\/git\/ref\/tags\/(.+)$/.exec(path), tagObject = /\/git\/tags\/([a-f0-9]{40})$/.exec(path);
    if (tagRef) { const name = decodeURIComponent(tagRef[1]); return state.tags[name] ? send({ ref: 'refs/tags/' + name, object: state.tags[name] }) : send({ message: 'Not Found' }, 404); }
    if (tagObject) return state.tagObjects[tagObject[1]] ? send({ sha: tagObject[1], object: state.tagObjects[tagObject[1]] }) : send({ message: 'Not Found' }, 404);
    if (path.endsWith('/rerun-failed-jobs')) {
      if (state.denyRerun) return send({ message: 'Resource not accessible by integration' }, 403);
      const r = state.runs.find(r => path.endsWith(`/${r.id}/rerun-failed-jobs`));
      if (!state.noAdvance) Object.assign(r, { run_attempt: r.run_attempt + 1, status: 'queued', conclusion: null });
      if (state.unknownRerun) return req.socket.destroy();
      return send({}, 201);
    }
    if (path.endsWith('/issues')) {
      if (req.method === 'GET') return send(state.issues);
      const issue = { assignees: [], labels: [], ...body, number: state.issues.length + 1, user: { id: 97 }, state: 'open' }; state.issues.push(issue);
      if (state.unknownIssue) return req.socket.destroy();
      return send(issue, 201);
    }
    const existing = /^.*\/issues\/(\d+)$/.exec(path);
    if (existing && req.method === 'GET') {
      const issue = state.issues.find(i => i.number === Number(existing[1]));
      return issue ? send(issue) : send({}, 404);
    }
    const comments = /\/issues\/(\d+)\/comments$/.exec(path);
    if (comments) {
      if (req.method === 'GET') return send(state.comments.filter(c => c.number === Number(comments[1])));
      state.comments.push({ id: state.comments.length + 1, number: Number(comments[1]), user: { id: 97 }, ...body });
      if (state.unknownComment) return req.socket.destroy();
      return send(state.comments.at(-1), 201);
    }
    return send({ message: 'Unknown fixture endpoint: ' + path }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const apiUrl = `http://127.0.0.1:${server.address().port}`, h = await harness(t, undefined, { githubUrl: apiUrl }), { admin } = await setup(h);
  const a = await account(admin, { type: 'github_app', app_id: '1', private_key: pem, token: undefined }); await repository(admin, a.id, '101');
  const policy = changes => admin('/api/repositories/101/policy', 'PATCH', changes);
  const modelRequests = [];
  const modelServer = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    modelRequests.push(JSON.parse(input));
    const args = options.decision ?? { role: 'dev', writes: ['github', 'actions_rerun'], reason: '调查失败运行' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'dispatch', type: 'function',
      function: { name: 'create_task', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }));
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  t.after(() => new Promise(resolve => { modelServer.close(resolve); modelServer.closeAllConnections(); }));
  const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'analysis', api_url: `http://127.0.0.1:${modelServer.address().port}/v1`, api_key: 'actions-analysis-model-key' })).value.model;
  const enabled = await policy({ actions_failures_enabled: true, review_enabled: true, development_enabled: true, model_id: model.id });
  assert.equal(enabled.status, 200);
  configureDispatch(null);
  t.after(() => configureDispatch(ruleDecider));
  let service = new ActionsFailures(h.store, apiUrl);
  const scan = async () => { h.store.run('UPDATE actions_failure_scans SET next_scan=0'); await service.tick(); };
  // One five-second tick as the timer runs it, without making the scan due.
  const poll = () => service.tick();
  const dispatch = async decide => {
    for (const event of h.store.all("SELECT * FROM dispatch_events WHERE type='actions.run_failed' AND state='pending' ORDER BY rowid")) {
      applyDecision(h.store, event, await decide(h.store, event, apiUrl), null);
    }
  };
  const tick = async () => {
    await scan();
    await dispatch((_store, event) => ({ decision: 'create', option_ids: [], role: 'dev', writes: ['github', 'actions_rerun'], reason: event.summary }));
    await scan();
  };
  const hook = (r = state.runs[0], delivery = 'actions-' + Math.random()) => h.hook(a.path, a.secret, delivery, { action: 'completed', repository: { id: 101 }, workflow_run: r }, { 'X-GitHub-Event': 'workflow_run' });
  const restart = async () => { await service.close(); await h.stop(); await h.start(); service = new ActionsFailures(h.store, apiUrl); };
  const reruns = () => state.requests.filter(r => r.method === 'POST' && r.path.endsWith('/rerun-failed-jobs'));
  const events = () => h.store.all("SELECT * FROM dispatch_events WHERE type='actions.run_failed' ORDER BY rowid");
  const tasks = () => h.store.all("SELECT t.* FROM tasks t JOIN task_events l ON l.task_id=t.id JOIN dispatch_events e ON e.id=l.event_id WHERE e.type='actions.run_failed' ORDER BY t.rowid");
  const write = (task = tasks()[0]) => grantedTaskWrite(h.store, task, new Redactor(), async () => {}, apiUrl);
  return { state, h, a, admin, policy, hook, tick, scan, poll, restart, reruns, apiUrl, modelRequests, events, tasks, write };
}


test('event excerpts contain the failed steps rather than unrelated earlier output', () => {
  const prior = '2026-11-04T00:59:00Z HTTPError: HTTP 429\n';
  assert.deepEqual(failedStepOutput(job(), prior + log('AssertionError: failed')).lines, ['AssertionError: failed']);
  assert.match(failedStepOutput(job(), null).problem, /Missing/);
});

test('the Manager dispatches a default-branch failure and the task can file or reply using repository-specific wording', async t => {
  const f = await fixture(t, { log: log('expected 3, got 2') });
  await f.hook();
  await f.scan();
  const event = f.events()[0];
  scriptedRoles(f.h.store, '101');
  const context = dispatchContext(f.h.store, event);
  const decision = await managerDecision(f.h.store, context, f.apiUrl);
  assert.equal(decision.role, 'dev');
  assert.deepEqual(decision.target, { type: 'commit', ref: head });
  applyDecision(f.h.store, event, decision, null);
  const task = f.tasks()[0], input = JSON.parse(task.input);
  assert.equal(task.kind, 'task.request');
  assert.equal(task.head_sha, head);
  assert.deepEqual(input.target, { type: 'commit', ref: head });
  assert.deepEqual(grantedWrites(f.h.store, task.id), ['github', 'actions_rerun']);
  assert.equal(input.event_adapter, undefined);
  const runContext = JSON.parse(input.context_files['run.json']);
  assert.equal(runContext.run.branch, 'main');
  assert.equal(runContext.failed_jobs[0].output_tail, 'expected 3, got 2');
  assert.equal(input.run_id, 800);
  assert.ok(f.modelRequests.length);
  assert.ok(f.state.tokens.some(token => token.permissions?.actions === 'read' && !token.permissions?.issues));

  const write = f.write(task);
  const body = { title: '打包清单缺少一个文件', body: '触发提交 ' + head + '，清单预期 3 项，实际 2 项。', labels: ['缺陷'], assignees: ['maintainer'] };
  const filed = await write('github_write', { method: 'POST', path: '/issues', key: 'package-incomplete', body });
  assert.equal(filed.status, 201, JSON.stringify(filed));
  assert.equal(f.state.issues[0].title, body.title);
  assert.ok(f.state.issues[0].body.startsWith(body.body));
  assert.deepEqual(f.state.issues[0].labels, body.labels);
  assert.deepEqual(f.state.issues[0].assignees, body.assignees);
  const reply = await write('github_write', { method: 'POST', path: '/issues/1/comments', key: 'new-log', body: { body: '复查时确认归档缺少版本文件。' } });
  assert.equal(reply.status, 201, JSON.stringify(reply));
  assert.equal(f.state.comments.length, 1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM actions_failure_reports').n, 0);
  await f.scan();
  assert.equal(f.h.store.get('SELECT state FROM actions_failure_attempts').state, 'done');
});

test('the generic rerun uses the failed attempt and honors its one-run budget, including historical sends', async t => {
  const f = await fixture(t, { noAdvance: true });
  await f.hook();
  await f.tick();
  const task = f.tasks()[0];
  const args = { job_ids: [91], reason: 'The package index rate limited the run.', evidence: ['HTTPError: HTTP 429 Too Many Requests'] };
  const write = f.write(task);
  assert.equal((await write('rerun_failed_run', { ...args, run_id: 999 })).error, 'actions_run_identity_changed');
  f.state.runs[0].run_attempt = 2;
  assert.equal((await write('rerun_failed_run', args)).error, 'actions_attempt_identity_changed');
  f.state.runs[0].run_attempt = 1;
  f.h.store.run("UPDATE actions_failure_runs SET retry_state='unknown'");
  assert.equal((await write('rerun_failed_run', args)).error, 'rerun_budget_exhausted');
  assert.equal(f.reruns().length, 0);
  f.h.store.run("UPDATE actions_failure_runs SET retry_state='none'");
  const results = await Promise.all([write('rerun_failed_run', args), write('rerun_failed_run', args)]);
  assert.equal(results.filter(result => result.rerun_requested).length, 1);
  assert.equal(results.filter(result => result.error === 'rerun_budget_exhausted').length, 1);
  await f.restart();
  assert.equal((await f.write(task)('rerun_failed_run', args)).error, 'rerun_budget_exhausted');
  assert.equal(f.reruns().length, 1);
});

test('project and Manager permission changes fence delivery using standard grants', async t => {
  const f = await fixture(t);
  await f.hook();
  await f.tick();
  const task = f.tasks()[0], write = f.write(task);
  const args = { method: 'POST', path: '/issues', key: 'restricted', body: { title: 'Pack failed', body: 'A file is missing from the artifact.' } };
  await f.policy({ capability_ceiling: 'read' });
  assert.equal((await write('github_write', args)).error, 'delivery_not_granted');
  await f.policy({ capability_ceiling: 'comment' });
  const configuration = roleConfiguration(f.h.store, '101'), manager = configuration.roles.find(role => role.role_id === 'manager');
  saveConfiguration(f.h.store, '101', { expected_revision: configuration.revision, roles: [{
    role_id: 'manager', permissions: { ...manager.permissions, github_issues: 'read', github_pull_requests: 'read', github_actions: 'read', github_contents: 'read' },
  }] }, 'fixture');
  assert.equal((await write('github_write', args)).error, 'delivery_not_granted');
  assert.equal((await write('rerun_failed_run', { job_ids: [91], reason: 'External', evidence: ['429'] })).error, 'delivery_not_granted');
  assert.equal(f.state.issues.length, 0);
  assert.equal(f.reruns().length, 0);
});

test('a pending legacy decision is converted and stored history survives restart without replaying publication', async t => {
  const f = await fixture(t);
  f.state.runs.push(run({ id: 801 }));
  await f.hook(f.state.runs[0]); await f.hook(f.state.runs[1]); await f.scan();
  const pending = f.events().find(e => e.event_key.endsWith(':800:1'));
  f.h.store.run('UPDATE dispatch_events SET options=? WHERE id=?', JSON.stringify([
    { id: 'analysis', work: 'actions.failures', default: true, spec: { type: 'event', kind: 'actions.failures', key: '800:1', sha: head, input: {} } },
  ]), pending.id);
  const history = JSON.stringify({ version: 2, evidence: [{ quote: 'Recorded before upgrade' }] });
  f.h.store.run("UPDATE actions_failure_attempts SET classification='code',data=? WHERE run_id=801", history);
  f.h.store.run("DELETE FROM dispatch_events WHERE event_key LIKE '%:801:1'");
  f.h.store.run("INSERT INTO actions_failure_reports(id,repository_id,run_id,attempt,signature,classification,body,title) VALUES('prior','101',801,1,'fixture','code','Original text','Previous title')");
  await f.restart();
  const result = applyDecision(f.h.store, pending, { decision: 'create', option_ids: ['analysis'], reason: 'Reuse old option', writes: ['issue'] }, null);
  assert.equal(result.created.length, 1);
  assert.equal(f.tasks()[0].kind, 'task.request');
  assert.deepEqual(grantedWrites(f.h.store, result.created[0]), ['github']);
  await f.scan();
  const attempt = f.h.store.get('SELECT state,classification,data FROM actions_failure_attempts WHERE run_id=801');
  assert.deepEqual({ ...attempt }, { state: 'done', classification: 'code', data: history });
  assert.equal(f.h.store.get("SELECT body FROM actions_failure_reports WHERE id='prior'").body, 'Original text');
  assert.equal(f.state.issues.length, 0);
  assert.equal(f.reruns().length, 0);
});

test('PR failures, cancelled, skipped, successful and other-branch runs are ignored', async t => {
  const cases = [{ event: 'pull_request' }, { event: 'pull_request_target' }, { pull_requests: [{ number: 1 }] }, { conclusion: 'cancelled' }, { conclusion: 'skipped' }, { conclusion: 'success' }, { head_branch: 'feature' }];
  const f = await fixture(t, { log: log('AssertionError: failed') }); f.state.runs = cases.map((change, i) => run({ id: 810 + i, ...change }));
  for (const r of f.state.runs) await f.hook(r); await f.tick(); assert.equal(f.state.issues.length, 0); assert.equal(f.reruns().length, 0);
  assert.ok(!f.state.requests.some(r => r.path.endsWith('/logs')));
});

test('a failed version-tag run of any workflow on the default branch history is handled once as a version-tag run, apart from releases (#1028)', async t => {
  // An annotated v1.2.3 tag on a default-branch commit, pushed for a workflow that is not called Release.
  const tagObject = 'c'.repeat(40), f = await fixture(t, { log: log('AssertionError: package lists 2 files; expected 3'), workflow: 'name: Publish\non: {push: {tags: [v*]}}\n',
    tags: { 'v1.2.3': { type: 'tag', sha: tagObject } }, tagObjects: { [tagObject]: { type: 'commit', sha: head } } });
  f.state.runs[0] = run({ name: 'Publish', head_branch: 'v1.2.3', event: 'push' });
  // The release page's record of this version: Actions failure handling neither reads it nor changes it.
  f.h.store.run(`INSERT INTO project_releases(id,repository_id,version,target_sha,actor_id,stage,active,data,created_at,updated_at)
    VALUES('release-v1.2.3','101','v1.2.3',?,'fixture','published',0,'{"detail":"release page record"}',?,?)`, head, at, at);
  const releases = () => JSON.stringify(['project_releases', 'release_preflights', 'release_effects', 'release_observers', 'release_attempts'].map(table => f.h.store.all(`SELECT * FROM ${table}`)));
  const before = releases();
  // The same run delivered twice under one delivery id and once under another, then found again by the next scan.
  await f.hook(f.state.runs[0], 'tag-run'); await f.hook(f.state.runs[0], 'tag-run'); await f.hook(); await f.tick(); await f.hook(); await f.tick();
  // One event for the Manager, saying it is a version-tag run and naming the tag instead of a branch.
  const events = f.h.store.all("SELECT * FROM dispatch_events WHERE type='actions.run_failed'");
  assert.equal(events.length, 1); assert.equal(events[0].summary, 'Actions 运行失败（版本标签运行 v1.2.3）：Publish run 800 / attempt 1');
  const facts = JSON.parse(events[0].facts).run;
  assert.deepEqual([facts.tag_run, facts.tag, facts.branch, facts.workflow, facts.event, facts.head_sha], [true, 'v1.2.3', undefined, 'Publish', 'push', head]);
  // One analysis, on the tagged commit, with the tag in its run.json and in its title.
  const tasks = f.tasks();
  assert.equal(tasks.length, 1); assert.match(tasks[0].summary, /版本标签运行 v1\.2\.3/);
  const input = JSON.parse(tasks[0].input);
  assert.equal(tasks[0].kind, 'task.request'); assert.deepEqual(input.target, { type: 'commit', ref: head });
  assert.deepEqual(JSON.parse(input.context_files['run.json']).run, facts);
  assert.equal(f.state.issues.length, 0); assert.equal(f.reruns().length, 0);
  assert.equal(f.h.store.get("SELECT count(*) n FROM actions_failure_attempts WHERE state='done'").n, 1);
  // The release side is untouched: the same records, no CI observation or release notes, no release request.
  assert.equal(releases(), before);
  assert.equal(f.h.store.get("SELECT count(*) n FROM tasks WHERE kind IN ('release.observe','release.notes')").n, 0);
  assert.equal(f.h.store.get("SELECT count(*) n FROM dispatch_events WHERE type='release.manual'").n, 0);
  assert.ok(!f.state.requests.some(r => r.path.includes('/releases')));
});

test('tags off the default branch history, branches that are not tags and PR runs are not version-tag runs (#1028)', async t => {
  const other = 'b'.repeat(40), f = await fixture(t, { log: log('AssertionError: failed'), workflow: 'name: Publish\non: {push: {tags: [v*]}}\n',
    tags: { 'v1.2.3': { type: 'commit', sha: head }, 'v2.0.0-rc.1': { type: 'commit', sha: other } } });
  f.state.runs = [
    // The tag's commit is only on another branch: the default branch history does not contain it.
    run({ id: 820, name: 'Publish', event: 'push', head_branch: 'v2.0.0-rc.1', head_sha: other }),
    // A pushed branch, not a tag, although its commit is on the default branch history.
    run({ id: 821, name: 'Publish', event: 'push', head_branch: 'release/next' }),
    // The tag of that name now names another commit than the run's.
    run({ id: 822, name: 'Publish', event: 'push', head_branch: 'v2.0.0-rc.1' }),
    // PR-related runs, even with a tag's name as their head.
    run({ id: 823, name: 'Publish', event: 'pull_request', head_branch: 'v1.2.3' }),
    run({ id: 824, name: 'Publish', event: 'push', head_branch: 'v1.2.3', pull_requests: [{ number: 1 }] })];
  f.state.custom = ({ path, send }) => { if (path.includes('/compare/' + other)) { send({ merge_base_commit: { sha: 'd'.repeat(40) } }); return true; } return false; };
  for (const r of f.state.runs) await f.hook(r); await f.tick();
  assert.equal(f.h.store.get("SELECT count(*) n FROM dispatch_events WHERE type='actions.run_failed'").n, 0);
  assert.equal(f.state.issues.length, 0); assert.equal(f.reruns().length, 0);
  assert.ok(!f.state.requests.some(r => r.path.endsWith('/logs')));
  assert.equal(f.h.store.get("SELECT count(*) n FROM actions_failure_attempts WHERE state='done'").n, 5);
  // PR runs are excluded before any lookup; only the tag that names the run's own commit is compared with the default branch.
  assert.ok(!f.state.requests.some(r => r.path.endsWith('/git/ref/tags/v1.2.3')));
  assert.deepEqual(f.state.requests.filter(r => r.path.includes('/compare/')).map(r => r.path.split('/compare/')[1]), [`${other}...main`]);
});

test('subscription validation is per enabled repository, visible in API, and does not change global events', async t => {
  const f = await fixture(t, { events: [...appEvents] }); await f.hook(); await f.tick(); assert.equal(f.state.issues.length, 0); assert.equal(f.reruns().length, 0);
  assert.equal((await f.admin('/api/repositories/101')).value.actions_failures.error, 'actions_workflow_run_subscription_missing');
  assert.ok(!appEvents.includes('workflow_run')); await f.policy({ actions_failures_enabled: false }); f.state.requests.length = 0; await f.tick(); assert.equal(f.state.requests.length, 0);
});

test('an installation without Actions access is reported as such, not as a missing workflow_run subscription', async t => {
  // GitHub offers Workflow run only to an App with Actions read; the Workflows permission plays no part.
  const f = await fixture(t, { events: [...appEvents], permissions: { contents: 'write', issues: 'write', workflows: 'write' } }); await f.hook(); await f.tick();
  assert.equal((await f.admin('/api/repositories/101')).value.actions_failures.error, 'actions_permission_missing');
  assert.equal(f.state.issues.length, 0); assert.equal(f.reruns().length, 0);
  assert.ok(!f.state.requests.some(r => /\/actions\/runs/.test(r.path)), 'no run is read before the configuration is complete');
  // Read-only Actions access is enough for the subscription check to pass.
  f.state.permissions = { contents: 'write', issues: 'write', actions: 'read' }; f.state.events = [...appEvents, 'workflow_run'];
  await f.tick();
  assert.equal((await f.admin('/api/repositories/101')).value.actions_failures.error, null);
});

test('activation does not backfill completed history; an older running workflow is followed to completion', async t => {
  const f = await fixture(t, { log: log('AssertionError: failed') });
  f.state.runs = [run({ id: 801, updated_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }), run({ id: 802, status: 'in_progress', conclusion: null, created_at: '2026-01-01T00:00:00Z' })];
  await f.tick(); assert.equal(f.state.issues.length, 0); assert.equal(f.h.store.get('SELECT run_id FROM actions_failure_runs').run_id, 802);
  Object.assign(f.state.runs[1], { status: 'completed', conclusion: 'failure' }); await f.tick(); assert.equal(f.events().length, 1); assert.equal(f.events()[0].event_key, '101:actions.run_failed:802:1');
});

test('scan persists the current page, retries failed items, and never passes an unprocessed page across restart', async t => {
  const f = await fixture(t, { log: log('AssertionError: failed') }), created = new Date(Date.now() - 30_000).toISOString(); f.state.runs = Array.from({ length: scanPageSize + 1 }, (_, i) => run({ id: 800 + i, created_at: created }));
  let broken = true; f.state.custom = ({ path, send }) => { if (broken && path.endsWith('/actions/runs/801')) { send({}, 503); return true; } return false; };
  await f.tick(); let scan = f.h.store.get('SELECT * FROM actions_failure_scans'); assert.equal(JSON.parse(scan.windows)[0].page, 1); assert.equal(JSON.parse(scan.page_data).index, 1);
  // One scan finishes the first page (its runs wait for their analysis) and stops at the second.
  assert.equal(f.events().length, 1); broken = false; await f.restart(); await f.scan(); scan = f.h.store.get('SELECT * FROM actions_failure_scans');
  assert.equal(JSON.parse(scan.windows)[0].page, 2); await f.tick(); assert.equal(f.h.store.get('SELECT windows FROM actions_failure_scans').windows, '[]');
  assert.equal(f.events().length, scanPageSize + 1); assert.equal(f.tasks().length, scanPageSize + 1);
});

test('overlapping workers and duplicate event/scan delivery create one investigation', async t => {
  const f = await fixture(t); await f.hook(f.state.runs[0], 'duplicate'); await f.hook(f.state.runs[0], 'duplicate');
  await Promise.all([f.tick(), new ActionsFailures(f.h.store, f.apiUrl).tick()]); assert.equal(f.tasks().length, 1); assert.equal(f.h.store.get('SELECT count(*) n FROM actions_failure_attempts').n, 1);
});

test('a policy disabled while reading evidence fences the outgoing write', async t => {
  const f = await fixture(t, { log: log('AssertionError: failed') });
  f.state.custom = ({ path }) => { if (path.endsWith('/logs')) f.h.store.run('UPDATE policies SET actions_failures_enabled=0'); return false; };
  await f.tick(); assert.equal(f.events().length, 0); assert.equal(f.state.issues.length, 0); assert.equal(f.reruns().length, 0);
});

test('publication of an Actions code issue rechecks the label it started on, not its assignees (#1104), before any write', async t => {
  for (const [change, code] of [[{ labels: [] }, 'development_not_approved'], [{ assignees: [{ login: 'person' }] }, 'actions_workflow_run_subscription_missing']]) {
    const issue = { id: 1, number: 1, state: 'open', title: 'Fix the assertion', body: 'Wrong result on the latest build.', labels: ['bot-develop'], assignees: [], ...change };
    const writes = [], f = await emptyRepositoryFixture(t, { github: (path, send, res) => {
      if (res.req.method !== 'GET') writes.push(path);
      if (path.endsWith('/issues/1')) { send(issue); return true; }
      return false;
    } });
    f.setBranch('ready'); await f.admin('/api/repositories/101/policy', 'PATCH', { actions_failures_enabled: true, development_enabled: true });
    f.store.run("UPDATE actions_failure_scans SET configured_at='2026-11-04T00:00:00Z'");
    f.store.run("INSERT INTO actions_failure_issues VALUES('101',1,'fixture','code')");
    f.store.run("UPDATE tasks SET kind='development.issue',phase='publish',input=? WHERE id=?", JSON.stringify({ review: { product_defect: true, request_quote: 'Fix the assertion.' } }), f.taskId);
    const branch = 'bot/issue-1-' + f.taskId; f.store.run("INSERT INTO bot_branches VALUES('101',?,?)", branch, f.taskId);
    f.store.run('INSERT INTO development_candidates VALUES(?,?)', f.taskId, JSON.stringify({ branch, owner_task_id: f.taskId, files: [], base_branch: 'main', base_sha: f.commit }));
    // Without a recorded basis a development started on the label; the fixture's installation lacks the workflow_run subscription.
    const result = await f.run(); assert.equal(result.error_code, code, JSON.stringify(change));
    assert.deepEqual(writes, []);
  }
});

test('scan splits oversized windows before consuming a page and refuses to skip an overflowing second', async t => {
  const f = await fixture(t); let split = true;
  f.state.custom = ({ path, send }) => { if (path.endsWith('/actions/runs') && split) { split = false; send({ total_count: 1001, workflow_runs: [] }); return true; } return false; };
  await f.scan(); assert.equal(JSON.parse(f.h.store.get('SELECT windows FROM actions_failure_scans').windows).length, 2); assert.equal(f.reruns().length, 0);
  await f.restart(); await f.tick(); await f.tick(); assert.equal(f.events().length, 1);
  const second = Math.floor(Date.now() / 1000) - 40;
  f.h.store.run('UPDATE actions_failure_scans SET windows=?,cursor=0,page_data=NULL', JSON.stringify([{ from: second, until: second, page: 1 }]));
  f.state.custom = ({ path, send }) => { if (path.endsWith('/actions/runs')) { send({ total_count: 1001, workflow_runs: [] }); return true; } return false; };
  await f.tick(); const state = f.h.store.get('SELECT * FROM actions_failure_scans'); assert.equal(state.error, 'actions_scan_window_overflow'); assert.equal(state.cursor, 0); assert.equal(JSON.parse(state.windows)[0].page, 1);
});

test('a person can rerun an untracked run and discovery finds the attempt without its webhook', async t => {
  const f = await fixture(t);
  const listings = () => f.state.requests.filter(r => r.path.endsWith('/actions/runs') && r.query.includes('per_page=100')).length;
  await f.tick();
  assert.equal(f.events().length, 1); assert.equal(listings(), 1);
  assert.equal(f.h.store.get('SELECT tracking FROM actions_failure_runs').tracking, 0);
  f.state.runs[0].run_attempt = 2;
  await f.tick();
  assert.equal(listings(), 1); assert.equal(f.events().length, 1);
  f.h.store.run('UPDATE actions_failure_scans SET reconciled_at=0'); await f.tick();
  assert.equal(listings(), 2); assert.equal(f.events().length, 2);
  assert.equal(f.tasks().length, 2); assert.equal(f.reruns().length, 0);
});

test('without webhooks a repository is scanned every 10 minutes on one connection, and a delivery is processed on the next tick (#1411)', async t => {
  const f = await fixture(t, { tokenLife: 3600_000, runs: [] });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const sent = match => f.state.requests.filter(match).length;
  const connects = () => sent(r => r.path === '/repositories/101'), mints = () => sent(r => r.path.endsWith('/access_tokens'));
  const scans = () => sent(r => r.path.endsWith('/actions/runs') && r.query.includes(`per_page=${scanPageSize}`));
  const revoked = () => f.state.requests.filter(r => r.path === '/installation/token').map(r => r.authorization);
  await f.poll();
  assert.deepEqual([connects(), mints(), scans()], [1, 1, 1]);
  // Nothing is due for the next ten minutes: the five-second ticks send nothing.
  const quiet = f.state.requests.length;
  t.mock.timers.tick(10 * 60_000 - 1); await f.poll();
  assert.equal(f.state.requests.length, quiet);
  // The fallback scan reuses the connection: no installation lookup, token or GET /repositories/:id, and no revoke.
  t.mock.timers.tick(1); await f.poll();
  assert.deepEqual([connects(), mints(), scans(), revoked().length], [1, 1, 2, 0]);
  assert.ok(f.state.requests.slice(quiet).every(r => r.authorization === 'Bearer fixture-actions-installation-token-1'));
  // A workflow_run delivery is processed on the next tick, long before the next scan is due.
  t.mock.timers.tick(60_000);
  f.state.runs = [run()]; await f.hook(f.state.runs[0]); await f.poll();
  assert.equal(f.events().length, 1); assert.equal(f.events()[0].event_key, '101:actions.run_failed:800:1');
  assert.deepEqual([connects(), mints()], [1, 1]);
  // With less than 15 minutes left the token is revoked and the repository connects again.
  t.mock.timers.tick(35 * 60_000); await f.poll();
  assert.deepEqual([connects(), mints()], [2, 2]);
  assert.deepEqual(revoked(), ['Bearer fixture-actions-installation-token-1']);
  // Switching the feature off revokes the token on the next tick.
  await f.policy({ actions_failures_enabled: false }); await f.poll();
  assert.deepEqual(revoked(), ['Bearer fixture-actions-installation-token-1', 'Bearer fixture-actions-installation-token-2']);
});
