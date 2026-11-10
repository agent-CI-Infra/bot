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
    // The version line names the saved revision and says the draft currently matches it.
    const status = page.locator('[data-role-version]');
    await expect(status).toHaveText(`配置版本 ${config.revision} · 已生效`);
    // An unsaved edit is visible as such, without pretending the saved revision changed.
    // A draft stays a draft: once edited, the line says so until the configuration is saved.
    await page.getByLabel('开启角色协调', { exact: true }).check();
    await expect(status).toHaveText(`配置版本 ${config.revision} · 草稿未保存`);
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
