import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #565: project pages show at most two nav layers, and every original entry is reached from 项目入口.
// #707: the project header has a 设置 entry, and a settings page lists every settings category (like personal and global
// settings) so switching between them is one click; work pages keep the two-item breadcrumb.
const out = resolve('.tmp/flatten-settings-nav');
const work = [
  ['项目总览', /#\/projects\/101\/overview$/],
  ['管理对话', null], // opens the chat, does not change the address
  ['发版本', /#\/projects\/101\/release$/],
  ['项目知识', /#\/projects\/101\/knowledge$/],
  ['运行状态', /#\/projects\/101\/activity$/]
];
const settings = [
  ['基本设置', 'basic'], ['机器配置', 'machine'], ['角色', 'roles'], ['模型', 'model'],
  ['计划与通知', 'schedules'], ['外部执行', 'external'], ['成员', 'members']
];
const pages = [...work, ...settings.map(([caption, key]) => [caption, new RegExp(`#/projects/101/${key}$`)])];
const settingsHrefs = ['#/projects/101/menu', ...settings.map(([, key]) => `#/projects/101/${key}`)];

const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };

async function login(page, h, password, hash = '#/projects/101/menu') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByTestId('project-hub')).toBeVisible();
}

test('项目入口总览可到达全部页面，页头有设置入口，设置页一次点击切换全部设置类别', async ({ page }) => {
  test.setTimeout(180000);
  // The engine serves the role configuration, so the 角色 page draws its overview instead of a read error.
  const h = await harness(undefined, manager, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await login(page, h, password);
    const hub = () => page.getByTestId('project-hub');
    const crumb = page.getByRole('navigation', { name: '项目入口' });
    const categories = page.getByRole('navigation', { name: '项目设置类别' });
    const openSettings = page.getByTestId('project-open-settings');
    const picker = page.getByLabel('当前页面', { exact: true });
    await expect(hub().getByRole('heading', { name: '项目工作', exact: true })).toBeVisible();
    await expect(hub().getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    for (const [caption] of pages) await expect(hub().getByRole('link', { name: caption, exact: true })).toBeVisible();
    // The hub only marks itself current; it does not list every neighbour as a nav row.
    await expect(crumb.getByRole('link')).toHaveCount(1);
    await expect(crumb.locator('[aria-current=page]')).toHaveText('项目入口');
    await expect(openSettings).toBeVisible();

    for (const [caption, url] of pages) {
      await page.evaluate(() => { location.hash = '#/projects/101/menu'; });
      await expect(hub()).toBeVisible();
      await hub().getByRole('link', { name: caption, exact: true }).click();
      if (caption === '管理对话') {
        await expect(page).toHaveURL(/#\/projects\/101\/menu$/);
        await expect(page.locator('#management-chat')).toBeVisible({ timeout: 15000 });
        await page.getByRole('button', { name: '收起管理助手', exact: true }).click();
        await expect(page.locator('#management-chat')).toBeHidden();
        continue;
      }
      await expect(page).toHaveURL(url);
      // Every project page carries the header's 设置 entry.
      await expect(openSettings).toBeVisible();
      if (settings.some(([name]) => name === caption)) {
        // A settings page: ← 项目入口 and all seven categories, the current one marked; no work page is listed.
        await expect(crumb).toHaveCount(0);
        await expect(categories.getByRole('link')).toHaveText(['← 项目入口', ...settings.map(([name]) => name)]);
        expect(await categories.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(settingsHrefs);
        await expect(categories.locator('[aria-current=page]')).toHaveText(caption);
        for (const [other] of work) await expect(categories.getByRole('link', { name: other, exact: true })).toHaveCount(0);
        continue;
      }
      // A work page keeps the #565 breadcrumb and lists no neighbour.
      await expect(categories).toHaveCount(0);
      await expect(crumb.getByRole('link', { name: '← 项目入口', exact: true })).toBeVisible();
      await expect(crumb.locator('[aria-current=page]')).toHaveText(caption);
      await expect(crumb.getByRole('link')).toHaveCount(2);
    }

    // From any settings page each other category is one click away, and the 当前页面 picker follows the same address.
    await page.goto(h.admin + '/#/projects/101/model');
    await expect(categories.locator('[aria-current=page]')).toHaveText('模型');
    for (const [caption, key] of settings) {
      await categories.getByRole('link', { name: caption, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#/projects/101/${key}$`));
      await expect(categories.locator('[aria-current=page]')).toHaveText(caption);
      await expect(picker).toHaveValue(`#/projects/101/${key}`);
      // The picker's 设置 group points at the addresses the category nav draws.
      expect(await page.locator('#console-section optgroup[label="设置"] option').evaluateAll(options => options.map(option => option.value))).toEqual(settingsHrefs.slice(1));
    }
    await categories.getByRole('link', { name: '← 项目入口', exact: true }).click();
    await expect(hub()).toBeVisible();

    // Direct addresses still work, including after a reload.
    await page.goto(h.admin + '/#/projects/101/basic');
    await expect(categories.locator('[aria-current=page]')).toHaveText('基本设置');
    await page.reload();
    await expect(categories.locator('[aria-current=page]')).toHaveText('基本设置');

    // Roles keeps its own list crumb (see #566); the project row is the category nav, not a third row of tabs.
    await page.evaluate(() => { location.hash = '#/projects/101/roles'; });
    await expect(categories.locator('[aria-current=page]')).toHaveText('角色');
    await expect(page.locator('#console-secondary-nav nav')).toHaveCount(1);
    await expect(crumb).toHaveCount(0);

    for (const [width, height, name] of [[1440, 900, '1440'], [768, 1024, '768'], [390, 844, '390']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { location.hash = '#/projects/101/overview'; });
      await expect(page.locator('.workspace-overview')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${out}/overview-${name}.png`, fullPage: true });
      // One click from 项目总览 into the settings.
      await openSettings.click();
      await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
      await expect(picker).toHaveValue('#/projects/101/basic');
      if (width > 767) {
        await expect(categories.locator('[aria-current=page]')).toHaveText('基本设置');
        // Every category is on screen at once: none hides behind a sideways scroll.
        for (const [caption] of settings) await expect(categories.getByRole('link', { name: caption, exact: true })).toBeInViewport({ ratio: 1 });
      } else await expect(categories).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${out}/basic-${name}.png`, fullPage: true });
      // One click (or one choice on a phone) from 基本设置 to 角色.
      if (width > 767) await categories.getByRole('link', { name: '角色', exact: true }).click();
      else await picker.selectOption('#/projects/101/roles');
      await expect(page).toHaveURL(/#\/projects\/101\/roles$/);
      await expect(picker).toHaveValue('#/projects/101/roles');
      if (width > 767) await expect(categories.locator('[aria-current=page]')).toHaveText('角色');
      else await expect(openSettings).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${out}/roles-${name}.png`, fullPage: true });
      // The way back to 项目入口 stays one click away at every width.
      if (width > 767) await categories.getByRole('link', { name: '← 项目入口', exact: true }).click();
      else await page.getByTestId('project-hub-link').click();
      await expect(hub()).toBeVisible();
      await page.screenshot({ path: `${out}/menu-${name}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
