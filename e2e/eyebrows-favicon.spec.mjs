import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #525: user-facing eyebrows are Chinese complete phrases; the site icon is served.
test('控制台眉题为中文，站点图标可访问', async ({ page }) => {
  const h = await harness();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');

    const ico = await page.request.get(h.admin + '/favicon.ico');
    expect(ico.status()).toBe(200);
    expect(ico.headers()['content-type']).toMatch(/^image\//);
    expect((await ico.body())[0]).toBe(0);

    const svg = await page.request.get(h.admin + '/favicon.svg');
    expect(svg.status()).toBe(200);
    expect(await svg.text()).toContain('launchpad');

    await page.goto(h.admin);
    await expect(page.locator('link[rel="icon"][href="/favicon.svg"]')).toHaveCount(1);
    await expect(page.locator('link[rel="icon"][href="/favicon.ico"]')).toHaveCount(1);

    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();

    mkdirSync('.tmp/ui-525', { recursive: true });
    async function shot(name) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: `.tmp/ui-525/${name}-desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 600, height: 900 });
      await page.screenshot({ path: `.tmp/ui-525/${name}-600.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    await page.goto(h.admin + '/#/inbox');
    await expect(page.getByRole('heading', { name: '待处理', exact: true })).toBeVisible();
    await expect(page.locator('.console-page-head .eyebrow')).toHaveText('需要关注');
    await shot('inbox');

    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    await expect(page.locator('.console-page-head .eyebrow')).toHaveText('工作区');
    await shot('more');

    await page.goto(h.admin + '/#/projects/101/overview');
    await expect(page.getByRole('heading', { name: '项目总览', exact: true })).toBeVisible();
    await expect(page.locator('#project-page .eyebrow')).toHaveText('总览');
    await shot('overview');

    await page.goto(h.admin + '/#/new-task/101');
    await expect(page.getByRole('heading', { name: '新建任务', exact: true })).toBeVisible();
    await expect(page.locator('.task-create-page .eyebrow')).toHaveText('新任务');
    await shot('new-task');

    expect(errors).toEqual([]);
  } finally {
    await h.stop();
    rmSync(h.directory, { recursive: true, force: true });
  }
});
