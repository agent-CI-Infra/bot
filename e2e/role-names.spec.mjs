import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { openRoleAdvanced, openRoleFromList, openRoleFormAdvanced } from './open-role-advanced.mjs';

const out = '.tmp/role-names-568';
const chineseNames = ['项目管理者', '开发', '测试', '检视', '体验检视', '独立验收', '跨任务协调'];
const englishNames = ['Project controller', 'Developer', 'Tester', 'Reviewer', 'UX reviewer', 'Independent QA', 'Task coordinator'];

async function login(page, url, password) {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}


test('中文界面的角色列表和详情使用完整中文名称与职责，标识只在高级里', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/projects/101/roles', password);
    await page.getByTestId('adopt-recommended-roles').click();
    await expect(page.locator('.flash')).toContainText('已使用推荐配置');
    await openRoleAdvanced(page);
    const table = page.getByRole('table', { name: '角色解析结果', exact: true });
    for (const name of chineseNames) await expect(table.getByRole('link', { name, exact: true })).toBeVisible();
    for (const name of ['Dev', 'Developer', 'Manager', 'Independent QA', 'UX reviewer']) {
      await expect(table.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    await expect(table).toContainText('在入口已有的权限范围内实现或调查任务。');
    await expect(table).not.toContainText('Implements or investigates');
    await page.screenshot({ path: `${out}/list-zh-1440.png`, fullPage: true });

    await openRoleFromList(page, '开发');
    await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('开发');
    await expect(page.getByLabel('职责', { exact: true })).toHaveValue('在入口已有的权限范围内实现或调查任务。');
    await expect(page.getByRole('heading', { name: '基本信息', exact: true })).toBeVisible();
    await expect(page.getByTestId('role-id')).toBeHidden();
    await expect(page.getByText('这份提示词会发给模型', { exact: false })).toBeVisible();
    await expect(page.getByText('推荐配置使用英文模板', { exact: false })).toBeVisible();
    await page.screenshot({ path: `${out}/form-zh-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${out}/form-zh-390.png`, fullPage: true });
    await openRoleFormAdvanced(page);
    await expect(page.getByTestId('role-id')).toHaveText('角色标识：dev');
    await expect(page.getByTestId('role-id')).toBeVisible();
    await page.getByTestId('role-list-link').click();
    await expect(page.getByRole('heading', { name: '角色概览', exact: true }).or(page.getByRole('heading', { name: 'Roles', exact: true }))).toBeVisible();
    await page.screenshot({ path: `${out}/list-zh-390.png`, fullPage: true });
  } finally { await h.stop(); }
});

test('英文界面同一位置使用完整英文，不再中英夹杂', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.addInitScript(() => { globalThis.__consoleLocale = 'en'; document.documentElement.lang = 'en'; });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/projects/101/roles', password);
    await page.getByTestId('adopt-recommended-roles').click();
    await expect(page.locator('.flash')).toBeVisible();
    await openRoleAdvanced(page);
    await expect(page.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
    const table = page.getByRole('table', { name: 'Role list', exact: true });
    for (const name of englishNames) await expect(table.getByRole('link', { name, exact: true })).toBeVisible();
    for (const name of ['Dev', '开发', '项目管理者', '独立 QA', '独立验收']) {
      await expect(table.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    await expect(table).toContainText("Implements or investigates the task within the entry point's existing authority.");
    await openRoleFromList(page, 'Developer');
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Developer');
    await expect(page.getByLabel('Duty', { exact: true })).toHaveValue("Implements or investigates the task within the entry point's existing authority.");
    await expect(page.getByRole('heading', { name: 'Basics', exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/form-en-1440.png`, fullPage: true });
    await openRoleFormAdvanced(page);
    await expect(page.getByTestId('role-id')).toHaveText('Role id：dev');
    await page.getByTestId('role-list-link').click();
    await expect(page.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/list-en-1440.png`, fullPage: true });
  } finally { await h.stop(); }
});
