import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { boardTask } from '../test/board-fixtures.mjs';

// #655: the bot stops a task by itself when the Issue or PR it works on is closed or turned into a draft. The card must
// not turn into "需要处理", and the board column, the overview and the inbox must count the same tasks.
test('自动停下的任务不算需要处理：看板列、总览与待处理给出同一个答案', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  const stop = 'object_closed_or_draft', work = (page, key, category) => page.locator(`[data-card-key="${key}"][data-card-category="${category}"]`);
  boardTask(h.store, 'closed-review', 1, 'review.issue', 'succeeded', { time: '2026-10-01T10:00:00.000Z', title: '已关闭的 Issue' });
  boardTask(h.store, 'closed-stop', 1, 'review.issue', 'cancelled', { time: '2026-10-02T10:00:00.000Z', title: '已关闭的 Issue', input: { issue: { state: 'closed' } }, errorCode: stop });
  boardTask(h.store, 'draft-review', 2, 'review.pr', 'succeeded', { time: '2026-10-01T10:00:00.000Z', title: '转草稿的 PR' });
  boardTask(h.store, 'draft-stop', 2, 'review.pr', 'cancelled', { time: '2026-10-02T10:00:00.000Z', title: '转草稿的 PR', input: { pull_request: { draft: true } }, errorCode: stop });
  boardTask(h.store, 'failed-review', 3, 'review.issue', 'failed', { time: '2026-10-02T10:00:00.000Z', title: '真的失败的任务' });
  try {
    await page.goto(h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('#tabs').getByRole('button', { name: '看板', exact: true }).click();
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    // The two stopped objects only show once the closed ones are included, which is what the person asked for.
    await page.getByRole('checkbox', { name: '含已关闭' }).check();
    await expect(page.locator('[data-column-id=attention] .board-column-count')).toHaveText('1');
    await expect(page.locator('[data-column-id=attention]')).toContainText('真的失败的任务');
    await expect(page.locator('[data-column-id=reviewed] [data-card-key="101/issue/1"][data-card-category="review.issue"]')).toBeVisible();
    await expect(page.locator('[data-column-id=reviewed] [data-card-key="101/pr/2"][data-card-category="review.pr"]')).toBeVisible();
    await expect(work(page,'101/issue/1','review.issue')).toContainText('已关闭');
    // The overview counts the same single task, not the two stops.
    await page.goto(h.admin + '/#/projects/101/overview');
    await expect(page.locator('[data-task-group=attention] strong')).toHaveText('1');
    // The inbox lists the same single task.
    await page.goto(h.admin + '/#/inbox');
    await expect(page.locator('.console-inbox')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.console-inbox [data-attention-task]')).toHaveCount(1);
    await expect(page.locator('.console-inbox')).toContainText('failed-review');
  } finally { await h.stop(); }
});
