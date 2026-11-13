import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { goRolePage, openRoleFormAdvanced } from './open-role-advanced.mjs';
import { consoleSave, compareWithServer, confirmDiscard } from './console-save.mjs';
async function prepared(page) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Role fixture model', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() })).value.model;
    const initial = (await admin('/api/repositories/101/roles')).value;
    const result = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: initial.revision, enabled: false, roles: [{ role_id: 'dev', harness_ref: { id: 'native' }, model_profile_ref: { model_id: model.id, api: 'openai-chat-completions', tool_calls: true, structured_output: 'tool_call' } }] });
    expect(result.status).toBe(200);
    await page.goto(h.admin + '/#/projects/101/roles/dev');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('角色提示词', { exact: true })).toBeVisible();
    return { h, admin, revision: result.value.configuration.revision };
  } catch (error) { await h.stop(); throw error; }
}
const draftPrompt = page => page.getByLabel('角色提示词', { exact: true });

test('role sections keep one editable draft, version and save operation reachable at six widths', async ({ page }) => {
  const { h, admin, revision } = await prepared(page), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await draftPrompt(page).fill('Keep the reproduction and evidence.');
    await expect(page.locator('[data-role-version]')).toHaveText(`有未保存的更改`);
    await openRoleFormAdvanced(page);
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 950 });
      await page.getByLabel('预算方式', { exact: true }).scrollIntoViewIfNeeded();
      await page.getByLabel('预算方式', { exact: true }).selectOption('bounded');
      await page.getByLabel('单次运行最多模型轮数', { exact: true }).fill('12');
      await draftPrompt(page).scrollIntoViewIfNeeded();
      await expect(draftPrompt(page)).toHaveValue('Keep the reproduction and evidence.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const save = consoleSave(page); await expect(save).toBeInViewport();
      expect(await save.evaluate(el => { const box = el.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return el === hit || el.contains(hit); })).toBe(true);
    }
    mkdirSync('.tmp/role-editor-229', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.getByRole('heading', { name: 'Agent 与模型', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: '.tmp/role-editor-229/editor-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('heading', { name: '基本信息', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: '.tmp/role-editor-229/editor-mobile.png' });
    await consoleSave(page).click(); await expect(page.locator('.flash')).toBeVisible();
    const dev = (await admin('/api/repositories/101/roles')).value.configuration.roles.find(row => row.role_id === 'dev');
    expect(dev.persona_prompt).toBe('Keep the reproduction and evidence.'); expect(dev.budget_policy_ref.max_turns).toBe(12); expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
test('a role conflict merges independent changes and requires a deliberate choice for the overlapping prompt', async ({ page }) => {
  const { h, admin, revision } = await prepared(page);
  try {
    await draftPrompt(page).fill('My new prompt');
    const role = (await admin('/api/repositories/101/roles')).value.configuration.roles.find(row => row.role_id === 'dev');
    const draft = await page.evaluate(role => editableRole(role), role);
    const changed = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: revision, enabled: false, roles: [{ ...draft, name: 'Server name', persona_prompt: 'Server prompt', permissions: { ...draft.permissions, computer: 'deny' } }] });
    expect(changed.status, JSON.stringify(changed.value)).toBe(200);
    await consoleSave(page).click(); await expect(page.getByRole('alert').filter({ hasText: '角色配置已被别人修改' })).toBeInViewport();
    await expect(draftPrompt(page)).toHaveValue('My new prompt'); await expect(consoleSave(page)).toBeDisabled();
    await compareWithServer(page);
    await expect(page.getByRole('heading', { name: '比较角色配置', exact: true })).toBeInViewport();
    const apply = page.getByRole('button', { name: '将修改应用到最新版本草稿', exact: true }); await expect(apply).toBeDisabled();
    await page.getByLabel('处理 roles › dev › persona_prompt', { exact: true }).selectOption('draft'); await apply.click(); await expect(page.getByRole('alert').filter({ hasText: '角色配置已被别人修改' })).toHaveCount(0);
    await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('Server name'); await expect(draftPrompt(page)).toHaveValue('My new prompt');
    await openRoleFormAdvanced(page);
    await expect(page.getByLabel('dev 使用虚拟电脑权限', { exact: true })).toHaveValue('deny');
    await consoleSave(page).click(); await expect(page.locator('.flash')).toBeVisible();
    const saved = (await admin('/api/repositories/101/roles')).value.configuration;
    expect(saved.revision).toBe(revision + 2); expect(saved.roles.find(row => row.role_id === 'dev')).toMatchObject({ name: 'Server name', persona_prompt: 'My new prompt', permissions: { computer: 'deny' } });
  } finally { await h.stop(); }
});
test('role read errors expose a read-only retry and permission loss clears the retained draft', async ({ page }) => {
  const { h } = await prepared(page);
  try {
    await draftPrompt(page).fill('Sensitive unsaved draft');
    await page.route('**/api/repositories/101/roles', route => route.request().method() === 'GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }) : route.continue());
    await page.goto(h.admin + '/#/projects/101/roles'); await expect(page.getByText('角色配置读取失败，当前状态未知。保留的草稿尚未提交。', { exact: true })).toBeVisible(); await expect(consoleSave(page)).toHaveCount(0);
    await page.unroute('**/api/repositories/101/roles'); await page.getByRole('button', { name: '重试读取角色配置', exact: true }).click();
    await goRolePage(page, { role: 'Dev' }); await expect(draftPrompt(page)).toHaveValue('Sensitive unsaved draft');
    await page.route('**/api/repositories/101/roles', route => route.request().method() === 'GET' ? route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"repository_forbidden"}' }) : route.continue());
    await compareWithServer(page);
    await expect(page.getByText('当前身份无权读取或修改角色配置，已清空本页草稿。', { exact: true })).toBeVisible(); await expect(draftPrompt(page)).toHaveCount(0);
    await page.unroute('**/api/repositories/101/roles'); await page.goto(h.admin + '/#/projects/101/roles'); await goRolePage(page, { role: 'Dev' }); await expect(draftPrompt(page)).not.toHaveValue('Sensitive unsaved draft');
  } finally { await h.stop(); }
});
test('a late role comparison cannot replace a different project editor', async ({ page }) => {
  const { h } = await prepared(page); let release;
  try {
    await draftPrompt(page).fill('Project 101 only');
    const gate = new Promise(resolve => { release = resolve; }); let entered; const seen = new Promise(resolve => { entered = resolve; });
    await page.route('**/api/repositories/101/roles', async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); });
    await compareWithServer(page); await seen;
    await page.goto(h.admin + '/#/projects/102/roles/dev'); await expect(draftPrompt(page)).toBeVisible(); release();
    await expect(page).toHaveURL(/projects\/102\/roles\/dev$/); await expect(draftPrompt(page)).not.toHaveValue('Project 101 only'); await expect(page.getByRole('heading', { name: '比较角色配置', exact: true })).toHaveCount(0);
  } finally { release?.(); await h.stop(); }
});

test('finishing a comparison after switching roles releases the shared draft lock without replacing that role', async ({ page }) => {
  const { h } = await prepared(page); let release;
  try {
    await draftPrompt(page).fill('Retained while navigating'); let entered; const seen = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; }); let held = false;
    await page.route('**/api/repositories/101/roles', async route => { if (held) return route.continue(); held = true; const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); });
    await compareWithServer(page); await seen;
    await goRolePage(page, { role: 'Test' }); await expect(page.getByRole('heading', { name: 'Test 设置', exact: true })).toBeVisible(); await expect(draftPrompt(page)).toBeDisabled();
    release(); await expect(draftPrompt(page)).toBeEnabled(); await expect(page.getByRole('heading', { name: '比较角色配置', exact: true })).toHaveCount(0);
    await goRolePage(page, { role: 'Dev' }); await expect(draftPrompt(page)).toHaveValue('Retained while navigating');
  } finally { release?.(); await h.stop(); }
});
test('choosing the latest edited role after a delete conflict also removes its pending deletion marker', async ({ page }) => {
  const { h, admin, revision } = await prepared(page);
  try {
    await goRolePage(page, { role: 'Test' }); await openRoleFormAdvanced(page); await page.getByRole('button', { name: '删除这个角色', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '删除角色', exact: true }).click();
    const role = (await admin('/api/repositories/101/roles')).value.configuration.roles.find(row => row.role_id === 'test');
    const draft = await page.evaluate(role => editableRole(role), role);
    const changed = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: revision, enabled: false, roles: [{ ...draft, name: 'Server Test' }] });
    expect(changed.status, JSON.stringify(changed.value)).toBe(200);
    await consoleSave(page).click(); await expect(page.getByRole('alert').filter({ hasText: '角色配置已被别人修改' })).toBeInViewport();
    await compareWithServer(page); await page.getByLabel('处理 roles › test', { exact: true }).selectOption('latest'); await page.getByRole('button', { name: '将修改应用到最新版本草稿', exact: true }).click();
    await goRolePage(page, { role: 'test' }); await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('Server Test'); await consoleSave(page).click(); await expect(page.locator('.flash')).toBeVisible();
    expect((await admin('/api/repositories/101/roles')).value.configuration.roles.find(row => row.role_id === 'test').name).toBe('Server Test');
  } finally { await h.stop(); }
});

test('a forbidden project read clears its role draft before the role endpoint is reached', async ({ page }) => {
  const { h } = await prepared(page);
  try {
    await draftPrompt(page).fill('Discard on project revocation');
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"repository_forbidden"}' }));
    await page.goto(h.admin + '/#/projects/101/roles'); await expect(page.locator('#project-page')).toContainText('repository_forbidden'); await expect(draftPrompt(page)).toHaveCount(0);
    await page.unroute('**/api/repositories/101'); await page.goto(h.admin + '/#/projects/101/roles/dev'); await expect(draftPrompt(page)).toBeVisible(); await expect(draftPrompt(page)).not.toHaveValue('Discard on project revocation');
  } finally { await h.stop(); }
});
