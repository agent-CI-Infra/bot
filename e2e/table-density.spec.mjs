import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #560: numbers right, text left; role duty clamped; 390 stacks. Does not restyle the project list (#544).
const out = resolve('.tmp/table-density-560');

test('#560 角色概览与统计表列对齐，390 下角色表按列堆叠', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();

    await page.goto(h.admin + '/#/costs');
    await expect(page.getByRole('heading', { name: '统计', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '任务统计' })).toBeVisible();
    const costs = await page.evaluate(() => {
      const th = [...document.querySelectorAll('.statistics-task-summary th')].map(el => ({
        text: el.textContent.trim(),
        align: getComputedStyle(el).textAlign,
      }));
      const td = [...document.querySelectorAll('.statistics-task-summary tbody tr:first-child td')].map(el => getComputedStyle(el).textAlign);
      return { th, td };
    });
    expect(costs.th[0].align === 'left' || costs.th[0].align === 'start').toBeTruthy();
    expect(costs.th.slice(1).every(c => c.align === 'right')).toBeTruthy();
    expect(costs.td[0] === 'left' || costs.td[0] === 'start').toBeTruthy();
    expect(costs.td.slice(1).every(a => a === 'right')).toBeTruthy();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: `${out}/costs-after-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/projects/101/roles');
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible({ timeout: 15000 });
    const table = page.locator('.project-table[aria-label="角色解析结果"]');
    await expect(table).toBeVisible({ timeout: 10000 });
    const roles = await page.evaluate(() => {
      const table = document.querySelector('.project-table[aria-label="角色解析结果"]');
      const duty = table.querySelector('td[data-label="职责"] > *');
      const cs = duty ? getComputedStyle(duty) : {};
      const clamp = duty ? (cs.webkitLineClamp || cs.lineClamp || getComputedStyle(duty).getPropertyValue('-webkit-line-clamp')) : '';
      const rows = [...table.querySelectorAll('tbody tr')];
      const heights = rows.map(r => Math.round(r.getBoundingClientRect().height));
      return {
        clamp: String(clamp),
        overflow: duty ? getComputedStyle(duty).overflow : '',
        hasDutyTitle: [...table.querySelectorAll('td[data-label="职责"] > *')].some(el => el.title),
        colCount: table.querySelectorAll('thead th').length,
        rowHeights: heights,
      };
    });
    expect(roles.clamp === '2' || roles.overflow === 'hidden').toBeTruthy();
    // Role list after the #566 rewrite: 角色 / 启用 / 职责 / 状态.
    expect(roles.colCount).toBe(4);
    expect(roles.hasDutyTitle).toBe(true);
    // rows should not wildly diverge just from padding (content still varies; all at least a control height)
    expect(roles.rowHeights.every(h => h >= 40)).toBeTruthy();
    await page.screenshot({ path: `${out}/roles-after-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects/101/roles');
    await expect(page.locator('.project-table[aria-label="角色解析结果"]')).toBeVisible({ timeout: 15000 });
    const mobile = await page.evaluate(() => {
      const table = document.querySelector('.project-table[aria-label="角色解析结果"]');
      const thead = getComputedStyle(table.querySelector('thead')).display;
      const td = table.querySelector('td');
      const display = getComputedStyle(td).display;
      return { thead, display, overflow: document.documentElement.scrollWidth };
    });
    expect(mobile.thead).toBe('none');
    expect(mobile.display).toBe('block');
    expect(mobile.overflow).toBe(390);
    await page.screenshot({ path: `${out}/roles-after-390.png`, fullPage: true });
    await page.goto(h.admin + '/#/costs');
    await expect(page.getByRole('heading', { name: '统计', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/costs-after-390.png`, fullPage: true });
  } finally { await h.stop(); }
});
