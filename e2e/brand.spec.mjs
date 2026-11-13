import { consoleNavigate } from './console-navigation.mjs';
import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup } from '../test/helpers.mjs';
import { externalFixture } from '../test/external-helpers.mjs';

// #218: the project has one visible name, launchpad. These assertions are the regression guard for the
// user-visible brand: a later copy change cannot quietly bring the old name back without a red CI.
const brand = 'launchpad';

test('浏览器标题与页头品牌在登录页和管理控制台都是 launchpad', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { password } = await setup(h);
    await page.goto(h.admin);
    await expect(page).toHaveTitle(brand + ' 管理');
    await expect(page.locator('header .brand strong')).toHaveText(brand);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    // The console route keeps the same title and brand; the name is not only on the login page.
    await expect(page).toHaveTitle(brand + ' 管理');
    await expect(page.locator('header .brand strong')).toHaveText(brand);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('外部执行端复制的接入说明用 launchpad 指代本项目', async ({ page, context }) => {
  const h = await externalFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const a = await h.client();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.adminBase });
    await page.goto(h.adminBase);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(h.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    await consoleNavigate(page, '外部执行端');
    const guide = page.locator('#external-panel .external-guide');
    await guide.locator(':scope > summary').click();
    await guide.getByRole('combobox', { name: '复制指令所用客户端', exact: true }).selectOption(a.client.id);
    await guide.getByRole('button', { name: '复制给我的 AI agent', exact: true }).click();
    await expect(guide.getByRole('status')).toHaveText('已复制接入指令');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(brand + ' 公钥接入');
    expect(copied).not.toContain('部门');
    expect(errors).toEqual([]);
  } finally {
    await h.stop(); await new Promise(resolve => h.github.server.close(resolve));
    rmSync(h.directory, { recursive: true, force: true });
  }
});
