import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { clickAccountMenuEntry, openAccountMenu } from '../helpers/console-navigation.mjs';

async function login(page, h, username, password, hash = '#/projects') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#rows .row')).toHaveCount(1);
}

// #550, #1369: the platform pages (系统初始化, 安装档案, 机器人账号) live under 全局设置, the one entry only a super
// administrator has: the desktop sidebar pins it and the phone's account menu carries it. 存储 is a personal page too.
test('#550 #1369 全局设置是超管唯一多出的入口：桌面侧栏与手机账号菜单都能进入，项目管理员都看不到', async ({ page, browser }) => {
  test.setTimeout(90000);
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const memberPassword = testPassword();
    expect((await admin('/api/users', 'POST', { username: 'admin-area-member', password: memberPassword, repository_ids: ['101'] })).status).toBe(201);

    // Super administrator: 全局设置 lists the platform pages and opens 系统初始化.
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h, 'administrator', password);
    await page.locator('.console-settings-nav').getByRole('link', { name: '全局设置', exact: true }).click();
    const platformNav = page.getByRole('navigation', { name: '全局设置类别' });
    for (const name of ['系统初始化', '安装档案', '机器人账号', '存储']) await expect(platformNav.getByRole('link', { name, exact: true })).toBeVisible();
    await platformNav.getByRole('link', { name: '系统初始化', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/onboarding/);
    await expect(page.locator('#onboarding-panel')).toBeVisible();
    // 个人设置 lists 存储 for a super administrator as well; it opens the same page, which stays under 全局设置.
    await page.locator('.console-settings-nav').getByRole('link', { name: '个人设置', exact: true }).click();
    await page.getByRole('navigation', { name: '个人设置类别' }).getByRole('link', { name: '存储', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/storage$/);
    await expect(page.locator('.console-settings-nav').getByRole('link', { name: '全局设置', exact: true })).toHaveAttribute('aria-current', 'page');

    // On the phone the account menu carries both settings entries.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects');
    await clickAccountMenuEntry(page, '全局设置', ['个人设置', '全局设置']);
    await expect(page).toHaveURL(/#\/settings\/work-computers$/);
    const picker = page.getByLabel('当前页面', { exact: true });
    await expect(picker).toBeVisible();
    for (const key of ['onboarding', 'installations', 'accounts']) await expect(picker.locator(`option[value="#/settings/${key}"]`)).toHaveCount(1);
    await picker.selectOption('#/settings/onboarding');
    await expect(page.locator('#onboarding-panel')).toBeVisible();
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);

    // Project administrator: no 全局设置 anywhere, and the platform pages stay closed.
    const context = await browser.newContext(), member = await context.newPage();
    try {
      await member.setViewportSize({ width: 1440, height: 900 });
      await login(member, h, 'admin-area-member', memberPassword);
      await expect(member.locator('.console-settings-nav a')).toHaveText(['个人设置']);
      await expect(member.locator('#console-sidebar').getByRole('link', { name: '全局设置', exact: true })).toHaveCount(0);
      await expect(member.locator('#console-sidebar').getByRole('button', { name: '仓库事件', exact: true })).toHaveCount(0);
      // A typed platform address falls back to the project list (the server refuses its reads anyway).
      await member.goto(h.admin + '/#/settings/onboarding');
      await expect(member.locator('#rows .row')).toHaveCount(1);
      await expect(member.locator('#onboarding-panel')).toBeHidden();
      await expect(member.locator('#settings-panel')).toBeHidden();

      await member.setViewportSize({ width: 390, height: 844 });
      await member.goto(h.admin + '/#/projects');
      await openAccountMenu(member, ['个人设置']);
      await expect(member.locator('#console-account-settings')).toBeHidden();
      await expect(member.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);

      // Remaining management addresses still open. #/events is not a page.
      await member.goto(h.admin + '/#/costs');
      await expect(member.getByRole('heading', { name: '用量与成本', exact: true })).toBeVisible();
      await member.goto(h.admin + '/#/events');
      const missing = member.locator('[data-page-not-found="console"]');
      await expect(missing).toBeVisible();
      await expect(missing.getByRole('heading', { name: '找不到这个页面', exact: true })).toBeVisible();
      await expect(member.locator('[data-delivery-record]')).toHaveCount(0);
      await expect(member.getByRole('button', { name: '查看详情', exact: true })).toHaveCount(0);
    } finally { await context.close(); }
  } finally { await h.stop(); }
});
