import { test, expect } from '@playwright/test';
import { harness, setup, account, testPassword } from '../../fixtures/helpers.mjs';

// #224-A: the sample page stays out of navigation, and a project administrator who
// opens #/design does not see it. The catalog itself is not a product surface.
test('#224-A 导航没有指向样例页的链接，项目管理员打开 #/design 看不到样例页', async ({ page, browser }) => {
  test.setTimeout(60000);
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h);
    await account(admin);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();

    await expect(page.locator('#tabs').getByRole('button', { name: '设计', exact: true })).toHaveCount(0);
    expect(await page.locator('a[href="#/design"]').count()).toBe(0);

    const memberPassword = testPassword();
    await admin('/api/users', 'POST', { username: 'member', password: memberPassword, role: 'project_admin', repository_ids: [] });
    const context = await browser.newContext(), member = await context.newPage();
    await member.goto(h.admin + '/#/design');
    await member.getByLabel('用户名', { exact: true }).fill('member');
    await member.getByLabel('密码', { exact: true }).fill(memberPassword);
    await member.getByRole('button', { name: '登录', exact: true }).click();
    await expect(member.locator('#design-page')).toBeHidden();
    await expect(member.locator('#tabs [aria-current=page]')).toHaveText('项目');
    await context.close();
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// #224-A made loading visible; #553 draws it with consoleState({ tone: 'loading' }) instead of ::after,
// so a held request shows the loading component (and not an empty-list message).
test('#224-A 列表加载中显示「正在加载列表」，加载完成后忙碌态解除', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness();
  try {
    const { admin, password } = await setup(h);
    await account(admin);
    // The projects list is served by /api/installations (the shell's own /api/repositories call happens earlier);
    // hold that one request so the loading state can be observed instead of raced.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/installations*', async route => { await held; return route.continue(); });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const rows = page.locator('#rows');
    await expect(rows).toHaveAttribute('aria-busy', 'true');
    await expect(rows.locator('[data-testid=console-state-loading]')).toBeVisible();
    await expect(rows.getByRole('heading', { name: '正在加载列表', exact: true })).toBeVisible();
    await expect(rows.locator('[data-testid=console-state-empty]')).toHaveCount(0);
    release();
    await expect(rows).not.toHaveAttribute('aria-busy', 'true');
    await expect(rows.locator('[data-testid=console-state-loading]')).toHaveCount(0);
    await expect(rows.getByRole('heading', { name: '还没有仓库', exact: true })).toBeVisible();
  } finally { await h.stop(); }
});
