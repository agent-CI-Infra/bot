import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { openRoleFormAdvanced } from './open-role-advanced.mjs';

async function prepared(page) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Role fixture model', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() })).value.model;
    const initial = (await admin('/api/repositories/101/roles')).value;
    const result = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: initial.revision, enabled: false, roles: [{ role_id: 'dev', harness_ref: { id: 'native' }, model_profile_ref: { model_id: model.id, api: 'openai-chat-completions', tool_calls: true, structured_output: 'tool_call' } }] });
    expect(result.status).toBe(200);
    await page.goto(h.admin + '/#/projects/101/roles/dev');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('角色提示词', { exact: true })).toBeVisible();
    await openRoleFormAdvanced(page);
    return { h, admin };
  } catch (error) { await h.stop(); throw error; }
}

test('an agent backend the server marks unavailable is labelled and cannot be chosen', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const { h, admin } = await prepared(page);
  try {
    const payload = (await admin('/api/repositories/101/roles')).value;
    const unavailable = payload.backends.filter(backend => !backend.available);
    expect(unavailable.length, 'the fixture must expose at least one backend the server refuses to run').toBeGreaterThan(0);
    const picker = page.getByLabel('dev Agent 后端', { exact: true });
    await expect(picker).toBeVisible();
    for (const backend of unavailable) {
      const option = picker.locator(`option[value="${backend.id}"]`);
      await expect(option, `${backend.id} must be shown with its own label, not silently dropped`).toHaveCount(1);
      await expect(option).toHaveText(`${backend.name}（尚不可用）`);
      expect(await option.evaluate(element => element.disabled), `${backend.id} is not runnable, so it must not be selectable and saved as runnable`).toBe(true);
    }
    const selectable = payload.backends.filter(backend => backend.available && backend.kinds.includes('writer'));
    expect(selectable.length).toBeGreaterThan(0);
    await picker.selectOption(selectable[0].id);
    await expect(page.locator('[data-role-version]')).toHaveText(/草稿未保存$/);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('a rejected saved-model resolution renders its own sentence, not the raw code', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const rejection = { error: 'harness_role_unsupported', field: 'roles.manager.harness_ref.id', reason: '执行器不支持此角色类型。' };
  await page.route('**/api/repositories/101/roles/resolve', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: rejection.error, field: rejection.field }) }));
  const { h } = await prepared(page);
  try {
    const region = page.locator('.role-model-resolution');
    await expect(region).toBeVisible();
    await region.getByRole('button', { name: '读取已保存模型解析', exact: true }).click();
    const status = region.getByRole('status');
    await expect(status).toContainText(`解析失败，当前结果未知：${rejection.reason}`);
    await expect(status).not.toContainText(rejection.error);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
