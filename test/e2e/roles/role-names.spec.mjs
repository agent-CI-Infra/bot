import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { consoleSave } from '../helpers/console-save.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { openRoleAdvanced, openRoleFromList, openRoleFormAdvanced } from '../helpers/open-role-advanced.mjs';

const storedNames = ['Manager', 'Developer', 'Tester', 'Reviewer', 'UX reviewer', 'Independent QA'];

async function login(page, url, password) {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

async function checkOverview(page) {
  const board = page.getByTestId('project-role-board');
  await expect(board.locator('[data-role-row]')).toHaveCount(storedNames.length);
  for (const name of storedNames) await expect(board.getByText(name, { exact: true })).toBeVisible();
  await expect(board.locator('[data-role-row="coordinator"]')).toHaveCount(0);
  await expect(board.locator('[data-role-row="manager"]')).toContainText('空闲');
  await expect(page.locator('.workspace-role-status')).toContainText('共启用 6 个项目角色');
}

test('中文界面在总览、角色列表和表单保留名称原文，内置职责使用中文', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/projects/101/overview', password);
    await checkOverview(page);
    await page.getByRole('link', { name: '角色与并发配置 →' }).click();
    await openRoleAdvanced(page);
    const table = page.getByRole('table', { name: '角色解析结果', exact: true });
    for (const name of storedNames) await expect(table.getByRole('link', { name, exact: true })).toBeVisible();
    for (const name of ['Dev', '开发', '项目管理者', '跨任务协调', 'Task Coordinator', 'Project controller']) {
      await expect(table.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    const roleIds = ['manager', 'dev', 'test', 'reviewer', 'ux', 'qa'];
    for (const id of roleIds) {
      await expect(table.getByRole('link', { name: id, exact: true })).toHaveCount(0);
      await expect(table.getByText(id + ' 启用', { exact: true })).toHaveCount(0);
    }
    await expect(table).toContainText('负责项目事件分派、任务内多角色编排与跨任务排期及依赖协调。');
    await expect(table).toContainText('在入口已有的权限范围内实现或调查任务。');
    await expect(table).not.toContainText('Implements or investigates');

    await openRoleFromList(page, 'Developer');
    await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('Developer');
    await expect(page.getByLabel('职责', { exact: true })).toHaveValue('在入口已有的权限范围内实现或调查任务。');
    await expect(page.getByRole('heading', { name: '基本信息', exact: true })).toBeVisible();
    await expect(page.getByTestId('role-id')).toBeHidden();
    await expect(page.getByText('这份提示词会发给模型', { exact: false })).toBeVisible();
    await expect(page.getByText('推荐配置使用英文模板', { exact: false })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await openRoleFormAdvanced(page);
    await expect(page.getByTestId('role-id')).toHaveText('角色标识：dev');
    await expect(page.getByTestId('role-id')).toBeVisible();
    await page.getByTestId('role-list-link').click();
    await expect(page.getByRole('heading', { name: '角色概览', exact: true }).or(page.getByRole('heading', { name: 'Roles', exact: true }))).toBeVisible();
  } finally { await h.stop(); }
});

test('英文界面在总览、角色列表和表单保留相同名称，内置职责使用英文', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.addInitScript(() => { globalThis.__consoleLocale = 'en'; document.documentElement.lang = 'en'; });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/projects/101/overview', password);
    await checkOverview(page);
    await page.getByRole('link', { name: '角色与并发配置 →' }).click();
    await openRoleAdvanced(page);
    await expect(page.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
    const table = page.getByRole('table', { name: 'Role list', exact: true });
    for (const name of storedNames) await expect(table.getByRole('link', { name, exact: true })).toBeVisible();
    for (const name of ['Dev', '开发', '项目管理者', '独立 QA', '独立验收']) {
      await expect(table.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    const enText = await table.innerText();
    expect(enText).not.toContain('启用');
    const roleIds = ['manager', 'dev', 'test', 'reviewer', 'ux', 'qa'];
    for (const id of roleIds) {
      await expect(table.getByRole('link', { name: id, exact: true })).toHaveCount(0);
      await expect(table.getByText(id + ' Enabled', { exact: true })).toHaveCount(0);
      await expect(table.getByText(id + ' 启用', { exact: true })).toHaveCount(0);
    }
    await expect(table).toContainText('Manages project event dispatch, coordinates multi-role task execution, and handles cross-task scheduling and dependencies.');
    await expect(table).toContainText("Implements or investigates the task within the entry point's existing authority.");
    await openRoleFromList(page, 'Developer');
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Developer');
    await expect(page.getByLabel('Duty', { exact: true })).toHaveValue("Implements or investigates the task within the entry point's existing authority.");
    await expect(page.getByRole('heading', { name: 'Basics', exact: true })).toBeVisible();
    await openRoleFormAdvanced(page);
    await expect(page.getByTestId('role-id')).toHaveText('Role id：dev');
    await page.getByTestId('role-list-link').click();
    await expect(page.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
  } finally { await h.stop(); }
});


test('已保存的历史简称、中文和自定义角色名原样显示，关闭的角色从总览移除', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, roles: [
      { role_id: 'dev', name: 'Dev' }, { role_id: 'test', enabled: false }, { role_id: 'observer_one', name: '开发' },
    ] });
    expect(saved.status).toBe(200);
    await login(page, h.admin + '/#/projects/101/roles', password);
    const roleTable = page.getByRole('table', { name: '角色解析结果' });
    const renamed = '验收 $& Team';
    await roleTable.getByRole('link', { name: 'Independent QA', exact: true }).click();
    const input = page.getByLabel('显示名称', { exact: true });
    await input.fill(renamed);
    await consoleSave(page).click();
    await expect(page.locator('.flash')).toContainText('角色配置已保存');
    await page.reload();
    await expect(input).toHaveValue(renamed);
    await expect(page.getByTestId('role-enable-reason')).toContainText(renamed + '是必需角色');
    await page.getByTestId('role-list-link').click();
    for (const name of [renamed, 'Dev', '开发']) await expect(roleTable.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(page.getByText(/是必需角色，其余角色都可以删除/)).toContainText(renamed);
    await page.goto(h.admin + '/#/projects/101/overview');
    const board = page.getByTestId('project-role-board');
    await expect(page.locator('.workspace-role-status')).toContainText('共启用 6 个项目角色');
    for (const name of [renamed, 'Dev', '开发']) await expect(board.getByText(name, { exact: true })).toBeVisible();
    await expect(board.locator('[data-role-row="test"]')).toHaveCount(0);
  } finally { await h.stop(); }
});
