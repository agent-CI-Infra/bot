import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

// #789: the board's quiet refresh is a read like any other. A 404 will answer the same way however often it is asked, so
// the refresh stops after one attempt, says so once, and leaves a button that really reads the board again.
test('#789 看板刷新遇到 404 只请求一次并停下，状态栏给真实可点的「重新读取看板」', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    // Only the quiet refreshes fail: the board itself loads, so the failure is the poll's own.
    let fail = false;
    const polls = [];
    await page.route('**/api/board/cards?*', route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('offset') !== '0') return route.continue();
      polls.push(Date.now());
      return fail ? route.fulfill({ status: 404, json: { error: 'not_found' } }) : route.continue();
    });
    await page.goto(h.admin + '/#/board');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#board-status')).toContainText('共 0 项工作');
    // The first page read is done; from here every quiet refresh answers 404.
    fail = true;
    await expect(page.locator('#board-status')).toContainText('刷新已停止', { timeout: 30000 });
    await expect(page.getByRole('button', { name: '重新读取看板', exact: true })).toBeVisible();
    const seen = polls.length;
    // No further automatic read, even after the old 15 second interval would have fired again.
    await page.waitForTimeout(16000);
    expect(polls.length).toBe(seen);
    // The control is real: pressing it reads the board again and the failure notice goes away.
    fail = false;
    await page.getByRole('button', { name: '重新读取看板', exact: true }).click();
    await expect(page.locator('#board-status')).toContainText('共 0 项工作');
    await expect(page.locator('#board-status')).not.toContainText('刷新已停止');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
