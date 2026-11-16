// Applying a confirmed onboarding plan (#932): the administrator confirms the plan's differences from the project, leaving
// out what they do not want; each item goes through the channel a person would use, as that person, with a receipt. GitHub
// and the model provider are local fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from './identity-fixture.mjs';
import { installed, repositoryRoutes, provider, call, person, say, assistantModel } from './onboarding-fixture.mjs';
import { managerPrompt } from '../dist/work/settings.js';
import { roleConfiguration } from '../dist/roles/definition.js';
import { projectCeiling } from '../dist/work/ceiling.js';

const plan = {
  profile: { summary: '命令行工具，Node.js。', sources: ['README.md', '/labels'] },
  capability_ceiling: { value: 'develop', reason: '有检视和 CI，可以开发简单问题' },
  events: { value: { 'actions.run_failed': true, 'issue.labels': ['kind/bug'] }, reason: '分析 Actions 失败；kind/bug 交给 Manager' },
  test_command: { value: 'npm test', reason: 'README 写明' },
  review_language: { value: 'zh', reason: '讨论都用中文' },
  labels: { items: [{ name: 'kind/bug', color: 'd73a4a', description: '缺陷', action: 'create' }, { name: 'docs', color: '0075ca', description: '文档', action: 'create' },
    { name: 'bug', color: 'd73a4a', action: 'keep' }], reason: '补齐分类标签' },
  conventions: { label_usage: 'kind/ 前缀表示问题类型，每个 Issue 只打一个。', simple_issues: '只改一个文件的拼写和文档问题算简单问题。' },
  schedules: [{ name: '每日巡检', cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai', instruction: '看看昨天失败的 Actions。' }],
  ci: { summary: '给 PR 加上 npm test 的检查。', files: ['.github/workflows/ci.yml'] },
  feishu: { level: 'comment', reason: '群里只需要问答和评论' },
};
// Any request gets the plan above.
const planner = t => provider(t, () => [call(0, ['propose_onboarding_plan', plan]), { role: 'assistant', content: '方案草稿已保存。' }]);
const receipts = view => Object.fromEntries(view.application.receipts.map(r => [r.item, r.state]));
const items = view => view.plan.changes.map(change => change.item);

test('confirming a started project\'s plan applies each item through its channel, with receipts; nothing twice, and a re-run lists only differences (#932)', async t => {
  const f = await identityFixture(t, { github: true }), { h, admin, state } = f, model = await planner(t);
  state.accessible = ['101']; const github = repositoryRoutes(f, [{ name: 'bug', color: 'd73a4a' }, { name: 'docs', color: 'ffffff', description: '原有的文档标签' }]);
  await assistantModel(admin, model);
  const repoAdmin = await person(f, 42, 'admin');
  const opened = (await repoAdmin('/api/management/onboarding/101', 'POST', {})).value;
  await say(repoAdmin, opened.session.conversation_id, '请出方案');

  // The confirmation lists what would change and where; nothing has changed yet.
  let view = (await repoAdmin('/api/management/onboarding/101')).value;
  assert.equal(view.plan.confirmed, false);
  assert.deepEqual(items(view), ['capability_ceiling', 'events', 'test_command', 'review_language', 'conventions', 'labels', 'schedules', 'ci']);
  assert.equal(view.plan.changes.find(change => change.item === 'schedules').service_principal, 'delegated');
  const ceiling = view.plan.changes.find(change => change.item === 'capability_ceiling');
  assert.deepEqual([ceiling.current, ceiling.proposed, ceiling.where], [projectCeiling(h.store, '101'), 'develop', '项目设置 · 能力上限']);
  const confirm = body => repoAdmin('/api/management/onboarding/101/confirm', 'POST', { version: view.plan.version, changes_revision: view.plan.changes_revision, ...body });

  // An outdated page, an item that is not a change, or none at all are refused before anything happens.
  assert.equal((await confirm({ changes_revision: 'outdated', items: ['test_command'] })).value.error, 'onboarding_changes_outdated');
  assert.equal((await confirm({ items: ['start'] })).value.error, 'invalid_onboarding_items');
  assert.equal((await confirm({ items: [] })).value.error, 'invalid_onboarding_items');
  assert.equal((await confirm({ version: 9, items: ['test_command'] })).value.error, 'onboarding_plan_outdated');
  const writer = await person(f, 43, 'write');
  assert.equal((await writer('/api/management/onboarding/101/confirm', 'POST', { version: 1, changes_revision: view.plan.changes_revision, items: ['test_command'] })).value.error, 'repository_admin_required');

  // Confirmed without the review language: everything else is applied in order, each with a receipt.
  const confirmed = await confirm({ items: items(view).filter(item => item !== 'review_language') });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.value));
  view = confirmed.value;
  assert.deepEqual(receipts(view), { capability_ceiling: 'succeeded', events: 'succeeded', test_command: 'succeeded', review_language: 'skipped', conventions: 'succeeded',
    labels: 'succeeded', schedules: 'failed', ci: 'succeeded' }, JSON.stringify(view.application.receipts, null, 1));
  const receipt = item => view.application.receipts.find(r => r.item === item);
  assert.ok(view.application.receipts.filter(r => r.state !== 'skipped').every(r => r.executed_by === receipt('ci').executed_by && r.attempts === 1));

  // The settings, as a person would have set them.
  const policy = h.store.get("SELECT * FROM policies WHERE repository_id='101'");
  assert.deepEqual([projectCeiling(h.store, '101'), policy.test_command, policy.review_language ?? 'auto', !!policy.actions_failures_enabled], ['develop', 'npm test', 'auto', true]);
  assert.equal(receipt('test_command').detail.verified, false);
  const commands = h.store.all("SELECT operation,state,principal_id FROM management_commands WHERE idempotency_key LIKE 'onboarding:%' ORDER BY rowid");
  assert.deepEqual(commands.map(c => [c.operation, c.state]), [['project.update', 'succeeded'], ['manager.update', 'succeeded'], ['project.update', 'succeeded'],
    ['manager.update', 'succeeded'], ['roles.update', 'succeeded'], ['task.create', 'succeeded']]);
  // The conventions: their own section, appended to the Manager prompt and every role that works on the repository.
  assert.match(managerPrompt(h.store, '101').content, /## 本仓库约定（接入向导第 1 版，\d{4}-\d{2}-\d{2}）[\s\S]*kind\/ 前缀表示问题类型/);
  const roles = roleConfiguration(h.store, '101').roles.filter(role => role.enabled && role.role_id !== 'coordinator');
  assert.ok(roles.length > 1 && roles.every(role => role.persona_prompt.includes('## 本仓库约定（接入向导第 1 版') && role.persona_prompt.includes('只改一个文件')));
  assert.deepEqual(receipt('conventions').detail, { manager: 'appended', roles: roles.map(role => role.role_id) });
  // Labels: the new one is created; one that exists keeps its colour and description.
  assert.deepEqual(github.created.map(c => [c.path, c.body]), [['/repos/fixture/project-101/labels', { name: 'kind/bug', color: 'd73a4a', description: '缺陷' }]]);
  assert.deepEqual(receipt('labels').detail.labels, [{ name: 'kind/bug', state: 'created' }, { name: 'docs', state: 'exists' }]);
  // The Manager checks need a destination: the item says so, with the choices, and the others went on.
  assert.deepEqual([receipt('schedules').error, receipt('schedules').detail.field, Array.isArray(receipt('schedules').detail.detail.destinations)], ['schedule_destination_required', 'schedule_destination_id', true]);
  // The CI suggestion is a development task the person confirmed may change workflows (#931).
  const task = h.store.get('SELECT * FROM tasks WHERE id=?', receipt('ci').detail.task_id), input = JSON.parse(task.input);
  assert.deepEqual([task.kind, input.contract.scope, !!input.workflow_changes?.confirmed_by], ['task.development', plan.ci.files, true]);
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='onboarding.confirmed' AND repository_id='101'"));
  assert.equal(h.store.get("SELECT count(*) AS n FROM audit WHERE action LIKE 'onboarding.item.%' AND repository_id='101'").n, 7);

  // Confirming again, or retrying what succeeded, applies nothing twice.
  assert.equal((await confirm({ items: ['test_command'] })).status, 201);
  assert.equal((await repoAdmin('/api/management/onboarding/101/items/labels/retry', 'POST', {})).value.error, 'onboarding_item_not_failed');
  assert.equal(h.store.get("SELECT count(*) AS n FROM management_commands WHERE idempotency_key LIKE 'onboarding:%'").n, commands.length);
  assert.equal(github.created.length, 1);
  // A failed item is retried on its own, still failing without a destination.
  view = (await repoAdmin('/api/management/onboarding/101/items/schedules/retry', 'POST', {})).value;
  assert.deepEqual([receipt('schedules').state, view.application.receipts.find(r => r.item === 'schedules').attempts], ['failed', 2]);

  // A re-run with the same plan lists only what still differs: the review language left out and the Manager check.
  await say(repoAdmin, opened.session.conversation_id, '再看一遍');
  view = (await repoAdmin('/api/management/onboarding/101')).value;
  assert.deepEqual([view.plan.version, items(view)], [2, ['review_language', 'schedules']]);
});

test('a repository that is not started starts first: approval needed, a trusted organization starts it, a super administrator with the plan\'s level (#932)', async t => {
  const f = await identityFixture(t, { github: true }), { h, admin, state } = f, model = await planner(t);
  installed(f, '103'); installed(f, '104'); state.accessible = ['101', '103', '104']; repositoryRoutes(f);
  await assistantModel(admin, model);
  const repoAdmin = await person(f, 42, 'admin');
  const prepare = async (who, id) => {
    const opened = (await who(`/api/management/onboarding/${id}`, 'POST', {})).value;
    await say(who, opened.session.conversation_id, '请出方案');
    return (await who(`/api/management/onboarding/${id}`)).value;
  };

  // The start comes first and cannot be left out.
  let view = await prepare(repoAdmin, '103');
  assert.deepEqual(items(view), ['start', 'capability_ceiling', 'events', 'test_command', 'review_language', 'conventions', 'labels', 'schedules', 'ci']);
  const listed = items(view), all = listed.filter(item => item !== 'schedules');
  assert.equal((await repoAdmin('/api/management/onboarding/103/confirm', 'POST', { version: view.plan.version, changes_revision: view.plan.changes_revision, items: ['test_command'] })).value.error, 'onboarding_start_required');

  // Neither super administrator nor trusted organization: the start waits for approval (#933), the rest for the start.
  view = (await repoAdmin('/api/management/onboarding/103/confirm', 'POST', { version: view.plan.version, changes_revision: view.plan.changes_revision, items: all })).value;
  assert.deepEqual(view.application.receipts.map(r => [r.item, r.state, r.error]), listed.map(item =>
    item === 'start' ? [item, 'failed', 'start_approval_required'] : item === 'schedules' ? [item, 'skipped', null] : [item, 'pending', 'project_not_started']));
  assert.equal(h.store.get("SELECT 1 FROM repositories WHERE id='103'"), undefined);

  // Once the organization is trusted, retrying the start starts it with the organization's level and applies the rest.
  assert.equal((await admin('/api/trusted-organizations/10', 'PUT', { capability_ceiling: 'comment' })).status, 200);
  view = (await repoAdmin('/api/management/onboarding/103/items/start/retry', 'POST', {})).value;
  assert.deepEqual(receipts(view), { start: 'succeeded', capability_ceiling: 'succeeded', events: 'succeeded', test_command: 'succeeded', review_language: 'succeeded',
    conventions: 'succeeded', labels: 'succeeded', schedules: 'skipped', ci: 'succeeded' }, JSON.stringify(view.application.receipts, null, 1));
  assert.deepEqual(view.application.receipts[0].detail.by, 'trusted_organization');
  assert.deepEqual([view.application.receipts[0].detail.capability_ceiling, projectCeiling(h.store, '103')], ['comment', 'develop']);
  assert.equal(view.repository.started, true);

  // A super administrator starts with the plan's level: the level item is then as planned already.
  assert.equal((await admin('/api/trusted-organizations/10', 'DELETE', {})).status, 200);
  view = await prepare(admin, '104');
  view = (await admin('/api/management/onboarding/104/confirm', 'POST', { version: view.plan.version, changes_revision: view.plan.changes_revision, items: ['start', 'capability_ceiling', 'test_command'] })).value;
  assert.deepEqual(view.application.receipts.filter(r => r.state !== 'skipped').map(r => [r.item, r.state]), [['start', 'succeeded'], ['capability_ceiling', 'exists'], ['test_command', 'succeeded']]);
  assert.deepEqual([view.application.receipts[0].detail.by, projectCeiling(h.store, '104')], ['super_admin', 'develop']);
});
