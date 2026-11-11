import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #238: a task created by a webhook delivery keeps that delivery as its source. The task page must name it and open the
// delivery detail, so the chain delivery → dispatch → task → run can be walked in both directions without copying an id.
test('task detail names the webhook delivery that created it and opens its detail', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await h.hook(a.path, a.secret, 'delivery-source', { repository: { id: 101, full_name: 'fixture/project-101' }, action: 'opened', issue: { number: 1, title: 'Review' } });
  // Tasks keep the archived delivery row's id, not the GitHub delivery string, so read it back from the store.
  const event = h.store.get("SELECT id FROM deliveries WHERE delivery_id='delivery-source'");
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,source_delivery_id,created_at,updated_at) VALUES('source-task','101','review.issue','failed','Review from webhook',1,'complete',?, '2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z')", event.id);
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    await page.goto(h.admin + '/#/inbox/101');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('[data-task-id="source-task"]').getByRole('button', { name: '查看任务', exact: true }).click();
    const side = page.locator('#task-side');
    const source = side.locator('[data-source-delivery]');
    await expect(source).toBeVisible();
    await expect(source).toContainText('来源投递');
    await source.getByRole('button', { name: '查看投递', exact: true }).click();
    const detail = page.locator('#detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('[data-delivery-id]')).toHaveText('delivery-source');
    await expect(detail.locator('[data-detail-section="reception"]')).toContainText('已接收');
    // The delivery names the task it created, so both directions agree about the same pair.
    await expect(detail.locator('.delivery-tasks')).toContainText('检视 Issue #1');
    await page.locator('#close-detail').click();
    await expect(detail).toBeHidden();
    await expect(page.locator('#task-view')).toBeVisible();
    // The same facts stay readable at 390px without horizontal scrolling.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(side.locator('[data-source-delivery]')).toContainText('来源投递');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
