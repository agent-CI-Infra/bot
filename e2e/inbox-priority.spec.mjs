import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #226 待我处理: every waiting item must say how urgent it is and how long it has waited, oldest first, so a person
// can decide what to open next without reading each task.
test('待处理列表显示优先级与已等待时长，并按状态变更时间从早到晚排列', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const ago = ms => new Date(Date.now() - ms).toISOString();
    const seed = (id, status, priority, time, summary) => h.store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,priority,created_at,updated_at)
      VALUES(?,?,'review.issue',?,'fixture',?,?,?,?)`, id, '101', status, Number(id.replace(/\D/g, '')) || 1, priority, time, time);
    seed('fail-0', 'failed', 'P0', ago(3 * 24 * 3600e3), '任务 A 执行失败'); h.store.run("UPDATE tasks SET summary='任务 A 执行失败' WHERE id='fail-0'");
    seed('perm-1', 'waiting_permission', 'P1', ago(5 * 3600e3), '任务 B 等待权限'); h.store.run("UPDATE tasks SET summary='任务 B 等待权限' WHERE id='perm-1'");
    seed('conf-2', 'waiting_configuration', 'P2', ago(30 * 60e3), '任务 C 等待配置'); h.store.run("UPDATE tasks SET summary='任务 C 等待配置' WHERE id='conf-2'");
    seed('queue-3', 'queued', 'P0', ago(4 * 24 * 3600e3), '任务 D 排队');
    seed('done-4', 'succeeded', 'P0', ago(6 * 24 * 3600e3), '任务 E 已完成');
    await page.goto(h.admin + '/#/inbox');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const rows = page.locator('.console-inbox [data-task-id]');
    await expect(rows).toHaveCount(3);
    // Queue order and completed work are not attention items, so the three waiting tasks are the only rows.
    await expect(rows).toHaveText([/任务 A 执行失败/, /任务 B 等待权限/, /任务 C 等待配置/]);
    // Each row names its urgency in the wording the task detail uses, and how long it has been waiting.
    await expect(rows.nth(0)).toContainText('P0 紧急止损');
    await expect(rows.nth(1)).toContainText('P1 核心阻塞');
    await expect(rows.nth(2)).toContainText('P2 正常开发');
    await expect(rows.nth(0)).toContainText('已等待 3 天');
    await expect(rows.nth(1)).toContainText('已等待 5 小时');
    await expect(rows.nth(2)).toContainText('已等待 30 分钟');
    // The waiting line keeps the timestamp it was computed from.
    await expect(rows.nth(0)).toContainText('最近状态变更');
    mkdirSync('.tmp/inbox-priority', { recursive: true });
    for (const [width, name] of [[390, 'inbox-390'], [768, 'inbox-768'], [1440, 'inbox-1440']]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(rows.nth(0).locator('text=/P0 紧急止损/')).toBeVisible();
      await expect(rows.nth(0).getByRole('button', { name: '查看任务', exact: true })).toBeVisible();
      await page.screenshot({ path: `.tmp/inbox-priority/${name}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
