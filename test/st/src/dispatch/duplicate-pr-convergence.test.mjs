import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture, toolCall } from './dispatch-fixture.mjs';
import { repository } from '../../../fixtures/helpers.mjs';
import { queueWebhook } from '../../../../dist/review/queue.js';
import { builtinRules } from '../../../../dist/dispatch/rules.js';
import { configureDispatch, Dispatcher } from '../../../../dist/dispatch/worker.js';
import { managerDecision } from '../../../../dist/dispatch/manager.js';
import { isBotPrOpen } from '../../../../dist/dispatch/store.js';
import { githubWrite } from '../../../../dist/github/write.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { setGrant } from '../../../../dist/tasks/grants.js';
import { captureTaskConfiguration, supplementalInstructions } from '../../../../dist/tasks/configuration.js';
import { roleConfiguration, saveConfiguration } from '../../../../dist/roles/definition.js';
import { defaultPermissions } from '../../../../dist/roles/permissions.js';

configureDispatch(null);

const HEAD_HUMAN = 'd'.repeat(40);
const HEAD_BOT = 'e'.repeat(40);

function seedDevTask(store, repoId, id, {
  status = 'running',
  objectNumber = 12,
  target = { type: 'issue', number: 12 },
  headSha = HEAD_BOT,
  summary = `Dev task ${id}`,
  withClaimAndRun = false,
} = {}) {
  const now = new Date().toISOString();
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,object_number,head_sha,attempt,created_at,updated_at)
     VALUES(?,?,'task.request',?,'model',?,?,?,?,1,?,?)`,
    id, repoId, status, summary, JSON.stringify({ generic: true, target, round: 1 }), objectNumber, headSha, now, now,
  );
  setGrant(store, { id, repository_id: repoId }, ['pull_request'], 'role:manager', null);
  captureTaskConfiguration(store, id);
  if (withClaimAndRun) {
    store.run('INSERT INTO task_claims(task_id,repository_id,token,claimed_at) VALUES(?,?,?,?)', id, repoId, 'claim-' + id, now);
    store.run('UPDATE tasks SET claim_token=? WHERE id=?', 'claim-' + id, id);
    store.run(
      `INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot)
       VALUES(?,?,'task.request',1,1,?,'running','{}','{}')`,
      'run-' + id, id, now,
    );
  }
}

test('Event Dispatch Manager uses list_project_tasks, read_project_task, and manage_task with repo/terminal isolation while PR review stays on standing rule', async t => {
  const { h, admin, a, requests, state, run } = await fixture(t);
  await admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop', development_enabled: true });
  // Restore builtin standing rules so pull_request.opened takes the zero-LLM fast path.
  const mgr = (await admin('/api/repositories/101/manager')).value.manager;
  assert.equal((await admin('/api/repositories/101/manager', 'PUT', { expected_revision: mgr.prompt.revision, standing_rules: builtinRules })).status, 200);

  // Create second repo 202 to verify strict cross-repository isolation.
  await repository(admin, a.id, '202');
  seedDevTask(h.store, '202', 'other-repo-task', { status: 'running', objectNumber: 12, withClaimAndRun: true });
  seedDevTask(h.store, '101', 'dev-12', { status: 'running', objectNumber: 12, withClaimAndRun: true });
  seedDevTask(h.store, '101', 'done-12', { status: 'pr_opened', objectNumber: 12 });

  const toolResults = [];
  let step = 0;
  state.message = (body) => {
    const tools = body.messages.filter(m => m.role === 'tool');
    if (tools.length) toolResults.push(JSON.parse(tools.at(-1).content));
    const sequence = [
      toolCall('list_project_tasks', { status: 'active', object_number: 12 }, 'c-list'),
      toolCall('read_project_task', { task_id: 'dev-12' }, 'c-read-ok'),
      toolCall('read_project_task', { task_id: 'other-repo-task' }, 'c-read-cross'),
      toolCall('manage_task', { task_id: 'other-repo-task', action: 'cancel', reason: '尝试跨仓取消。' }, 'c-cancel-cross'),
      toolCall('manage_task', { task_id: 'done-12', action: 'cancel', reason: '尝试取消终态任务。' }, 'c-cancel-done'),
      toolCall('manage_task', { task_id: 'dev-12', action: 'instructions', instruction: 'Check human PR #50 and stop cleanly if nothing new remains.', reason: '人类提交 PR #50，补充核对指令。' }, 'c-inst'),
      toolCall('manage_task', { task_id: 'dev-12', action: 'pause', reason: '先暂停观察人类 PR #50。' }, 'c-pause'),
      toolCall('manage_task', { task_id: 'dev-12', action: 'cancel', reason: '人类 PR #50 已覆盖 Issue #12，取消 bot 在研任务。' }, 'c-cancel'),
      toolCall('ignore_event', { reason: '已按人类优先原则取消在研 bot 开发任务 dev-12。' }, 'c-ignore'),
    ];
    return sequence[step++];
  };

  // Human opens PR #50 linking Issue #12
  assert.equal(queueWebhook(h.store, '101', 'pull_request', {
    action: 'opened',
    sender: { type: 'User', login: 'alice', id: 5 },
    pull_request: {
      number: 50,
      state: 'open',
      draft: false,
      title: 'Fix Issue #12 cleanly',
      body: 'Fixes #12',
      head: { sha: HEAD_HUMAN, ref: 'fix/12' },
      base: { ref: 'main' },
      user: { id: 5, login: 'alice' },
      html_url: 'https://github.com/acme/demo/pull/50',
    },
  }, 'deliv-human-50'), 2);

  await run();

  // Standing rule settled pull_request.opened; only issue.linked_pull_request called the Manager model.
  const evPr = h.store.get("SELECT * FROM dispatch_events WHERE type='pull_request.opened'");
  assert.equal(evPr.state, 'decided');
  assert.equal(evPr.decision, 'create');
  assert.equal(JSON.parse(evPr.rule).id, 'pull-request-opened');
  assert.ok(requests.every(r => JSON.parse(r.messages[1].content).event.type === 'issue.linked_pull_request'));

  // Verify tool outputs and strict isolation
  assert.deepEqual(toolResults[0].tasks.map(row => row.id), ['dev-12']);
  assert.equal(toolResults[1].object_number, 12);
  assert.deepEqual(toolResults[1].writes, ['pull_request']);
  assert.equal(toolResults[2].error, 'coordination_task_out_of_scope');
  assert.equal(toolResults[3].error, 'task_not_found');
  assert.equal(toolResults[3].changed, false);
  assert.equal(toolResults[4].error, 'task_already_delivered');
  assert.equal(toolResults[4].changed, false);
  assert.equal(toolResults[5].ok, true);
  assert.equal(toolResults[6].status, 'paused');
  assert.equal(toolResults[7].status, 'cancelled');

  // Verify DB state after instructions -> pause -> cancel
  const dev12 = h.store.get("SELECT * FROM tasks WHERE id='dev-12'");
  assert.equal(dev12.status, 'cancelled');
  assert.equal(dev12.error_code, 'manager_cancel');
  assert.equal(dev12.claim_token, null);
  assert.equal(h.store.get("SELECT count(*) AS n FROM task_claims WHERE task_id='dev-12'").n, 0);
  assert.equal(h.store.get("SELECT status,stop_reason FROM task_runs WHERE id='run-dev-12'").status, 'interrupted');
  assert.equal(supplementalInstructions(h.store, dev12)[0], 'Check human PR #50 and stop cleanly if nothing new remains.');
  assert.equal(h.store.get("SELECT count(*) AS n FROM review_updates WHERE task_id='dev-12'").n, 1);

  // Other repo task and terminal task remained untouched
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id='other-repo-task'").status, 'running');
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id='done-12'").status, 'pr_opened');

  // Audit entries were recorded
  const audits = h.store.all("SELECT action,resource_id FROM audit WHERE user_id='role:manager' ORDER BY rowid");
  assert.deepEqual(audits.map(r => [r.action, r.resource_id]), [
    ['task.instructions', 'dev-12'],
    ['task.pause', 'dev-12'],
    ['task.cancel', 'dev-12'],
  ]);
});

test('Manager compares open bot PR against human PR, closes duplicate bot PR via github_write, and cancels residual tasks cleanly', async t => {
  const { h, admin, state } = await fixture(t);
  await admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop', development_enabled: true });
  const mgr = (await admin('/api/repositories/101/manager')).value.manager;
  assert.equal((await admin('/api/repositories/101/manager', 'PUT', { expected_revision: mgr.prompt.revision, standing_rules: builtinRules })).status, 200);

  // Mock GitHub API for github_read + github_write
  const repoFull = h.store.get("SELECT full_name FROM repositories WHERE id='101'").full_name;
  const ghCalls = [];
  const gh = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const pathname = new URL(req.url || '/', 'http://fixture').pathname;
    ghCalls.push({ method: req.method, url: pathname, body });
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (pathname === '/user') return send(200, { id: 999, login: 'launchpad-bot', type: 'User' });
    if (pathname === '/repositories/101' || pathname === `/repos/${repoFull}`) {
      return send(200, { id: 101, owner: { id: 10 }, full_name: repoFull, default_branch: 'main' });
    }
    if (req.method === 'GET' && pathname === `/repos/${repoFull}/issues/30`) {
      return send(200, { number: 30, state: 'open', pull_request: { url: `https://github.com/${repoFull}/pull/30` }, html_url: `https://github.com/${repoFull}/pull/30` });
    }
    if (pathname === `/repos/${repoFull}/pulls/50/files`) return send(200, [{ filename: 'src/fix.js', patch: '+fix()' }]);
    if (pathname === `/repos/${repoFull}/pulls/30/files`) return send(200, [{ filename: 'src/fix.js', patch: '+fix()' }]);
    if (req.method === 'POST' && pathname === `/repos/${repoFull}/issues/30/comments`) {
      return send(201, { id: 7001, html_url: `https://github.com/${repoFull}/pull/30#issuecomment-7001`, body: body.body });
    }
    if (req.method === 'PATCH' && pathname === `/repos/${repoFull}/pulls/30`) {
      return send(200, {
        id: 3000,
        number: 30,
        state: body.state || 'closed',
        draft: false,
        title: 'Bot fix for #12',
        html_url: `https://github.com/${repoFull}/pull/30`,
        base: { ref: 'main', sha: '1'.repeat(40) },
        head: { ref: 'bot/issue-12', sha: HEAD_BOT },
      });
    }
    if (req.method === 'PATCH' && pathname === `/repos/${repoFull}/pulls/35`) {
      return send(200, {
        id: 3500,
        number: 35,
        state: body?.state || 'closed',
        draft: false,
        title: 'Bot PR #35',
        html_url: `https://github.com/${repoFull}/pull/35`,
        base: { ref: 'main', sha: '1'.repeat(40) },
        head: { ref: 'bot/issue-35', sha: HEAD_BOT },
      });
    }
    return send(404, { message: 'Not Found' });
  });
  gh.listen(0, '127.0.0.1'); await once(gh, 'listening');
  t.after(() => new Promise(resolve => { gh.close(resolve); gh.closeAllConnections(); }));
  const ghUrl = `http://127.0.0.1:${gh.address().port}`;

  // Seed open bot PR #30 with an active residual revision task + pending PR event queued after the linked-PR event
  const now = new Date().toISOString();
  const later = '2099-01-01T00:00:00.000Z';
  seedDevTask(h.store, '101', 'bot-dev-30', { status: 'running', objectNumber: 12, target: { type: 'issue', number: 12 }, withClaimAndRun: true });
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',30,'3000','999','101','bot/issue-12',?,'bot-dev-30',0)", HEAD_BOT);
  h.store.run(
    `INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,head_sha,title,html_url,updated_at)
     VALUES('101',30,'open',0,'main',?,'Bot fix for #12',?,?)`,
    HEAD_BOT, `https://github.com/${repoFull}/pull/30`, now,
  );
  h.store.run(
    `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,thread_key,state,created_at)
     VALUES('ev-pending-pr30','101','101:pending-30','pull_request.updated','github','pr',30,'Pending update on bot PR #30','{}','[]','101:issue:12','pending',?)`,
    later,
  );

  let step = 0;
  state.message = () => {
    const seq = [
      toolCall('github_read', { path: '/pulls/50/files' }, 'c-r50'),
      toolCall('github_read', { path: '/pulls/30/files' }, 'c-r30'),
      toolCall('github_write', {
        method: 'POST',
        path: '/issues/30/comments',
        body: { body: 'Closing in favor of #50 after verifying this bot PR adds no extra fixes or tests.' },
        key: 'close-note-30',
      }, 'c-comment30'),
      toolCall('github_write', {
        method: 'PATCH',
        path: '/pulls/30',
        body: { state: 'closed' },
        key: 'close-pr-30',
      }, 'c-close30'),
      toolCall('ignore_event', { reason: '已核对差异并主动关闭重复的 bot PR #30，保留人类 PR #50。' }, 'c-done'),
    ];
    return seq[step++];
  };

  assert.equal(queueWebhook(h.store, '101', 'pull_request', {
    action: 'opened',
    sender: { type: 'User', login: 'alice', id: 5 },
    pull_request: {
      number: 50,
      state: 'open',
      draft: false,
      title: 'Human fix #12',
      body: 'Closes #12',
      head: { sha: HEAD_HUMAN, ref: 'fix/12' },
      base: { ref: 'main' },
      user: { id: 5, login: 'alice' },
      html_url: 'https://github.com/owner/repo/pull/50',
    },
  }, 'deliv-human-dup'), 2);

  // Run Dispatcher with custom githubUrl
  const dispatcher = new Dispatcher(h.store, (store, ctx) => managerDecision(store, ctx, ghUrl));
  dispatcher.tick();
  await dispatcher.idle();

  assert.ok(ghCalls.some(c => c.method === 'POST' && c.url.endsWith('/issues/30/comments')));
  assert.ok(ghCalls.some(c => c.method === 'PATCH' && c.url.endsWith('/pulls/30') && c.body?.state === 'closed'));
  assert.equal(h.store.get("SELECT state FROM bot_pr_states WHERE repository_id='101' AND number=30").state, 'closed');
  assert.equal(isBotPrOpen(h.store, '101', 30), false);

  // Residual active task + claim + running run + pending PR dispatch event were all cleaned up automatically.
  const dev30 = h.store.get("SELECT * FROM tasks WHERE id='bot-dev-30'");
  assert.equal(dev30.status, 'cancelled');
  assert.equal(dev30.error_code, 'bot_pr_closed');
  assert.equal(h.store.get("SELECT count(*) AS n FROM task_claims WHERE task_id='bot-dev-30'").n, 0);
  assert.equal(h.store.get("SELECT status,stop_reason FROM task_runs WHERE id='run-bot-dev-30'").stop_reason, 'bot_pr_closed');
  assert.equal(h.store.get("SELECT state,decision FROM dispatch_events WHERE id='ev-pending-pr30'").decision, 'ignore');

  // Also verify self-close safety: when a task calls github_write to close its own bot PR, its own task_id is NOT killed mid-turn,
  // while another residual task on that PR IS cancelled.
  seedDevTask(h.store, '101', 'self-caller-task', { status: 'running', objectNumber: 35, target: { type: 'pr', number: 35 }, withClaimAndRun: true });
  seedDevTask(h.store, '101', 'other-pr35-task', { status: 'queued', objectNumber: 35, target: { type: 'pr', number: 35 } });
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',35,'3500','999','101','bot/issue-35',?,'self-caller-task',0)", HEAD_BOT);
  h.store.run(
    `INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,head_sha,title,html_url,updated_at)
     VALUES('101',35,'open',0,'main',?,'Bot PR #35','https://github.com/owner/repo/pull/35',?)`,
    HEAD_BOT, now,
  );
  const repoRow = h.store.get("SELECT * FROM repositories WHERE id='101'");
  const closed = await githubWrite({
    store: h.store,
    repository: repoRow,
    redactor: new Redactor(),
    guard: async () => {},
    apiUrl: ghUrl,
    scope: 'task:self-caller-task',
    actor: { kind: 'task', role: 'dev', task_id: 'self-caller-task' },
    allowed: () => true,
  }, { method: 'PATCH', path: '/pulls/35', body: { state: 'closed' }, key: 'self-close-35' });
  assert.equal(closed.status, 200, JSON.stringify(closed));
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id='self-caller-task'").status, 'running', 'calling task itself stays running until submit_report');
  assert.equal(h.store.get("SELECT status,error_code FROM tasks WHERE id='other-pr35-task'").error_code, 'bot_pr_closed');
});

test('idle repo incurs zero Manager model calls on pull_request.opened and project_tasks=read withholds manage_task', async t => {
  const { h, admin, requests, state, run } = await fixture(t);
  const mgr = (await admin('/api/repositories/101/manager')).value.manager;
  assert.equal((await admin('/api/repositories/101/manager', 'PUT', { expected_revision: mgr.prompt.revision, standing_rules: builtinRules })).status, 200);

  // 1) Idle repo: zero Manager calls on human PR with Closes #99
  assert.equal(queueWebhook(h.store, '101', 'pull_request', {
    action: 'opened',
    sender: { type: 'User', login: 'alice', id: 5 },
    pull_request: {
      number: 60, state: 'open', draft: false, title: 'Standalone human PR', body: 'Closes #99',
      head: { sha: HEAD_HUMAN, ref: 'feat/99' }, base: { ref: 'main' }, user: { id: 5, login: 'alice' },
    },
  }, 'deliv-idle-60'), 1);
  await run();
  assert.equal(requests.length, 0, 'standing rule handles PR review with zero Manager model calls');

  // 2) Restrict manager project_tasks to read-only and verify manage_task is not offered
  saveConfiguration(h.store, '101', {
    expected_revision: roleConfiguration(h.store, '101').revision,
    enabled: true,
    roles: [{ role_id: 'manager', harness_ref: { id: 'scripted' }, permissions: { ...defaultPermissions('manager', 'controller'), project_tasks: 'read' } }],
  }, 'fixture');
  seedDevTask(h.store, '101', 'dev-77', { status: 'running', objectNumber: 77, target: { type: 'issue', number: 77 } });
  let offeredNames = [];
  state.message = (body) => {
    offeredNames = (body.tools || []).map(tool => tool.function?.name);
    return toolCall('ignore_event', { reason: '仅查看任务权限验证。' }, 'c-ro');
  };
  assert.equal(queueWebhook(h.store, '101', 'pull_request', {
    action: 'opened',
    sender: { type: 'User', login: 'alice', id: 5 },
    pull_request: {
      number: 78, state: 'open', draft: false, title: 'Human fix #77', body: 'Fixes #77',
      head: { sha: HEAD_HUMAN, ref: 'fix/77' }, base: { ref: 'main' }, user: { id: 5, login: 'alice' },
    },
  }, 'deliv-ro-78'), 2);
  await run();
  assert.ok(offeredNames.includes('list_project_tasks'));
  assert.ok(offeredNames.includes('read_project_task'));
  assert.ok(!offeredNames.includes('manage_task'), 'manage_task must not be offered when project_tasks is read-only');
});
