import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { goRolePage, openRoleFormAdvanced, openRoleAdvanced } from './open-role-advanced.mjs';
import { consoleSave, compareWithServer, confirmDiscard } from './console-save.mjs';


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
    await page.getByLabel('dev 使用虚拟电脑权限', { exact: true }).selectOption(dev.permissions.computer === 'allow' ? 'deny' : 'allow'); await dirty(); await discard();
    await goRolePage(page);
    const row = table.locator('tr[data-role=dev]');
    await page.getByLabel('开启角色协调', { exact: true }).setChecked(!config.configuration.enabled); await dirty();

    await expect(table.getByRole('columnheader', { name: '职责', exact: true })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: '状态', exact: true })).toBeVisible();
    await expect(row).toContainText(dev.responsibility); await expect(row).toContainText('已启用');
    await expect(table.locator('tr[data-role]')).toHaveCount(config.configuration.roles.length);
    await consoleSave(page).click();
    await expect(page.locator('.flash')).toHaveText('角色配置已保存，新任务使用新配置；收回权限会阻止后续调用');
    config = (await admin('/api/repositories/101/roles')).value;
    await expect(status).toHaveText(`已保存`);

    await repository(admin, a.id, '102'); await page.goto(h.admin + '/#/projects/102/roles');
    await expect(page.getByRole('heading', { name: '使用推荐的角色分工', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '使用推荐配置', exact: true })).toBeVisible();
    await expect(page.getByTestId('role-advanced')).toBeVisible();
    expect(await page.getByTestId('role-advanced').evaluate(el => el.open)).toBe(false);
    await expect(page.locator('[data-role-version]').first()).toHaveText('尚未保存。可先使用推荐配置。');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// #285: main already covers four edit paths plus the save/discard flow. These close the remaining gaps: the three
// detail-page selects that the overview cannot reach, the never-saved project, and the two controls whose default
// catalog has a single option (`模型 API`, `输出结果`) so no interaction can switch them.
async function prepared(page) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const model = (await admin('/api/models/provider', 'POST', { repository_id: '101', api_url: 'http://127.0.0.1:9/v1', api_key: 'sk-role-team', model_names: ['fixture-model'] })).value.models[0];
  const config = (await admin('/api/repositories/101/roles')).value;
  const dev = config.configuration.roles.find(role => role.role_id === 'dev');
  const { revision, kind, ...editable } = dev;
  // A configuration that renders all three controls: a model profile (structured output), an environment list, and a
  // metered budget with a cost (the currency select only exists when max_cost is set).
  const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: config.revision, enabled: true,
    skills: [{ id: 'skills_1', source: { type: 'inline', files: [{ path: 'guide.md', content: 'fixture' }] } }],
    roles: [{ ...editable, model_profile_ref: { model_id: model.id, api: 'openai-chat-completions', tool_calls: true, structured_output: 'tool_call' },
      budget_policy_ref: { id: 'metered', max_cost: { amount: 1, currency: 'USD' } } }] });
  expect(saved.status).toBe(200);
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
  ['结构化输出方式', async page => other(page.getByLabel('结构化输出方式', { exact: true }))],
  ['运行环境', async page => other(page.getByLabel('运行环境', { exact: true }))],
  ['预算币种', async page => page.getByLabel('预算币种', { exact: true }).selectOption('CNY')],
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
test('尚未配置过角色的项目保持「尚未保存。可先使用推荐配置。」，勾选后也不出现「配置版本 0」', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    h.store.run("DELETE FROM settings WHERE key='roles:101'");
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const status = page.locator('[data-role-version]').first();
    await expect(status).toHaveText('尚未保存。可先使用推荐配置。');
    await openRoleAdvanced(page);
    await page.getByLabel('开启角色协调', { exact: true }).setChecked(true);
    await expect(status).toHaveText('有未保存的更改');
    await expect(status).not.toContainText('配置版本 0');
  } finally { await h.stop(); }
});
// `模型 API` and `输出结果` have exactly one option in the default catalog, so no test can switch them. Pin the structure
// that keeps both honest instead: every one of those controls records its edit through markRoleDirty, and `state.dirty`
// is written in exactly one place — inside that function. Counting call sites would go red the moment someone adds a
// control, so this asserts the single write site and its location, not how many callers exist.
test('源码里 state.dirty 只在 markRoleDirty 内被赋值一次', async ({ request }) => {
  const h = await harness();
  try {
    const response = await request.get(h.admin + '/roles.js');
    expect(response.status()).toBe(200);
    const source = await response.text();
    // Any direct write — `state.dirty = true`, `state.dirty=false`, a compound assignment — counts; reads do not.
    const writes = [...source.matchAll(/\bstate\s*\.\s*dirty\s*(?:[+\-*/%]?=|\|\|=|&&=|\?\?=)/g)].map(match => match.index);
    expect(writes, 'state.dirty must be written in exactly one place').toHaveLength(1);
    const start = source.search(/function markRoleDirty\s*\(/);
    expect(start).toBeGreaterThan(-1);
    // Find the function body by brace matching, so the assertion does not depend on formatting or line numbers.
    let depth = 0, end = -1;
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}' && (depth -= 1) === 0) { end = i; break; }
    }
    expect(end, 'markRoleDirty must have a body').toBeGreaterThan(start);
    expect(writes[0] > start && writes[0] < end, 'the single state.dirty write must sit inside markRoleDirty').toBe(true);
  } finally { await h.stop(); }
});
