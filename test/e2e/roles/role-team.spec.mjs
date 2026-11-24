import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { goRolePage, openRoleFormAdvanced, openRoleAdvanced } from '../helpers/open-role-advanced.mjs';
import { consoleSave, compareWithServer, confirmDiscard } from '../helpers/console-save.mjs';


// #229 slice 1: the AI-team list carries the role facts and distinguishes saved configuration from the shared draft.
test('AI 团队列表如实区分推荐配置、各类未保存草稿与已生效版本', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Coding model', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() })).value.model;
    let config = (await admin('/api/repositories/101/roles')).value;
    const initialized = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: config.configuration.revision, enabled: config.configuration.enabled, roles: [],
      skills: [{ id: 'review-kit', source: { type: 'inline', files: [{ path: 'guide.md', content: 'Check the current state.' }] } }] });
    expect(initialized.status).toBe(200);
    config = (await admin('/api/repositories/101/roles')).value;
    const dev = config.configuration.roles.find(role => role.role_id === 'dev');
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const table = page.locator('.project-table[aria-label="角色解析结果"]'), status = page.locator('[data-role-version]');
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible();
    await expect(status).toHaveText(`已保存`);
    const dirty = () => expect(status).toHaveText(`有未保存的更改`);
    const discard = async () => {
      await page.getByTestId('console-save-discard').click();
      await page.getByRole('dialog').getByRole('button', { name: '放弃更改', exact: true }).click();
      await expect(status).toHaveText(`已保存`);
    };

    await goRolePage(page, { role: 'dev' });
    await page.getByLabel('dev 模型', { exact: true }).selectOption(model.id); await dirty(); await discard();
    await openRoleFormAdvanced(page);
    await page.getByLabel('dev 技能包', { exact: true }).selectOption('review-kit'); await dirty(); await discard();
    await openRoleFormAdvanced(page);
    await page.getByLabel('dev 项目任务与协作权限', { exact: true }).selectOption(dev.permissions.project_tasks === 'write' ? 'read' : 'write'); await dirty(); await discard();
    await goRolePage(page);
    const row = table.locator('tr[data-role=dev]');
    await expect(page.getByLabel('开启角色协调', { exact: true })).toHaveCount(0);
    await row.getByRole('checkbox').uncheck(); await dirty();

    await expect(table.getByRole('columnheader', { name: '职责', exact: true })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: '状态', exact: true })).toBeVisible();
    await expect(row).toContainText('在入口已有的权限范围内实现或调查任务。'); await expect(row).toContainText('未保存');
    await expect(table.locator('tr[data-role]')).toHaveCount(config.configuration.roles.length);
    await consoleSave(page).click();
    await expect(page.locator('.flash')).toHaveText('角色配置已保存，新任务使用新配置；收回权限会阻止后续调用');
    config = (await admin('/api/repositories/101/roles')).value;
    await expect(status).toHaveText(`已保存`);

    // A project without a configuration shows the defaults in force, with no intro or fold in front (#1068).
    await repository(admin, a.id, '102'); await page.goto(h.admin + '/#/projects/102/roles');
    await expect(page.locator('[data-role-version]').first()).toHaveText('正在使用默认配置，内置默认更新时自动跟随。');
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible();
    await expect(page.locator('tr[data-role=manager]')).toContainText('默认配置');
    await expect(page.getByRole('button', { name: '使用推荐配置', exact: true })).toHaveCount(0);
    await expect(page.locator('details.role-advanced')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// #285: main already covers four edit paths plus the save/discard flow. These close the remaining gaps: the detail-page
// controls that the overview cannot reach, the never-saved project, and the controls whose default catalog has a single
// option (`模型 API`, `运行环境`, `输出结果`) so no interaction can switch them.
async function prepared(page) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const model = (await admin('/api/models/provider', 'POST', { repository_id: '101', name: 'fixture', api_url: 'http://127.0.0.1:9/v1', api_key: 'sk-role-team', model_names: ['fixture-model'] })).value.models[0];
  const config = (await admin('/api/repositories/101/roles')).value;
  const dev = config.configuration.roles.find(role => role.role_id === 'dev');
  const { revision, kind, entry_harness_source, ...editable } = dev;
  // A configuration that renders all three controls: a model profile (structured output), an environment list, and a
  // metered resource budget; legacy monetary values are accepted but omitted on save.
  const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: config.revision, enabled: true,
    skills: [{ id: 'skills_1', source: { type: 'inline', files: [{ path: 'guide.md', content: 'fixture' }] } }],
    // Process, which offers two structured output modes to switch between (Pi, the default, offers one).
    roles: [{ ...editable, harness_ref: { id: 'process' }, model_profile_ref: { model_id: model.id, api: 'openai-chat-completions', tool_calls: true, structured_output: 'tool_call' },
      budget_policy_ref: { id: 'metered', max_tool_calls: 5, max_cost: { amount: 1, currency: 'USD' } } }] });
  expect(saved.status).toBe(200);
  expect(saved.value.configuration.roles.find(role=>role.role_id==='dev').budget_policy_ref.max_cost).toBeUndefined();
  await page.goto(h.admin + '/#/projects/101/roles');
  await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  return { h, revision: saved.value.configuration.revision, list: h.admin + '/#/projects/101/roles', detail: h.admin + '/#/projects/101/roles/dev' };
}
// Pick a different option, so the test does not depend on the catalog's order or on one particular default.
async function other(select) {
  const currentValue = await select.inputValue();
  const options = await select.locator('option').evaluateAll(entries => entries.map(entry => entry.value));
  const value = options.find(option => option !== currentValue);
  expect(value, 'the control needs a second option to switch to').toBeTruthy();
  await select.selectOption(value);
}
for (const [name, act] of [
  ['结构化输出方式', async page => {
    const envOptions = await page.getByLabel('运行环境', { exact: true }).locator('option').evaluateAll(entries => entries.map(entry => entry.value));
    expect(envOptions).toEqual(['task-workspace']);
    await other(page.getByLabel('结构化输出方式', { exact: true }));
  }],
  ['任务累计工具调用', async page => page.getByLabel('任务累计工具调用', { exact: true }).fill('9')],
]) test(`详情页的「${name}」改一下，回到列表就标记为草稿，放弃后回到已生效`, async ({ page }) => {
  test.setTimeout(90000);
  const { h, revision, list, detail } = await prepared(page);
  try {
    const status = page.locator('[data-role-version]');
    await expect(status).toHaveText(`已保存`);
    await page.goto(detail);
    await openRoleFormAdvanced(page);
    await act(page);
    await page.goto(list);
    await expect(status).toHaveText(`有未保存的更改`);
    await page.getByTestId('console-save-discard').click();
    await page.getByRole('dialog').getByRole('button', { name: '放弃更改', exact: true }).click();
    await expect(status).toHaveText(`已保存`);
  } finally { await h.stop(); }
});
test('跟随默认配置的项目显示「正在使用默认配置」，勾选后也不出现「配置版本 0」', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    h.store.run("DELETE FROM settings WHERE key='roles:101'");
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const status = page.locator('[data-role-version]').first();
    await expect(status).toHaveText('正在使用默认配置，内置默认更新时自动跟随。');
    await openRoleAdvanced(page);
    await page.locator('tr[data-role=dev]').getByRole('checkbox').uncheck();
    await expect(status).toHaveText('有未保存的更改');
    await expect(status).not.toContainText('配置版本 0');
  } finally { await h.stop(); }
});
