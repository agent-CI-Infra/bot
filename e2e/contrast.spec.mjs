import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #563: muted text and chips meet 4.5:1; 11px labels are now 12px. The muted hex is unchanged.
const out = resolve('.tmp/contrast-563');

function contrastScript() {
  return () => {
    const lin = (c) => { c = c / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const parse = (color) => {
      const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    };
    const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    const ratio = (fg, bg) => {
      const a = parse(fg), b = parse(bg);
      if (!a || !b) return 0;
      const L1 = lum(a), L2 = lum(b);
      return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    };
    const walkBg = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        const rgb = parse(bg);
        if (rgb && (rgb[0] + rgb[1] + rgb[2] < 750 || bg.startsWith('rgb(') && !bg.startsWith('rgba(0, 0, 0, 0)'))) {
          if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') { n = n.parentElement; continue; }
          return bg;
        }
        n = n.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const sample = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        selector,
        color: cs.color,
        background: walkBg(el),
        fontSize: parseFloat(cs.fontSize),
        contrast: ratio(cs.color, walkBg(el)),
      };
    };
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--color-text-muted').trim();
    return {
      muted,
      body: sample('body'),
      heading: sample('h1'),
      mutedText: sample('.muted') || sample('.cost-note') || sample('.cost-scope'),
      navLabel: sample('.console-nav-label'),
      chip: sample('.status'),
      role: sample('.current-user-role'),
    };
  };
}

test('#563 辅助文字与默认芯片对比度至少 4.5:1，侧栏标签至少 12px，1440 与 390 可对照', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/');
    // login page
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const login = await page.evaluate(contrastScript());
    expect(login.muted.toLowerCase()).toBe('#607087');
    expect(login.heading.contrast).toBeGreaterThanOrEqual(4.5);
    if (login.mutedText) {
      expect(login.mutedText.contrast).toBeGreaterThanOrEqual(4.5);
      expect(login.mutedText.fontSize).toBeGreaterThanOrEqual(12);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: `${out}/login-after-1440.png`, fullPage: true });

    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();

    const projects = await page.evaluate(contrastScript());
    expect(projects.muted.toLowerCase()).toBe('#607087');
    expect(projects.heading.contrast).toBeGreaterThanOrEqual(4.5);
    expect(projects.mutedText.contrast).toBeGreaterThanOrEqual(4.5);
    expect(projects.mutedText.fontSize).toBeGreaterThanOrEqual(12);
    expect(projects.navLabel.fontSize).toBeGreaterThanOrEqual(12);
    expect(projects.navLabel.contrast).toBeGreaterThanOrEqual(4.5);
    if (projects.role) {
      expect(projects.role.fontSize).toBeGreaterThanOrEqual(12);
      expect(projects.role.contrast).toBeGreaterThanOrEqual(4.5);
    }
    if (projects.chip) {
      expect(projects.chip.fontSize).toBeGreaterThanOrEqual(12);
      expect(projects.chip.contrast).toBeGreaterThanOrEqual(4.5);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: `${out}/projects-after-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/costs');
    await expect(page.getByRole('heading', { name: '统计', exact: true })).toBeVisible({ timeout: 10000 });
    const costs = await page.evaluate(contrastScript());
    const note = costs.mutedText;
    expect(note).toBeTruthy();
    expect(note.contrast).toBeGreaterThanOrEqual(4.5);
    expect(note.fontSize).toBeGreaterThanOrEqual(12);
    await page.screenshot({ path: `${out}/costs-after-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/more-after-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const mobile = await page.evaluate(contrastScript());
    if (mobile.mutedText) expect(mobile.mutedText.contrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `${out}/projects-after-390.png`, fullPage: true });
    await page.goto(h.admin + '/');
    // already logged in — go via logout? login is only signed-out. Just shot costs and more.
    await page.goto(h.admin + '/#/costs');
    await expect(page.getByRole('heading', { name: '统计', exact: true })).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${out}/costs-after-390.png`, fullPage: true });
    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/more-after-390.png`, fullPage: true });
    // login at 390: logout first
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const login390 = await page.evaluate(contrastScript());
    if (login390.mutedText) expect(login390.mutedText.contrast).toBeGreaterThanOrEqual(4.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/login-after-390.png`, fullPage: true });
  } finally { await h.stop(); }
});
