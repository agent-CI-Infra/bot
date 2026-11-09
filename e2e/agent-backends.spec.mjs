import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

test('角色按能力选择 Agent 后端，Claude Code 仅用于工作角色，未接入驱动明确显示', async ({ page }) => {
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
      const claude = picker.locator('option[value="claude_code"]');
      if (['coordinator', 'manager'].includes(role)) await expect(claude).toBeDisabled();
      else await expect(claude).toBeEnabled();
      for (const backend of ['codex', 'opencode']) await expect(picker.locator(`option[value="${backend}"]`)).toBeDisabled();
    }
    await page.getByRole('combobox', { name: 'manager Agent 后端', exact: true }).selectOption('native');
    await page.getByRole('combobox', { name: 'reviewer Agent 后端', exact: true }).selectOption('acp');
    await page.getByRole('combobox', { name: 'dev Agent 后端', exact: true }).selectOption('claude_code');
    await page.getByRole('button', { name: '保存为新 revision', exact: true }).click();
    await expect(page.locator('#project-page .flash')).toContainText('revision 1');
    const saved = (await admin('/api/repositories/101/roles')).value;
    expect(saved.configuration.roles.find(r => r.role_id === 'manager').harness_ref.id).toBe('native');
    expect(saved.configuration.roles.find(r => r.role_id === 'reviewer').harness_ref.id).toBe('acp');
    expect(saved.configuration.roles.find(r => r.role_id === 'dev').harness_ref.id).toBe('claude_code');
    expect(saved.configuration.roles.find(r => r.role_id === 'qa').harness_ref.id).toBe('pi');
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'manager Agent 后端', exact: true })).toHaveValue('native');
    await expect(page.getByRole('combobox', { name: 'reviewer Agent 后端', exact: true })).toHaveValue('acp');
    await expect(page.getByRole('combobox', { name: 'dev Agent 后端', exact: true })).toHaveValue('claude_code');
    const catalog = page.getByText('Agent 后端：', { exact: false });
    await expect(catalog).toContainText('Claude Code（claude_code@2.1.319）');
    await expect(catalog).not.toContainText('Claude Code（驱动待接入');
    await expect(catalog).toContainText('Codex（驱动待接入，#171）');
    await expect(catalog).toContainText('OpenCode（驱动待接入，#172）');
    mkdirSync('.tmp/agent-backends', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '.tmp/agent-backends/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('combobox', { name: 'qa Agent 后端', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/agent-backends/mobile.png', fullPage: true });
    // Load an unmarked old V2 definition: the UI always resubmits its saved harness id.
    const old = JSON.parse(h.store.get("SELECT value FROM settings WHERE key='roles:101'").value);
    const dev = old.roles.find(r => r.role_id === 'dev');
    delete dev.entry_harness_source; dev.harness_ref = { id: 'native', version: '1' };
    h.store.run("UPDATE settings SET value=? WHERE key='roles:101'", JSON.stringify(old));
    await page.reload();
    const warning = page.getByText('检视与 Actions 的开发执行器仍为 Pi，直到该角色的后端选择发生变更', { exact: true });
    await expect(warning).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'dev Agent 后端', exact: true })).toHaveValue('native');
    await page.getByRole('button', { name: '保存为新 revision', exact: true }).click();
    await expect(page.locator('#project-page .flash')).toContainText('revision 2');
    await expect(warning).toBeVisible();
    expect((await admin('/api/repositories/101/roles')).value.configuration.roles.find(r => r.role_id === 'dev').entry_harness_source).toBeUndefined();
    await page.getByRole('combobox', { name: 'dev Agent 后端', exact: true }).selectOption('process');
    await page.getByRole('button', { name: '保存为新 revision', exact: true }).click();
    await expect(page.locator('#project-page .flash')).toContainText('revision 3');
    await expect(warning).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'dev Agent 后端', exact: true })).toHaveValue('process');
    await expect(warning).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
