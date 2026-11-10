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
    const grant = f.h.store.get("SELECT * FROM scoped_grants WHERE source='github_derived'");
    f.h.store.run('UPDATE github_installations SET revision=revision+1 WHERE ref=?', grant.installation_ref);
    await page.evaluate(() => start());
    await expect(page.locator('#identity-panel')).toContainText('安装待同步');
    await page.screenshot({ path: resolve(output, 'identity-installation-pending-1440.png'), fullPage: true });

    f.h.store.run("UPDATE external_identities SET status='pending_verification' WHERE principal_id=?", grant.principal_id);
    await page.evaluate(() => start());
    await expect(page.locator('#identity-panel')).toContainText('待验证／权限不足，请重新授权');
    await expect(page.locator('#identity-panel')).not.toContainText('安装待同步');
    await expect(page.getByRole('button', { name: '重新验证 GitHub 权限' })).toBeVisible();
    f.h.store.run("UPDATE external_identities SET status='active' WHERE principal_id=?", grant.principal_id);
    await page.evaluate(() => start());
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#identity-panel')).toContainText('安装待同步');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });

    f.h.store.run('UPDATE github_installations SET revision=?, scope_pending=1 WHERE ref=?', grant.installation_revision, grant.installation_ref);
    await page.evaluate(() => start());
    await expect(page.locator('#identity-panel')).toContainText('安装或权限待核验');
    await expect(page.locator('#identity-panel')).not.toContainText('安装仍有效');
    f.h.store.run("UPDATE github_installations SET scope_pending=0, status='suspended' WHERE ref=?", grant.installation_ref);
    await page.evaluate(() => start());
    await expect(page.locator('#identity-panel')).toContainText('安装或权限待核验');
    await expect(page.locator('#identity-panel')).not.toContainText('安装仍有效');
    f.h.store.run("UPDATE github_installations SET status='active' WHERE ref=?", grant.installation_ref);

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

test('the boot state waits for setup and then opens initialization', async ({ page }) => {
  const h = await harness();
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await page.route('**/api/setup', async route => {
      if (route.request().method() === 'GET') await gate;
      await route.continue();
    });
    await page.goto(h.admin + '/');
    await expect(page.locator('#boot')).toBeVisible();
    await expect(page.locator('#boot-message')).toHaveText('正在载入…');
    await expect(page.locator('#access')).toBeHidden();
    release();
    await expect(page.locator('#boot')).toBeHidden();
    await expect(page.getByRole('heading', { name: '创建第一名超级管理员', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '初始化并登录', exact: true })).toBeVisible();
  } finally { release(); await h.stop(); }
});

test('a setup failure replaces loading with an error and retries into the login page at every supported width', async ({ page }) => {
  const h = await harness(); await setup(h);
  let failSetup = true, setupRequests = 0;
  try {
    mkdirSync(output, { recursive: true });
    await page.route('**/api/setup', route => {
      if (route.request().method() !== 'GET') return route.continue();
      setupRequests++;
      if (failSetup) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'setup_unavailable' }) });
      return route.continue();
    });
    await page.goto(h.admin + '/');
    const bootError = page.locator('#boot-message'), retry = page.getByRole('button', { name: '重试', exact: true });
    await expect(bootError).toHaveAttribute('role', 'alert');
    await expect(bootError).toContainText('控制台载入失败：503 · setup_unavailable');
    await expect(bootError).not.toContainText('正在载入');
    await expect(page.locator('#access')).toBeHidden();
    await expect(page.locator('#message')).toBeEmpty();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await expect(retry).toBeVisible(); await expect(retry).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: resolve(output, `boot-error-${width}.png`), fullPage: true });
    }
    failSetup = false; await retry.click();
    await expect(page.locator('#boot')).toBeHidden();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    expect(setupRequests).toBe(2);
  } finally { await h.stop(); }
});
