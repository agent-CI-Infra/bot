import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

const out = '.tmp/admin-area-550';

async function login(page, h, username, password, hash = '#/more') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
}

function adminCaptions(page) {
  return page.getByTestId('console-admin-group').locator('a > span').allInnerTexts().then(rows => rows.map(t => t.trim()));
}

test('#550 管理区按角色可见：项目管理员看不到接入向导，超级管理员能从管理区到达', async ({ page, browser }) => {
  test.setTimeout(90000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const memberPassword = testPassword();
    expect((await admin('/api/users', 'POST', { username: 'admin-area-member', password: memberPassword, repository_ids: ['101'] })).status).toBe(201);

    // Super administrator: 管理 lists platform pages and opens 接入向导.
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h, 'administrator', password);
    await expect(page.getByRole('heading', { name: '管理', exact: true })).toBeVisible();
    expect(await adminCaptions(page)).toEqual([
      '用量与成本', 'Webhook 投递', '外部执行端', '存储', '接入向导', '安装档案', '机器人账号', '全局设置'
    ]);
    await page.getByTestId('console-admin-group').getByRole('link', { name: /^接入向导/ }).click();
    await expect(page).toHaveURL(/#\/settings\/onboarding/);
    await expect(page.locator('#onboarding-panel')).toBeVisible();
    await page.goto(h.admin + '/#/more');
    await page.screenshot({ path: `${out}/admin-super-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#console-mobile-nav').getByRole('link', { name: '更多', exact: true }).click();
    await expect(page.getByTestId('console-admin-group')).toBeVisible();
    expect(await adminCaptions(page)).toContain('接入向导');
    expect(await adminCaptions(page)).toContain('机器人账号');
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${out}/admin-super-390.png`, fullPage: true });

    // Project administrator: 管理 is limited, platform pages stay hidden, 存储 still opens.
    const context = await browser.newContext(), member = await context.newPage();
    try {
      await member.setViewportSize({ width: 1440, height: 900 });
      await login(member, h, 'admin-area-member', memberPassword);
      for (const name of ['统计', 'Webhook 投递', '存储', '全局设置']) {
        await expect(member.locator('#console-sidebar').getByRole('button', { name, exact: true })).toBeHidden();
      }
      expect(await adminCaptions(member)).toEqual(['用量与成本', 'Webhook 投递', '外部执行端', '存储']);
      for (const name of ['接入向导', '安装档案', '机器人账号', '全局设置']) {
        await expect(member.getByTestId('console-admin-group').getByRole('link', { name, exact: true })).toHaveCount(0);
        await expect(member.locator('#console-page')).not.toContainText(name);
      }
      await member.getByTestId('console-admin-group').getByRole('link', { name: /^存储/ }).click();
      await expect(member).toHaveURL(/#\/settings\/storage/);
      await expect(member.locator('#settings-panel')).toBeVisible();
      await member.goto(h.admin + '/#/more');
      await member.screenshot({ path: `${out}/admin-member-1440.png`, fullPage: true });

      await member.setViewportSize({ width: 390, height: 844 });
      await member.locator('#console-mobile-nav').getByRole('link', { name: '更多', exact: true }).click();
      await expect(member.getByTestId('console-admin-group')).toBeVisible();
      expect(await adminCaptions(member)).toEqual(['用量与成本', 'Webhook 投递', '外部执行端', '存储']);
      await expect(member.locator('#console-page')).not.toContainText('接入向导');
      await expect(member.locator('#console-page')).not.toContainText('全局设置');
      await expect(member.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
      await member.screenshot({ path: `${out}/admin-member-390.png`, fullPage: true });

      // Addresses still open (permissions unchanged).
      await member.goto(h.admin + '/#/events');
      await expect(member.getByText('本页', { exact: false })).toBeVisible();
    } finally { await context.close(); }
  } finally { await h.stop(); }
});
