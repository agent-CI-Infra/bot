import { test, expect } from '@playwright/test';
import { publicBoardFixture } from '../test/public-board-fixtures.mjs';

test.use({ locale: 'zh-CN' });

test('public dashboard and repository board render the existing pages without console login', async ({ page }) => {
  const cleanup = [], f = await publicBoardFixture({ after: fn => cleanup.push(fn) });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // The browser and collectors use only this test's local services.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  try {
    await page.goto(f.h.webhook + '/dashboard/#/gate');
    await expect(page.getByText('没有匹配的仓库', { exact: true })).toBeVisible();
    await expect(page.getByText('sciencediscovery', { exact: true })).toHaveCount(0);
    await f.hook('browser-first'); await f.boards.drain();
    await page.reload();
    await expect(page.getByText('hello', { exact: true }).first()).toBeVisible();
    await expect(page.locator('a[href*="github.io"]')).toHaveCount(0);
    await page.screenshot({ path: '.tmp/public-dashboard-desktop.png', fullPage: true });
    await page.getByRole('link', { name: '单仓看板', exact: true }).click();
    await expect(page).toHaveURL(f.h.webhook + '/boards/');
    await page.locator('a.card').click();
    await expect(page.locator('#repo-link')).toHaveText('octo/hello');
    await expect(page.locator('#tabs')).toContainText('Coverage');
    await expect(page.locator('#meta')).not.toContainText('载入中');
    await page.locator('[data-tab="ci"]').click();
    await expect(page.locator('#tab-ci')).toBeVisible();
    await page.screenshot({ path: '.tmp/public-board-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.tmp/public-board-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});
