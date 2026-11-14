import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { boardFixtures } from '../test/board-fixtures.mjs';

// #699: the origin line on a board card (and in the task detail) is one plain sentence: where the work came from and which
// role took it, with the role page's names. Stored kinds (event / operator / role), role ids and conversation ids stay out.
const out = '.tmp/task-origin-caption-699';
const origin = (store, task, kind, from, to, conversation = null) => store.run(`INSERT INTO task_origins(task_id,source_kind,project_id,source_role,conversation_id,owner_key,executor_role,config_revision,created_at)
  VALUES(?,?,?,?,?,?,?,1,?)`, task, kind, '101', from, conversation, 'fixture', to, '2026-10-01T12:00:00.000Z');

test('看板卡片和任务详情的来源用白话写明从哪来、交给了谁', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101'); await repository(admin, a.id, '202'); boardFixtures(h.store);
    origin(h.store, 'developing', 'event', 'manager', 'dev');
    origin(h.store, 'reviewing', 'operator', null, 'reviewer');
    origin(h.store, 'developed', 'role', 'dev', 'dev', 'chat-7f3c0000000000000000');
    origin(h.store, 'failed-review', 'role', 'manager', null);
    origin(h.store, 'reviewed', 'mystery', 'manager', 'qa');
    origin(h.store, 'developed-review', 'role', 'manager', 'custom-checker');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/board');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    const card = (key, category) => page.locator(`[data-card-key="${key}"][data-card-category="${category}"]`);
    const expected = [
      ['101/issue/3', 'development.issue', '来源：GitHub 事件 · 项目管理者交给开发'],
      ['101/pr/2', 'review.pr', '来源：有人手动创建 · 交给检视'],
      ['101/issue/4', 'development.issue', '来源：连续会话 · 开发自己执行'],
      ['101/issue/5', 'review.issue', '来源：角色委派 · 按原执行流程处理'],
      ['101/issue/1', 'review.issue', '来源：其他来源 · 项目管理者交给独立验收'],
      ['101/issue/4', 'review.issue', '来源：角色委派 · 项目管理者交给custom-checker']
    ];
    for (const [key, category, caption] of expected) await expect(card(key, category)).toContainText(caption);
    const board = page.locator('#board-panel');
    for (const raw of ['event', 'operator', 'mystery', 'manager →', '→ dev', '（委派）', 'chat-7f3c']) await expect(board).not.toContainText(raw);
    await card('101/issue/3', 'development.issue').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/board-1440.png` });
    // The task detail uses the same sentence.
    await card('101/issue/3', 'development.issue').locator('.board-card-title').click();
    await expect(page.locator('#task-title')).toHaveText('开发 · Issue #3');
    await expect(page.getByText('来源：GitHub 事件 · 项目管理者交给开发', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: `${out}/task-1440.png` });
    await page.locator('#task-actions').getByRole('button', { name: '关闭', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    // A phone shows one group at a time; open the one that holds the development card.
    const group = page.getByLabel('当前分组', { exact: true });
    const label = await group.locator('option', { hasText: '开发 / 跟进 / 发版中' }).textContent();
    await group.selectOption({ label });
    await card('101/issue/3', 'development.issue').scrollIntoViewIfNeeded();
    await expect(card('101/issue/3', 'development.issue')).toContainText('来源：GitHub 事件 · 项目管理者交给开发');
    await page.screenshot({ path: `${out}/board-390.png` });
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
