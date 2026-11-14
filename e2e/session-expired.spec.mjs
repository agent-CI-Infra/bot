import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture } from '../test/identity-fixture.mjs';

// #715: once the session expires every page says 登录已过期 with 重新登录, one banner covers the console, the header stops
// naming a role, and signing in again comes back to the page that was open.
const out = resolve('.tmp/ui-715');
test('登录过期后各页显示登录已过期与重新登录，只有一条横幅，重新登录后回到原页面', async ({ page }) => {
  test.setTimeout(60000);
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message)); mkdirSync(out, { recursive: true });
  try {
    await page.route('https://avatars.githubusercontent.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#16636b"/></svg>' }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#who')).toContainText('项目管理员');
    f.h.store.run('DELETE FROM sessions');
    const banner = page.locator('.session-expired-banner');
    for (const [name, hash] of [['projects', '#/projects'], ['identity', '#/identity'], ['costs', '#/costs'], ['inbox', '#/inbox/101']]) {
      await page.evaluate(h => { location.hash = h; }, hash);
      const card = page.locator('[data-session-expired]:visible').first();
      await expect(card.getByRole('heading', { name: '登录已过期' })).toBeVisible();
      await expect(card).toContainText('当前登录已失效，请重新登录后再查看。');
      await expect(card.getByRole('button', { name: '重新登录' })).toBeVisible();
      await expect(card.getByRole('button', { name: '重新加载' })).toHaveCount(0);
      expect(await page.locator('main').innerText()).not.toContain('login_required');
      await expect(banner).toHaveCount(1);
      await expect(banner).toHaveText(/登录已过期，请重新登录后继续。/);
      await expect(page.locator('#who')).not.toContainText('项目管理员');
      await expect(page.locator('#who')).toContainText('登录已过期');
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await expect(banner.getByRole('button', { name: '重新登录' })).toBeInViewport();
        await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    // The raw code is still there for support, folded under 技术信息.
    const card = page.locator('[data-session-expired]:visible').first();
    await card.locator('summary', { hasText: '技术信息' }).click();
    await expect(card.locator('details code')).toContainText('login_required');
    // 重新登录 goes through GitHub sign-in and comes back to the inbox, not to #/identity.
    await banner.getByRole('button', { name: '重新登录' }).click();
    await expect(page).toHaveURL(/#\/inbox\/101$/);
    await expect(page.locator('#who')).toContainText('项目管理员');
    await expect(banner).toHaveCount(0);
    await expect(page.locator('[data-session-expired]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
