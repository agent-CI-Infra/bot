import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository, testPassword } from '../../../fixtures/helpers.mjs';
import { insertTaskLog } from '../../../../dist/storage/payloads.js';
import { withRunTraceScope } from '../../../../dist/tasks/trace.js';
import { pruneCommitChecks } from '../../../../dist/tasks/external-links.js';
import { RetentionCleanup } from '../../../../dist/storage/retention.js';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';
import { appEvents } from '../../../../dist/github/client.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';

test('parallel role runs stamp exact run_id and role on task_logs without cross-contamination', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,phase,created_at,updated_at) VALUES('t-par','101','development.issue','running','Parallel test','model','2026-11-16T08:00:00Z','2026-11-16T08:00:00Z')");
  const taskRow = h.store.get("SELECT * FROM tasks WHERE id='t-par'");
  h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role) VALUES('run-rev','t-par','execution',1,1,'2026-11-16T08:01:00Z','running','{}','{}','reviewer')");
  h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role) VALUES('run-tst','t-par','execution',1,1,'2026-11-16T08:01:00Z','running','{}','{}','test')");

  await Promise.all([
    withRunTraceScope('t-par', 'run-rev', 'reviewer', async () => {
      await new Promise(r => setTimeout(r, 5));
      insertTaskLog(h.store, taskRow, JSON.stringify({ type: 'tool', name: 'read_file', arguments: { path: 'src/a.ts' }, result: { bytes: 120 } }));
    }),
    withRunTraceScope('t-par', 'run-tst', 'test', async () => {
      insertTaskLog(h.store, taskRow, JSON.stringify({ type: 'command', command: 'npm test', exit_code: 0, output: 'ok' }));
    }),
  ]);

  const res = await admin('/api/tasks/t-par/logs');
  assert.equal(res.status, 200);
  const byRole = Object.fromEntries(res.value.logs.map(l => [l.role, l.run_id]));
  assert.equal(byRole.reviewer, 'run-rev');
  assert.equal(byRole.test, 'run-tst');
});

test('role_flow groups parallel observers, ingests check_run/status via signed webhook route, omits trace on /roles by default, and gates permissions', async t => {
  const h = await harness(t, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');

  const configured = await admin('/api/repositories/101/roles', 'PUT', {
    expected_revision: 0, roles: [{ role_id: 'test', name: 'Build verification' }, { role_id: 'qa', name: '交付验收' }],
  });
  assert.equal(configured.status, 200);

  const sha = 'a'.repeat(40);
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,priority,summary,object_number,phase,result,created_at,updated_at) VALUES('t-952','101','development.issue','running','P1','重构任务流转详情页',952,'model',?,'2026-11-16T08:00:00Z','2026-11-16T08:10:00Z')",
    JSON.stringify({ pr_number: 958, branch: 'feat/task-view-952', sha }),
  );
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,priority,summary,object_number,phase,created_at,updated_at) VALUES('t-done','101','development.issue','pr_opened','P2','历史已完成任务',910,'done','2026-11-15T08:00:00Z','2026-11-15T09:00:00Z')",
  );

  h.store.run("INSERT OR REPLACE INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','issue',952,'任务详情两层折叠','open',0,'2026-11-16T08:00:00Z')");
  h.store.run("INSERT OR REPLACE INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','pr',958,'feat: task detail view','open',0,'2026-11-16T08:09:00Z')");

  // Post real signed check_run & status webhooks through `/hooks/github/<account>/<endpoint>`
  const hook1 = await h.hook(
    a.path,
    a.secret,
    'del-check-1',
    { repository: { id: 101 }, check_run: { id: 1, name: 'unit', head_sha: sha, status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project-101/runs/1' } },
    { 'X-GitHub-Event': 'check_run' },
  );
  assert.equal(hook1.status, 200);
  const hook2 = await h.hook(
    a.path,
    a.secret,
    'del-check-2',
    { repository: { id: 101 }, check_run: { id: 2, name: 'e2e', head_sha: sha, status: 'in_progress', conclusion: null, html_url: 'https://github.com/fixture/project-101/runs/2' } },
    { 'X-GitHub-Event': 'check_run' },
  );
  assert.equal(hook2.status, 200);
  const hook3 = await h.hook(
    a.path,
    a.secret,
    'del-status-1',
    { repository: { id: 101 }, sha, context: 'lint-gate', state: 'success', target_url: 'https://github.com/fixture/project-101/statuses/1' },
    { 'X-GitHub-Event': 'status' },
  );
  assert.equal(hook3.status, 200);

  // Multi-role runs: 1. Manager -> 2. Dev (v1) -> 3a. Reviewer (1 finding) + 3b. Tester (0 findings) -> 4. Dev (v2 running)
  const insRun = h.store.db.prepare('INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,ended_at,status,context_snapshot,config_snapshot,role,assignment_id,harness) VALUES(?,?,?,1,1,?,?,?,\'{}\',\'{}\',?,?,?)');
  insRun.run('r1', 't-952', 'execution', '2026-11-16T08:00:05Z', null, 'running', 'manager', null, 'native');
  insRun.run('r2', 't-952', 'execution', '2026-11-16T08:01:00Z', '2026-11-16T08:03:00Z', 'succeeded', 'dev', 'a-dev-1', 'pi');
  insRun.run('r3a', 't-952', 'execution', '2026-11-16T08:03:05Z', '2026-11-16T08:04:30Z', 'succeeded', 'reviewer', 'a-rev-1', 'codex');
  insRun.run('r3b', 't-952', 'execution', '2026-11-16T08:03:06Z', '2026-11-16T08:04:45Z', 'succeeded', 'test', 'a-tst-1', 'pi');
  insRun.run('r4', 't-952', 'execution', '2026-11-16T08:05:00Z', null, 'running', 'dev', 'a-dev-2', 'pi');

  const insHist = h.store.db.prepare('INSERT INTO task_history(task_id,type,data,created_at,run_id,actor) VALUES(?,?,?,?,?,?)');
  insHist.run('t-952', 'role_result', JSON.stringify({ role: 'dev', assignment_id: 'a-dev-1', result: { summary: '初版完成' } }), '2026-11-16T08:03:00Z', 'r2', 'role:dev');
  insHist.run('t-952', 'role_result', JSON.stringify({ role: 'reviewer', assignment_id: 'a-rev-1', result: { summary: '发现折叠状态重置问题', findings: [{ description: '轮询未保留内层展开态', evidence: ['static/views/timeline.js:120'] }], inspected_scope: ['static/'], unknowns: [] } }), '2026-11-16T08:04:30Z', 'r3a', 'role:reviewer');
  insHist.run('t-952', 'role_result', JSON.stringify({ role: 'test', assignment_id: 'a-tst-1', result: { summary: '单测通过', findings: [], inspected_scope: ['test/'], unknowns: [] } }), '2026-11-16T08:04:45Z', 'r3b', 'role:test');
  insHist.run('t-952', 'tool_started', JSON.stringify({ call_id: 'c1', name: 'delegate_role', arguments: { role: 'dev', purpose: '修复折叠态' } }), '2026-11-16T08:04:55Z', 'r1', 'agent');

  const detail = await admin('/api/tasks/t-952');
  assert.equal(detail.status, 200);
  const { task, role_flow, role_runs } = detail.value;

  // External links check (ingested via `/hooks/github/...`)
  assert.equal(task.external.issue.number, 952);
  assert.equal(task.external.pull_request.number, 958);
  assert.equal(task.external.pull_request.branch, 'feat/task-view-952');
  assert.equal(task.external.actions.status, 'running');
  assert.equal(task.external.actions.total, 3);
  assert.equal(task.external.actions.passed, 2);
  assert.equal(task.external.actions.running, 1);

  // `/api/tasks/:id/roles` omits `role_flow`/`role_runs` by default during polling; `?trace=1` includes them on demand
  const rolesNoTrace = await admin('/api/tasks/t-952/roles');
  assert.equal(rolesNoTrace.status, 200);
  assert.equal(rolesNoTrace.value.role_flow, undefined);
  assert.equal(rolesNoTrace.value.role_runs, undefined);
  const rolesWithTrace = await admin('/api/tasks/t-952/roles?trace=1');
  assert.equal(rolesWithTrace.status, 200);
  assert.equal(rolesWithTrace.value.role_flow.active_role, 'dev');

  // Flow diagram stages: 1. Manager (delegated) -> 2. Dev (completed) -> [3a. Reviewer (returned) + 3b. Tester (completed)] -> 4. Dev (v2 running) -> QA (pending)
  assert.equal(role_flow.active_role, 'dev');
  assert.equal(role_flow.stages.length, 5);
  assert.equal(role_flow.stages[0].nodes[0].state, 'delegated');
  assert.equal(role_flow.stages[1].nodes[0].state, 'completed');
  assert.equal(role_flow.stages[2].parallel, true);
  assert.deepEqual(role_flow.stages[2].nodes.map(node => node.name), ['Reviewer', 'Build verification']);
  assert.deepEqual(role_flow.stages[2].nodes.map(n => [n.index_label, n.state, n.findings_count]), [['3a', 'returned', 1], ['3b', 'completed', 0]]);
  assert.equal(role_flow.stages[3].nodes[0].state, 'running');
  assert.equal(role_flow.stages[3].nodes[0].badge, '返工中');
  assert.equal(role_flow.stages[4].nodes[0].role, 'qa');
  assert.equal(role_flow.stages[4].nodes[0].name, '交付验收');
  assert.equal(role_flow.stages[4].nodes[0].state, 'pending');

  // Role runs default_open: only r4 (currently running) is default_open=true!
  assert.deepEqual(role_runs.map(r => [r.index_label, r.default_open]), [['1', false], ['2', false], ['3a', false], ['3b', false], ['4', true]]);
  assert.equal(role_runs[0].history_steps.length, 1);
  assert.equal(role_runs[0].history_steps[0].tool, 'delegate_role');

  // List endpoint with flow=1, completed group, and search `q`
  const listCompleted = await admin('/api/tasks?repository_id=101&summary=1&flow=1&group=completed');
  assert.equal(listCompleted.status, 200);
  assert.equal(listCompleted.value.completed_count, 1);
  assert.deepEqual(listCompleted.value.tasks.map(row => row.id), ['t-done']);

  const searchByPr = await admin('/api/tasks?repository_id=101&flow=1&q=958');
  assert.equal(searchByPr.status, 200);
  assert.deepEqual(searchByPr.value.tasks.map(row => row.id), ['t-952']);
  assert.equal(searchByPr.value.tasks[0].role_flow.active_role, 'dev');

  // Read-only member without tasks.write / knowledge.write gets can_write_tasks=false, can_manage=false, and body_omitted=true
  const pw = testPassword();
  const userCreated = await admin('/api/users', 'POST', { username: 'ro-viewer', password: pw, repository_ids: ['101'] });
  const principal = h.store.get('SELECT id FROM principals WHERE user_id=?', userCreated.value.user.id);
  h.store.run("UPDATE scoped_grants SET role='viewer',policy='explicit',capabilities=? WHERE principal_id=?", JSON.stringify(['tasks.read']), principal.id);
  const viewer = h.client();
  await viewer('/api/auth/login', 'POST', { username: 'ro-viewer', password: pw });
  const roBoard = await viewer('/api/repositories/101/role-board');
  assert.equal(roBoard.status, 200);
  assert.equal(roBoard.value.can_write_tasks, false);
  const roDetail = await viewer('/api/tasks/t-952');
  assert.equal(roDetail.status, 200);
  assert.equal(roDetail.value.can_manage, false);
  assert.equal(roDetail.value.role_runs[0].history_steps[0].body_omitted, true);
  assert.equal(roDetail.value.role_runs[0].history_steps[0].arguments, null);
});

test('live task check sync reports full/partial failures without cooldown, omits events_unsubscribed without head_sha, and records retention counts', async t => {
  const sha = 'c'.repeat(40);
  let revokedTokens = 0;
  let mode = 'both_fail';
  const ghServer = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/app/installations') {
      return res.end(JSON.stringify([{ id: 77, account: { id: 10, login: 'fixture' } }]));
    }
    if (url.pathname === '/repos/fixture/project-101/installation') {
      return res.end(JSON.stringify({ id: 77, account: { id: 10, login: 'fixture' }, permissions: { checks: 'read', statuses: 'read', metadata: 'read' }, events: [...appEvents] }));
    }
    if (url.pathname === '/app/installations/77/access_tokens') {
      return res.end(JSON.stringify({ token: 'ghs_live_check_token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { checks: 'read', statuses: 'read', metadata: 'read' } }));
    }
    if (url.pathname === '/installation/token' && req.method === 'DELETE') {
      revokedTokens++;
      res.statusCode = 204;
      return res.end();
    }
    if (url.pathname === '/repositories/101') {
      return res.end(JSON.stringify({ id: 101, full_name: 'fixture/project-101', default_branch: 'main', owner: { id: 10, login: 'fixture' } }));
    }
    if (url.pathname === `/repos/fixture/project-101/commits/${sha}/check-runs`) {
      if (mode === 'both_fail') {
        res.statusCode = 403;
        return res.end(JSON.stringify({ message: 'Resource not accessible by integration' }));
      }
      return res.end(JSON.stringify({
        check_runs: [
          { id: 101, name: 'unit', status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project-101/runs/101' },
          { id: 102, name: 'e2e', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/runs/102' },
        ],
      }));
    }
    if (url.pathname === `/repos/fixture/project-101/commits/${sha}/status`) {
      if (mode === 'both_fail' || mode === 'status_fail') {
        res.statusCode = 403;
        return res.end(JSON.stringify({ message: 'Resource not accessible by integration' }));
      }
      return res.end(JSON.stringify({ state: 'success', statuses: [{ context: 'deploy-preview', state: 'success', target_url: 'https://preview.invalid' }] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  ghServer.listen(0, '127.0.0.1');
  await once(ghServer, 'listening');
  t.after(() => new Promise(r => ghServer.close(r)));

  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const h = await harness(t, undefined, { githubUrl: `http://127.0.0.1:${ghServer.address().port}` });
  const { admin } = await setup(h);
  const app = await account(admin, {
    type: 'github_app',
    app_id: '123',
    private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token: undefined,
  });
  await repository(admin, app.id, '101');
  await repository(admin, app.id, '202');

  // Mark installation 101 as lacking check_run/status subscriptions initially
  h.store.run("UPDATE installed_repositories SET events=? WHERE repository_id='101'", JSON.stringify([...appEvents]));
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,phase,created_at,updated_at) VALUES('t-pr','101','review.pr','running','检视 PR #77',77,?,'model','2026-11-16T08:00:00Z','2026-11-16T08:05:00Z')",
    sha,
  );
  // A task with no commit SHA does not falsely blame App event subscriptions
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,created_at,updated_at) VALUES('t-issue','101','review.issue','running','检视 Issue #78',78,'model','2026-11-16T08:00:00Z','2026-11-16T08:05:00Z')",
  );

  const issueBefore = (await admin('/api/tasks/t-issue')).value.task;
  assert.equal(issueBefore.external.actions.head_sha, null);
  assert.equal(issueBefore.external.actions.events_unsubscribed, undefined);

  const beforeSync = (await admin('/api/tasks/t-pr')).value.task;
  assert.equal(beforeSync.external.actions.total, 0);
  assert.equal(beforeSync.external.actions.events_unsubscribed, true);

  // 1. Both GitHub endpoints failing returns 502 (not synced: true), revokes token, and sets NO cooldown
  const failedSync = await admin('/api/tasks/t-pr/checks?sync=1');
  assert.equal(failedSync.status, 502);
  assert.equal(failedSync.value.synced, undefined);
  assert.equal(revokedTokens, 1);

  // 2. Immediate retry without waiting 15 s hits GitHub again; partial failure stores check-runs, reports partial+error, and sets NO cooldown
  mode = 'status_fail';
  const partialSync = await admin('/api/tasks/t-pr/checks?sync=1');
  assert.equal(partialSync.status, 200);
  assert.equal(partialSync.value.synced, true);
  assert.equal(partialSync.value.partial, true);
  assert.ok(partialSync.value.error);
  assert.equal(partialSync.value.actions.total, 2);
  assert.equal(revokedTokens, 2);

  // 3. Immediate retry after fixing status permission succeeds completely and records cooldown
  mode = 'ok';
  const synced = await admin('/api/tasks/t-pr/checks?sync=1');
  assert.equal(synced.status, 200);
  assert.equal(synced.value.synced, true);
  assert.equal(synced.value.partial, undefined);
  assert.equal(synced.value.actions.total, 3);
  assert.equal(synced.value.actions.passed, 2);
  assert.equal(synced.value.actions.failed, 1);
  assert.equal(synced.value.actions.status, 'failing');
  assert.equal(revokedTokens, 3);

  // Cooldown prevents duplicate GitHub API fetches on immediate repeat click after a clean sync
  const cached = await admin('/api/tasks/t-pr/checks?sync=1');
  assert.equal(cached.status, 200);
  assert.equal(cached.value.cached, true);
  assert.equal(revokedTokens, 3);

  // Age/retention prune removes expired rows while keeping fresh rows and records count on RetentionCleanup
  h.store.run(
    "INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at) VALUES('202',?,'check:old','old-job','completed','success',NULL,'2026-09-01T00:00:00.000Z')",
    'd'.repeat(40),
  );
  h.store.run(
    "INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at) VALUES('202',?,'check:fresh','fresh-job','completed','success',NULL,?)",
    'e'.repeat(40),
    new Date().toISOString(),
  );
  const cleanupResult = await new RetentionCleanup(h.store, undefined, { pauseMs: 0, now: () => Date.parse('2026-11-16T12:00:00Z') }).run();
  assert.deepEqual(cleanupResult.commit_checks, { count: 1, failed: 0 });
  assert.equal(pruneCommitChecks(h.store, 30 * 24 * 3600_000, Date.parse('2026-11-16T12:00:00Z')), 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM commit_checks WHERE repository_id='202'").n, 1);

  h.store.transaction(() => deleteProjectRecords(h.store, '101'));
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM commit_checks WHERE repository_id='101'").n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM commit_checks WHERE repository_id='202'").n, 1);
});
