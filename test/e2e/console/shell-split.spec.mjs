import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

const out = '.tmp/shell-split';

async function login(page, h, password) {
  await page.goto(h.admin + '/#/projects');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
}

async function unifiedHeader(page) {
  const header = page.locator('#console-project-header');
  await expect(header).toBeVisible();
  await expect(page.locator('#main-content #console-location')).toHaveCount(0);
  expect(await page.locator('#console-permission').evaluate(node => node.closest('header') !== null)).toBe(true);
  await expect(page.locator('body > header #locale-switch')).toBeVisible();
  await expect(page.locator('body > header #identity')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function desktopFrame(page, height = 900) {
  const sidebar = await page.locator('#console-sidebar').boundingBox();
  const header = await page.locator('body > header').boundingBox();
  const rail = await page.locator('#console-sidebar').evaluate(node => node.getBoundingClientRect().width);
  expect(sidebar.y).toBe(0);
  expect(Math.round(sidebar.height)).toBe(height);
  expect(Math.abs(header.x - rail)).toBeLessThanOrEqual(1);
  const bodyWidth = await page.locator('body').evaluate(node => node.clientWidth);
  expect(Math.round(header.width)).toBe(Math.round(bodyWidth - rail));
  await expect.poll(async () => (await page.locator('body > header').boundingBox()).height).toBeLessThanOrEqual(100);
  await expect(page.locator('body > header')).toHaveCSS('position', 'sticky');
  await expect(page.locator('body > header > .brand')).toBeHidden();
  await expect(page.locator('#console-sidebar > .console-sidebar-brand')).toBeVisible();
  await unifiedHeader(page);
}

test('desktop keeps one sticky header over the workspace beside a full-height rail', async ({ page }) => {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    h.store.run('UPDATE installed_repositories SET permissions=? WHERE repository_id=?', JSON.stringify({ pull: true }), '101');
    mkdirSync(out, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h, password);
    await page.goto(h.admin + '/#/projects/101/board');
    await expect(page.locator('#board-panel')).toBeVisible();
    await expect(page.locator('#console-context')).toHaveText('fixture / project-101 / 任务看板');
    await expect(page.locator('#console-project-header [data-permission]')).toBeVisible();
    await desktopFrame(page);
    await page.screenshot({ path: `${out}/board-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/projects/101/basic');
    await expect(page.locator('#console-project-header .project-head h1')).toHaveText('基本设置');
    await expect(page.locator('#console-location')).toBeVisible();
    await expect(page.locator('#console-context')).toHaveText('fixture / project-101 / 基本设置');
    await expect(page.locator('#console-project-header [data-permission]')).toBeVisible();
    await expect(page.locator('#project-page > .project-head')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '项目设置类别' })).toBeVisible();
    await desktopFrame(page);
    await page.screenshot({ path: `${out}/basic-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 1440, height: 600 });
    await page.evaluate(() => scrollTo(0, 500));
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await expect(page.locator('body > header')).toHaveCSS('top', '0px');
    expect((await page.locator('body > header').boundingBox()).y).toBe(0);
    await page.evaluate(() => scrollTo(0, 0));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/101/overview');
    await expect(page.locator('.workspace-overview')).toBeVisible();
    await expect(page.locator('#console-location')).toBeHidden();
    await expect(page.locator('#console-project-header .workbench-tabs')).toBeVisible();
    await desktopFrame(page);
    await page.screenshot({ path: `${out}/overview-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 1440, height: 360 });
    await page.goto(h.admin + '/#/settings/users');
    await expect(page.locator('#settings-panel')).toBeVisible();
    const rail = await page.locator('#console-sidebar').boundingBox();
    expect(rail.y).toBe(0);
    expect(Math.round(rail.height)).toBe(360);
    await expect(page.locator('#console-sidebar')).toHaveCSS('overflow-y', 'auto');
    expect(await page.locator('.console-primary-nav').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  } finally { await h.stop(); }
});

test('mobile keeps the header fixed and navigation reachable without a second location bar', async ({ page }) => {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    h.store.run('UPDATE installed_repositories SET permissions=? WHERE repository_id=?', JSON.stringify({ pull: true }), '101');
    mkdirSync(out, { recursive: true });
    await login(page, h, password);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(h.admin + '/#/projects/101/board');
      await expect(page.locator('#board-panel')).toBeVisible();
      await expect(page.locator('#console-context')).toHaveText('fixture / project-101 / 任务看板');
      await expect(page.locator('#console-project-header [data-permission]')).toBeVisible();
      await unifiedHeader(page);
      await expect(page.locator('#console-sidebar')).toBeHidden();
      await expect(page.locator('#console-mobile-nav')).toBeVisible();
      await page.screenshot({ path: `${out}/board-${width}.png`, fullPage: true });

      await page.goto(h.admin + '/#/projects/101/basic');
      await expect(page.locator('#console-project-header .project-head h1')).toHaveText('基本设置');
      await expect(page.locator('#console-location')).toBeVisible();
      await expect(page.locator('#console-section-region')).toBeVisible();
      await expect(page.getByLabel('当前页面', { exact: true })).toBeVisible();
      await unifiedHeader(page);
      await page.screenshot({ path: `${out}/basic-${width}.png`, fullPage: true });
      await page.evaluate(() => scrollTo(0, 300));
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      expect((await page.locator('body > header').boundingBox()).y).toBe(0);
      await page.evaluate(() => scrollTo(0, 0));

      await page.goto(h.admin + '/#/projects/101/overview');
      await expect(page.locator('.workspace-overview')).toBeVisible();
      await expect(page.locator('#console-location')).toBeHidden();
      await expect(page.locator('#console-project-header .workbench-tabs')).toBeVisible();
      await unifiedHeader(page);
      await page.screenshot({ path: `${out}/overview-${width}.png`, fullPage: true });
      const mobileHeaderHeight = Math.round((await page.locator('body > header').boundingBox()).height);
      await expect.poll(() => page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.body).getPropertyValue('--console-header'))))).toBe(mobileHeaderHeight);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/101/basic');
    await expect(page.getByRole('button', { name: '刷新项目设置', exact: true })).toBeVisible();
    await desktopFrame(page);
    expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--console-header').trim())).toBe('64px');
  } finally { await h.stop(); }
});

test('all console route families keep location and permission content in the single header', async ({ page }) => {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h, password);
    const routes = [
      '#/projects', '#/board', '#/inbox', '#/costs', '#/identity', '#/more', '#/design', '#/management',
      '#/settings/work-computers', '#/settings/models', '#/settings/projects', '#/settings/users',
      '#/projects/101/overview', '#/projects/101/board', '#/projects/101/inbox', '#/projects/101/new-task',
      '#/projects/101/release', '#/projects/101/knowledge', '#/projects/101/activity', '#/projects/101/costs',
      '#/projects/101/basic', '#/projects/101/triggers', '#/projects/101/machine', '#/projects/101/model',
      '#/projects/101/roles', '#/projects/101/external', '#/projects/101/members'
    ];
    for (const route of routes) {
      await page.goto(h.admin + '/' + route);
      await unifiedHeader(page);
      await expect(page.locator('#project-page > .console-state-loading, #project-page .project-content > .console-state-loading, #console-page > .console-state-loading')).toHaveCount(0);
    }
  } finally { await h.stop(); }
});
