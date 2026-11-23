import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #1285: when every unreturned child waits on the project computer or its configuration, the parent used to show only
// "automatically continues when any result arrives". The summary now names each child's status, error code and recovery.
// The aggregate cause and settings destination must come from each child's failure cause (status + error code), so a
// model/repository wait never opens the wrong settings page and disagreeing children fall back to the child entries.
const scripts = ['static/app/states.js', 'static/app/state.js', 'static/app/api.js', 'static/app/addresses.js', 'static/views/status-text.js',
  'static/views/widgets.js', 'static/views/task-session.js', 'static/views/task-records.js'];
const child = (id, status, error_code, recovery) => ({ id, status, error_code, recovery });
const task = (blocked, error_cause = null) => ({
  id: 'parent', repository_id: '101', status: 'waiting_coordination', error_code: 'task_children_pending',
  summary: 'Parent task', error_cause: error_cause || { cause: blocked?.cause || null, label: blocked?.label || '', action: blocked?.action || '' },
  structured: { contract: { goal: 'Parent task', criteria: [] }, children: { blocked } },
});
const block = (children, { cause = null, destination = null, mixed = false, label = '子任务分别等待不同原因',
  action = '请打开子任务查看各自的阻塞原因；条件恢复后子任务会自动继续。' } = {}) => ({
  count: children.length, statuses: [...new Set(children.map(item => item.status))], error_codes: children.map(item => item.error_code),
  cause, destination, mixed, label, action, children,
});

test('#1285: an all-waiting parent lists each child, derives its settings entry and does not rebuild unchanged polls', () => {
  const page = loadConsole(scripts, async () => [200, {}]);
  const environment = task(block([
    child('c-env', 'waiting_environment', 'fixture_tool_scope_denied', '环境或外部条件恢复后子任务会自动继续。'),
    child('c-config', 'waiting_configuration', 'model_not_configured', '按子任务说明修正模型配置后子任务会自动继续。'),
  ], { cause: 'environment', destination: { section: 'machine', caption: '检查项目电脑' }, label: '子任务等待项目电脑或运行环境',
    action: '检查项目电脑或运行环境，并打开子任务查看各自的阻塞原因；条件恢复后子任务会自动继续。' }));
  page.run(`renderTaskSummaryBody(${JSON.stringify(environment)}, {})`);
  const box = page.$('task-fault-box');
  assert.equal(box.hidden, false);
  assert.equal(box.classList.contains('task-blocked-callout'), true);
  assert.equal(box.children[0].textContent, '子任务阻塞原因：');
  assert.equal(box.children[1].textContent, '子任务等待项目电脑或运行环境（2 个子任务）');
  const rows = box.children[2].children;
  assert.equal(box.children[2].className, 'task-blocked-children');
  assert.deepEqual(rows.map(item => item.children[0].tagName), ['BUTTON', 'BUTTON']);
  assert.deepEqual(rows.map(item => item.children[0].textContent), ['子任务 c-env', '子任务 c-config']);
  assert.deepEqual(rows.map(item => item.children[1].textContent), [
    ' · 等待环境 · fixture_tool_scope_denied · 环境或外部条件恢复后子任务会自动继续。',
    ' · 配置待补 · model_not_configured · 按子任务说明修正模型配置后子任务会自动继续。',
  ]);
  assert.match(box.children[3].textContent, /检查项目电脑或运行环境/);
  assert.deepEqual(JSON.parse(JSON.stringify(page.run(`taskConfigurationDestination(${JSON.stringify(environment)})`))), { section: 'machine', caption: '检查项目电脑' });

  // The poll redraws the same aggregate object: the focusable child button must survive until the content changes.
  const button = rows[0].children[0];
  page.run(`renderTaskSummaryBody(${JSON.stringify(environment)}, {})`);
  assert.equal(page.$('task-fault-box').children[2].children[0].children[0], button);
  const changed = structuredClone(environment);
  changed.structured.children.blocked.children[0].recovery = '等待环境恢复后子任务会自动继续。';
  page.run(`renderTaskSummaryBody(${JSON.stringify(changed)}, {})`);
  assert.notEqual(page.$('task-fault-box').children[2].children[0].children[0], button);
  assert.match(page.$('task-fault-box').children[2].children[0].children[1].textContent, /等待环境恢复/);
});

test('#1285: recovery follows the real child causes and mixed causes stay neutral', () => {
  const page = loadConsole(scripts, async () => [200, {}]);
  const configuration = task(block([child('c-role', 'waiting_configuration', 'role_configuration_changed', '按子任务说明修正配置后子任务会自动继续。')],
    { cause: 'role_configuration', destination: { section: 'roles', caption: '打开角色配置' }, label: '子任务等待配置', action: '按子任务说明修正项目、角色或集成配置；条件满足后子任务会自动继续。' }));
  assert.deepEqual(JSON.parse(JSON.stringify(page.run(`taskConfigurationDestination(${JSON.stringify(configuration)})`))), { section: 'roles', caption: '打开角色配置' });
  page.run(`renderTaskSummaryBody(${JSON.stringify(configuration)}, {})`);
  assert.match(page.$('task-fault-box').children[1].textContent, /子任务等待配置/);

  const model = task(block([child('c-model', 'waiting_configuration', 'model_not_configured', '按子任务说明修正模型配置后子任务会自动继续。')],
    { cause: 'model', destination: { section: 'model', caption: '打开项目模型配置' }, label: '子任务等待模型配置', action: '按子任务说明修正项目模型配置；条件满足后子任务会自动继续。' }));
  assert.deepEqual(JSON.parse(JSON.stringify(page.run(`taskConfigurationDestination(${JSON.stringify(model)})`))), { section: 'model', caption: '打开项目模型配置' });

  // Repository-class waits have no settings page; the parent offers the child entries instead of guessing one.
  const repository = task(block([child('c-repo', 'waiting_configuration', 'repository_has_no_commit', '按子任务说明修正仓库内容或规则后子任务会自动继续。')],
    { cause: 'repository', label: '子任务等待仓库内容或规则修正', action: '按子任务说明修正仓库内容或规则；条件满足后子任务会自动继续。' }));
  assert.equal(page.run(`taskConfigurationDestination(${JSON.stringify(repository)})`), null);
  page.run(`renderTaskHeader(${JSON.stringify(repository)}, {}); renderTaskSummaryBody(${JSON.stringify(repository)}, {})`);
  assert.equal(page.$('task-actions').children[0].textContent, '查看子任务');
  assert.match(page.$('task-fault-box').children[1].textContent, /仓库内容或规则/);

  const mixed = task(block([
    child('c-model', 'waiting_configuration', 'model_not_configured', '按子任务说明修正模型配置后子任务会自动继续。'),
    child('c-repo', 'waiting_configuration', 'repository_has_no_commit', '按子任务说明修正仓库内容或规则后子任务会自动继续。'),
  ], { mixed: true }));
  assert.equal(page.run(`taskConfigurationDestination(${JSON.stringify(mixed)})`), null);
  page.run(`renderTaskHeader(${JSON.stringify(mixed)}, {}); renderTaskSummaryBody(${JSON.stringify(mixed)}, {})`);
  assert.equal(page.$('task-actions').children[0].textContent, '查看子任务');
  assert.equal(page.$('task-fault-box').children[1].textContent, '子任务分别等待不同原因（2 个子任务）');

  // A sibling that can still return keeps the ordinary wait-first contract: no aggregate child list is invented.
  const ordinary = task(null);
  page.run(`renderTaskSummaryBody(${JSON.stringify(ordinary)}, {})`);
  assert.equal(page.$('task-fault-box').hidden, false);
  assert.equal(page.$('task-fault-box').children[0].textContent, '异常原因：');
  assert.equal(page.$('task-fault-box').classList.contains('task-blocked-callout'), false);
  assert.equal(page.run(`taskConfigurationDestination(${JSON.stringify(ordinary)})`), null);
});

test('#1285: the progress sentence keeps only the short aggregate label while the callout owns the action', () => {
  const page = loadConsole(scripts, async () => [200, {}]);
  const blocked = block([child('c-role', 'waiting_configuration', 'role_configuration_changed', '按子任务说明修正配置后子任务会自动继续。')],
    { cause: 'role_configuration', destination: { section: 'roles', caption: '打开角色配置' }, label: '子任务等待配置', action: '按子任务说明修正项目、角色或集成配置；条件满足后子任务会自动继续。' });
  // The server keeps error_cause.action empty for the parent; the callout still carries the full advice.
  const waiting = task(blocked, { cause: 'role_configuration', label: '子任务等待配置', action: '' });
  assert.equal(page.run(`liveText(${JSON.stringify(waiting)})`), '已暂停：等待协调 · 子任务等待配置（task_children_pending）。');
  assert.equal(page.run(`taskNextStep(${JSON.stringify(waiting)}, null)`), '已暂停（等待协调）：子任务等待配置。');
  page.run(`renderTaskSummaryBody(${JSON.stringify(waiting)}, {})`);
  assert.match(page.$('task-fault-box').children[3].textContent, /按子任务说明修正项目、角色或集成配置/);
});
