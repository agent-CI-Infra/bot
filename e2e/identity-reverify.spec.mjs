import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture } from '../test/identity-fixture.mjs';

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
    await expect(page.getByRole('heading', { name: '当前角色与授权来源' })).toBeVisible();

    // 把身份与服务端授权行改成「待验证」，模拟 GitHub 侧权限失效后的中间态。
    const identity = f.h.store.get("SELECT id FROM external_identities WHERE provider='github'");
    f.h.store.run("UPDATE external_identities SET status='pending_verification' WHERE id=?", identity.id);
    await page.reload();
    const panel = page.locator('#identity-panel');
    await expect(panel).toContainText('github · 待验证／需重新授权');

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
    await expect(panel).toContainText('github · 已验证');
    await expect(panel).not.toContainText('github · 待验证／需重新授权');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: resolve(output, 'reverify-verified-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: '重新验证 GitHub 权限', exact: true })).toBeInViewport();
    await page.screenshot({ path: resolve(output, 'reverify-verified-390.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

    expect(errors).toEqual([]);
    expect(posts).toHaveLength(1);
  } finally { await f.close(); }
});
