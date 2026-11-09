import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// The console's three layers: a workflow says when it runs, with which prompt, model and writes; the 角色 page says how
// the controller delegates and on which executor each role runs; a task shows its own facts and who is doing what now.
const text = node => [node.textContent, ...node.children.map(text)].filter(Boolean).join('\n');
const record = (overrides = {}) => ({ contract: { goal: 'Keep the query string on the login redirect', scope: [], criteria: ['The redirect keeps ?next='], endpoint: null },
  revision: 2, progress: { next_action: 'Run the auth tests', completed: [] }, selections: [], candidate: null, acceptance: null, pending: null, followups: [], ...overrides });
const candidate = { id: 'cand1234567890abcdef', revision: 2, created_at: '2026-11-09T01:00:00Z', claims: {}, artifacts: [{ kind: 'code', reference: 'task:t:candidate', version: 'tree9876543210fedcba' }],
  evidence: [{ source: 'policy_validation', version: 'tree9876543210fedcba', verified: true }, { source: 'task_history:41', version: 'abc', verified: false }] };

function taskPage(t, task, roles, handoffs = []) {
  const page = loadConsole(['static/app.js', 'static/views.js'], (_method, path) => {
    if (path.endsWith('/logs')) return [200, { logs: [] }];
    if (path.includes('/roles?')) return roles ? [200, roles] : [404, { error: 'not_found' }];
    if (path.includes('/events?type=role_handoff')) return [200, { events: handoffs }];
    if (path === '/api/tasks/' + task.id) return [200, { task, publications: [] }];
    return [404, {}];
  });
  page.run("scroller = node => node; taskMetricsCard = () => element('section','');");
  t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  return { page, open: async () => { await page.run(`openTask(${JSON.stringify(task.id)})`); page.run('clearTimeout(taskTimer)'); },
    next: () => text(page.$('task-side').querySelector('.task-next-text')), side: () => text(page.$('task-side')),
    facts: () => page.$('task-side').querySelectorAll('.task-fact').map(part => part.dataset.fact) };
}

test('a task without role coordination says it ran on the original executor, and that independent QA still accepts it', async t => {
  const task = { id: 't1', repository_id: '101', kind: 'development.issue', object_number: 7, status: 'running', phase: 'model', attempt: 1, structured: record() };
  const view = taskPage(t, task, { instances: [], assignments: [], runs: [], snapshots: {} }); await view.open();
  assert.equal(view.next(), '执行器（项目电脑里的 Pi 进程）正在处理：Run the auth tests');
  // Goal, candidate, evidence, acceptance and publication, in that order, each from the task's own record.
  assert.deepEqual(view.facts(), ['目标', '候选', '证据', '验收', '发布']);
  const side = view.side();
  assert.match(side, /Keep the query string on the login redirect/); assert.match(side, /The redirect keeps \?next=/);
  assert.match(side, /原来的执行器：这个任务没有经过主控/); assert.match(side, /独立 QA\n有候选后验收/);
  assert.doesNotMatch(side, /委派记录/, 'no delegation is invented for a task that had none');
  assert.equal(view.page.run("[...document.querySelectorAll('#task-side .side-card h3')].some(h => h.textContent === '任务契约与交付验收')"), false);
});

test('under the controller the next step names the role at work, its executor and the purpose it was handed', async t => {
  const task = { id: 't2', repository_id: '101', kind: 'development.issue', object_number: 8, status: 'running', phase: 'model', attempt: 2,
    structured: record({ candidate, acceptance: { outcome: 'return', reason: 'The redirect drops the fragment', gaps: ['Keep #fragment as well'], residuals: [], candidate_id: candidate.id, revision: 2 } }) };
  const roles = { instances: [{ id: 'i-m', role: 'manager', harness: 'pi', snapshot_id: 's-m' }, { id: 'i-d', role: 'dev', harness: 'native' }, { id: 'i-r', role: 'reviewer', harness: 'acp' }, { id: 'i-q', role: 'qa', harness: 'native' }],
    assignments: [{ id: 'a1', instance_id: 'i-d', status: 'completed', candidate_version: null }, { id: 'a2', instance_id: 'i-r', status: 'running', candidate_version: 'tree9876543210fedcba' }],
    runs: [{ role: 'manager', status: 'running' }, { role: 'qa', status: 'completed' }], snapshots: { 's-m': { legacy: false } } };
  const handoffs = [{ data: { assignment_id: 'a1', purpose: 'Implement the redirect fix' } }, { data: { assignment_id: 'a2', purpose: 'Check the redirect against the criteria' } }];
  const view = taskPage(t, task, roles, handoffs); await view.open();
  assert.equal(view.next(), 'Reviewer（ACP）正在做主控交给它的工作：Check the redirect against the criteria');
  const side = view.side();
  assert.match(side, /角色协调：主控 Manager（Pi）按需委派工作/); assert.match(side, /独立 QA\n运行过 1 次，每次都是新的上下文/);
  assert.match(side, /委派记录\nDev\nNative\n已交回\nImplement the redirect fix/); assert.match(side, /Reviewer\nACP\n进行中\nCheck the redirect against the criteria\n看的是候选版本 tree98765432/);
  // The delegation list is a record, not a plan or a grant.
  assert.match(side, /这不是预设流程，也不授予权限/);
  assert.match(side, /候选\n当前\n编号\ncand12345678/); assert.match(side, /项目测试命令\n已核验/); assert.match(side, /任务记录 #41\n未核验/); assert.match(side, /1\/2 已核验/);
  assert.match(side, /验收\n退回修改/); assert.match(side, /还缺\nKeep #fragment as well/);
  // Purposes are read again only when the number of delegations changes.
  await view.page.run('(async () => { await refreshTask(); clearTimeout(taskTimer); })()');
  assert.equal(view.page.requests.filter(request => request.includes('type=role_handoff')).length, 1);
});

test('a long task reads every page of delegations, so the one running now is not cut off', async t => {
  const task = { id: 't4', repository_id: '101', kind: 'task.request', object_number: null, summary: 'Audit', status: 'running', phase: 'model', attempt: 1, structured: record() };
  const instances = [{ id: 'i-m', role: 'manager', harness: 'pi' }, { id: 'i-t', role: 'test', harness: 'process' }];
  const done = Array.from({ length: 100 }, (_, n) => ({ sequence: n + 1, id: 'old-' + n, instance_id: 'i-t', status: 'completed' }));
  const page = loadConsole(['static/app.js', 'static/views.js'], (_method, path) => {
    if (path.endsWith('/logs')) return [200, { logs: [] }];
    if (path.includes('/roles?')) return /after=0$/.test(path) ? [200, { instances, runs: [], snapshots: {}, assignments: done, next_after: 100 }]
      : [200, { instances, runs: [], snapshots: {}, assignments: [{ sequence: 101, id: 'now', instance_id: 'i-t', status: 'running' }], next_after: null }];
    if (path.includes('type=role_handoff')) return /after=0$/.test(path) ? [200, { events: [], next_after: 7 }] : [200, { events: [{ data: { assignment_id: 'now', purpose: 'Re-run the flaky suite' } }], next_after: null }];
    if (path === '/api/tasks/t4') return [200, { task, publications: [] }];
    return [404, {}];
  });
  page.run("scroller = node => node; taskMetricsCard = () => element('section','');"); t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  await page.run('openTask("t4")'); page.run('clearTimeout(taskTimer)');
  assert.equal(text(page.$('task-side').querySelector('.task-next-text')), 'Test（Process）正在做主控交给它的工作：Re-run the flaky suite');
  assert.equal(page.$('task-side').querySelectorAll('.role-work > li').length, 101);
});

test('a controller from an old configuration is shown as the old configuration still in use', async t => {
  const task = { id: 't3', repository_id: '101', kind: 'task.request', object_number: null, summary: 'Weekly report', status: 'running', phase: 'model', attempt: 1, structured: record() };
  const view = taskPage(t, task, { instances: [{ id: 'i-m', role: 'manager', harness: 'native', snapshot_id: 's-m' }], assignments: [], runs: [], snapshots: { 's-m': { legacy: true } } }); await view.open();
  assert.match(view.next(), /^主控 Manager 正在读任务记录，决定下一步委派谁；它记下的下一步：Run the auth tests$/);
  assert.match(view.side(), /主控 Manager（Native，旧配置沿用）/); assert.match(view.side(), /主控还没有委派工作/);
});

test('the next step is one sentence for waiting, accepting, finished and unreadable cases', () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], () => [404, {}]);
  const next = (task, value = record(), roles = null) => page.run(`taskNextStep(${JSON.stringify(task)}, ${JSON.stringify(value)}, ${JSON.stringify(roles)})`);
  assert.equal(next({ status: 'queued', phase: 'prepare' }), '排队中：等这个仓库的项目电脑空闲后开始。');
  assert.equal(next({ status: 'waiting_configuration', error_code: 'model_unavailable', error_cause: { label: '模型配置', action: '在「模型」页选一个可用模型。' } }), '已暂停（配置待补）：模型配置。在「模型」页选一个可用模型。');
  assert.equal(next({ status: 'running', phase: 'acceptance' }, record({ candidate })), '独立 QA 正在新的上下文里验收候选 cand12345678。');
  assert.equal(next({ status: 'pr_opened', phase: 'done' }), '已创建 PR：独立 QA 验收通过后按原规则交付，没有下一步。');
  assert.equal(next({ status: 'running', phase: 'validate' }), '控制面正在项目电脑里运行仓库测试。');
  // Unreadable role records fall back to the facts the task itself has.
  assert.equal(next({ status: 'running', phase: 'model' }, record({ progress: { next_action: null } })), '执行器（项目电脑里的 Pi 进程）正在处理。');
});

// A role as GET /api/repositories/:id/roles returns it.
const role = (role_id, kind, harness, version = '1') => ({ role_id, kind, enabled: true, name: role_id, responsibility: '', persona_prompt: '', revision: 1, model_profile_ref: null, skill_bundle_ref: null,
  harness_ref: { id: harness, version }, capability_policy_ref: { id: 'policy', version: '1' }, environment_profile_ref: { id: 'env', version: '1' }, budget_policy_ref: { id: 'entry-default', version: '1' }, output_schema_ref: { id: 'out', version: '1' } });
const roleData = (config, workflow = 'development.issue') => ({ configuration: config, workflow, harnesses: [{ id: 'pi', version: '1.4.0', kinds: ['controller'], runtime: { package: '@mariozechner/pi-coding-agent' } }, { id: 'native', version: '1', kinds: ['writer', 'observer', 'evaluator'] }],
  models: [], revisions: [], skill_inputs: [], preview: config.roles.map(r => ({ role: r.role_id, model: r.harness_ref.id === 'acp' ? { source: 'external_harness', name: 'external' } : { source: 'project', name: 'fixture-model' } })) });
const team = controller => [role('manager', 'controller', controller, controller === 'pi' ? '1.4.0' : '1'), role('dev', 'writer', 'native'), role('test', 'observer', 'native'), role('reviewer', 'observer', 'acp'), role('ux', 'observer', 'native'), role('qa', 'evaluator', 'native'), role('coordinator', 'controller', 'native')];
const entries = { development: true, request: true, review: false, actions: false };
function rolesPage(data) {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], () => [404, {}]);
  page.run(`current = { id: '101', section: 'roles' }; window.roleView = roleCards(${JSON.stringify(data)}, element('p', ''));`);
  const cards = [...page.run('roleView')], byTitle = title => cards.find(c => c.children[0].textContent === title);
  return { page, cards, byTitle, tile: id => byTitle('主控怎样委派').querySelector(`[data-role=${id}]`) };
}

test('the 角色 page: without coordination every entry keeps its original executor and QA stays independent', () => {
  const view = rolesPage(roleData({ schema: 2, revision: 3, enabled: false, controller: { role: 'manager', entries }, roles: team('pi'), skills: [] }));
  assert.deepEqual(view.cards.map(c => c.children[0].textContent), ['角色协调', '主控怎样委派', '每个角色的解析结果', '修改配置']);
  const state = text(view.byTitle('角色协调'));
  assert.match(state, /未开启/); assert.match(state, /都走原来的执行器，也就是各工作流在项目电脑里的 Pi 进程。交付前仍由独立 QA 在新的上下文里验收/);
  assert.doesNotMatch(state, /旧配置/);
});

test('the 角色 page: the controller delegates Dev, Test, Reviewer and UX; each role names its executor and a new controller is Pi', () => {
  const view = rolesPage(roleData({ schema: 2, revision: 4, enabled: true, controller: { role: 'manager', entries }, roles: team('pi'), skills: [] }));
  const state = view.byTitle('角色协调');
  assert.deepEqual(state.querySelectorAll('[data-entry]').map(item => item.dataset.entry + ':' + item.querySelector('.status').textContent),
    ['development:主控委派', 'request:主控委派', 'review:原执行器', 'actions:原执行器']);
  const lanes = view.byTitle('主控怎样委派').querySelectorAll('.role-lane').map(lane => lane.children[0].textContent + '=' + lane.querySelectorAll('[data-role]').map(tile => tile.dataset.role).join(','));
  assert.deepEqual(lanes, ['主控=manager', '按需委派=dev,test,reviewer,ux', '验收与发布=qa']);
  assert.match(text(view.tile('manager')), /Manager\n.*\nPi\n项目电脑里的 Pi 会话/s); assert.doesNotMatch(text(view.tile('manager')), /旧配置沿用/);
  assert.match(text(view.tile('reviewer')), /ACP\n外部智能体，用它自带的模型\n模型：执行器自带模型/);
  assert.match(text(view.byTitle('主控怎样委派')), /不是每个任务都要走一遍的流程，也不授予权限/);
  // The resolution table keeps its name and the pinned harness reference.
  const table = view.byTitle('每个角色的解析结果').querySelector('table');
  assert.equal(table.getAttribute('aria-label'), '角色解析结果'); assert.match(text(table), /Pi\npi@1\.4\.0/);
});

test('the 角色 page: an old configuration still running a Native controller is marked as such and saving offers Pi', () => {
  const view = rolesPage(roleData({ schema: 2, revision: 0, enabled: true, legacy: true, controller: { role: 'manager', entries }, roles: team('native'), skills: [] }));
  assert.match(text(view.byTitle('角色协调')), /保存于 V2 之前，仍按旧配置运行：主控还是 Native/);
  assert.match(text(view.tile('manager')), /Native\n控制面的工具循环\n旧配置沿用/);
  // Workers on Native are a choice, not a leftover: only the old controller is marked.
  assert.doesNotMatch(text(view.tile('dev')), /旧配置沿用/); assert.doesNotMatch(text(view.tile('coordinator')), /旧配置沿用/);
  assert.match(text(view.byTitle('每个角色的解析结果').querySelector('table')), /Native\n \n旧配置沿用\nnative@1/);
  const edited = JSON.parse(view.byTitle('修改配置').querySelector('textarea').value);
  assert.deepEqual(edited.roles.map(r => r.role_id + ':' + r.harness_ref.id), ['manager:pi', 'dev:native', 'test:native', 'reviewer:acp', 'ux:native', 'qa:native', 'coordinator:native']);
});

test('the 角色 page: a project that never saved a V2 configuration shows the Pi controller a save gives it, not an old one in use', () => {
  // GET /roles reports a never saved project as legacy with a Native manager; with coordination off nothing runs on it.
  const view = rolesPage(roleData({ schema: 2, revision: 0, enabled: false, legacy: true, controller: { role: 'manager', entries }, roles: team('native'), skills: [] }));
  const state = text(view.byTitle('角色协调'));
  assert.match(state, /还没有保存过 V2 角色配置。开启协调并保存后，主控在 Pi 上运行/); assert.doesNotMatch(state, /仍按旧配置运行/);
  assert.match(text(view.tile('manager')), /Pi\n项目电脑里的 Pi 会话\n保存后生效/); assert.doesNotMatch(text(view.tile('manager')), /Native|旧配置沿用/);
  assert.match(text(view.byTitle('每个角色的解析结果').querySelector('table')), /Pi\n \n保存后生效\npi@1\.4\.0/);
  assert.equal(JSON.parse(view.byTitle('修改配置').querySelector('textarea').value).roles[0].harness_ref.id, 'pi');
});

test('the workflow summary answers when, which prompt, which model, which writes and who executes', () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/workflows.js'], () => [404, {}]);
  const workflow = (id, base, triggers) => ({ id, base, name: id, triggers, trigger_options: [{ id: 'review.published', title: '检视发布结论' }, { id: 'issue.labeled', title: '有人加上标签' }, { id: 'issue.opened', title: 'Issue 打开' }],
    prompt: { source: 'builtin', path: `.bot/rules/${id}.md` }, model: { id: null, default_id: null, inherited: true }, permissions: { writes: ['code', 'pull_request'] }, write_options: [{ id: 'code', title: '修改工作区代码' }, { id: 'pull_request', title: '开或更新 bot PR' }] });
  const summary = (config, value) => page.run(`current = { id: '101', models: [], policy: {}, roleConfig: ${JSON.stringify(config)} }; [...workflowSummary(${JSON.stringify(value)}).children].map(node => node.tagName === 'DT' ? '#' + node.textContent : [node.textContent, ...node.children.map(c => c.textContent)].join('')).join('\\n')`);
  const coordinated = { enabled: true, controller: { role: 'manager', entries }, roles: team('pi') };
  const development = summary(coordinated, workflow('development.issue', 'development', [{ id: 'review.published' }, { id: 'issue.labeled', label: 'bot-develop' }]));
  assert.equal(development, ['#何时触发', '检视发布结论、有人加上标签：bot-develop', '#提示词', '内置默认 · .bot/rules/development.issue.md', '#模型', '未选择 · 继承项目默认',
    '#允许的写入', '修改工作区代码、开或更新 bot PR', '#谁来执行', '主控 Manager（Pi）按需委派 Dev、Test、Reviewer、UX。完成前由独立 QA 验收。 查看角色'].join('\n'));
  assert.match(summary(coordinated, workflow('review.issue', 'review', [{ id: 'issue.opened' }])), /#谁来执行\n原来的执行器：项目电脑里的 Pi 进程（这个入口没有接入主控）。完成前由独立 QA 验收。/);
  assert.match(summary({ ...coordinated, enabled: false }, workflow('custom.abc', undefined, [])), /#何时触发\n没有触发源，不会运行[\s\S]*#谁来执行\n原来的执行器：项目电脑里的 Pi 进程。/);
  assert.match(summary({ ...coordinated, legacy: true, roles: team('native') }, workflow('development.pr', 'development', [])), /主控 Manager（Native，旧配置沿用）/);
  // Adding a workflow is offered under the list, for a new trigger, not as the page's first action.
  page.run("current = { id: '101', workflows: { workflows: [] }, rules: { files: [] } }; ruleSync = () => element('div', '');");
  const side = page.run('workflowSidebar("review.issue")'), add = side.querySelector('.workflow-add');
  assert.deepEqual(side.children.map(child => child.className), ['workflow-sidebar-head', 'workflow-lists', 'workflow-add', '']);
  assert.match(text(side.querySelector('.workflow-sidebar-head')), /不需要为单个任务新写工作流/);
  assert.deepEqual(add.querySelectorAll('button').map(b => b.textContent + ':' + b.className), ['新增工作流:quiet', '用聊天新增:quiet']);
});
