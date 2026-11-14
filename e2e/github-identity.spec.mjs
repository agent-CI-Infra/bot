import { consoleNavigate } from './console-navigation.mjs';
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture, openIdentityAdvanced } from '../test/identity-fixture.mjs';

const output = resolve('.tmp/github-login-163');
test.beforeEach(async ({ page }) => {
  await page.route('https://avatars.githubusercontent.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#16636b"/></svg>' }));
});
test('GitHub 登录、组织切换、权限来源、撤销与本地恢复', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message)); mkdirSync(output, { recursive: true });
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await openIdentityAdvanced(page);
    await expect(page.getByRole('heading', { name: '当前角色与授权来源' })).toBeVisible();
    await expect(page.locator('#identity-panel')).toContainText('组织管理员');
    await expect(page.locator('#identity-panel')).toContainText('GitHub 当前权限（继承）');
    await expect(page.getByRole('button', { name: '全局设置', exact: true })).toBeHidden();
    const principal = f.h.store.get("SELECT principal_id FROM external_identities WHERE provider='github'").principal_id;
    await f.admin('/api/project-admin-assignments', 'PUT', { user_id: principal, repository_ids: ['101'] });
    await page.reload(); await openIdentityAdvanced(page); await expect(page.locator('#identity-panel')).toContainText('手动分配');
    await page.getByLabel('当前租户').selectOption('github.com:10');
    const switched = page.waitForResponse(r => r.url().includes('/api/identity') && r.request().method() === 'GET' && r.ok());
    await page.getByRole('button', { name: '切换组织' }).click();
    await switched;
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await openIdentityAdvanced(page);
    await expect(page.getByLabel('当前租户')).toHaveValue('github.com:10');
    const crossTenant = await page.evaluate(async () => (await fetch('/api/repositories/201')).status); expect(crossTenant).toBe(403);
    await page.screenshot({ path: resolve(output, 'permissions-desktop.png'), fullPage: true });
    f.state.owner = false; f.state.admin = false;
    await openIdentityAdvanced(page);
    const reverified = page.waitForResponse(r => r.url().includes('/api/identity') && r.request().method() === 'GET' && r.ok());
    await page.getByRole('button', { name: '重新验证 GitHub 权限' }).click();
    await reverified;
    await openIdentityAdvanced(page);
    await expect(page.locator('#identity-panel')).toContainText('已撤销');
    await expect(page.locator('#identity-panel')).toContainText('手动分配');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(output, 'revoked-mobile.png'), fullPage: true });
    page.on('dialog', dialog => dialog.accept());
    await openIdentityAdvanced(page);
    await page.getByRole('button', { name: '解除绑定', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click(); await consoleNavigate(page, '身份与权限');
    await openIdentityAdvanced(page);
    await expect(page.locator('#identity-panel')).toContainText('平台管理员');
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
      // #481: a phone header keeps one account control instead of the inline login text and sign-out button.
      await expect(page.locator('#console-account')).toBeVisible();
      await page.locator('#console-account').click();
      await expect(page.locator('#console-account-menu')).toContainText('@' + f.state.login);
      await expect(page.locator('#console-account-menu').getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
      await page.keyboard.press('Escape'); await expect(page.locator('#console-account-menu')).toBeHidden();
    }
    await page.screenshot({ path: resolve(output, 'profile-mobile.png'), fullPage: true });
    await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
    await page.reload(); await expect(who.locator('img')).toHaveCount(0); await expect(who).toContainText('@' + f.state.login);
    await page.locator('#console-account').click();
    await page.locator('#console-account-menu').getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(who).toHaveAttribute('title', 'administrator · 管理员');
    await expect(who.locator('.current-user-name')).toHaveText('administrator');
    await expect(who.locator('.current-user-role')).toHaveText('管理员');
    await expect(who.locator('img')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('绑定同一 GitHub 身份会显示冲突；本地会话可以完成新身份绑定', async ({ page }) => {
  const f = await identityFixture();
  try {
    await f.login(); await page.goto(f.h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click(); await consoleNavigate(page, '身份与权限');
    await openIdentityAdvanced(page);
    await page.getByRole('button', { name: '绑定 GitHub 账号', exact: true }).click();
    await expect(page.locator('#message')).toContainText('已绑定其他账号');
    f.state.id = 43;
    await openIdentityAdvanced(page);
    await page.getByRole('button', { name: '绑定 GitHub 账号', exact: true }).click();
    await expect(page.locator('#identity-panel')).toContainText('已验证');
    await expect(page.locator('#identity-panel')).toContainText('平台管理员');
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
    await expect(row).toContainText('当前可见项目（1）'); await expect(row).toContainText('fixture/project-101 · 可配置 · 来自 GitHub');
    await expect(row).toContainText('手工分配：无'); await expect(row).not.toContainText('看不到任何项目'); await expect(row).not.toContainText('other/project-201');
    await row.getByRole('button', { name: '修改仓库权限', exact: true }).click();
    const editor = page.locator('#editor'), picker = editor.getByLabel('仓库权限');
    await expect(editor).toContainText('已验证的 GitHub 继承权限仍然有效');
    expect(await picker.evaluate(select => [...select.selectedOptions].map(o => o.value))).toEqual([]);
    await picker.selectOption([]); await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(row).toContainText('fixture/project-101 · 可配置 · 来自 GitHub');
    await page.screenshot({ path: resolve(output, 'user-effective-access-desktop.png'), fullPage: true });
    await f.admin('/api/project-admin-assignments', 'PUT', { user_id: principal, repository_ids: ['201'] });
    f.h.store.run("UPDATE scoped_grants SET expires_at=0 WHERE principal_id=? AND source='github_derived'", principal);
    await page.reload(); await expect(row).toContainText('GitHub 权限待验证');
    await expect(row).toContainText('other/project-201 · 可配置 · 手动分配'); await expect(row).not.toContainText('fixture/project-101');
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
    await expect(go).toHaveAttribute('href', 'https://github.com/apps/fixture-app/installations/select_target');
    await expect(go).toHaveAttribute('rel', /noopener/);
    const [installRequest] = await Promise.all([
      page.waitForRequest(request => request.url().startsWith('https://github.com/apps/fixture-app/installations/select_target')),
      go.click(),
    ]);
    expect(new URL(installRequest.url()).searchParams.get('state')).toMatch(/^[a-f0-9]{48}$/);
    await page.goto(f.h.admin + '/#/identity');
    await expect(go).toBeVisible();
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

test('已安装但未启动的仓库写明待超级管理员启动，项目管理员可复制提醒，超级管理员在仓库列表直接启动', async ({ page, context }) => {
  const f = await identityFixture();
  try {
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    f.h.store.transaction(() => {
      f.h.store.run("DELETE FROM policies WHERE repository_id='101'");
      f.h.store.run("DELETE FROM identity_projects WHERE project_id='101'");
      f.h.store.run("DELETE FROM repositories WHERE id='101'");
    });
    const { mkdirSync } = await import('node:fs');
    mkdirSync('.tmp/ui-515', { recursive: true });
    const shot = async (name, width) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: `.tmp/ui-515/${name}-${width}.png`, fullPage: true });
    };
    await page.reload();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/identity');
    await expect(page.locator('#identity-panel')).toContainText('fixture/project-101');
    await expect(page.locator('#identity-panel')).toContainText('待超级管理员启动');
    await expect(page.locator('.identity-connection-status')).toContainText('已安装但还没有被超级管理员启动');
    await shot('identity-pending', 1440);
    await shot('identity-pending', 390);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '等待超级管理员启动' })).toBeVisible();
    const pendingRow = page.locator('.project-pending-row');
    await expect(pendingRow).toContainText('需要超级管理员在控制台启动后才能打开');
    await expect(pendingRow.locator('.status')).toHaveText('待超级管理员启动');
    await expect(page.locator('.project-pending-intro')).toHaveText('这些仓库已装好 GitHub App，启动后会出现在上面的项目列表里。');
    await expect(pendingRow.getByRole('button', { name: '去启动' })).toHaveCount(0);
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    await expect(page.getByRole('heading', { name: '已登录，尚无可管理的项目' })).toHaveCount(0);
    await expect(page.locator('#count')).toContainText('0 个项目，1 个待超级管理员启动');
    await expect(page.locator('.project-pending-group').getByRole('link', { name: '项目总览' })).toHaveCount(0);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await pendingRow.getByRole('button', { name: '复制提醒' }).click();
    await expect(pendingRow.getByRole('button', { name: '已复制' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`请在 LaunchPad 控制台启动仓库 fixture/project-101：${new URL(f.h.admin).origin}${new URL(f.h.admin).pathname}#/projects`);
    await shot('projects-pending', 1440);
    await shot('projects-pending', 390);
    // Narrow: the repository name keeps its own line width; the button sits under it and never overlaps it.
    const name = await pendingRow.locator('strong').boundingBox(), action = await pendingRow.getByRole('button', { name: '已复制' }).boundingBox();
    expect(name.width).toBeGreaterThan(150);
    expect(action.y).toBeGreaterThanOrEqual(name.y + name.height);
    // A super administrator's project list is the installed list: the same repository carries 启动, which only opens the dialog.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const installedRow = page.locator('#rows .row', { hasText: 'fixture/project-101' });
    await expect(installedRow.getByRole('button', { name: '启动', exact: true })).toBeVisible();
    await expect(page.locator('.project-pending-group')).toHaveCount(0);
    await installedRow.getByRole('button', { name: '启动', exact: true }).click();
    await expect(page.locator('#activation-title')).toHaveText('启动 fixture/project-101');
  } finally { await f.close(); }
});

test('身份页概览在 1440 与 390 下完整可见，展开的高级区占满整行', async ({ page }) => {
  const f = await identityFixture();
  const { mkdirSync } = await import('node:fs');
  try {
    mkdirSync('.tmp/ui-514', { recursive: true });
    const shot = async (name) => {
      const advanced = page.locator('.identity-advanced');
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(advanced).not.toHaveAttribute('open', '');
      await page.screenshot({ path: `.tmp/ui-514/${name}-collapsed-1440.png`, fullPage: true });
      await openIdentityAdvanced(page);
      const widths = await page.evaluate(() => {
        const overview = document.querySelector('.identity-overview');
        const adv = document.querySelector('.identity-advanced');
        return { overview: Math.round(overview.getBoundingClientRect().width), advanced: Math.round(adv.getBoundingClientRect().width) };
      });
      expect(Math.abs(widths.overview - widths.advanced)).toBeLessThan(2);
      await page.screenshot({ path: `.tmp/ui-514/${name}-expanded-1440.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: `.tmp/ui-514/${name}-expanded-390.png`, fullPage: true });
      await advanced.locator(':scope > summary').click();
      await expect(advanced).not.toHaveAttribute('open', '');
      await page.screenshot({ path: `.tmp/ui-514/${name}-collapsed-390.png`, fullPage: true });
    };

    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await expect(page.locator('.identity-connection-status')).toContainText('已连接 GitHub');
    await shot('connected');

    const identity = f.h.store.get("SELECT id, principal_id FROM external_identities WHERE provider='github'");
    f.h.store.run("UPDATE external_identities SET status='pending_verification' WHERE id=?", identity.id);
    await page.reload();
    await expect(page.locator('.identity-connection-status')).toContainText('待验证');
    await expect(page.getByRole('button', { name: '重新验证 GitHub 权限', exact: true })).toBeVisible();
    await shot('pending');

    f.h.store.run("UPDATE external_identities SET status='active' WHERE id=?", identity.id);
    f.h.store.run("INSERT OR REPLACE INTO settings VALUES('onboarding.app',?)", JSON.stringify({
      account_id: f.a.id, app_id: '123', slug: 'fixture-app',
      install_url: 'https://github.com/apps/fixture-app/installations/select_target',
    }));
    f.state.owner = false; f.state.admin = false; f.state.permission = 'write';
    await f.identity.reverify(identity.principal_id);
    await page.reload();
    await expect(page.locator('.identity-connection-status')).toContainText('还没有授权任何仓库');
    await expect(page.getByRole('link', { name: '去 GitHub 选择仓库', exact: true })).toBeVisible();
    await shot('no-repos');
  } finally { await f.close(); }
});

test('会话限定在别的组织时，身份页不再说「可在项目列表中打开」，一键切回后项目列表能看到仓库', async ({ page }) => {
  const f = await identityFixture(), output = '.tmp/ui-identity-scope';
  mkdirSync(output, { recursive: true });
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.locator('.identity-connection-status')).toContainText('已连接 GitHub，可访问 1 个仓库');
    f.h.store.run("INSERT OR IGNORE INTO tenants(id,github_host,github_account_id,display_name) VALUES('github.com:30','github.com','30','elsewhere')");
    f.h.store.run("UPDATE sessions SET tenant_id='github.com:30'");
    await page.goto(f.h.admin + '/#/projects'); await page.reload();
    await expect(page.locator('#count')).toHaveText('0 个项目');
    await page.goto(f.h.admin + '/#/identity');
    const status = page.locator('.identity-connection-status');
    await expect(status).toHaveText('已连接 GitHub，但当前组织下没有你能打开的项目');
    await expect(page.locator('#identity-panel')).toContainText('1 个仓库不在当前组织「elsewhere」里');
    await expect(page.locator('#identity-panel')).not.toContainText('可在项目列表中打开这些仓库');
    const widen = page.getByRole('button', { name: '切换到所有已授权组织', exact: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await expect(widen).toBeVisible();
      await page.screenshot({ path: `${output}/identity-outside-tenant-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // English keeps the hidden count and the organization name, which travel as fields rather than inside next_step.
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(status).toHaveText('Connected to GitHub, but there are no projects you can open in the current organization');
    await expect(page.locator('#identity-panel')).toContainText('The 1 repositories you can access are not in the current organization "elsewhere".');
    await expect(page.getByRole('button', { name: 'Switch to all authorized organizations', exact: true })).toBeVisible();
    await expect(page.locator('#identity-panel')).not.toContainText(/identity\.(github|switch_all_tenants)/);
    await page.getByRole('button', { name: '中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await widen.click();
    await expect(page.locator('.identity-connection-status')).toHaveText('已连接 GitHub，可访问 1 个仓库');
    expect(f.h.store.get('SELECT tenant_id FROM sessions ORDER BY rowid DESC LIMIT 1').tenant_id).toBe(null);
    await page.goto(f.h.admin + '/#/projects');
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
