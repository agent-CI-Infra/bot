import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #565: project settings show at most two nav layers. All original entries are reached from 项目入口,
// and a leaf page no longer lists every neighbour.
const out = resolve('.tmp/flatten-settings-nav');
const pages = [
  ['项目总览', /#\/projects\/101\/overview$/],
  ['管理对话', null], // opens the chat, does not change the address
  ['发版本', /#\/projects\/101\/release$/],
  ['项目知识', /#\/projects\/101\/knowledge$/],
  ['运行状态', /#\/projects\/101\/activity$/],
  ['基本设置', /#\/projects\/101\/basic$/],
  ['机器配置', /#\/projects\/101\/machine$/],
  ['角色', /#\/projects\/101\/roles$/],
  ['模型', /#\/projects\/101\/model$/],
  ['计划与通知', /#\/projects\/101\/schedules$/],
  ['外部执行', /#\/projects\/101\/external$/],
  ['成员', /#\/projects\/101\/members$/]
];

const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };

async function login(page, h, password, hash = '#/projects/101/menu') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByTestId('project-hub')).toBeVisible();
}

test('项目入口总览可到达全部原有页面，配置页不再同时列出全部邻居', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(undefined, manager), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await login(page, h, password);
    const hub = () => page.getByTestId('project-hub');
    const crumb = page.getByRole('navigation', { name: '项目入口' });
    await expect(hub().getByRole('heading', { name: '项目工作', exact: true })).toBeVisible();
    await expect(hub().getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    for (const [caption] of pages) await expect(hub().getByRole('link', { name: caption, exact: true })).toBeVisible();
    // The hub only marks itself current; it does not list every neighbour as a nav row.
    await expect(crumb.getByRole('link')).toHaveCount(1);
    await expect(crumb.locator('[aria-current=page]')).toHaveText('项目入口');

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
      await expect(crumb.getByRole('link', { name: '← 项目入口', exact: true })).toBeVisible();
      await expect(crumb.locator('[aria-current=page]')).toHaveText(caption);
      await expect(crumb.getByRole('link')).toHaveCount(2);
      // Neighbour section titles are not listed in the project crumb.
      for (const [other] of pages) {
        if (other === caption) continue;
        await expect(crumb.getByRole('link', { name: other, exact: true })).toHaveCount(0);
      }
    }

    // Direct addresses still work, including after a reload.
    await page.goto(h.admin + '/#/projects/101/basic');
    await expect(crumb.locator('[aria-current=page]')).toHaveText('基本设置');
    await page.reload();
    await expect(crumb.locator('[aria-current=page]')).toHaveText('基本设置');

    // Roles keeps its own tabs (see #566) but must not also show the 12-item project section list.
    await page.evaluate(() => { location.hash = '#/projects/101/roles'; });
    await expect(crumb.locator('[aria-current=page]')).toHaveText('角色');
    await expect(crumb.getByRole('link')).toHaveCount(2);
    // Three rows of "项目分段 + 角色标签 + 角色内分段" are gone because 项目分段 is only the crumb.

    for (const [width, height, name] of [[1440, 900, '1440'], [768, 1024, '768'], [390, 844, '390']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { location.hash = '#/projects/101/menu'; });
      await expect(hub()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${out}/menu-${name}.png`, fullPage: true });
      await hub().getByRole('link', { name: '基本设置', exact: true }).click();
      await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
      if (width > 767) await expect(crumb.locator('[aria-current=page]')).toHaveText('基本设置');
      else {
        await expect(page.getByTestId('project-hub-link')).toBeVisible();
        await expect(page.getByLabel('当前页面', { exact: true })).toHaveValue('#/projects/101/basic');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${out}/basic-${name}.png`, fullPage: true });
      if (width > 767) await crumb.getByRole('link', { name: '← 项目入口', exact: true }).click();
      else await page.getByTestId('project-hub-link').click();
      await expect(hub()).toBeVisible();
      await hub().getByRole('link', { name: '角色', exact: true }).click();
      await expect(page).toHaveURL(/#\/projects\/101\/roles$/);
      if (width > 767) await expect(crumb.locator('[aria-current=page]')).toHaveText('角色');
      else await expect(page.getByTestId('project-hub-link')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${out}/roles-${name}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
