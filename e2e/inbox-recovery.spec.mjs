import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

async function prepared(page, width = 390) {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    for (let i = 0; i < 51; i++) h.store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,phase,error_code,updated_at)
      VALUES(?,'101','review.issue','waiting_configuration',?,'model','model_not_configured',?)`,
      'inbox-' + i, 'Configure task ' + i, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`);
    await page.setViewportSize({ width, height: 844 }); await page.goto(h.admin + '/#/inbox/all/50');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(item(page)).toBeVisible(); return { h, admin };
  } catch (error) { await h.stop(); throw error; }
}
const item = page => page.locator('.console-inbox [data-task-id="inbox-50"]');
const open = page => item(page).getByRole('button', { name: '查看任务', exact: true });
const detail = page => page.locator('#task-view');

for (const width of [390, 1440]) test(`configuration recovery returns to the same inbox page and waits for a real retry receipt (${width}px)`, async ({ page }) => {
  const { h, admin } = await prepared(page, width), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Recovery model', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() })).value.model;
    const before = h.store.all('SELECT * FROM audit');
    await expect(item(page)).toContainText('检查项目的模型地址、模型名和 API Key');
    await open(page).click(); await detail(page).getByRole('button', { name: '打开项目模型配置', exact: true }).click();
    await expect(detail(page)).toBeHidden(); await expect(page).toHaveURL(/#\/projects\/101\/model$/);
    expect(h.store.all('SELECT * FROM audit')).toEqual(before);
    await page.getByRole('combobox', { name: '默认模型', exact: true }).selectOption(model.id);
    await page.getByRole('button', { name: '保存默认模型', exact: true }).click();
    await expect(page.getByText('已保存项目默认模型', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '返回待处理列表', exact: false }).click();
    await expect(page).toHaveURL(/#\/inbox\/all\/50$/); await expect(open(page)).toBeFocused();
    // Saving configuration does not prove this task resumed; it stays until its task record actually changes.
    await expect(item(page)).toBeVisible(); expect(h.store.get("SELECT status FROM tasks WHERE id='inbox-50'").status).toBe('waiting_configuration');
    mkdirSync('.tmp/inbox-recovery-226/previews', { recursive: true });
    await open(page).click(); await page.screenshot({ path: `.tmp/inbox-recovery-226/previews/inbox-recovery-${width}.png` });
    await detail(page).getByRole('button', { name: '重试', exact: true }).click();
    await expect(detail(page).locator('#task-badges')).toContainText('待执行');
    await detail(page).getByRole('button', { name: '关闭', exact: true }).click();
    await expect(item(page)).toHaveCount(0); await expect(page.getByRole('button', { name: '刷新待处理', exact: true })).toBeFocused();
    await expect(page).toHaveURL(/#\/inbox\/all\/50$/);
    expect(h.store.all("SELECT * FROM audit WHERE action='task.retry'")).toHaveLength(1);
    expect(h.store.get("SELECT status FROM tasks WHERE id='inbox-50'").status).toBe('queued');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('a rejected retry keeps the item and return focus, and recorded failures choose only their applicable configuration page', async ({ page }) => {
  const { h } = await prepared(page);
  try {
    await open(page).click();
    await page.route('**/api/tasks/inbox-50/retry', route => route.fulfill({ status: 409, json: { error: 'task_already_running' } }));
    await detail(page).getByRole('button', { name: '重试', exact: true }).click();
    await expect(detail(page).locator('#task-error')).toContainText('不用再次重试');
    await page.keyboard.press('Escape'); await expect(open(page)).toBeFocused(); await expect(item(page)).toBeVisible();
    for (const [code, caption, section] of [['role_disabled', '打开角色配置', 'roles'], ['environment_not_ready', '检查项目电脑', 'machine']]) {
      h.store.run("UPDATE tasks SET error_code=? WHERE id='inbox-50'", code);
      await open(page).click(); await detail(page).getByRole('button', { name: caption, exact: true }).click();
      await expect(page).toHaveURL(new RegExp('#/projects/101/' + section + '$'));
      await page.getByRole('link', { name: '返回待处理列表', exact: false }).click(); await expect(open(page)).toBeFocused();
    }
    h.store.run("UPDATE tasks SET error_code='model_unavailable' WHERE id='inbox-50'");
    await open(page).click(); await expect(detail(page).getByRole('button', { name: /打开项目模型配置|打开角色配置|检查项目电脑/ })).toHaveCount(0);
    expect(h.store.all("SELECT * FROM audit WHERE action='task.retry'")).toHaveLength(0);
  } finally { await h.stop(); }
});

test('a late inbox refresh after closing cannot replace a new page or steal its focus', async ({ page }) => {
  const { h } = await prepared(page); let release;
  try {
    await open(page).click();
    let entered; const seen = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/tasks?attention=*', async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); });
    await page.keyboard.press('Escape'); await seen;
    await page.locator('#console-mobile-nav').getByRole('link', { name: '更多', exact: true }).click();
    const heading = page.getByRole('heading', { name: '更多功能', exact: true }); await expect(heading).toBeVisible();
    const focus = page.getByRole('link', { name: '身份与权限', exact: false }); await focus.focus();
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(heading).toBeVisible(); await expect(focus).toBeFocused(); await expect(item(page)).toHaveCount(0);
  } finally { release?.(); await h.stop(); }
});

test('access revoked during an open task clears the returned inbox instead of retaining private rows', async ({ page }) => {
  const { h, admin } = await prepared(page);
  try {
    const password = testPassword(); await admin('/api/users', 'POST', { username: 'inbox-member', password, repository_ids: ['101'] });
    // #481: below the phone breakpoint sign-out lives in the account menu; wide screens keep the inline button.
    if (await page.locator('#console-account').isVisible()) { await page.locator('#console-account').click(); await page.locator('#console-account-menu').getByRole('button', { name: '退出登录', exact: true }).click(); }
    else await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible(); await page.goto(h.admin + '/#/inbox/101');
    await page.getByLabel('用户名', { exact: true }).fill('inbox-member'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#workspace')).toBeVisible(); await page.goto(h.admin + '/#/inbox/101');
    const selected = page.locator('.console-inbox [data-task-id="inbox-0"]'); await selected.getByRole('button', { name: '查看任务', exact: true }).click();
    const member = h.store.get("SELECT id FROM users WHERE username='inbox-member'");
    await admin('/api/project-admin-assignments', 'PUT', { user_id: member.id, repository_ids: [] });
    await page.keyboard.press('Escape'); await expect(page.getByRole('heading', { name: '待处理事项未能读取', exact: true })).toBeVisible();
    await expect(page.locator('.console-inbox [data-task-id]')).toHaveCount(0); await expect(page.locator('.console-inbox')).toContainText('403');
  } finally { await h.stop(); }
});
