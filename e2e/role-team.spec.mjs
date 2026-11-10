import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #229 slice 1: the AI-team list is the place where a project administrator reads what each role is and how it is
// configured. The design asks the list itself to carry responsibility, the resolved agent/model source, skills,
// budget/permission summary and the configuration version — the first three were missing from the summary table.
test('AI 团队列表显示职责、预算与配置版本，草稿与已生效版本可区分', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const config = (await admin('/api/repositories/101/roles')).value;
    const dev = config.configuration.roles.find(role => role.role_id === 'dev');
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const table = page.locator('.project-table[aria-label="角色解析结果"]');
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible();
    // Nothing about the roles has been saved yet, so there is no revision to name — "version 0 · in force" would be
    // a contradiction, because version 0 means there is no saved configuration at all.
    const status = page.locator('[data-role-version]');
    await expect(status).toHaveText('尚未保存角色配置');
    // An unsaved edit is visible as such, without pretending the saved revision changed.
    // A draft stays a draft: once edited, the line says so until the configuration is saved.
    await page.getByLabel('开启角色协调', { exact: true }).check();
    await expect(status).toHaveText('尚未保存角色配置 · 草稿未保存');
    // Responsibility and budget are real configuration values, not placeholders.
    await expect(table.getByRole('columnheader', { name: '职责', exact: true })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: '预算', exact: true })).toBeVisible();
    const row = table.locator('tr[data-role=dev]');
    await expect(row).toContainText(dev.responsibility);
    await expect(row).toContainText(dev.budget_policy_ref.id);
    // Every configured role is listed once, with its own row identity for the detail page.
    await expect(table.locator('tr[data-role]')).toHaveCount(config.configuration.roles.length);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// Review finding on the first tip: the version line only refreshed for controls that went through `roleBound`, so a
// plain `<select>` left the draft dirty while the line still said "已生效". Every edit now marks the draft through one
// function. Each bypass gets its own test, so a control that works can never vouch for one that does not.
async function prepared(page) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const model = (await admin('/api/models/provider', 'POST', { repository_id: '101', api_url: 'http://127.0.0.1:9/v1', api_key: 'sk-role-team', model_names: ['fixture-model'] })).value.models[0];
  const config = (await admin('/api/repositories/101/roles')).value;
  const dev = config.configuration.roles.find(role => role.role_id === 'dev');
  const { revision, kind, ...editable } = dev;
  // A configuration that renders every control: a model profile (model API + structured output), a skill bundle and a
  // metered budget with a cost (currency). None of it is what the test asserts; it only makes the controls exist.
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
const other = async select => {
  const currentValue = await select.inputValue();
  const options = await select.locator('option').evaluateAll(entries => entries.map(entry => entry.value));
  const value = options.find(option => option !== currentValue);
  expect(value, 'the control needs a second option to switch to').toBeTruthy();
  await select.selectOption(value);
};
const bypasses = [
  ['概览表模型下拉', async page => page.getByLabel('dev 模型', { exact: true }).selectOption({ index: 1 })],
  ['逐项权限', async page => { await page.locator('details.role-permission-details summary').first().click(); await other(page.locator('.role-permissions select').first()); }],
  ['技能包', async page => page.getByLabel('dev 技能包', { exact: true }).selectOption('skills_1')],
  // `模型 API` and `输出结果` have exactly one option in the default catalog, so no page can switch them; the structural
  // test below pins those two instead of pretending to exercise them.
  ['结构化输出方式', async page => other(page.getByLabel('结构化输出方式', { exact: true })), 'detail'],
  ['运行环境', async page => other(page.getByLabel('运行环境', { exact: true })), 'detail'],
  ['预算币种', async page => page.getByLabel('预算币种', { exact: true }).selectOption('CNY'), 'detail']
];
for (const [name, act, where] of bypasses) test(`不经过 roleBound 的控件单独改一下也让版本行说明是草稿：${name}`, async ({ page }) => {
  test.setTimeout(90000);
  const { h, revision, list, detail } = await prepared(page);
  try {
    const status = page.locator('[data-role-version]');
    // The line lives on the overview; a detail-only control is changed after reading it there.
    await page.goto(list);
    await expect(status).toHaveText(`配置版本 ${revision} · 已生效`);
    if (where === 'detail') await page.goto(detail);
    await act(page);
    if (where === 'detail') await page.goto(list);
    await expect(status).toHaveText(`配置版本 ${revision} · 草稿未保存`);
  } finally { await h.stop(); }
});
test('尚未保存过角色配置的项目显示「尚未保存角色配置」，不显示「配置版本 0」', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    h.store.run("DELETE FROM settings WHERE key='roles:101'");
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const status = page.locator('[data-role-version]');
    await expect(status).toHaveText('尚未保存角色配置');
    await page.getByLabel('开启角色协调', { exact: true }).check();
    await expect(status).toHaveText('尚未保存角色配置 · 草稿未保存');
  } finally { await h.stop(); }
});

// Two of the bypass controls (`模型 API`, `输出结果`) have exactly one option in a default catalog, so no test can switch
// them. Rather than leave them unverified, this pins the structure that makes them correct: the source contains exactly
// one `state.dirty = true`, inside `markDirty`, so no control can dirty the draft without refreshing the line.
test('源码里只有一处 state.dirty = true，即 markDirty 自身', async ({ request }) => {
  const h = await harness();
  try {
  const response = await request.get(h.admin + '/roles.js');
  expect(response.status()).toBe(200);
  const source = await response.text();
  expect(source).toContain('function markDirty(state) { state.dirty = true;');
  expect(source.match(/state\.dirty = true/g)).toHaveLength(1);
  // Every mutating control still reaches it, so the single assignment is on the path rather than dead code.
  expect(source.match(/markDirty\(state\)/g).length).toBeGreaterThanOrEqual(20);
  } finally { await h.stop(); }
});
