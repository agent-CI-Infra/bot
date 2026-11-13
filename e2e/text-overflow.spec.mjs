import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #561: long titles and notes ellipsize; 390 keeps 退出登录 and 设置 visible; 1440 does not over-truncate medium names.
const out = resolve('.tmp/text-overflow-561');

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

const longName = 'fixture/an-extraordinarily-long-repository-name-used-to-verify-ellipsis-truncation-on-narrow-screens';

test('#561 长文本截断，窄屏不遮挡主操作，桌面不误截中等名称', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');
    const long = await repository(admin, a.id, '202');
    h.store.run('UPDATE repositories SET full_name=? WHERE id=?', longName, '202');
    h.store.run('UPDATE installed_repositories SET full_name=? WHERE repository_id=?', longName, '202');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await expect(page.locator('.project-list-row .row-title').filter({ hasText: longName })).toBeVisible();

    const header = await page.evaluate(() => {
      const bar = document.querySelector('body > header');
      const who = document.getElementById('who');
      const logout = document.getElementById('logout');
      const role = document.querySelector('.current-user-role');
      const name = document.querySelector('.current-user-name');
      const hb = bar.getBoundingClientRect(), wb = who.getBoundingClientRect(), lb = logout.getBoundingClientRect();
      return {
        wrap: getComputedStyle(bar).flexWrap,
        whoTitle: who.title,
        nameEllipsis: getComputedStyle(name).textOverflow,
        nameWrap: getComputedStyle(name).whiteSpace,
        roleDisplay: role ? getComputedStyle(role).display : 'missing',
        whoRight: wb.right, logoutLeft: lb.left, logoutRight: lb.right,
        sameRow: Math.abs(wb.top - lb.top) < 16,
        logoutVisible: lb.width > 0 && lb.right <= 390.5 && lb.bottom > 0 && lb.top >= 0,
        overflow: document.documentElement.scrollWidth,
      };
    });
    expect(header.wrap).toBe('nowrap');
    expect(header.nameEllipsis).toBe('ellipsis');
    expect(header.nameWrap).toBe('nowrap');
    expect(header.roleDisplay).toBe('none');
    expect(header.whoTitle).toMatch(/超级管理员/);
    expect(header.logoutVisible).toBe(true);
    expect(header.whoRight).toBeLessThanOrEqual(header.logoutLeft + 1);
    expect(header.sameRow).toBe(true);
    expect(header.overflow).toBe(390);

    const list = await page.evaluate((expected) => {
      const row = [...document.querySelectorAll('.project-list-row')].find(r => r.querySelector('.row-title')?.textContent === expected);
      const title = row.querySelector('.row-title');
      const actions = row.querySelector(':scope > .actions');
      const state = row.querySelector('.row-state');
      const setting = [...(actions?.querySelectorAll('button') || [])].find(b => b.textContent.trim() === '设置');
      const ts = getComputedStyle(title), ss = getComputedStyle(state);
      const ab = actions.getBoundingClientRect(), sb = state.getBoundingClientRect(), tb = title.getBoundingClientRect();
      return {
        title: title.title,
        ellipsis: ts.textOverflow,
        nowrap: ts.whiteSpace,
        truncated: title.scrollWidth > title.clientWidth + 1,
        actionsAboveChips: ab.bottom <= sb.top + 2,
        settingVisible: !!setting && setting.getBoundingClientRect().height > 0,
        stateOverflow: ss.overflow,
        stateMax: ss.maxHeight,
        titleWidth: tb.width,
        overflow: document.documentElement.scrollWidth,
      };
    }, longName);
    expect(list.title).toBe(longName);
    expect(list.ellipsis).toBe('ellipsis');
    expect(list.nowrap).toBe('nowrap');
    expect(list.truncated).toBe(true);
    expect(list.actionsAboveChips).toBe(true);
    expect(list.settingVisible).toBe(true);
    expect(list.stateOverflow).toBe('hidden');
    expect(Number.parseFloat(list.stateMax)).toBeGreaterThan(0);
    expect(list.overflow).toBe(390);
    await page.screenshot({ path: resolve(out, 'projects-390.png'), fullPage: true });

    await readyIdentity(page, h.admin + '/#/identity');
    const identity = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '切换组织');
      const notes = [...document.querySelectorAll('.identity-layout .muted, .identity-overview .muted')];
      const bb = btn.getBoundingClientRect();
      const overlaps = notes.some(n => {
        const nb = n.getBoundingClientRect();
        return !(nb.right <= bb.left || bb.right <= nb.left || nb.bottom <= bb.top + 1 || bb.bottom <= nb.top);
      });
      const clamp = notes.map(n => getComputedStyle(n).webkitLineClamp);
      return {
        overlaps,
        clamp,
        btnVisible: bb.height > 0 && bb.width > 0,
        logoutVisible: document.getElementById('logout').getBoundingClientRect().right <= 390.5,
        overflow: document.documentElement.scrollWidth,
      };
    });
    expect(identity.overlaps).toBe(false);
    expect(identity.btnVisible).toBe(true);
    expect(identity.logoutVisible).toBe(true);
    expect(identity.overflow).toBe(390);
    expect(identity.clamp.some(v => v === '4')).toBeTruthy();
    await page.screenshot({ path: resolve(out, 'identity-390.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await expect(page.locator('.project-list-row .row-title').filter({ hasText: 'fixture/project-101' })).toBeVisible();
    const desktop = await page.evaluate(() => {
      const medium = [...document.querySelectorAll('.row-title')].find(el => el.textContent.trim() === 'fixture/project-101');
      const role = document.querySelector('.current-user-role');
      const ts = getComputedStyle(medium);
      return {
        shown: medium.textContent,
        truncated: medium.scrollWidth > medium.clientWidth + 1,
        ellipsis: ts.textOverflow,
        roleDisplay: role ? getComputedStyle(role).display : 'missing',
        overflow: document.documentElement.scrollWidth,
      };
    });
    expect(desktop.shown).toBe('fixture/project-101');
    expect(desktop.truncated).toBe(false);
    expect(desktop.ellipsis).toBe('ellipsis');
    expect(desktop.roleDisplay).not.toBe('none');
    expect(desktop.overflow).toBe(1440);
    await page.screenshot({ path: resolve(out, 'projects-1440.png'), fullPage: true });

    await page.goto(h.admin + '/#/projects/101/roles');
    await expect(page.getByRole('heading', { name: '角色概览' })).toBeVisible();
    await expect(page.locator('table[aria-label="角色解析结果"]')).toBeVisible();
    const roles = await page.evaluate(() => {
      const muted = document.querySelector('.roles-page .project-table td .muted');
      if (!muted) return { missing: true };
      const cs = getComputedStyle(muted);
      return { clamp: cs.webkitLineClamp, overflow: cs.overflow, title: muted.title || muted.textContent };
    });
    expect(roles.missing).toBeFalsy();
    expect(roles.clamp).toBe('2');
    await page.screenshot({ path: resolve(out, 'roles-1440.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects/101/roles');
    await expect(page.getByRole('heading', { name: '角色概览' })).toBeVisible();
    await page.screenshot({ path: resolve(out, 'roles-390.png'), fullPage: true });
  } finally {
    await h.stop();
  }
});
