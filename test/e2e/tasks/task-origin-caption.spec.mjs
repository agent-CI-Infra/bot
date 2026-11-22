import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { boardFixtures } from '../../fixtures/board-fixtures.mjs';

// #699: the origin line on a board card (and in the task detail) is one plain sentence: where the work came from and which
// role took it, with the role page's names. Stored kinds (event / operator / role), role ids and conversation ids stay out.
const out = '.tmp/task-origin-caption-699';
const origin = (store, task, kind, from, to, conversation = null, project = '101') => store.run(`INSERT INTO task_origins(task_id,source_kind,project_id,source_role,conversation_id,owner_key,executor_role,config_revision,created_at)
  VALUES(?,?,?,?,?,?,?,1,?)`, task, kind, project, from, conversation, 'fixture', to, '2026-10-01T12:00:00.000Z');

test('任务详情和待处理列表的来源用白话写明从哪来、交给了谁', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101'); await repository(admin, a.id, '202'); boardFixtures(h.store);
    const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, roles: [
      { role_id: 'manager', name: '调度组' }, { role_id: 'dev', name: 'Dev' },
      { role_id: 'custom-checker', name: '复核小组' },
    ] });
    expect(saved.status).toBe(200);
    origin(h.store, 'foreign-review', 'role', 'manager', 'dev', null, '202');
    origin(h.store, 'developing', 'event', 'manager', 'dev');
    origin(h.store, 'source-review', 'role', 'manager', 'retired-role');
    origin(h.store, 'reviewing', 'operator', null, 'reviewer');
    origin(h.store, 'developed', 'role', 'dev', 'dev', 'chat-7f3c0000000000000000');
    origin(h.store, 'failed-review', 'role', 'manager', null);
    origin(h.store, 'reviewed', 'mystery', 'manager', 'qa');
    origin(h.store, 'developed-review', 'role', 'manager', 'custom-checker');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/tasks/developing');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const expected = [
      ['foreign-review', '来源：角色委派 · Manager交给Developer'],
      ['developing', '来源：GitHub 事件 · 调度组交给Dev'],
      ['source-review', '来源：角色委派 · 调度组交给retired-role'],
      ['reviewing', '来源：有人手动创建 · 交给Reviewer'],
      ['developed', '来源：连续会话 · Dev自己执行'],
      ['failed-review', '来源：角色委派 · 按原执行流程处理'],
      ['reviewed', '来源：其他来源 · 调度组交给Independent QA'],
      ['developed-review', '来源：角色委派 · 调度组交给复核小组']
    ];
    for (const [taskId, caption] of expected) {
      await page.goto(h.admin + '/#/tasks/' + taskId);
      await expect(page.locator('#task-view').getByText(caption, { exact: true }).first()).toBeVisible();
      for (const raw of ['event', 'operator', 'mystery', 'manager →', '→ dev', '（委派）', 'chat-7f3c']) {
        await expect(page.locator('#task-external-bar')).not.toContainText(raw);
      }
      if (taskId === 'developing') await page.screenshot({ path: `${out}/task-1440.png` });
    }
    // The inbox receives task list data and shows the same plain-language caption.
    h.store.run("UPDATE tasks SET status='needs_help' WHERE id='developing'");
    await page.goto(h.admin + '/#/inbox/all');
    await expect(page.locator('.console-attention-row[data-task-id="developing"]')).toContainText('来源：GitHub 事件 · 调度组交给Dev');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.console-attention-row[data-task-id="developing"]')).toContainText('来源：GitHub 事件 · 调度组交给Dev');
    await page.screenshot({ path: `${out}/inbox-390.png` });
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
