import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

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
    await expect(status).toHaveText(`配置版本 ${config.revision} · 已生效`);
    const dirty = () => expect(status).toHaveText(`配置版本 ${config.revision} · 草稿未保存`);
    const discard = async () => {
      await page.getByRole('button', { name: '放弃草稿并刷新', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '放弃并刷新', exact: true }).click();
      await expect(status).toHaveText(`配置版本 ${config.revision} · 已生效`);
    };

    await page.getByLabel('dev 模型', { exact: true }).selectOption(model.id); await dirty(); await discard();
    await page.getByLabel('dev 技能包', { exact: true }).selectOption('review-kit'); await dirty(); await discard();
    const row = table.locator('tr[data-role=dev]');
    await row.locator('details').locator('summary').click();
    await page.getByLabel('dev 工作区文件权限', { exact: true }).selectOption(dev.permissions.repository === 'read' ? 'write' : 'read'); await dirty(); await discard();
    await page.getByLabel('开启角色协调', { exact: true }).setChecked(!config.configuration.enabled); await dirty();

    await expect(table.getByRole('columnheader', { name: '职责', exact: true })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: '预算', exact: true })).toBeVisible();
    await expect(row).toContainText(dev.responsibility); await expect(row).toContainText(dev.budget_policy_ref.id);
    await expect(table.locator('tr[data-role]')).toHaveCount(config.configuration.roles.length);
    await page.getByRole('button', { name: '保存角色配置', exact: true }).click();
    await expect(page.locator('.flash')).toHaveText('角色配置已保存，新任务使用新配置');
    config = (await admin('/api/repositories/101/roles')).value;
    await expect(status).toHaveText(`配置版本 ${config.revision} · 已生效`);

    await repository(admin, a.id, '102'); await page.goto(h.admin + '/#/projects/102/roles');
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible();
    await expect(page.locator('[data-role-version]')).toHaveText('推荐配置 · 尚未保存');
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
    await expect(status).toHaveText(`配置版本 ${revision} · 已生效`);
    await page.goto(detail);
    await act(page);
    await page.goto(list);
    await expect(status).toHaveText(`配置版本 ${revision} · 草稿未保存`);
    await page.getByRole('button', { name: '放弃草稿并刷新', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '放弃并刷新', exact: true }).click();
    await expect(status).toHaveText(`配置版本 ${revision} · 已生效`);
  } finally { await h.stop(); }
});
test('尚未配置过角色的项目保持「推荐配置 · 尚未保存」，勾选后也不出现「配置版本 0」', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    h.store.run("DELETE FROM settings WHERE key='roles:101'");
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const status = page.locator('[data-role-version]');
    await expect(status).toHaveText('推荐配置 · 尚未保存');
    await page.getByLabel('开启角色协调', { exact: true }).setChecked(true);
    await expect(status).toHaveText('推荐配置 · 尚未保存');
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
