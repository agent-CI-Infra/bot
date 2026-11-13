import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #557: one content width, stretched card rows, login vertically centered, 全局设置 spans the grid.
const out = resolve('.tmp/page-grid-557');
const box = async (locator) => locator.evaluate(el => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
});

/** 高级／诊断 fold cards: their boxes, and the column gutter between cards that share a row. */
const foldCards = page => page.evaluate(() => {
  const cards = [...document.querySelectorAll('.identity-layout > .identity-advanced[open] > .side-card')].map(el => el.getBoundingClientRect());
  const lefts = [...new Set(cards.map(r => Math.round(r.left)))];
  const gutters = [];
  for (const a of cards) for (const b of cards) if (Math.abs(a.top - b.top) < 2 && b.left > a.right) gutters.push(Math.round(b.left - a.right));
  return { count: cards.length, columns: lefts.length, gutter: gutters.length ? Math.min(...gutters) : null };
});

/** After #514 the org-scope card lives inside a closed 高级／诊断 fold. Open it when present. */
async function readyIdentity(page, url) {
  if (url) await page.goto(url);
  await expect(page.locator('#identity-panel')).toBeVisible();
  const org = page.getByRole('heading', { name: '当前组织与项目范围' });
  const github = page.getByRole('heading', { name: '我的 GitHub 连接' });
  const legacy = page.getByRole('heading', { name: '我的身份与有效权限' });
  await expect(github.or(org).or(legacy).first()).toBeVisible({ timeout: 15000 });
  if (await org.isVisible()) return;
  const summary = page.locator('details.identity-advanced > summary');
  if (await summary.count()) {
    await summary.first().click();
    await expect(org).toBeVisible({ timeout: 10000 });
  }
  const switcher = page.getByRole('button', { name: '切换组织' });
  if (await switcher.count()) await switcher.first().scrollIntoViewIfNeeded();
}


test('#557 登录、身份、更多功能、基本设置在 1440 对齐同一栅格，390 不横向溢出', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/');
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const login = await page.evaluate(() => {
      const card = document.querySelector('#access.access-layout');
      const intro = document.querySelector('.access-intro');
      const panel = document.querySelector('.access-panel');
      const main = document.querySelector('main');
      const cr = card.getBoundingClientRect();
      const mr = main.getBoundingClientRect();
      const contentMax = getComputedStyle(document.documentElement).getPropertyValue('--content-max').trim();
      return {
        contentMax,
        cardWidth: cr.width,
        introHeight: intro.getBoundingClientRect().height,
        panelHeight: panel.getBoundingClientRect().height,
        spaceAbove: cr.top - mr.top,
        spaceBelow: mr.bottom - cr.bottom,
        left: intro.getBoundingClientRect().left,
        right: panel.getBoundingClientRect().right,
      };
    });
    expect(login.contentMax).toBe('1120px');
    expect(login.cardWidth).toBeLessThanOrEqual(1120);
    expect(login.cardWidth).toBeGreaterThan(900);
    expect(Math.abs(login.introHeight - login.panelHeight)).toBeLessThan(2);
    // Vertically centered: leftover space above and below should be similar, not a 5vh stuck-to-top card.
    expect(login.spaceAbove).toBeGreaterThan(40);
    expect(Math.abs(login.spaceAbove - login.spaceBelow)).toBeLessThan(login.spaceAbove * 0.5 + 24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: `${out}/login-after-1440.png`, fullPage: true });

    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();

    await readyIdentity(page, h.admin + '/#/identity');
    const identity = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.identity-layout > .side-card, .identity-advanced > .side-card')]
        .map(el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), height: Math.round(r.height), className: el.className }; })
        .filter(c => !c.className.includes('identity-overview') && c.height > 0);
      // Pair cards that share a top (same row).
      const rows = [];
      for (const c of cards) {
        const row = rows.find(r => Math.abs(r[0].top - c.top) < 4);
        if (row) row.push(c); else rows.push([c]);
      }
      return { rows, sameHeight: rows.every(r => r.length < 2 || r.every(c => Math.abs(c.height - r[0].height) < 2)) };
    });
    expect(identity.rows.some(r => r.length === 2)).toBeTruthy();
    // The fold's paired cards keep the --space-6 (20px) gutter at 1440.
    const fold1440 = await foldCards(page);
    expect(fold1440.columns).toBe(2);
    expect(fold1440.gutter).toBe(20);
    expect(identity.sameHeight).toBeTruthy();
    await page.screenshot({ path: `${out}/identity-after-1440.png`, fullPage: true });

    // Since #481 更多 carries 当前项目 only while a project is in scope, so enter one first: then 当前项目 and 分析与渠道
    // share the first row and the personal/platform group spans the full row under them.
    await page.goto(h.admin + '/#/projects/101/basic');
    await expect(page.locator('.project-content')).toBeVisible({ timeout: 10000 });
    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '当前项目', exact: true })).toBeVisible();
    const more = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.console-group')].map(el => {
        const r = el.getBoundingClientRect();
        return { title: el.querySelector('h2')?.textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), wide: el.classList.contains('console-group-wide') };
      });
      const firstRow = groups.filter(g => Math.abs(g.top - groups[0].top) < 4);
      const wide = groups.find(g => g.wide);
      const grid = document.querySelector('.console-groups').getBoundingClientRect();
      return {
        firstRowBottoms: firstRow.map(g => g.bottom),
        firstRowAligned: firstRow.every(g => Math.abs(g.bottom - firstRow[0].bottom) < 2),
        firstRowCount: firstRow.length,
        wideWidth: wide ? wide.width : 0,
        gridWidth: Math.round(grid.width),
        wideSpans: wide ? Math.abs(wide.left - grid.left) < 4 && Math.abs(wide.right - grid.right) < 4 : false,
      };
    });
    expect(more.firstRowCount).toBeGreaterThanOrEqual(2);
    expect(more.firstRowAligned).toBeTruthy();
    expect(more.wideSpans).toBeTruthy();
    expect(more.wideWidth).toBeGreaterThan(more.gridWidth * 0.9);
    await page.screenshot({ path: `${out}/more-after-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/projects/101/basic');
    await expect(page.locator('.project-content')).toBeVisible({ timeout: 10000 });
    const basic = await page.evaluate(() => {
      const content = document.querySelector('.project-content');
      const main = document.querySelector('#project-page') || content.parentElement;
      const cr = content.getBoundingClientRect();
      const layout = document.querySelector('.project-settings-layout');
      const cards = layout ? [...layout.querySelectorAll(':scope > .side-card')].map(el => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) };
      }) : [];
      const rows = [];
      for (const c of cards) {
        const row = rows.find(r => Math.abs(r[0].top - c.top) < 4);
        if (row) row.push(c); else rows.push([c]);
      }
      const parent = content.parentElement.getBoundingClientRect();
      return {
        contentWidth: Math.round(cr.width),
        parentWidth: Math.round(parent.width),
        twoCol: rows.some(r => r.length === 2),
        sameHeight: rows.filter(r => r.length === 2).every(r => Math.abs(r[0].height - r[1].height) < 2),
        dangerFull: (() => {
          const d = document.querySelector('.project-danger');
          if (!d || !layout) return false;
          const a = d.getBoundingClientRect(), b = layout.getBoundingClientRect();
          return Math.abs(a.width - b.width) < 4;
        })(),
      };
    });
    // No 980px cap: content should use nearly the full parent (allow padding).
    expect(basic.contentWidth).toBeGreaterThan(1000);
    expect(basic.contentWidth / basic.parentWidth).toBeGreaterThan(0.9);
    expect(basic.twoCol).toBeTruthy();
    expect(basic.sameHeight).toBeTruthy();
    expect(basic.dangerFull).toBeTruthy();
    await page.screenshot({ path: `${out}/project-basic-after-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects/101/basic');
    await expect(page.locator('.project-content')).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/project-basic-after-390.png`, fullPage: true });
    await readyIdentity(page, h.admin + '/#/identity');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    // ≤1279px the 高级／诊断 cards stack in one column.
    const fold390 = await foldCards(page);
    expect(fold390.count).toBeGreaterThan(1);
    expect(fold390.columns).toBe(1);
    await page.screenshot({ path: `${out}/identity-after-390.png`, fullPage: true });
    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/more-after-390.png`, fullPage: true });
    // #481: below 768px sign-out lives in the account menu.
    await page.getByRole('button', { name: '账号菜单' }).click();
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    // Single column at 390
    const mobileLogin = await page.evaluate(() => getComputedStyle(document.querySelector('#access.access-layout')).gridTemplateColumns);
    expect(mobileLogin.split(' ').length).toBe(1);
    await page.screenshot({ path: `${out}/login-after-390.png`, fullPage: true });
  } finally { await h.stop(); }
});
