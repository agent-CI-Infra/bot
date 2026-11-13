import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture, openIdentityAdvanced } from '../test/identity-fixture.mjs';

const output = resolve('.tmp/identity-reverify-225');

// #225 最后一条未覆盖的验收：待核验的身份必须由用户主动「重新验证 GitHub 权限」
// 触发一次服务端复核，且页面只显示服务端复核后的状态，不能靠前端把标签改绿。
test('重新验证 GitHub 权限：待验证身份经服务端复核后回到已验证', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  mkdirSync(output, { recursive: true });
  try {
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();

    // 把身份与服务端授权行改成「待验证」，模拟 GitHub 侧权限失效后的中间态。
    const identity = f.h.store.get("SELECT id FROM external_identities WHERE provider='github'");
    f.h.store.run("UPDATE external_identities SET status='pending_verification' WHERE id=?", identity.id);
    await page.reload();
    const panel = page.locator('#identity-panel');
    await expect(panel.locator('.identity-connection-status')).toContainText('GitHub 授权待验证');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: resolve(output, 'reverify-pending-1440.png'), fullPage: true });

    const posts = [];
    page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/identity/refresh') posts.push(r.url()); });
    const refresh = page.getByRole('button', { name: '重新验证 GitHub 权限', exact: true });
    await expect(refresh).toBeEnabled();

    // 键盘可操作：按钮在制表位里能被聚焦，回车即可触发复核（手机上没有可点区域之外的替代路径）。
    await refresh.focus();
    await expect(refresh).toBeFocused();
    await expect(refresh).toBeInViewport();
    await page.keyboard.press('Enter');

    // 服务端必须真的被调用一次，且只调用一次。
    await expect.poll(() => posts.length).toBe(1);
    // 复核结果以服务端状态为准：身份回到已验证。
    await expect.poll(() => f.h.store.get("SELECT status FROM external_identities WHERE id=?", identity.id).status).toBe('active');
    await expect(panel.getByRole('status')).toHaveText('GitHub 权限已重新验证。');
    await expect(panel.locator('.identity-connection-status')).not.toHaveText('GitHub 授权待验证');
    await expect(panel.getByRole('button', { name: '正在验证…' })).toHaveCount(0);
    await openIdentityAdvanced(page);
    await expect(panel).toContainText('github · 已验证');
    await expect(panel).not.toContainText('github · 待验证／需重新授权');
    const done = page.getByRole('button', { name: '重新验证 GitHub 权限', exact: true });
    await expect(done).toBeEnabled();
    await expect(done).toHaveText('重新验证 GitHub 权限');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: resolve(output, 'reverify-verified-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const reverifyButton = page.getByRole('button', { name: '重新验证 GitHub 权限', exact: true });
    await reverifyButton.scrollIntoViewIfNeeded();
    await expect(reverifyButton).toBeInViewport();
    await page.screenshot({ path: resolve(output, 'reverify-verified-390.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

    expect(errors).toEqual([]);
    expect(posts).toHaveLength(1);
  } finally { await f.close(); }
});


test('重新验证 GitHub 权限：需要重新授权时显示原因并跳转到 GitHub', async ({ page, context }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();


    const identity = f.h.store.get("SELECT id FROM external_identities WHERE provider='github'");
    f.h.store.run("UPDATE external_identities SET status='pending_verification' WHERE id=?", identity.id);
    await page.reload();
    const panel = page.locator('#identity-panel');
    await expect(panel.locator('.identity-connection-status')).toContainText('GitHub 授权待验证');


    f.state.failure = 401;
    const refresh = page.getByRole('button', { name: '重新验证 GitHub 权限', exact: true });
    await expect(refresh).toBeEnabled();
    const authorized = page.waitForRequest(r => { try { return new URL(r.url()).pathname === '/login/oauth/authorize'; } catch { return false; } }, { timeout: 15_000 });
    await refresh.click();
    await expect(panel.getByRole('alert')).toContainText('需要重新授权', { timeout: 10_000 });
    await authorized;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: resolve(output, 'reverify-error-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.screenshot({ path: resolve(output, 'reverify-error-390.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});


test('重新验证 GitHub 权限：安装仍待确认时显示原因而不是成功', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await openIdentityAdvanced(page);


    f.state.failure = 403;
    const panel = page.locator('#identity-panel');
    const refresh = page.getByRole('button', { name: '重新验证 GitHub 权限', exact: true });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(panel.getByRole('alert')).toContainText('还在等待确认', { timeout: 10_000 });
    await expect(panel.getByRole('status')).toHaveCount(0);
    await expect(panel).not.toContainText('GitHub 权限已重新验证。');
    await expect(refresh).toBeEnabled();
    await expect(refresh).toHaveText('重新验证 GitHub 权限');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: resolve(output, 'reverify-pending-result-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await refresh.scrollIntoViewIfNeeded();
    await expect(refresh).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.screenshot({ path: resolve(output, 'reverify-pending-result-390.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('重新验证 GitHub 权限：请求超时后显示错误并恢复按钮', async ({ page }) => {
  test.setTimeout(45_000);
  const f = await identityFixture(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();


    const identity = f.h.store.get("SELECT id FROM external_identities WHERE provider='github'");
    f.h.store.run("UPDATE external_identities SET status='pending_verification' WHERE id=?", identity.id);
    await page.reload();
    const panel = page.locator('#identity-panel');
    await expect(panel.locator('.identity-connection-status')).toContainText('GitHub 授权待验证');


    await page.route('**/api/identity/refresh', async route => {
      await new Promise(resolve => setTimeout(resolve, 60_000));
      await route.abort();
    });
    const refresh = page.getByRole('button', { name: /重新验证 GitHub 权限|正在验证/ });
    await expect(refresh).toBeEnabled();
    const started = Date.now();
    await refresh.click();
    await expect(refresh).toHaveText('正在验证…');
    await expect(panel.getByRole('alert')).toContainText('验证超时', { timeout: 25_000 });
    expect(Date.now() - started).toBeLessThan(30_000);
    await expect(refresh).toBeEnabled();
    await expect(refresh).toHaveText('重新验证 GitHub 权限');
    await expect(page).toHaveURL(/#\/identity/);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: resolve(output, 'reverify-timeout-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await refresh.scrollIntoViewIfNeeded();
    await expect(refresh).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.screenshot({ path: resolve(output, 'reverify-timeout-390.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('从 GitHub 安装或授权返回后自动刷新并显示结果，身份页没有重复的刷新按钮', async ({ page }) => {
  const f = await identityFixture();
  let refreshed = 0;
  try {
    await page.route('**/api/identity/refresh', async route => {
      if (route.request().method() === 'POST') refreshed++;
      await route.continue();
    });
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await page.goto(f.h.admin + '/?github_setup=ready#/identity');
    await expect(page.locator('#identity-panel').getByRole('status')).toHaveText('GitHub App 安装已完成，身份与授权已刷新。');
    expect(refreshed).toBeGreaterThan(0);
    expect(new URL(page.url()).searchParams.has('github_setup')).toBe(false);
    await expect(page.getByRole('button', { name: '刷新身份与授权' })).toHaveCount(0);
    await openIdentityAdvanced(page);
    await expect(page.getByRole('button', { name: '刷新身份与授权' })).toHaveCount(0);
    const { mkdirSync } = await import('node:fs');
    mkdirSync('.tmp/ui-516', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: '.tmp/ui-516/setup-return-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/ui-516/setup-return-390.png', fullPage: true });
    const beforeAuth = refreshed;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/?github_auth=1#/identity');
    await expect(page.locator('#identity-panel').getByRole('status')).toHaveText('已从 GitHub 授权返回，身份与授权已刷新。');
    expect(refreshed).toBeGreaterThan(beforeAuth);
    await page.screenshot({ path: '.tmp/ui-516/auth-return-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/ui-516/auth-return-390.png', fullPage: true });
  } finally { await f.close(); }
});

test('自动刷新在重新授权后绑定失败时显示错误，不会停在正在刷新', async ({ page }) => {
  const f = await identityFixture();
  try {
    await page.route('**/api/identity/refresh', async route => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'github_reauthorization_required' }) });
        return;
      }
      await route.continue();
    });
    await page.route('**/api/identity/github/bind', async route => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'github_oauth_unavailable' }) });
        return;
      }
      await route.continue();
    });
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await page.goto(f.h.admin + '/?github_auth=1#/identity');
    await expect(page.getByRole('heading', { name: '正在刷新身份与授权' })).toHaveCount(0);
    await expect(page.locator('#identity-panel')).toContainText('连接 GitHub 失败：授权请求没有完成');
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
  } finally { await f.close(); }
});

test('从飞书绑定流程回到控制台时不阻塞在身份刷新上', async ({ page }) => {
  const f = await identityFixture();
  let refreshed = 0;
  try {
    await page.route('**/api/identity/refresh', async route => {
      if (route.request().method() === 'POST') refreshed++;
      await route.continue();
    });
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    const afterLogin = refreshed;
    await page.goto(f.h.admin + '/?github_auth=1#/identity/feishu');
    await expect(page.getByRole('heading', { name: '正在刷新身份与授权' })).toHaveCount(0);
    await expect(page.locator('#identity-panel')).toContainText('飞书绑定');
    expect(refreshed).toBe(afterLogin);
    expect(page.url()).toContain('#/identity/feishu');
  } finally { await f.close(); }
});
