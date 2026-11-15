import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #790: the project list's five-second task-count read answers 401/403/404 the same way whenever it is asked, so the
// list stops asking, keeps the rows it has, and says so where the reader can see it — with one manual read.
test('项目列表的任务数轮询遇到 403 只请求一次并显示可见提示，手动重新读取可恢复', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.goto(h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const rows = page.locator('#rows .row');
    await expect(rows).toHaveCount(1);
    // Every later list read of the signed-in super administrator is answered 403 until the test says otherwise.
    let answer = 403, reads = 0;
    await page.route(/\/api\/installations\?/, route => { reads++; return answer === 403
      ? route.fulfill({ status: 403, json: { error: 'forbidden' } })
      : route.continue(); });
    // Two five-second ticks would be two more requests if the poll kept going.
    await page.waitForTimeout(11000);
    expect(reads, 'the 403 is asked once, not every five seconds').toBe(1);
    const notice = page.locator('#rows [data-testid="project-activity-status"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('任务数已停止更新');
    await expect(rows, 'the numbers already on the list stay').toHaveCount(1);
    await expect(notice.getByRole('button', { name: '重新读取任务数' })).toBeVisible();
    // Reading by hand goes through again, and a readable listing takes the notice away.
    answer = 200;
    await notice.getByRole('button', { name: '重新读取任务数' }).click();
    await expect(page.locator('#rows [data-testid="project-activity-status"]')).toHaveCount(0);
    await expect(rows).toHaveCount(1);
    expect(reads, 'the manual read is the next request').toBe(2);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
