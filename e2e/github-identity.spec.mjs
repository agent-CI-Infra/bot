import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture } from '../test/identity-fixture.mjs';

const output = resolve('.tmp/github-login-163');
test('GitHub 登录、组织切换、权限来源、撤销与本地恢复', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message)); mkdirSync(output, { recursive: true });
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '当前角色与授权来源' })).toBeVisible();
    await expect(page.locator('#identity-panel')).toContainText('组织管理员');
    await expect(page.locator('#identity-panel')).toContainText('GitHub 当前权限（继承）');
    await expect(page.getByRole('button', { name: '全局设置', exact: true })).toBeHidden();
    const principal = f.h.store.get("SELECT principal_id FROM external_identities WHERE provider='github'").principal_id;
    await f.admin('/api/project-admin-assignments', 'PUT', { user_id: principal, repository_ids: ['101'] });
    await page.reload(); await expect(page.locator('#identity-panel')).toContainText('显式委派');
    await page.getByLabel('当前租户').selectOption('github.com:10'); await page.getByRole('button', { name: '切换组织' }).click();
    await expect(page.getByLabel('当前租户')).toHaveValue('github.com:10');
    const crossTenant = await page.evaluate(async () => (await fetch('/api/repositories/201')).status); expect(crossTenant).toBe(403);
    await page.screenshot({ path: resolve(output, 'permissions-desktop.png'), fullPage: true });
    f.state.owner = false; f.state.admin = false;
    await page.getByRole('button', { name: '重新验证 GitHub 权限' }).click();
    await expect(page.locator('#identity-panel')).toContainText('已撤销');
    await expect(page.locator('#identity-panel')).toContainText('显式委派');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(output, 'revoked-mobile.png'), fullPage: true });
    page.on('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '解除绑定', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByRole('button', { name: '身份与权限', exact: true }).click();
    await expect(page.locator('#identity-panel')).toContainText('平台超级管理员');
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('绑定同一 GitHub 身份会显示冲突；本地会话可以完成新身份绑定', async ({ page }) => {
  const f = await identityFixture();
  try {
    await f.login(); await page.goto(f.h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByRole('button', { name: '身份与权限', exact: true }).click();
    await page.getByRole('button', { name: '绑定 GitHub 账号', exact: true }).click();
    await expect(page.locator('#message')).toContainText('已绑定其他账号');
    f.state.id = 43;
    await page.getByRole('button', { name: '绑定 GitHub 账号', exact: true }).click();
    await expect(page.locator('#identity-panel')).toContainText('已验证');
    await expect(page.locator('#identity-panel')).toContainText('平台超级管理员');
    await page.screenshot({ path: resolve(output, 'bound-local-account.png'), fullPage: true });
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
