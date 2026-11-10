import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture } from '../test/identity-fixture.mjs';
import { harness, setup, account } from '../test/helpers.mjs';

const output = resolve('.tmp/login-onboarding-225');

test.beforeEach(async ({ page }) => {
  await page.route('https://avatars.githubusercontent.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#16636b"/></svg>' }));
});

test('the first paint is a loading line, not an empty page, and the login card is usable on a phone', async ({ page }) => {
  const h = await harness();
  try {
    await setup(h);
    mkdirSync(output, { recursive: true });
    // The shell used to stay empty until /api/setup and /api/auth/me came back; the boot line covers that gap.
    await page.goto(h.admin + '/');
    await expect(page.getByRole('status').first()).toBeHidden();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await expect(page.locator('#boot')).toBeHidden();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const form = page.locator('#access');
      await expect(form).toBeVisible();
      // 44px is the touch floor this slice promises on the only screen used before any styling context exists.
      for (const control of [page.getByLabel('用户名', { exact: true }), page.getByLabel('密码', { exact: true }), page.getByRole('button', { name: '登录', exact: true })]) {
        const box = await control.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.getByLabel('用户名', { exact: true }).evaluate(el => getComputedStyle(el.closest('label')).fontSize)).toBe('14px');
      await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: resolve(output, `login-${width}.png`), fullPage: true });
    }
  } finally { await h.stop(); }
});

test('a pending grant says which condition it waits on, and an older server without the field still renders', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', e => errors.push(e.message)); mkdirSync(output, { recursive: true });
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '当前角色与授权来源' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '当前角色与授权来源' })).toBeVisible();
    const grant = f.h.store.get("SELECT * FROM scoped_grants WHERE source='github_derived'");
    // The installation moved on since the grant was verified: the installation branch of the old combined state.
    f.h.store.run('UPDATE github_installations SET revision=revision+1 WHERE ref=?', grant.installation_ref);
    await page.evaluate(() => start());
    await expect(page.locator('#identity-panel')).toContainText('安装待同步');
    await page.screenshot({ path: resolve(output, 'identity-installation-pending-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#identity-panel')).toContainText('安装待同步');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    // The permission branch is a different cause with the same old state text.
    f.h.store.run('UPDATE github_installations SET revision=?, scope_pending=1 WHERE ref=?', grant.installation_revision, grant.installation_ref);
    await page.evaluate(() => start());
    await expect(page.locator('#identity-panel')).toContainText('权限待核验');
    // Backward compatibility: a server that predates the field sends no reason, and the console keeps its sentence.
    await page.route('**/api/identity', async route => {
      const response = await route.fetch(), body = await response.json();
      for (const scope of body.scopes) delete scope.reason;
      await route.fulfill({ response, json: body });
    });
    f.h.store.run('UPDATE github_installations SET revision=revision+1 WHERE ref=?', grant.installation_ref);
    await page.evaluate(() => start());
    await expect(page.locator('#identity-panel')).toContainText('待验证／权限不足，请重新授权');
    await expect(page.locator('#identity-panel')).not.toContainText('安装待同步');
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
