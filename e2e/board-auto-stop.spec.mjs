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
  // A development waiting for an environment asks a person: the board must not call it 正在开发 while the inbox and the
  // overview count it as 需要关注. Its Issue is closed only so the card is visible with the closed ones included.
  boardTask(h.store, 'wait-env-dev', 4, 'development.issue', 'waiting_environment', { time: '2026-10-02T10:00:00.000Z', title: '等待环境的开发', input: { issue: { state: 'closed' } } });
  // The same wait, then stopped because the Issue closed: the card falls back to the wait, not to 未检视.
  boardTask(h.store, 'env-dev', 5, 'development.issue', 'waiting_environment', { time: '2026-10-01T10:00:00.000Z', title: '等待环境后关闭的开发' });
  boardTask(h.store, 'stop-env-dev', 5, 'development.issue', 'cancelled', { time: '2026-10-02T10:00:00.000Z', title: '等待环境后关闭的开发', input: { issue: { state: 'closed' } }, errorCode: stop });
  // Cancelled for another reason: the card must not borrow the bot's own stop sentence for it.
  boardTask(h.store, 'revoked-review', 6, 'review.issue', 'cancelled', { time: '2026-10-02T10:00:00.000Z', title: '执行权撤销的 Issue', input: { issue: { state: 'closed' } }, errorCode: 'task_claim_revoked' });
  try {
    await page.goto(h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('#tabs').getByRole('button', { name: '看板', exact: true }).click();
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    // The two stopped objects only show once the closed ones are included, which is what the person asked for.
    await page.getByRole('checkbox', { name: '含已关闭' }).check();
    await expect(page.locator('[data-column-id=attention] .board-column-count')).toHaveText('3');
    await expect(page.locator('[data-column-id=attention]')).toContainText('真的失败的任务');
    // Both developments wait for a person, so neither sits in 正在开发.
    await expect(work(page, '101/issue/4', 'development.issue')).toContainText('等待环境的开发');
    await expect(page.locator('[data-column-id=attention] [data-card-key="101/issue/4"][data-card-category="development.issue"]')).toBeVisible();
    await expect(page.locator('[data-column-id=developing] [data-card-key="101/issue/4"][data-card-category="development.issue"]')).toHaveCount(0);
    await expect(page.locator('[data-column-id=attention] [data-card-key="101/issue/5"][data-card-category="development.issue"]')).toBeVisible();
    await expect(page.locator('[data-column-id=reviewed] [data-card-key="101/issue/1"][data-card-category="review.issue"]')).toBeVisible();
    await expect(page.locator('[data-column-id=reviewed] [data-card-key="101/pr/2"][data-card-category="review.pr"]')).toBeVisible();
    await expect(work(page, '101/issue/1', 'review.issue')).toContainText('已关闭');
    // The stop is explained in plain words, not only by a "已取消" badge.
    await expect(work(page, '101/issue/1', 'review.issue').locator('[data-card-note=auto-stop]')).toHaveText('Issue 已关闭，已自动停止检视');
    await expect(work(page, '101/pr/2', 'review.pr').locator('[data-card-note=auto-stop]')).toHaveText('PR 已转草稿，已自动停止检视');
    await expect(work(page, '101/issue/5', 'development.issue').locator('[data-card-note=auto-stop]')).toHaveText('Issue 已关闭，已自动停止开发');
    // A cancellation for another reason keeps its badge and gets no automatic-stop sentence.
    await expect(page.locator('[data-column-id=unreviewed] [data-card-key="101/issue/6"][data-card-category="review.issue"]')).toBeVisible();
    await expect(work(page, '101/issue/6', 'review.issue').locator('[data-card-note=auto-stop]')).toHaveCount(0);
    await expect(work(page, '101/issue/6', 'review.issue').locator('.board-card-badges')).toContainText('已取消');
    // The note stays inside the card at phone and desktop widths instead of spilling out of it.
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      // A phone shows one column at a time; the reviewed column holds the stopped review card.
      if (width === 390) await page.locator('#board-mobile-group').selectOption('reviewed');
      const card = work(page, '101/issue/1', 'review.issue'), note = card.locator('[data-card-note=auto-stop]');
      await expect(note).toBeVisible();
      const spills = await card.evaluate(el => {
        const note = el.querySelector('[data-card-note]'), box = el.getBoundingClientRect(), edge = note.getBoundingClientRect();
        return edge.left < box.left - 1 || edge.right > box.right + 1 || note.scrollWidth > note.clientWidth + 1;
      });
      expect(spills, `card note at ${width}px`).toBe(false);
    }
    // The overview counts the same three tasks, not the two stops.
    await page.goto(h.admin + '/#/projects/101/overview');
    await expect(page.locator('[data-task-group=attention] strong')).toHaveText('3');
    // The inbox lists the same three tasks.
    await page.goto(h.admin + '/#/inbox');
    await expect(page.locator('.console-inbox')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.console-inbox [data-attention-task]')).toHaveCount(3);
    await expect(page.locator('.console-inbox')).toContainText('failed-review');
  } finally { await h.stop(); }
});
