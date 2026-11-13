import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #562: 390 / 768 / 1440 layout sets; FAB and bottom bar do not cover primary actions. Does not rewrite #481 / #496 nav.
const out = resolve('.tmp/responsive-layout-562');

const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);


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

async function login(page, h, password) {
  await page.goto(h.admin + '/');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  // After #481, 390 puts 退出登录 in the account menu; wider screens keep the inline button.
  const account = page.locator('#console-account');
  await expect(account.or(page.getByRole('button', { name: '退出登录', exact: true })).first()).toBeVisible();
  if (await account.isVisible()) {
    // F7: the phone's sign-out really sits in the account menu, and the menu closes again.
    await account.click();
    const menu = page.locator('#console-account-menu');
    await expect(menu.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
}

async function metrics(page, name) {
  return page.evaluate((label) => {
    const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const fab = document.getElementById('management-launcher');
    const nav = document.querySelector('.console-mobile-nav');
    const logout = document.getElementById('logout');
    const target = [...document.querySelectorAll('button, a, h2, h1')].find(el => (el.textContent || '').trim().startsWith(label) || (el.textContent || '').trim() === label);
    const fb = fab ? fab.getBoundingClientRect() : null;
    const tb = target ? target.getBoundingClientRect() : null;
    const nb = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null;
    const lb = logout.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      fab: fb ? { left: fb.left, right: fb.right, top: fb.top, bottom: fb.bottom, width: fb.width, height: fb.height } : null,
      target: tb ? { left: tb.left, right: tb.right, top: tb.top, bottom: tb.bottom, height: tb.height, inView: tb.height > 0 && tb.top < window.innerHeight && tb.bottom > 0 } : null,
      fabHitsTarget: fb && tb ? overlap(fb, tb) : false,
      fabHitsNav: fb && nb ? overlap(fb, nb) : false,
      fabHitsLogout: fb ? overlap(fb, lb) : false,
      navDisplay: nav ? getComputedStyle(nav).display : 'missing',
      sidebar: (() => {
        const s = document.getElementById('console-sidebar');
        if (!s) return null;
        const cs = getComputedStyle(s);
        return { display: cs.display, width: s.getBoundingClientRect().width };
      })(),
    };
  }, name);
}

test('#562 390 / 768 / 1440 核心页不横向溢出，主操作不被浮钮或底栏挡住', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');

    // --- 390 ---
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, h, password);

    await readyIdentity(page, h.admin + '/#/identity');
    const identity = await metrics(page, '切换组织');
    expect(identity.overflow).toBe(390);
    expect(identity.target.inView).toBe(true);
    expect(identity.fabHitsTarget).toBe(false);
    expect(identity.fabHitsNav).toBe(false);
    expect(identity.fabHitsLogout).toBe(false);
    // F6: #481 hides the floating assistant on a phone, so there is no launcher to collide with; the assistant is the
    // bar's 助手 destination instead.
    await expect(page.locator('#management-launcher')).toBeHidden();
    expect(identity.fab === null || (identity.fab.width === 0 && identity.fab.height === 0)).toBe(true);
    const assistant = page.locator('.console-mobile-nav a[href="#/management"]');
    await expect(assistant).toBeVisible();
    await expect(assistant).toHaveAccessibleName(/^助手/);
    expect(identity.navDisplay).toBe('grid');
    await page.screenshot({ path: resolve(out, 'identity-390.png'), fullPage: true });

    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '设置' }).first()).toBeVisible();
    const projects = await metrics(page, '设置');
    expect(projects.overflow).toBe(390);
    expect(projects.fabHitsTarget).toBe(false);
    expect(projects.fabHitsNav).toBe(false);
    await page.screenshot({ path: resolve(out, 'projects-390.png'), fullPage: true });

    // Since #564/#566 an unconfigured role page opens on the recommended-config intro; its primary is 使用推荐配置.
    await page.goto(h.admin + '/#/projects/101/roles');
    await expect(page.getByRole('button', { name: '使用推荐配置', exact: true })).toBeVisible();
    const roles = await page.evaluate(() => {
      const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      const adopt = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '使用推荐配置');
      const fab = document.getElementById('management-launcher');
      const bar = document.querySelector('.console-mobile-nav');
      const ab = adopt.getBoundingClientRect(), fb = fab ? fab.getBoundingClientRect() : null;
      const reserved = bar.getBoundingClientRect().top;
      return {
        overflow: document.documentElement.scrollWidth,
        adoptInFirstScreen: ab.top >= 0 && ab.bottom <= reserved && ab.height > 0,
        fabHitsAdopt: !!fb && fb.width > 0 && overlap(fb, ab),
      };
    });
    expect(roles.overflow).toBe(390);
    expect(roles.adoptInFirstScreen).toBe(true);
    expect(roles.fabHitsAdopt).toBe(false);
    // A role page keeps its back crumb on one scrollable row instead of wrapping.
    await page.goto(h.admin + '/#/projects/101/roles/dev');
    await expect(page.getByTestId('role-list-link')).toBeVisible();
    const crumb = await page.evaluate(() => {
      const ns = getComputedStyle(document.querySelector('.role-nav'));
      return { wrap: ns.flexWrap, overflowX: ns.overflowX, overflow: document.documentElement.scrollWidth };
    });
    expect(crumb.overflow).toBe(390);
    expect(crumb.wrap).toBe('nowrap');
    expect(crumb.overflowX).toMatch(/auto|scroll/);
    await page.goto(h.admin + '/#/projects/101/roles');
    await expect(page.getByRole('button', { name: '使用推荐配置', exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(out, 'roles-390.png'), fullPage: false });

    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    const more390 = await metrics(page, '更多功能');
    expect(more390.overflow).toBe(390);
    await page.screenshot({ path: resolve(out, 'more-390.png'), fullPage: true });

    // --- 768 ---
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(h.admin + '/#/projects/101/roles/dev');
    await expect(page.getByTestId('role-list-link')).toBeVisible();
    const tablet = await page.evaluate(() => {
      const nav = document.querySelector('#console-secondary-nav .project-nav');
      const sidebar = document.getElementById('console-sidebar');
      const ns = getComputedStyle(nav);
      const links = [...nav.querySelectorAll('a')];
      const tops = new Set(links.map(a => Math.round(a.getBoundingClientRect().top)));
      const roleNav = document.querySelector('.role-nav');
      const roleTops = new Set([...roleNav.querySelectorAll('a')].map(a => Math.round(a.getBoundingClientRect().top)));
      return {
        overflow: document.documentElement.scrollWidth,
        wrap: ns.flexWrap,
        overflowX: ns.overflowX,
        oneRow: tops.size === 1,
        roleNavOneRow: roleTops.size === 1,
        sidebarWidth: sidebar.getBoundingClientRect().width,
        sidebarVisible: getComputedStyle(sidebar).display !== 'none',
        mobileNav: getComputedStyle(document.querySelector('.console-mobile-nav')).display,
      };
    });
    expect(tablet.overflow).toBe(768);
    expect(tablet.wrap).toBe('nowrap');
    expect(tablet.oneRow).toBe(true);
    expect(tablet.roleNavOneRow).toBe(true);
    expect(tablet.sidebarVisible).toBe(true);
    expect(tablet.sidebarWidth).toBeGreaterThan(150);
    expect(tablet.sidebarWidth).toBeLessThanOrEqual(200);
    expect(tablet.mobileNav).toBe('none');
    await page.screenshot({ path: resolve(out, 'roles-768.png'), fullPage: false });
    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(out, 'more-768.png'), fullPage: true });

    // --- 1440 ---
    await page.setViewportSize({ width: 1440, height: 1100 });
    await readyIdentity(page, h.admin + '/#/identity');
    const deskId = await metrics(page, '切换组织');
    expect(deskId.overflow).toBe(1440);
    expect(deskId.target.inView).toBe(true);
    expect(deskId.fabHitsTarget).toBe(false);
    expect(deskId.sidebar.width).toBeGreaterThan(200);
    await page.screenshot({ path: resolve(out, 'identity-1440.png'), fullPage: true });

    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    const deskPr = await metrics(page, '设置');
    expect(deskPr.overflow).toBe(1440);
    expect(deskPr.fabHitsTarget).toBe(false);
    await page.screenshot({ path: resolve(out, 'projects-1440.png'), fullPage: true });

    await page.goto(h.admin + '/#/projects/101/roles');
    await expect(page.getByRole('button', { name: '使用推荐配置', exact: true })).toBeVisible();
    const deskRoles = await metrics(page, '使用推荐配置');
    expect(deskRoles.overflow).toBe(1440);
    expect(deskRoles.fabHitsTarget).toBe(false);
    await page.screenshot({ path: resolve(out, 'roles-1440.png'), fullPage: false });
  } finally {
    await h.stop();
  }
});
