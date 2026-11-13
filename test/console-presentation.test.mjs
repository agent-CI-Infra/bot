import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadConsole } from './console-page.mjs';
import { harness, setup, account, repository } from './helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { evaluateDelivery } from '../dist/tasks/acceptance.js';
import { Redactor } from '../dist/agent/common.js';

// The console's three layers: the Manager page says what each work type may write and who executes it; the roles say how
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
    next: () => page.$('task-next-text').textContent, side: () => text(page.$('task-side')),
    facts: () => page.$('task-side').querySelectorAll('.task-fact').map(part => part.dataset.fact) };
}

test('missing role records do not invent an executor, and independent QA remains a separate fact', async t => {
  const task = { id: 't1', repository_id: '101', kind: 'development.issue', object_number: 7, status: 'running', phase: 'model', attempt: 1, structured: record() };
  const view = taskPage(t, task, { instances: [], assignments: [], runs: [], snapshots: {} }); await view.open();
  assert.equal(view.next(), '执行器正在处理：Run the auth tests');
  // Goal, candidate, evidence, acceptance and publication, in that order, each from the task's own record.
  assert.deepEqual(view.facts(), ['目标', '候选', '证据', '验收', '发布']);
  const side = view.side();
  assert.match(side, /Keep the query string on the login redirect/); assert.match(side, /The redirect keeps \?next=/);
  assert.match(side, /没有读取到主控记录；实际 Agent 和模型以运行记录为准/); assert.match(side, /独立 QA\n有候选后验收/);
  assert.doesNotMatch(side, /Pi 进程/, 'an absent runtime record cannot identify the executor');
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

test('when a page cursor stops moving the records are marked unread, and the controller is not said to be deciding', async t => {
  const task = { id: 't4', repository_id: '101', kind: 'task.request', object_number: null, summary: 'Audit', status: 'running', phase: 'model', attempt: 1, structured: record() };
  const instances = [{ id: 'i-m', role: 'manager', harness: 'pi' }, { id: 'i-t', role: 'test', harness: 'process' }];
  const done = Array.from({ length: 100 }, (_, n) => ({ sequence: n + 1, id: 'old-' + n, instance_id: 'i-t', status: 'completed' }));
  // A server answering every page with the same cursor: reading stops instead of looping, and says so.
  const page = loadConsole(['static/app.js', 'static/views.js'], (_method, path) => {
    if (path.endsWith('/logs')) return [200, { logs: [] }];
    if (path.includes('/roles?')) return [200, { instances, runs: [], snapshots: {}, assignments: /after=0$/.test(path) ? done : [], next_after: 100 }];
    if (path.includes('type=role_handoff')) return [200, { events: [], next_after: null }];
    if (path === '/api/tasks/t4') return [200, { task, publications: [] }];
    return [404, {}];
  });
  page.run("scroller = node => node; taskMetricsCard = () => element('section','');"); t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  await page.run('openTask("t4")'); page.run('clearTimeout(taskTimer)');
  assert.equal(page.$('task-next-text').textContent, '委派记录没有读完（已读 100 条），现在说不清是谁在处理。');
  assert.match(text(page.$('task-side')), /委派记录没有读完：服务端的分页游标没有前进，下面只列出已读到的 100 条，看不出现在是谁在处理。/);
  assert.doesNotMatch(text(page.$('task-side')), /主控还没有委派工作/);
  assert.equal(page.requests.filter(request => request.includes('/roles?')).length, 2);
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
  // The acceptance phase alone is not a running QA run: without role records nobody is named.
  assert.equal(next({ status: 'running', phase: 'acceptance' }, record({ candidate })), '正在执行（独立验收）；读不到角色记录，说不清现在是谁在处理。');
  const none = { instances: [], assignments: [], runs: [{ role: 'qa', kind: 'acceptance', harness: 'native', status: 'succeeded' }], snapshots: {} };
  assert.equal(page.run(`taskNextStep(${JSON.stringify({ status: 'running', phase: 'acceptance' })}, ${JSON.stringify(record({ candidate }))}, roleRecords(${JSON.stringify(none)}))`),
    '任务处在独立验收阶段，但现在没有正在运行的 QA：控制面还没开始这次验收，或者正在处理验收结论。');
  assert.equal(next({ status: 'pr_opened', phase: 'done' }), '已创建 PR：没有读取到当前候选的有效独立 QA 通过记录，请核对任务事实。PR 已创建，合入与 GitHub CI 状态需分别核对。');
  const accepted = record({ candidate, acceptance: { outcome: 'pass', candidate_id: candidate.id, revision: candidate.revision } });
  assert.match(next({ status: 'completed', phase: 'done' }, accepted), /独立 QA 对当前候选的验收已通过/);
  accepted.acceptance.candidate_id = 'stale-candidate';
  assert.doesNotMatch(next({ status: 'completed', phase: 'done' }, accepted), /验收已通过/);
  assert.equal(next({ status: 'running', phase: 'validate' }), '控制面正在项目电脑里运行仓库测试。');
  // Without role records the page cannot tell the original executor from the controller, and says so.
  assert.equal(next({ status: 'running', phase: 'model' }, record({ progress: { next_action: null } })), '正在执行（模型执行）；读不到角色记录，说不清现在是谁在处理。');
  // A running QA run decides the sentence whatever the phase, also when a controller and a running delegation exist.
  const qa = { instances: [{ id: 'm', role: 'manager', harness: 'pi' }, { id: 'd', role: 'dev', harness: 'pi' }], assignments: [{ id: 'a', instance_id: 'd', status: 'running' }],
    runs: [{ role: 'dev', assignment_id: 'a', harness: 'pi', status: 'running' }, { role: 'qa', kind: 'acceptance', harness: 'native', status: 'running' }], snapshots: {} };
  assert.equal(page.run(`taskNextStep(${JSON.stringify({ status: 'running', phase: 'model' })}, ${JSON.stringify(record({ candidate }))}, roleRecords(${JSON.stringify(qa)}))`), '独立 QA 正在新的上下文里验收候选 cand12345678。');
  // Role ids are the project's: a custom role called constructor never reads Object.prototype.
  assert.equal(page.run("roleLabel('constructor')"), 'constructor'); assert.equal(page.run("roleLabel('constructor', 'Constructor checker')"), 'Constructor checker');
  assert.equal(page.run("harnessName('constructor')"), 'constructor');
});

test('task run history uses the executed snapshot and does not borrow the current model or role revision', async t => {
  const task = { id: 'historical-run', repository_id: '101', kind: 'task.request', status: 'completed', phase: 'done', structured: record() };
  const roles = { instances: [{ id: 'worker', role: 'dev', snapshot_id: 'new', harness: 'native' }], assignments: [],
    runs: [{ id: 'run-original', role: 'dev', status: 'completed', harness: 'pi', harness_version: '1.4.0', role_snapshot: 'old', started_at: '2026-11-10T01:00:00Z', ended_at: '2026-11-10T01:01:00Z' }],
    snapshots: { old: { name: 'Original worker', config_revision: 7, model: { name: 'original-model', source: 'project' } }, new: { name: 'New worker', config_revision: 9, model: { name: 'MODEL_MUST_NOT_REWRITE_HISTORY', source: 'role' } } } };
  const page = taskPage(t, task, roles); await page.open();
  assert.match(page.side(), /实际运行记录/); assert.match(page.side(), /run-original/); assert.match(page.side(), /original-model/); assert.match(page.side(), /项目默认/);
  assert.doesNotMatch(page.side(), /MODEL_MUST_NOT_REWRITE_HISTORY/);
});

// A role as GET /api/repositories/:id/roles returns it.
const role = (role_id, kind, harness, version = '1') => ({ role_id, kind, enabled: true, name: role_id, responsibility: '', persona_prompt: '', revision: 1, model_profile_ref: null, skill_bundle_ref: null,
  harness_ref: { id: harness, version }, permissions: {computer:'deny'}, environment_profile_ref: { id: 'env', version: '1' }, budget_policy_ref: { id: 'entry-default', version: '1' }, output_schema_ref: { id: 'out', version: '1' } });
// Agent backends as GET /api/repositories/:id/roles lists them: peers, Pi recommended, Claude Code for worker roles only.
const all = ['controller', 'writer', 'observer', 'evaluator'], backends = [['pi', 'Pi', '1.4.0', all], ['native', 'Native', '1', all], ['process', 'Process', '1', all], ['acp', 'ACP', '1', all], ['claude_code', 'Claude Code', '2.1.319', ['writer', 'observer', 'evaluator']]]
  .map(([id, name, version, kinds]) => ({ id, name, version, kinds, available: true, recommended: id === 'pi', integration_issue: null })).concat([{ id: 'codex', name: 'Codex', version: null, kinds: [], available: false, recommended: false, integration_issue: 171 }]);
const roleData = (config, { workflow = 'development.issue', configured = true } = {}) => ({ configuration: config, configured, revision: config.revision, workflow, backends, recommended_backend: 'pi', harnesses: backends.filter(b => b.available).map(({ id, version, kinds }) => ({ id, version, kinds })),
  models: [], revisions: [], skill_inputs: [], preview: config.roles.map(r => ({ role: r.role_id, model: r.harness_ref.id === 'acp' ? { source: 'external_harness', name: 'external' } : { source: 'project', name: 'fixture-model' } })) });
const team = controller => [role('manager', 'controller', controller, controller === 'pi' ? '1.4.0' : '1'), role('dev', 'writer', 'native'), role('test', 'observer', 'native'), role('reviewer', 'observer', 'acp'), role('ux', 'observer', 'native'), role('qa', 'evaluator', 'native'), role('coordinator', 'controller', 'native')];
const entries = { development: true, request: true, review: false, actions: false };
function rolesDraft(data) {
  return {enabled:data.configuration.enabled,controller:data.configuration.controller,roles:data.configuration.roles.map(role=>({...role,...(!data.configured?{harness_ref:{id:'pi'}}:{})})),skills:[],required_stages:[]};
}
function rolesPage(data) {
  data.permission_items = [{id:'computer',name:'使用虚拟电脑',group:'platform',modes:['deny','allow'],detail:'读取、修改工作区文件和执行命令。'}];
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/roles.js'], () => [404, {}]);
  const draft = rolesDraft(data);
  page.run(`current={id:'101',section:'roles'}; window.roleState=${JSON.stringify({data,draft,dirty:false})}; window.roleView=roleOverviewCards(roleState,()=>{});`);
  const cards=[...page.run('roleView')];return {page,cards,table:cards[0].querySelector('table')};
}
function roleForm(data, roleId = 'dev') {
  data.permission_items = data.permission_items || [{id:'computer',name:'使用虚拟电脑',group:'platform',modes:['deny','allow'],detail:'读取、修改工作区文件和执行命令。'}];
  data.environment_profiles = data.environment_profiles || [];
  data.output_schemas = data.output_schemas || [];
  data.system_prompt = data.system_prompt || '';
  data.role_templates = data.role_templates || {};
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/roles.js'], () => [404, {}]);
  const draft = rolesDraft(data);
  page.run(`current={id:'101',section:'roles',item:${JSON.stringify(roleId)}}; window.roleState=${JSON.stringify({data,draft,dirty:false})}; window.roleForm=roleSettingsCard(roleState.draft.roles.find(r=>r.role_id===${JSON.stringify(roleId)}), roleState, ()=>{}, {live:()=>true,failed:()=>{}});`);
  return {page, form: page.run('roleForm')};
}
test('role overview is a list of name, enabled, duty and status, without inline editors', () => {
  const view=rolesPage(roleData({schema:2,revision:4,enabled:true,controller:{role:'manager',entries},roles:team('pi'),skills:[]}));
  assert.equal(view.cards[0].children[0].textContent,'角色概览');
  assert.deepEqual([...view.table.querySelectorAll('th')].map(th => th.textContent), ['角色', '启用', '职责', '状态']);
  assert.equal(view.table.querySelectorAll('select').length, 0);
  assert.doesNotMatch(text(view.cards[0]), /编辑权限/);
  assert.doesNotMatch(text(view.cards[0]), /policy@|配置（JSON）|修改配置/);
  const link = [...view.table.querySelectorAll('a')].find(a => a.textContent === 'Dev');
  assert.equal(link && link.href, '#/projects/101/roles/dev');
  assert.match(text(view.table.querySelector('tr[data-role=dev]')), /已启用/);
  const status=view.cards[0].querySelector('[data-role-version]');
  assert.equal(status.textContent,'配置版本 4 · 已生效');
});
test('role list status is per-role and refreshes when enabled is toggled', () => {
  const data=roleData({schema:2,revision:4,enabled:true,controller:{role:'manager',entries},roles:team('pi'),skills:[]});
  data.permission_items=[{id:'computer',name:'使用虚拟电脑',group:'platform',modes:['deny','allow'],detail:'读取、修改工作区文件和执行命令。'}];
  const page=loadConsole(['static/app.js','static/views.js','static/project.js','static/roles.js'],()=>[404,{}]);
  const draft=rolesDraft(data);
  page.run(`current={id:'101',section:'roles'}; window.roleState=${JSON.stringify({data,draft,dirty:false})};
    window.drawRoles=()=>{window.roleView=roleOverviewCards(roleState,window.drawRoles);};
    window.drawRoles();`);
  const row=id=>page.run(`roleView[0].querySelector(${JSON.stringify('tr[data-role='+id+']')})`);
  assert.match(text(row('dev')), /已启用 · 已保存/);
  assert.match(text(row('test')), /已启用 · 已保存/);
  const box=page.run("roleView[0].querySelector('tr[data-role=dev] input')");
  box.checked=false;
  for (const fn of box.listeners.change || []) fn();
  assert.equal(page.run('roleState.dirty'), true);
  assert.equal(page.run("roleState.draft.roles.find(r=>r.role_id==='dev').enabled"), false);
  assert.match(text(row('dev')), /已关闭 · 有未保存的更改/);
  assert.match(text(row('test')), /已启用 · 已保存/);
  assert.doesNotMatch(text(row('test')), /有未保存的更改/);
});
test('role form edits backends without a JSON editor, and marks the draft dirty', () => {
  const manager=roleForm(roleData({schema:2,revision:4,enabled:true,controller:{role:'manager',entries},roles:team('pi'),skills:[]}), 'manager');
  const dev=roleForm(roleData({schema:2,revision:4,enabled:true,controller:{role:'manager',entries},roles:team('pi'),skills:[]}), 'dev');
  const reviewer=roleForm(roleData({schema:2,revision:4,enabled:true,controller:{role:'manager',entries},roles:team('pi'),skills:[]}), 'reviewer');
  const picker=(view,id)=>view.form.querySelectorAll('select').find(select=>select.getAttribute('aria-label')===id+' Agent 后端');
  assert.equal(picker(manager,'manager').value,'pi');
  assert.equal(picker(dev,'dev').value,'native');
  assert.equal(picker(reviewer,'reviewer').value,'acp');
  assert.ok(picker(manager,'manager').children.find(option=>option.value==='claude_code').disabled);
  assert.ok(!picker(dev,'dev').children.find(option=>option.value==='claude_code').disabled);
  assert.doesNotMatch(text(dev.form),/能力策略|policy@|配置（JSON）|修改配置/);
  picker(dev,'dev').value='process';picker(dev,'dev').listeners.change[0]();
  assert.equal(dev.page.run("roleState.draft.roles.find(r=>r.role_id==='dev').harness_ref.id"),'process');
  assert.equal(dev.page.run('roleState.dirty'), true);
});
test('role form preserves stored backends and recommends Pi only for an unsaved project', () => {
  const config={schema:2,revision:0,enabled:true,legacy:true,controller:{role:'manager',entries},roles:team('native'),skills:[]};
  const saved=roleForm(roleData(config),'manager');
  assert.equal(saved.form.querySelectorAll('select').find(s=>s.getAttribute('aria-label')==='manager Agent 后端').value,'native');
  const fresh=roleForm(roleData(config,{configured:false}),'manager');
  assert.equal(fresh.form.querySelectorAll('select').find(s=>s.getAttribute('aria-label')==='manager Agent 后端').value,'pi');
  const list=rolesPage(roleData(config,{configured:false}));
  assert.equal(list.cards[0].querySelector('[data-role-version]').textContent,'尚未保存。可先使用推荐配置。');
  assert.match(text(list.table.querySelector('tr[data-role=manager]')), /推荐配置/);
});

// ---- Against the real control plane: the page reads the same routes and fields the server returns. ----

// A project with an idle task engine (it serves the role and task routes but never runs tasks) and a console page whose
// requests go to that server with the administrator's session.
async function realProject(t, files = ['static/app.js', 'static/views.js', 'static/project.js', 'static/manager.js'], rewrite = null) {
  const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };
  const h = await harness(t, manager, store => ({ engine: new TaskEngine(store, manager) })), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const page = loadConsole(files, async (method, path, body) => { const response = await admin(path, method, body); return rewrite?.(path, response) || [response.status, response.value]; });
  page.run("scroller = node => node; taskMetricsCard = () => element('section','');"); t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  const now = new Date().toISOString();
  const task = (id, kind, phase = 'model') => h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,attempt,created_at,updated_at) VALUES(?,'101',?,'running','Fixture task',7,?,1,?,?)", id, kind, phase, now, now);
  const instance = (id, owner, role, harness, snapshot = null) => h.store.run('INSERT INTO role_instances(id,task_id,role,definition,harness,updated_at,snapshot_id) VALUES(?,?,?,?,?,?,?)', id, owner, role, '{}', harness, now, snapshot);
  const open = async id => { await page.run(`openTask(${JSON.stringify(id)})`); page.run('clearTimeout(taskTimer)'); };
  return { h, admin, page, now, task, instance, open, records: new TaskRecords(h.store), next: () => page.$('task-next-text').textContent, side: () => text(page.$('task-side')) };
}
// A chat model that holds every request until released, so a page can look at a QA run while it is running.
async function heldModel(t) {
  const waiting = [], verdict = { outcome: 'pass', reason: 'Fixture accepted', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true };
  let arrived; const calls = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* the request body is not needed */ }
    await new Promise(resolve => { waiting.push(resolve); calls.push(1); arrived?.(); });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const release = () => waiting.splice(0).forEach(resolve => resolve());
  t.after(() => { release(); return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, release, called: count => new Promise(resolve => { arrived = () => calls.length >= count && resolve(); arrived(); }) };
}

test('independent QA started by development and review delivery is named in the next step while the task phase is still model', async t => {
  const p = await realProject(t), model = await heldModel(t);
  const fixture = (await p.admin('/api/models', 'POST', { repository_id: '101', model_name: 'qa-fixture', api_url: model.url, api_key: 'fixture-key' })).value.model;
  await p.admin('/api/repositories/101/policy', 'PATCH', { model_id: fixture.id });
  const cases = [['dev-qa', 'development.issue', { kind: 'code', reference: 'task:dev-qa:candidate', version: 'tree0123456789abcdef', content: { tree_sha: 'tree0123456789abcdef' } }],
    ['review-qa', 'review.issue', { kind: 'report', reference: 'task:review-qa:candidate', version: 'report0123456789', content: { summary: 'Review report' } }]];
  for (const [id, kind, artifact] of cases) {
    p.task(id, kind); p.records.contract(id, { goal: 'Fixture goal', scope: [kind], criteria: ['Deliver the result'], endpoint: null, source: kind });
    const candidate = p.records.submit(id, [artifact], [], {});
    // The same call the engine makes from inside the executor; it records acceptance_started and runs QA without
    // changing the task's phase.
    const evaluation = evaluateDelivery(p.h.store, p.h.store.get('SELECT * FROM tasks WHERE id=?', id), { call: async () => ({ content: 'Fixture report' }) }, new Redactor(), async () => {}, false);
    await model.called(cases.findIndex(entry => entry[0] === id) + 1);
    const roles = (await p.admin(`/api/tasks/${id}/roles?limit=100&after=0`)).value;
    try {
      assert.deepEqual([p.h.store.get('SELECT phase FROM tasks WHERE id=?', id).phase, ...roles.runs.filter(run => run.status === 'running').map(run => run.role + ':' + run.kind)], ['model', 'qa:acceptance']);
      // The page's own reading of the server's facts, then what the open task shows.
      const detail = (await p.admin('/api/tasks/' + id)).value.task;
      assert.equal(p.page.run(`taskNextStep(${JSON.stringify(detail)}, ${JSON.stringify(detail.structured)}, roleRecords(${JSON.stringify(roles)}))`), `独立 QA 正在新的上下文里验收候选 ${candidate.id.slice(0, 12)}。`, kind);
      await p.open(id); assert.equal(p.next(), `独立 QA 正在新的上下文里验收候选 ${candidate.id.slice(0, 12)}。`, kind);
      // A controller on the task does not take the sentence over while QA runs.
      p.instance(id + '-manager', id, 'manager', 'pi'); await p.open(id); assert.equal(p.next(), `独立 QA 正在新的上下文里验收候选 ${candidate.id.slice(0, 12)}。`, kind + ' under the controller');
    } finally { model.release(); await evaluation; }
    // QA has returned (its run succeeded); even with the phase moved to acceptance, as ordinary requests do, nothing
    // says QA is still accepting.
    p.h.store.run("UPDATE tasks SET phase='acceptance' WHERE id=?", id);
    const after = (await p.admin(`/api/tasks/${id}/roles?limit=100&after=0`)).value;
    assert.deepEqual(after.runs.filter(run => run.role === 'qa').map(run => run.status), ['succeeded']);
    await p.open(id); assert.equal(p.next(), '任务处在独立验收阶段，但现在没有正在运行的 QA：控制面还没开始这次验收，或者正在处理验收结论。', kind + ' after QA');
  }
});

test('delegations are read to the last page: the 1001st, running, is the one the next step names with its purpose', async t => {
  const p = await realProject(t);
  p.task('long', 'task.request'); p.instance('long-manager', 'long', 'manager', 'pi'); p.instance('long-test', 'long', 'test', 'process');
  p.h.store.db.exec('BEGIN');
  for (let n = 1; n <= 1001; n++) {
    p.h.store.run('INSERT INTO role_assignments VALUES(?,?,?,?,?,?,?,NULL)', 'a-' + n, 'long', 'long-test', 1, null, n === 1001 ? 'running' : 'completed', 'input-' + n);
    p.h.store.run("INSERT INTO task_history(task_id,type,data,created_at,actor) VALUES('long','role_handoff',?,?,'role:manager')", JSON.stringify({ assignment_id: 'a-' + n, role: 'test', purpose: 'Purpose ' + n, refs: [], revision: 1 }), p.now);
  }
  p.h.store.db.exec('COMMIT');
  // The page's own paging of the real routes, then what the open task shows.
  const view = await p.page.run('taskRoleView("long")'), detail = (await p.admin('/api/tasks/long')).value.task;
  assert.equal(view.assignments.length, 1001);
  const purposes = await p.page.run(`rolePurposes('long', roleRecords(${JSON.stringify(view)}))`);
  assert.equal(p.page.run(`taskNextStep(${JSON.stringify(detail)}, null, roleRecords(${JSON.stringify(view)}), ${JSON.stringify(purposes)})`), 'Test（Process）正在做主控交给它的工作：Purpose 1001');
  p.page.run('handoffPurposes = { task: null }');
  const opened = p.page.requests.length; await p.open('long');
  assert.equal(p.next(), 'Test（Process）正在做主控交给它的工作：Purpose 1001');
  const items = p.page.$('task-side').querySelectorAll('.role-work > li');
  assert.equal(items.length, 1001); assert.match(text(items.at(-1)), /^Test\nProcess\n进行中\nPurpose 1001$/);
  assert.equal(p.page.requests.slice(opened).filter(request => request.includes('/roles?')).length, 11);
  // Later refreshes read only the handoff events after the last one read.
  p.h.store.run("INSERT INTO role_assignments VALUES('a-1002','long','long-test',1,NULL,'running','input-1002',NULL)");
  p.h.store.run("INSERT INTO task_history(task_id,type,data,created_at,actor) VALUES('long','role_handoff',?,?,'role:manager')", JSON.stringify({ assignment_id: 'a-1002', role: 'test', purpose: 'Purpose 1002', refs: [], revision: 1 }), p.now);
  const before = p.page.requests.length; await p.page.run('(async () => { await refreshTask(); clearTimeout(taskTimer); })()');
  const handoffs = p.page.requests.slice(before).filter(request => request.includes('type=role_handoff'));
  assert.equal(handoffs.length, 1); assert.doesNotMatch(handoffs[0], /after=0$/); assert.equal(p.next(), 'Test（Process）正在做主控交给它的工作：Purpose 1002');
});

test('with a delegation running on the pages read and records left unread, the next step names nobody', async t => {
  // Real pages from the server; only the page after the first is replaced by a stalled cursor (empty, same cursor).
  let stall = false;
  const p = await realProject(t, undefined, (path, response) => stall && /\/roles\?limit=100&after=100$/.test(path) ? [200, { ...response.value, assignments: [], next_after: 100 }] : null);
  p.task('mixed', 'task.request'); p.instance('m-manager', 'mixed', 'manager', 'pi'); p.instance('m-test', 'mixed', 'test', 'process'); p.instance('m-reviewer', 'mixed', 'reviewer', 'acp');
  p.h.store.db.exec('BEGIN');
  for (let n = 1; n <= 101; n++) {
    const [owner, status, purpose] = n === 1 ? ['m-test', 'running', 'Earlier running test'] : n === 101 ? ['m-reviewer', 'running', 'Latest running review'] : ['m-test', 'completed', 'Finished check ' + n];
    p.h.store.run('INSERT INTO role_assignments VALUES(?,?,?,?,?,?,?,NULL)', 'm-' + n, 'mixed', owner, 1, null, status, 'input-' + n);
    p.h.store.run("INSERT INTO task_history(task_id,type,data,created_at,actor) VALUES('mixed','role_handoff',?,?,'role:manager')", JSON.stringify({ assignment_id: 'm-' + n, role: owner.slice(2), purpose, refs: [], revision: 1 }), p.now);
  }
  p.h.store.db.exec('COMMIT');
  // Read to the end, the newest running delegation is the one at work.
  await p.open('mixed'); assert.equal(p.next(), 'Reviewer（ACP）正在做主控交给它的工作：Latest running review');
  p.page.run('taskView.close()'); stall = true; await p.open('mixed');
  const next = p.next();
  assert.equal(next, '委派记录没有读完（已读 100 条），现在说不清是谁在处理。');
  assert.doesNotMatch(next, /Test|Reviewer|主控|执行器/);
  // What was read is still listed, under the warning that says it is not all.
  const card = p.page.$('task-side').querySelector('.task-execution'), parts = card.children.map(child => child.className || child.tagName);
  assert.ok(parts.indexOf('endpoint-warning') >= 0 && parts.indexOf('endpoint-warning') < parts.indexOf('role-work'), JSON.stringify(parts));
  assert.match(text(card), /委派记录没有读完：服务端的分页游标没有前进，下面只列出已读到的 100 条，看不出现在是谁在处理。/);
  const items = card.querySelectorAll('.role-work > li');
  assert.equal(items.length, 100); assert.match(text(items[0]), /^Test\nProcess\n进行中\nEarlier running test$/);
  // In the acceptance phase with no QA run read, unread records still mean nobody is named, QA included.
  p.h.store.run("UPDATE tasks SET phase='acceptance' WHERE id='mixed'");
  assert.equal((await p.admin('/api/tasks/mixed/roles?limit=100&after=0')).value.runs.filter(run => run.role === 'qa' && run.status === 'running').length, 0);
  p.page.run('taskView.close()'); await p.open('mixed');
  assert.equal(p.next(), '委派记录没有读完（已读 100 条），现在说不清是谁在处理。');
  // Read to the end, the running delegation is named, not QA.
  p.page.run('taskView.close()'); stall = false; await p.open('mixed');
  assert.equal(p.next(), 'Reviewer（ACP）正在做主控交给它的工作：Latest running review');
});

test('a past delegation shows the harness its runs used, not the one its role instance was rebound to later', async t => {
  const p = await realProject(t);
  p.task('historical', 'task.request'); p.instance('h-manager', 'historical', 'manager', 'pi'); p.instance('h-reviewer', 'historical', 'reviewer', 'acp');
  const run = (id, assignment, harness, status, extra = {}) => p.h.store.run(`INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,stop_reason,context_snapshot,config_snapshot,role,role_instance_id,assignment_id,harness,recovery_mode)
    VALUES(?,'historical','role',1,1,?,?,?,'{}','{}','reviewer','h-reviewer',?,?,?)`, id, p.now, status, extra.stop ?? null, assignment, harness, extra.recovery ?? null);
  p.h.store.run("INSERT INTO role_assignments VALUES('old','historical','h-reviewer',1,NULL,'completed','old-input','old-result')"); run('old-run', 'old', 'native', 'succeeded', { recovery: 'new_session' });
  // One delegation that crossed a revision: ended at a checkpoint on Native, continued on ACP.
  p.h.store.run("INSERT INTO role_assignments VALUES('moved','historical','h-reviewer',1,NULL,'running','moved-input',NULL)");
  run('moved-1', 'moved', 'native', 'fault', { stop: 'role_revision_checkpoint', recovery: 'new_session' }); run('moved-2', 'moved', 'acp', 'running', { recovery: 'checkpoint_transcript' });
  const roles = (await p.admin('/api/tasks/historical/roles?limit=100&after=0')).value;
  assert.deepEqual(roles.instances.find(i => i.id === 'h-reviewer').harness, 'acp');
  await p.open('historical');
  const items = p.page.$('task-side').querySelectorAll('.role-work > li').map(text);
  assert.equal(items[0], 'Reviewer\nNative\n已交回');
  assert.equal(items[1], 'Reviewer\nNative → ACP\n进行中\n执行了 2 次：第 1 次 Native，中止（换到新 revision）；第 2 次 ACP，从检查点续接，进行中。');
  assert.equal(p.next(), 'Reviewer（ACP）正在做主控交给它的工作。');
});

test('review and Actions summaries offer only Dev on its backend in the entry; development offers every enabled worker', async t => {
  const p = await realProject(t);
  const saved = await p.admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: true, controller: { role: 'manager', entries: { development: true, request: true, review: true, actions: true } }, roles: [{ role_id: 'ux', enabled: false }] });
  assert.equal(saved.status, 200);
  const config=saved.value.configuration;
  const execution=(configuration, id)=>p.page.run(`entryDevText(${JSON.stringify(configuration)})`);
  assert.equal(p.page.run(`workerNames(entryWorkers(${JSON.stringify(config)},'development'))`),'Dev、Test、Reviewer');
  assert.equal(execution(config,'review.issue'),'只委派 Dev，Dev 用这个入口的工具和工作区，后端 Pi');
  // Dev's own backend applies once chosen; an older V2 configuration keeps Pi in these entries until Dev's choice changes.
  const devTo = async (harness, revision) => (await p.admin('/api/repositories/101/roles', 'PUT', { expected_revision: revision, enabled: true, controller: { role: 'manager', entries: { development: true, request: true, review: true, actions: true } }, roles: [{ role_id: 'ux', enabled: false }, { role_id: 'dev', harness_ref: { id: harness } }] })).value.configuration;
  const processDev = await devTo('process', 1);
  assert.equal(execution(processDev, 'review.issue'),
    '只委派 Dev，Dev 用这个入口的工具和工作区，后端 Process');
  const older = JSON.parse(p.h.store.get("SELECT value FROM settings WHERE key='roles:101'").value), dev = older.roles.find(r => r.role_id === 'dev');
  delete dev.entry_harness_source; dev.harness_ref = { id: 'native', version: '1' }; p.h.store.run("UPDATE settings SET value=? WHERE key='roles:101'", JSON.stringify(older));
  const kept = (await p.admin('/api/repositories/101/roles')).value.configuration;
  assert.equal(execution(kept, 'actions.failures'),
    '只委派 Dev，Dev 用这个入口的工具和工作区，后端 Pi（旧 V2 配置沿用 Pi，Dev 的后端选择改变后才换）');
});

test('a custom role called constructor shows its own name and responsibility on the 角色 page and in a task', async t => {
  const p = await realProject(t);
  // Resolving a role needs a usable project model; it is never asked anything here.
  const fixture = (await p.admin('/api/models', 'POST', { repository_id: '101', model_name: 'resolve-fixture', api_url: 'http://127.0.0.1:9/v1', api_key: 'fixture-key' })).value.model;
  await p.admin('/api/repositories/101/policy', 'PATCH', { model_id: fixture.id });
  const save = async (revision, responsibility) => (await p.admin('/api/repositories/101/roles', 'PUT', { expected_revision: revision, enabled: true, controller: { role: 'manager', entries: { development: true, request: true, review: false, actions: false } },
    roles: [{ role_id: 'constructor', name: 'Construction inspector', responsibility }] }));
  assert.equal((await save(0, 'Inspect construction invariants only.')).status, 200);
  const configured=(await p.admin('/api/repositories/101/roles')).value.configuration.roles.find(r=>r.role_id==='constructor');
  assert.equal(configured.name,'Construction inspector');assert.equal(configured.responsibility,'Inspect construction invariants only.');
  // In a task, name and responsibility come from the snapshot a delegation ran with, as the server stores it.
  const snapshot = async () => {
    const resolved = (await p.admin('/api/repositories/101/roles/resolve', 'POST', { role: 'constructor' })).value;
    p.h.store.run('INSERT INTO role_snapshots VALUES(?,?,?,?,?,?,?)', resolved.snapshot_id, '101', 'constructor', resolved.snapshot.config_revision, resolved.snapshot.role_revision, JSON.stringify(resolved.snapshot), p.now);
    return resolved;
  };
  const first = await snapshot(); assert.equal(first.snapshot.responsibility, 'Inspect construction invariants only.');
  p.task('custom', 'task.request'); p.instance('c-manager', 'custom', 'manager', 'pi'); p.instance('c-constructor', 'custom', 'constructor', 'native', first.snapshot_id);
  p.h.store.run("INSERT INTO role_assignments VALUES('c-1','custom','c-constructor',1,NULL,'running','c-input-1',NULL)");
  await p.open('custom');
  assert.equal(p.next(), 'Construction inspector（Native）正在做主控交给它的工作。');
  let items = p.page.$('task-side').querySelectorAll('.role-work > li').map(text);
  assert.equal(items[0], 'Construction inspector\nNative\n进行中\n职责：Inspect construction invariants only.');
  // The definition changes later and the instance is rebound; the earlier delegation keeps what it ran with.
  p.h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role,role_instance_id,assignment_id,role_snapshot,harness) VALUES('c-run-1','custom','role',1,1,?,'succeeded','{}','{}','constructor','c-constructor','c-1',?,'native')", p.now, first.snapshot_id);
  p.h.store.run("UPDATE role_assignments SET status='completed' WHERE id='c-1'");
  assert.equal((await save(1, 'Inspect only the new construction paths.')).status, 200);
  const second = await snapshot(); p.h.store.run("UPDATE role_instances SET snapshot_id=? WHERE id='c-constructor'", second.snapshot_id);
  p.h.store.run("INSERT INTO role_assignments VALUES('c-2','custom','c-constructor',1,NULL,'running','c-input-2',NULL)");
  p.page.run('taskView.close()'); await p.open('custom');
  items = p.page.$('task-side').querySelectorAll('.role-work > li').map(text);
  assert.deepEqual(items, ['Construction inspector\nNative\n已交回\n职责：Inspect construction invariants only.', 'Construction inspector\nNative\n进行中\n职责：Inspect only the new construction paths.']);
  assert.doesNotMatch(p.side(), /function|native code/);
  // A delegation that ran without a recorded snapshot (role_snapshot may be null) gets no definition from today's
  // instance: the definition changes again and the instance moves to Process, and that delegation still says Native
  // and that its historical definition is unavailable.
  p.h.store.run("INSERT INTO role_assignments VALUES('c-0','custom','c-constructor',1,NULL,'completed','c-input-0',NULL)");
  p.h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role,role_instance_id,assignment_id,role_snapshot,harness) VALUES('c-run-0','custom','role',1,1,?,'succeeded','{}','{}','constructor','c-constructor','c-0',NULL,'native')", p.now);
  const v2 = await p.admin('/api/repositories/101/roles', 'PUT', { expected_revision: 2, enabled: true, controller: { role: 'manager', entries: { development: true, request: true, review: false, actions: false } },
    roles: [{ role_id: 'constructor', name: 'Construction inspector v2', responsibility: 'Inspect the changed construction paths.', harness_ref: { id: 'process' } }] });
  assert.equal(v2.status, 200, JSON.stringify(v2.value));
  const third = await snapshot(); p.h.store.run("UPDATE role_instances SET snapshot_id=?,harness='process' WHERE id='c-constructor'", third.snapshot_id);
  const roles = (await p.admin('/api/tasks/custom/roles?limit=100&after=0')).value;
  assert.deepEqual(roles.runs.filter(run => run.assignment_id === 'c-0').map(run => [run.role_snapshot, run.harness]), [[null, 'native']]);
  p.page.run('taskView.close()'); await p.open('custom');
  // Delegations are listed in the order they were recorded: c-1, c-2, then c-0.
  const missing = p.page.$('task-side').querySelectorAll('.role-work > li').map(text)[2];
  assert.equal(missing, 'constructor\nNative\n已交回\n历史定义不可用：这次运行没有留下可读的角色快照，名称和职责不按现在的定义补写。');
  assert.doesNotMatch(missing, /Construction inspector v2|Inspect the changed construction paths/);
  // The delegation that has not run yet takes today's definition and harness.
  assert.match(p.side(), /Construction inspector v2\nProcess\n进行中\n职责：Inspect the changed construction paths\./);
});


test('a source-owned task shows its actual role without inventing a controller or legacy Pi executor',async t=>{
  for(const role of ['reviewer','manager']){
    const task={id:'owned-'+role,repository_id:'101',kind:'task.request',status:'running',phase:'model',attempt:1,structured:record(),origin:{source_kind:'role',source_role:role,executor_role:role,conversation_id:'chat-a',source_message:'incoming-a'}};
    const view=taskPage(t,task,{instances:role==='manager'?[{id:'m',role:'manager',harness:'native',snapshot_id:'s'}]:[],assignments:[],runs:[],snapshots:{}});
    view.page.run('function taskOriginCaption(origin) { return origin.executor_role; } function note(value) { return element("p", value); }');await view.open();
    assert.ok(view.next().includes('角色 '+role+' 正在处理'));assert.ok(view.side().includes('任务执行角色：'+role),role+': '+text(view.page.$('task-error'))+'; side='+view.side());assert.doesNotMatch(view.side(),/原来的执行器|Pi 进程直接执行|按需委派/);
    const active=view.page.run(`taskNextStep(${JSON.stringify(task)},${JSON.stringify(record())},{complete:true,instances:[],runs:[],assignments:[{id:'own-run',status:'running',role:'reviewer',name:'Reviewer',harness:'native'}]})`);
    assert.match(active,/正在处理任务/);assert.doesNotMatch(active,/主控交给/);
  }
});
