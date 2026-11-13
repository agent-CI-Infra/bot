import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { openRoleAdvanced, openRoleFromList } from './open-role-advanced.mjs';

const out = '.tmp/role-layout-569';

async function loginRoles(page, h, password) {
  await page.goto(h.admin + '/#/projects/101/roles');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByTestId('adopt-recommended-roles').click();
  await expect(page.locator('.flash')).toContainText('已使用推荐配置');
  await openRoleAdvanced(page);
}

test('#569 角色页用满内容区，不裁切文字；必需角色写明不能关闭的原因', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');

    await page.setViewportSize({ width: 1440, height: 900 });
    await loginRoles(page, h, password);
    const table = page.getByRole('table', { name: '角色解析结果', exact: true });
    await expect(table.getByRole('link', { name: '开发', exact: true })).toBeVisible();

    const layout = await page.evaluate(() => {
      const pageEl = document.querySelector('.project-page');
      const content = document.querySelector('.project-content');
      const nav = document.querySelector('.console-nav, #tabs, .console-sidebar, aside');
      const pb = pageEl?.getBoundingClientRect();
      const cb = content?.getBoundingClientRect();
      const clipped = [...document.querySelectorAll('.console-link, .roles-page a, .roles-page h2, .roles-page h3')]
        .filter(el => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).textOverflow !== 'ellipsis')
        .map(el => el.textContent.trim().slice(0, 40));
      return {
        contentWidth: cb?.width || 0,
        pageWidth: pb?.width || 0,
        ratio: cb && pb ? cb.width / pb.width : 0,
        overflow: document.documentElement.scrollWidth,
        clipped,
        pageOverflow: pageEl ? getComputedStyle(pageEl).overflow : '',
      };
    });
    expect(layout.pageOverflow).not.toBe('clip');
    expect(layout.ratio).toBeGreaterThan(0.88);
    expect(layout.overflow).toBeLessThanOrEqual(1440);
    expect(layout.clipped).toEqual([]);
    await page.screenshot({ path: `${out}/list-1440.png`, fullPage: true });

    await openRoleFromList(page, '项目管理者');
    await expect(page.getByLabel('启用角色', { exact: true })).toBeDisabled();
    await expect(page.getByTestId('role-enable-reason')).toContainText('项目管理者是必需角色，不能关闭');
    const requiredBox = await page.evaluate(() => {
      const input = document.querySelector('.role-form input[type=checkbox]:disabled, .roles-page input[type=checkbox]:disabled');
      return { cursor: input ? getComputedStyle(input).cursor : 'missing', width: input?.getBoundingClientRect().width };
    });
    expect(requiredBox.cursor).toBe('not-allowed');
    expect(requiredBox.width).toBeGreaterThanOrEqual(16);
    await page.screenshot({ path: `${out}/form-required-1440.png`, fullPage: true });

    await page.getByTestId('role-list-link').click();
    await openRoleFromList(page, '开发');
    const enable = page.getByLabel('启用角色', { exact: true });
    await expect(enable).toBeEnabled();
    await expect(page.getByTestId('role-enable-reason')).toHaveCount(0);
    const editable = await page.evaluate(() => {
      const input = [...document.querySelectorAll('.roles-page input[type=checkbox]')].find(el => !el.disabled);
      const cs = getComputedStyle(input);
      return { cursor: cs.cursor, opacity: Number(cs.opacity), width: input.getBoundingClientRect().width };
    });
    expect(editable.cursor).toBe('pointer');
    expect(editable.opacity).toBeGreaterThan(0.9);
    expect(editable.width).toBeGreaterThanOrEqual(16);
    await page.screenshot({ path: `${out}/form-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByRole('heading', { name: /开发/ })).toBeVisible();
    await expect(enable).toBeVisible();
    const firstScreen = await page.evaluate(() => {
      const heading = [...document.querySelectorAll('h2, h3')].find(el => /开发/.test(el.textContent));
      const input = document.querySelector('.role-form-head input[type=checkbox]') || document.querySelector('.roles-page input[type=checkbox]');
      const bar = 64;
      const hb = heading.getBoundingClientRect(), ib = input.getBoundingClientRect();
      return {
        headingIn: hb.top >= 0 && hb.bottom <= 844 - bar,
        enableIn: ib.top >= 0 && ib.bottom <= 844 - bar,
        overflow: document.documentElement.scrollWidth,
      };
    });
    expect(firstScreen.headingIn).toBe(true);
    expect(firstScreen.enableIn).toBe(true);
    expect(firstScreen.overflow).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${out}/form-390.png`, fullPage: true });

    await page.getByTestId('role-list-link').click();
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/list-390.png`, fullPage: true });
  } finally { await h.stop(); }
});
