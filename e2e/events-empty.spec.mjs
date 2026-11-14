import { consoleNavigate } from './console-navigation.mjs';
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

// #523: an empty Webhook 投递 page explains likely causes and offers a next step,
// instead of the generic 「暂无记录」 placeholder.
test('Webhook 投递空状态说明原因并给出下一步', async ({ page }) => {
  const h = await harness();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h);
    await page.goto(h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await consoleNavigate(page, 'Webhook 投递');
    await expect(page.getByText('本页 0 条投递')).toBeVisible();

    const empty = page.locator('#rows .console-state');
    await expect(empty.getByRole('heading', { name: '还没有 Webhook 投递', exact: true })).toBeVisible();
    await expect(empty).toContainText('Webhook 还没指向本部署');
    await expect(empty).toContainText('验签失败或尚未启动的仓库仍会作为投递出现在本页');
    await expect(empty).not.toContainText('还没被超级管理员启动，事件不会在这里形成任务');
    await expect(empty.getByRole('link', { name: '打开接入向导' })).toHaveAttribute('href', '#/settings/onboarding');
    await expect(empty.getByRole('link', { name: '查看机器人账号' })).toHaveAttribute('href', '#/settings/accounts');
    expect(await page.locator('#rows').evaluate(el => getComputedStyle(el, '::after').content)).not.toContain('暂无记录');

    mkdirSync('.tmp/ui-523', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: '.tmp/ui-523/unfiltered-empty-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/ui-523/unfiltered-empty-390.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    await empty.getByRole('link', { name: '打开接入向导' }).click();
    await expect(page).toHaveURL(/#\/settings\/onboarding/);

    await page.goto(h.admin + '/#/events');
    await expect(empty.getByRole('heading', { name: '还没有 Webhook 投递', exact: true })).toBeVisible();
    const filtersFold = page.getByTestId('project-filters-fold');
    await expect(filtersFold).toBeVisible();
    await filtersFold.locator('summary').click();
    await page.locator('#owner-filter').fill('99999');
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expect(page.getByText('本页 0 条投递')).toBeVisible();
    await expect(empty.getByRole('heading', { name: '当前筛选下没有投递', exact: true })).toBeVisible();
    await expect(empty).toContainText('这个仓库、账号或组织范围内还没有投递记录');
    await page.screenshot({ path: '.tmp/ui-523/filtered-empty-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/ui-523/filtered-empty-390.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(empty.getByRole('heading', { name: '还没有 Webhook 投递', exact: true })).toBeVisible();
    await expect(page.locator('#owner-filter')).toHaveValue('');

    const a = await account(admin);
    await repository(admin, a.id, '101');
    await h.hook(a.path, a.secret, 'empty-page-delivery', { repository: { id: 101, full_name: 'fixture/project-101' }, action: 'opened', issue: { number: 1 } });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByText('本页 1 条投递')).toBeVisible();
    await expect(page.locator('#rows .console-state')).toHaveCount(0);
    await expect(page.locator('#rows [data-delivery-record]')).toHaveCount(1);
    await expect(page.locator('#rows')).toContainText('empty-page-delivery');
    await page.screenshot({ path: '.tmp/ui-523/with-delivery-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/ui-523/with-delivery-390.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    await repository(admin, a.id, '202');
    const memberPassword = testPassword();
    await admin('/api/users', 'POST', { username: 'empty-admin', password: memberPassword, repository_ids: ['202'] });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('用户名', { exact: true }).fill('empty-admin');
    await page.getByLabel('密码', { exact: true }).fill(memberPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await consoleNavigate(page, 'Webhook 投递');
    await expect(page.getByText('本页 0 条投递')).toBeVisible();
    const memberEmpty = page.locator('#rows .console-state');
    await expect(memberEmpty.getByRole('heading', { name: '还没有 Webhook 投递', exact: true })).toBeVisible();
    await expect(memberEmpty).toContainText('Webhook 还没指向本部署');
    await expect(memberEmpty).toContainText('还没被超级管理员启动');
    await expect(memberEmpty.getByRole('link', { name: '查看身份与权限' })).toHaveAttribute('href', '#/identity');
    await expect(memberEmpty).toContainText('联系管理员');
    await expect(memberEmpty.getByRole('link', { name: '打开接入向导' })).toHaveCount(0);
    await expect(memberEmpty.getByRole('link', { name: '查看机器人账号' })).toHaveCount(0);
    await memberEmpty.getByRole('link', { name: '查看身份与权限' }).click();
    await expect(page).toHaveURL(/#\/identity/);
    expect(errors).toEqual([]);
  } finally {
    await h.stop();
    rmSync(h.directory, { recursive: true, force: true });
  }
});
