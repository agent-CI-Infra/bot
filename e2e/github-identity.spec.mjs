import { consoleNavigate } from './console-navigation.mjs';
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture } from '../test/identity-fixture.mjs';

const output = resolve('.tmp/github-login-163');
test.beforeEach(async ({ page }) => {
  await page.route('https://avatars.githubusercontent.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#16636b"/></svg>' }));
});
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
    await page.getByRole('button', { name: '登录', exact: true }).click(); await consoleNavigate(page, '身份与权限');
    await expect(page.locator('#identity-panel')).toContainText('平台超级管理员');
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('GitHub 页头展示用户名与头像，旧会话和改名可刷新，窄屏及头像失败仍可识别用户', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message)); mkdirSync(output, { recursive: true });
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    const who = page.locator('#who'), avatar = who.getByRole('img', { name: 'administrator 的 GitHub 头像' });
    await expect(who).toContainText('@administrator'); await expect(who).not.toContainText('github:42:');
    await expect(avatar).toBeVisible();
    await expect.poll(() => avatar.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.screenshot({ path: resolve(output, 'profile-desktop.png'), fullPage: true });
    const principal = f.h.store.get("SELECT principal_id FROM external_identities WHERE provider='github'").principal_id;
    f.state.login = 'a-github-username-with-thirty-nine-chars1'; await f.identity.reverify(principal);
    await page.reload(); await expect(who).toContainText('@' + f.state.login);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(who).toBeVisible(); await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    }
    await page.screenshot({ path: resolve(output, 'profile-mobile.png'), fullPage: true });
    await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
    await page.reload(); await expect(who.locator('img')).toHaveCount(0); await expect(who).toContainText('@' + f.state.login);
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(who).toHaveText('administrator · 超级管理员'); await expect(who.locator('img')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('绑定同一 GitHub 身份会显示冲突；本地会话可以完成新身份绑定', async ({ page }) => {
  const f = await identityFixture();
  try {
    await f.login(); await page.goto(f.h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click(); await consoleNavigate(page, '身份与权限');
    await page.getByRole('button', { name: '绑定 GitHub 账号', exact: true }).click();
    await expect(page.locator('#message')).toContainText('已绑定其他账号');
    f.state.id = 43;
    await page.getByRole('button', { name: '绑定 GitHub 账号', exact: true }).click();
    await expect(page.locator('#identity-panel')).toContainText('已验证');
    await expect(page.locator('#identity-panel')).toContainText('平台超级管理员');
    await page.screenshot({ path: resolve(output, 'bound-local-account.png'), fullPage: true });
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('全局用户按实际项目显示 GitHub 继承与手工委派，编辑手工分配不会覆盖继承权限', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message)); mkdirSync(output, { recursive: true });
  try {
    const login = await f.login(), principal = login.result.principal_id;
    await page.goto(f.h.admin + '/#/settings/users');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const row = page.locator('#settings-panel .row').filter({ has: page.getByText('@administrator', { exact: true }) });
    await expect(row).toContainText('当前可见项目（1）'); await expect(row).toContainText('fixture/project-101 · 可配置 · GitHub 继承权限');
    await expect(row).toContainText('手工分配：无'); await expect(row).not.toContainText('看不到任何项目'); await expect(row).not.toContainText('other/project-201');
    await row.getByRole('button', { name: '修改仓库权限', exact: true }).click();
    const editor = page.locator('#editor'), picker = editor.getByLabel('仓库权限');
    await expect(editor).toContainText('已验证的 GitHub 继承权限仍然有效');
    expect(await picker.evaluate(select => [...select.selectedOptions].map(o => o.value))).toEqual([]);
    await picker.selectOption([]); await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(row).toContainText('fixture/project-101 · 可配置 · GitHub 继承权限');
    await page.screenshot({ path: resolve(output, 'user-effective-access-desktop.png'), fullPage: true });
    await f.admin('/api/project-admin-assignments', 'PUT', { user_id: principal, repository_ids: ['201'] });
    f.h.store.run("UPDATE scoped_grants SET expires_at=0 WHERE principal_id=? AND source='github_derived'", principal);
    await page.reload(); await expect(row).toContainText('GitHub 权限待验证');
    await expect(row).toContainText('other/project-201 · 可配置 · Bot 显式委派'); await expect(row).not.toContainText('fixture/project-101');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(output, 'user-effective-access-mobile.png'), fullPage: true });
    await f.admin('/api/project-admin-assignments', 'PUT', { user_id: principal, repository_ids: [] });
    await page.reload(); await expect(row).toContainText('当前没有可访问的项目'); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('已登录但没有仓库时可以去 GitHub 选择仓库，接入向导接口仍仅限超级管理员', async ({ page }) => {
  const f = await identityFixture();
  try {
    f.h.store.run("INSERT INTO settings VALUES('onboarding.app',?)", JSON.stringify({
      account_id: f.a.id, app_id: '123', slug: 'fixture-app',
      settings_url: 'https://github.com/settings/apps/fixture-app',
      webhook_url: 'https://hooks.invalid/secret-webhook',
      install_url: 'https://github.com/apps/fixture-app/installations/new',
    }));
    f.state.owner = false; f.state.admin = false; f.state.permission = 'write';
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.locator('#identity-panel')).toContainText('已登录 GitHub，但还没有授权任何仓库');
    const go = page.getByRole('link', { name: '去 GitHub 选择仓库', exact: true });
    await expect(go).toBeVisible();
    await expect(go).toHaveAttribute('href', 'https://github.com/apps/fixture-app/installations/new');
    await expect(go).toHaveAttribute('target', '_blank');
    await expect(go).toHaveAttribute('rel', /noopener/);
    const status = await page.evaluate(async () => (await fetch('/api/onboarding')).status);
    expect(status).toBe(403);
    expect((await f.admin('/api/onboarding')).status).toBe(200);
    mkdirSync('.tmp/ui-509', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(go).toBeInViewport();
    await page.screenshot({ path: '.tmp/ui-509/choose-repos-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(go).toBeInViewport();
    await page.screenshot({ path: '.tmp/ui-509/choose-repos-390.png', fullPage: true });
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
