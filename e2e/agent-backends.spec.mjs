import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

test('所有角色可选择并列 Agent 后端，默认推荐 Pi，未接入驱动明确显示', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }), maxBodyBytes: 1024 * 1024 })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const model = await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Fixture', api_url: 'https://model.invalid/v1', api_key: testPassword() });
    await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.value.model.id });
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const roles = ['coordinator', 'manager', 'dev', 'test', 'reviewer', 'ux', 'qa'];
    for (const role of roles) {
      const picker = page.getByRole('combobox', { name: `${role} Agent 后端`, exact: true });
      await expect(picker).toHaveValue('pi');
      for (const backend of ['pi', 'native', 'process', 'acp']) await expect(picker.locator(`option[value="${backend}"]`)).toBeEnabled();
      for (const backend of ['codex', 'claude_code', 'opencode']) await expect(picker.locator(`option[value="${backend}"]`)).toBeDisabled();
    }
    await page.getByRole('combobox', { name: 'manager Agent 后端', exact: true }).selectOption('native');
    await page.getByRole('combobox', { name: 'reviewer Agent 后端', exact: true }).selectOption('acp');
    await page.getByRole('button', { name: '保存为新 revision', exact: true }).click();
    await expect(page.locator('#project-page .flash')).toContainText('revision 1');
    const saved = (await admin('/api/repositories/101/roles')).value;
    expect(saved.configuration.roles.find(r => r.role_id === 'manager').harness_ref.id).toBe('native');
    expect(saved.configuration.roles.find(r => r.role_id === 'reviewer').harness_ref.id).toBe('acp');
    expect(saved.configuration.roles.find(r => r.role_id === 'qa').harness_ref.id).toBe('pi');
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'manager Agent 后端', exact: true })).toHaveValue('native');
    await expect(page.getByRole('combobox', { name: 'reviewer Agent 后端', exact: true })).toHaveValue('acp');
    await expect(page.getByText('Agent 后端：', { exact: false })).toContainText('Codex（驱动待接入，#171）');
    mkdirSync('.tmp/agent-backends', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '.tmp/agent-backends/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('combobox', { name: 'qa Agent 后端', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/agent-backends/mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
