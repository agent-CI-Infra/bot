import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup } from '../test/helpers.mjs';

// #554: workspace navigation uses one linear SVG set; glyphs ⌂▤◷⋯ are gone,
// and every entry keeps its visible text as the accessible name.
const out = resolve('.tmp/console-icons-554');
const glyphs = /[⌂▤◷⋯]/;

test('#554 侧栏与移动端底栏使用线性图标，1440 与 390 可识别且无横向溢出', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();

    const sidebar = page.locator('#console-sidebar');
    await expect(sidebar.getByRole('button', { name: '项目', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '管理对话', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '看板', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '统计', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Webhook 投递', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('link', { name: '待处理', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '个人设置', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '全局设置', exact: true }).locator('svg.console-icon')).toBeVisible();
    const sidebarText = await sidebar.innerText();
    expect(sidebarText).not.toMatch(glyphs);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: `${out}/projects-icons-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    const moreLinks = page.locator('.console-groups .console-link-with-icon');
    expect(await moreLinks.count()).toBeGreaterThan(4);
    expect(await moreLinks.locator('svg.console-icon').count()).toBe(await moreLinks.count());
    await page.screenshot({ path: `${out}/more-icons-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    const mobile = page.locator('#console-mobile-nav');
    await expect(mobile).toBeVisible();
    for (const name of ['总览', '任务', '待处理', '更多']) {
      const item = mobile.getByRole('link', { name, exact: true });
      await expect(item).toBeVisible();
      await expect(item.locator('svg.console-icon')).toBeVisible();
    }
    expect(await mobile.innerText()).not.toMatch(glyphs);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/projects-icons-390.png`, fullPage: true });

    await mobile.getByRole('link', { name: '更多', exact: true }).click();
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    expect(await page.locator('.console-groups .console-link-with-icon svg.console-icon').count()).toBeGreaterThan(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/more-icons-390.png`, fullPage: true });
  } finally { await h.stop(); }
});
