import { test, expect } from '@playwright/test';
import { harness, setup } from '../../fixtures/helpers.mjs';

// #558: projects, identity, usage and login each show one visible h1.
// The identity page's context is 「个人设置」 and does not repeat the title.
const loginAndOpen = async (page, h, password, hash) => {
  await page.goto(h.admin + '/');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
  await page.goto(h.admin + '/' + hash);
};

test('#558 项目、身份、用量、登录各只有一个可见 h1，身份页上下文是个人设置', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness();
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginAndOpen(page, h, password, '#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    expect(await page.locator('h1:visible').count()).toBe(1);

    await page.goto(h.admin + '/#/identity');
    await expect(page.getByRole('heading', { name: '身份与权限', exact: true })).toBeVisible();
    expect(await page.getByRole('heading', { name: '身份与权限', exact: true }).count()).toBe(1);
    await expect(page.locator('#console-area')).toHaveText('个人设置');
    await expect(page.locator('#console-context')).toHaveText('');
    expect(await page.locator('h1:visible').count()).toBe(1);

    await page.goto(h.admin + '/#/costs');
    await expect(page.getByRole('heading', { name: '用量与成本', exact: true })).toBeVisible();
    expect(await page.locator('h1:visible').count()).toBe(1);

    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect(await page.locator('#access h1:visible').count()).toBe(1);
  } finally { await h.stop(); }
});
