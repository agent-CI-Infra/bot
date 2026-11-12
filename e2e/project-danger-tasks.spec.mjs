import { test, expect } from '@playwright/test';
import { identityFixture } from '../test/identity-fixture.mjs';

// #226 项目设置 · 危险区: before disabling a project an administrator can see how much work is in flight
// right now, and a failed count never degrades into "nothing is running".
const seed = (f, rows) => rows.forEach(([id, status]) => f.h.store.run(
  `INSERT INTO tasks(id,repository_id,object_number,kind,status,summary,input,result,created_at,updated_at)
   VALUES(?,'101',1,'review.issue',?,?,'{}',NULL,'2026-11-11T12:00:00.000Z','2026-11-11T12:00:00.000Z')`,
  id, status, id));

test('the danger zone states how many tasks a disable would stop, and never reports an unreadable count as zero', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    seed(f, [['danger-run-a', 'running'], ['danger-run-b', 'implementing'], ['danger-run-c', 'succeeded']]);
    await page.goto(f.h.admin + '/#/settings/projects/101');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();

    const impact = page.locator('[data-project-danger-tasks]');
    await expect(impact).toBeVisible();
    await expect(impact).toContainText('当前 2 项任务在推进中');
    await expect(page.locator('.project-danger a[href="#/projects/101/overview/active"]')).toHaveText(/查看推进中的任务/);

    // A count that cannot be read is not zero: the line says so and offers the existing refresh.
    await page.route('**/api/tasks?**', route => route.fulfill({ status: 503, json: { error: 'tasks_unavailable' } }));
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(impact).toContainText('暂时无法读取推进中的任务数');
    await expect(impact).toContainText('不按零处理');
    await page.unroute('**/api/tasks?**');

    // No work in flight is stated as such instead of leaving the previous count behind.
    f.h.store.run("DELETE FROM tasks WHERE id LIKE 'danger-%'");
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(impact).toContainText('当前没有推进中的任务');
    await expect(impact).not.toContainText('项任务在推进中');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
