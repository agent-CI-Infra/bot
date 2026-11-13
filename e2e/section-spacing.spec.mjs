import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #559: title / filter / content / paging and card stacks share one rhythm from the --space-* scale.
const out = resolve('.tmp/section-spacing-559');
const px = async (locator, prop) => locator.evaluate((el, p) => getComputedStyle(el)[p], prop);

test('#559 项目、身份、更多功能、基本设置的区块间距来自同一套 token，1440 与 390 可对照', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();

    const spaces = await page.evaluate(() => {
      const r = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return { 4: r('--space-4'), 5: r('--space-5'), 6: r('--space-6'), 7: r('--space-7'), 8: r('--space-8'), 10: r('--space-10') };
    });
    expect(spaces).toMatchObject({ 4: '12px', 5: '16px', 6: '20px', 7: '24px', 8: '32px', 10: '48px' });

    // management.css reserves 96px under the floating assistant; this PR does not change that.
    const toolbarPad = await page.locator('.list-panel .toolbar').evaluate(el => getComputedStyle(el).padding);
    expect(toolbarPad).toContain(spaces[6]);
    const filterPad = await page.locator('#filters').evaluate(el => getComputedStyle(el).padding);
    expect(filterPad).toContain(spaces[5]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: `${out}/projects-after-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/identity');
    await expect(page.locator('#identity-panel')).toBeVisible();
    const idGap = await page.locator('.identity-layout').evaluate(el => getComputedStyle(el).gap);
    expect(idGap).toBe(spaces[6]);
    await page.screenshot({ path: `${out}/identity-after-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    const groupsGap = await page.locator('.console-groups').evaluate(el => getComputedStyle(el).gap);
    const titleMargin = await page.locator('.console-group h2').first().evaluate(el => getComputedStyle(el).marginBottom);
    expect(groupsGap).toBe(spaces[6]);
    expect(titleMargin).toBe(spaces[5]);
    await page.screenshot({ path: `${out}/more-after-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/projects/101/basic');
    await expect(page.locator('.project-content')).toBeVisible({ timeout: 10000 });
    const contentGap = await page.locator('.project-content').evaluate(el => getComputedStyle(el).gap);
    const contentPad = await page.locator('.project-content').evaluate(el => getComputedStyle(el).padding);
    expect(contentGap).toBe(spaces[6]);
    expect(contentPad).toBe(spaces[6]);
    await page.screenshot({ path: `${out}/project-basic-after-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/projects-after-390.png`, fullPage: true });
    await page.goto(h.admin + '/#/identity');
    await expect(page.locator('#identity-panel')).toBeVisible();
    await page.screenshot({ path: `${out}/identity-after-390.png`, fullPage: true });
    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/more-after-390.png`, fullPage: true });
    await page.goto(h.admin + '/#/projects/101/basic');
    await expect(page.locator('.project-content')).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/project-basic-after-390.png`, fullPage: true });
  } finally { await h.stop(); }
});
