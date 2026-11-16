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
    // The header updates before start() finishes routing, which closes any account menu opened in that gap.
    await expect.poll(() => page.evaluate(() => announcedPage)).toBe('page:identity');
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
    await expect.poll(() => page.evaluate(() => announcedPage)).toBe('page:identity');
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
    const row = page.locator('#settings-panel .users-table tbody tr').filter({ has: page.getByText('@administrator', { exact: true }) });
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
    f.state.owner = false; f.state.admin = false; f.state.permission = 'none';
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

test('已安装但未启动的仓库写明启动需超级管理员同意，项目管理员从「开始接入」进入接入向导，超级管理员在仓库列表也可直接启动', async ({ page }) => {
  const f = await identityFixture();
  try {
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    f.h.store.transaction(() => {
      f.h.store.run("DELETE FROM policies WHERE repository_id='101'");
      // A started project has Actions failure handling on (#851).
      f.h.store.run("DELETE FROM actions_failure_scans WHERE repository_id='101'");
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
    await expect(page.locator('#identity-panel')).toContainText('启动需超级管理员同意');
    await expect(page.locator('.identity-connection-status')).toContainText('已安装但还没有被超级管理员启动');
    await expect(page.locator('.identity-pending-repos').getByRole('link', { name: '开始接入 fixture/project-101' })).toHaveAttribute('href', '#/onboarding/101');
    await shot('identity-pending', 1440);
    await shot('identity-pending', 390);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '待接入的仓库' })).toBeVisible();
    const pendingRow = page.locator('.project-pending-row');
    await expect(pendingRow.locator('p')).toHaveCount(0);
    await expect(pendingRow.locator('.status')).toHaveText('启动需超级管理员同意');
    await expect(page.locator('.project-pending-intro')).toHaveText('这些仓库已装好 GitHub App。点「开始接入」，助手先只读分析仓库、问几个问题并给出方案；你确认后启动，所属组织未受信任的由超级管理员同意后启动。启动后它们出现在上面的项目列表里。');
    await expect(pendingRow.getByRole('button', { name: '去启动' })).toHaveCount(0);
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    await expect(page.getByRole('heading', { name: '已登录，尚无可管理的项目' })).toHaveCount(0);
    await expect(page.locator('#count')).toContainText('0 个项目，1 个待接入');
    await expect(page.locator('.project-pending-group').getByRole('link', { name: '项目总览' })).toHaveCount(0);
    const entry = pendingRow.getByRole('link', { name: '开始接入 fixture/project-101' });
    await expect(entry).toHaveAttribute('href', '#/onboarding/101');
    await expect(pendingRow.getByRole('button')).toHaveCount(0);
    await shot('projects-pending', 1440);
    await shot('projects-pending', 390);
    // Narrow: the repository name keeps its own line width; the entry sits under it and never overlaps it.
    const name = await pendingRow.locator('strong').boundingBox(), action = await entry.boundingBox();
    expect(name.width).toBeGreaterThan(150);
    expect(action.y).toBeGreaterThanOrEqual(name.y + name.height);
    // A super administrator's project list is the installed list: the same repository carries 开始接入 and 启动, which only opens the dialog.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const installedRow = page.locator('#rows .row', { hasText: 'fixture/project-101' });
    await expect(installedRow.getByRole('button', { name: '启动', exact: true })).toBeVisible();
    await expect(installedRow.getByRole('link', { name: /^开始接入/ })).toHaveAttribute('href', '#/onboarding/101');
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
    f.state.owner = false; f.state.admin = false; f.state.permission = 'none';
    await f.identity.reverify(identity.principal_id);
    await page.reload();
    await expect(page.locator('.identity-connection-status')).toContainText('还没有授权任何仓库');
    await expect(page.getByRole('link', { name: '去 GitHub 选择仓库', exact: true })).toBeVisible();
    await shot('no-repos');
  } finally { await f.close(); }
});

test('身份页同时列出已启动的项目和待启动仓库，两句话不会混在一起', async ({ page }) => {
  const f = await identityFixture();
  try {
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.locator('.identity-overview')).toBeVisible();
    const owner = f.h.store.get("SELECT owner_id FROM installation_repositories WHERE repository_id='101'")?.owner_id || '10';
    f.h.store.run("UPDATE repositories SET full_name='open-x-agents/Douya' WHERE id='101'");
    f.h.store.run("UPDATE installation_repositories SET full_name='open-x-agents/Douya' WHERE repository_id='101'");
    f.h.store.run(`INSERT OR REPLACE INTO installation_repositories VALUES('github.com/123/77','102','ThinkFlowLab/FlyBot',?,?,1,1,?)`,
      owner, 'ThinkFlowLab', new Date().toISOString());
    await page.goto(f.h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await page.goto(f.h.admin + '/#/identity');
    await expect(page.locator('.identity-connection-status')).toHaveText('已连接 GitHub，可访问 1 个仓库');
    await expect(page.locator('#identity-panel')).toContainText('可在项目列表中打开这些仓库。');
    const openable = page.locator('.identity-openable-repos a');
    await expect(openable).toHaveText('open-x-agents/Douya');
    await expect(openable).toHaveAttribute('href', '#/projects/101/overview');
    await expect(page.locator('#identity-panel')).toContainText('另有 1 个仓库已安装，等待超级管理员启动');
    const pending = page.locator('.identity-pending-repos li');
    await expect(pending).toContainText('ThinkFlowLab/FlyBot');
    await expect(pending.locator('.status')).toHaveText('启动需超级管理员同意');
    await expect(pending.getByRole('link', { name: '开始接入 ThinkFlowLab/FlyBot' })).toBeVisible();
    await expect(page.locator('.identity-openable-repos')).not.toContainText('启动需超级管理员同意');
    mkdirSync('.tmp/ui-825', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: `.tmp/ui-825/identity-openable-${width}.png`, fullPage: true });
    }
    await openable.click();
    await expect(page).toHaveURL(/#\/projects\/101\/overview/);
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

// #979: dozens of installed-but-not-started repositories fold behind one count line on the project list and identity
// page; a long list filters by name, and the fold opens from the keyboard.
test('待启动仓库很多时项目列表和身份页默认折叠，可按名称查找', async ({ page }) => {
  const f = await identityFixture();
  try {
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    f.h.store.transaction(() => {
      f.h.store.run("DELETE FROM policies WHERE repository_id='101'");
      f.h.store.run("DELETE FROM actions_failure_scans WHERE repository_id='101'");
      f.h.store.run("DELETE FROM identity_projects WHERE project_id='101'");
      f.h.store.run("DELETE FROM repositories WHERE id='101'");
    });
    // The fixture installs one repository; the reader's identity answer is widened to many to show the long list.
    await page.route('**/api/identity', async route => {
      const response = await route.fetch(), body = await response.json();
      const extra = Array.from({ length: 14 }, (_, i) => ({ id: String(9000 + i), full_name: `fixture/waiting-${String(i).padStart(2, '0')}` }));
      body.github_connection.pending_repositories = [...(body.github_connection.pending_repositories || []), ...extra];
      await route.fulfill({ response, json: body });
    });
    mkdirSync('.tmp/ui-979', { recursive: true });
    // 1440 is the repository evidence width; 1280 is named in #979 and is the project-table breakpoint; 390 is the narrow width.
    for (const width of [1440, 1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      // A reload starts a fresh page: the fold remembers its state only within one page session.
      await page.goto(f.h.admin + '/#/projects'); await page.reload();
      await expect(page.getByRole('heading', { name: '待接入的仓库' })).toBeVisible();
      await expect(page.locator('#count')).toContainText('0 个项目，15 个待接入');
      const fold = page.locator('#rows [data-testid=pending-repo-fold]');
      await expect(fold.locator('summary')).toHaveText('查看 15 个待接入仓库');
      await expect(fold.locator('.project-pending-row').first()).toBeHidden();
      await expect(page.locator('.project-pending-intro')).toHaveText('这些仓库已装好 GitHub App。点「开始接入」，助手先只读分析仓库、问几个问题并给出方案；你确认后启动，所属组织未受信任的由超级管理员同意后启动。启动后它们出现在上面的项目列表里。');
      if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: `.tmp/ui-979/projects-folded-${width}.png`, fullPage: true });
      await fold.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(fold.locator('.project-pending-row')).toHaveCount(15);
      await expect(fold.locator('.project-pending-row').first()).toBeVisible();
      const search = fold.getByLabel('按名称查找');
      await search.fill('waiting-1');
      await expect(fold.locator('.project-pending-row:visible')).toHaveCount(4);
      await page.screenshot({ path: `.tmp/ui-979/projects-search-${width}.png`, fullPage: true });
      await search.fill('nope');
      await expect(fold.locator('.project-pending-row:visible')).toHaveCount(0);
      await expect(fold.getByRole('status')).toHaveText('没有名称包含「nope」的待接入仓库');
      await search.fill('');
      await expect(fold.locator('.project-pending-row:visible')).toHaveCount(15);
      if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

      await page.goto(f.h.admin + '/#/identity');
      const identityFold = page.locator('#identity-panel [data-testid=pending-repo-fold]');
      await expect(identityFold.locator('summary')).toHaveText('查看 15 个待接入仓库');
      await expect(identityFold.locator('.identity-pending-repos li').first()).toBeHidden();
      await expect(page.locator('.identity-connection-status')).toContainText('已安装但还没有被超级管理员启动');
      if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: `.tmp/ui-979/identity-folded-${width}.png`, fullPage: true });
      await identityFold.locator('summary').click();
      await identityFold.getByLabel('按名称查找').fill('waiting-13');
      await expect(identityFold.locator('.identity-pending-repos li:visible')).toHaveCount(1);
      await expect(identityFold.locator('.identity-pending-repos li:visible')).toContainText('fixture/waiting-13');
      await page.screenshot({ path: `.tmp/ui-979/identity-search-${width}.png`, fullPage: true });
    }

    // #980 review B1: also capture the trusted-organization variant, where some pending rows are marked 可自行启动.
    await page.unroute('**/api/identity');
    await page.route('**/api/identity', async route => {
      const response = await route.fetch(), body = await response.json();
      const fixturePending = (body.github_connection.pending_repositories || []).map(repo => ({ ...repo, self_start: true }));
      const extra = Array.from({ length: 14 }, (_, i) => ({
        id: String(9000 + i),
        full_name: `fixture/waiting-${String(i).padStart(2, '0')}`,
        self_start: i < 8,
      }));
      body.github_connection.pending_repositories = [...fixturePending, ...extra];
      await route.fulfill({ response, json: body });
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(f.h.admin + '/#/projects'); await page.reload();
      await expect(page.getByRole('heading', { name: '待接入的仓库' })).toBeVisible();
      await expect(page.locator('#count')).toContainText('0 个项目，15 个待接入');
      const fold = page.locator('#rows [data-testid=pending-repo-fold]');
      await expect(fold.locator('summary')).toHaveText('查看 15 个待接入仓库');
      await expect(page.locator('.project-pending-intro')).toHaveText('这些仓库已装好 GitHub App。点「开始接入」，助手先只读分析仓库、问几个问题并给出方案；你确认后启动，所属组织未受信任的由超级管理员同意后启动。启动后它们出现在上面的项目列表里。');
      if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: `.tmp/ui-979/projects-self-start-folded-${width}.png`, fullPage: true });
      await fold.locator('summary').click();
      await expect(page.locator('[data-key="pending:9000"]')).toContainText('可自行启动');
      await expect(page.locator('[data-key="pending:9000"]').getByRole('link', { name: '开始接入 fixture/waiting-00' })).toBeVisible();
      await expect(page.locator('[data-key="pending:9008"]')).toContainText('启动需超级管理员同意');
      await expect(page.locator('[data-key="pending:9008"]').getByRole('link', { name: '开始接入 fixture/waiting-08' })).toBeVisible();
      if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: `.tmp/ui-979/projects-self-start-${width}.png`, fullPage: true });

      await page.goto(f.h.admin + '/#/identity');
      const identityFold = page.locator('#identity-panel [data-testid=pending-repo-fold]');
      await expect(identityFold.locator('summary')).toHaveText('查看 15 个待接入仓库');
      await identityFold.locator('summary').click();
      await expect(identityFold.locator('.identity-pending-repos').getByText('可自行启动').first()).toBeVisible();
      await expect(identityFold.locator('.identity-pending-repos').getByText('启动需超级管理员同意').first()).toBeVisible();
      if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: `.tmp/ui-979/identity-self-start-${width}.png`, fullPage: true });
    }
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
