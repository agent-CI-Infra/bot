import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

// #750 phase 1: the console follows the system theme and offers light / dark / system by hand. The four surfaces in
// scope (login, project list, global settings, confirmation dialog) must be readable in dark, must not overflow
// horizontally at 390, and a stored choice must already be on <html> before the first stylesheet lands.
const out = resolve('.tmp/theme-750');
const LIGHT_BG = 'rgb(245, 247, 251)';
const DARK_TOKENS = { bg: '#0f141b', surface: '#161d27' };

async function signIn(page, h, password, hash = '#/projects') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
}

function channel(pixel) {
  return pixel / 255 <= 0.04045 ? pixel / 255 / 12.92 : ((pixel / 255 + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb) {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(foreground, background) {
  const [a, b] = [luminance(foreground), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function rgb(text) {
  const match = text.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// Reads the colours a reader actually sees: the effective background is the nearest ancestor that paints one.
async function surfaces(page) {
  return page.evaluate(() => {
    const parse = (color) => color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)?.slice(1).map(Number) || null;
    const paint = (el) => {
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && bg !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(bg)) return bg;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      return { color: style.color, background: paint(el) };
    };
    return {
      htmlTheme: document.documentElement.dataset.theme || null,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      body: read('body'),
      heading: read('h1'),
      muted: read('.muted, #access-description'),
      brandText: read('.eyebrow'),
    };
  });
}

function readable(sample, minimum = 4.5, label = '') {
  const [fg, bg] = [rgb(sample.color), rgb(sample.background)];
  expect(fg, `${label} foreground`).not.toBeNull();
  expect(bg, `${label} background`).not.toBeNull();
  expect(contrast(fg, bg), `${label} ${sample.color} on ${sample.background}`).toBeGreaterThanOrEqual(minimum);
}

test('#750 theme-boot applies a stored choice before the first stylesheet and follows the system otherwise', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness();
  try {
    await setup(h);
    // A cold start with a stored choice must not paint light first: park every stylesheet and watch <html>.
    // Seed once per session: the reload below removes the stored choice and must then see "system", not the seed again.
    await page.addInitScript(() => {
      try {
        if (sessionStorage.getItem('theme-seeded')) return;
        sessionStorage.setItem('theme-seeded', '1');
        localStorage.setItem('launchpad.theme', 'dark');
      } catch (e) {}
    });
    let stylesheetsServed = 0;
    await page.route('**/*.css', async (route) => { await new Promise((done) => setTimeout(done, 400)); stylesheetsServed++; await route.continue(); });
    await page.mouse.move(0, 0);
    await page.goto(h.admin + '/', { waitUntil: 'commit' });
    // theme-boot parses before the first stylesheet is requested, so the attribute must be there while no sheet has
    // answered yet. Polling without waiting for a full paint keeps the assertion deterministic on a slow machine.
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBe('dark');
    expect(stylesheetsServed, 'no stylesheet may answer before the theme is on <html>').toBe(0);
    const stored = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, scheme: document.documentElement.style.colorScheme }));
    expect(stored.scheme).toBe('dark');
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const booted = await page.evaluate(() => {
      const boot = document.querySelector('script[src="/theme-boot.js"]');
      const firstSheet = document.querySelector('link[rel="stylesheet"]');
      if (!boot || !firstSheet) return { found: false };
      return { found: true, before: !!(boot.compareDocumentPosition(firstSheet) & Node.DOCUMENT_POSITION_FOLLOWING), deferred: boot.defer || boot.async };
    });
    expect(booted.found).toBe(true);
    expect(booted.before).toBe(true);
    expect(booted.deferred).toBe(false);

    // No stored choice: the system decides, and no data-theme is written (that attribute means a manual override).
    await page.unroute('**/*.css');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => localStorage.removeItem('launchpad.theme'));
    await page.reload();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const system = await surfaces(page);
    expect(system.htmlTheme).toBeNull();
    expect(system.colorScheme).toBe('dark');
    expect(rgb(system.body.background)).toEqual([15, 20, 27]);
  } finally { await h.stop(); }
});

test('#750 the three-way choice is stored, survives a reload and beats the system preference', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness();
  try {
    const { admin, password } = await setup(h);
    await account(admin);
    await signIn(page, h, password);
    await page.goto(h.admin + '/#/identity');
    const group = page.getByRole('radiogroup', { name: '外观主题' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('radio', { name: '跟随系统', exact: true })).toBeChecked();

    await page.emulateMedia({ colorScheme: 'dark' });
    await group.getByRole('radio', { name: '深色', exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('launchpad.theme'))).toBe('dark');
    await page.reload();
    await expect(page.getByRole('radiogroup', { name: '外观主题' }).getByRole('radio', { name: '深色', exact: true })).toBeChecked();
    const dark = await surfaces(page);
    expect(dark.htmlTheme).toBe('dark');
    expect(rgb(dark.body.background)).toEqual([15, 20, 27]);

    // Manual light while the system is dark: the media query must not win.
    await page.getByRole('radiogroup', { name: '外观主题' }).getByRole('radio', { name: '浅色', exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(LIGHT_BG);
    // And back to system: the system's dark applies again without reloading, and the manual attribute is gone.
    await page.getByRole('radiogroup', { name: '外观主题' }).getByRole('radio', { name: '跟随系统', exact: true }).check();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBeNull();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(15, 20, 27)');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(LIGHT_BG);
  } finally { await h.stop(); }
});

test('#750 dark theme paints login, project list, global settings and the confirmation dialog without overflow', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');

    // Login page, signed out.
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(h.admin + '/');
      await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
      const login = await surfaces(page);
      expect(login.overflow, `login ${width}`).toBeLessThanOrEqual(0);
      expect(rgb(login.body.background)).toEqual([15, 20, 27]);
      readable(login.heading, 4.5, `login h1 ${width}`);
      if (login.muted) readable(login.muted, 4.5, `login muted ${width}`);
      await page.screenshot({ path: `${out}/dark-login-${width}.png`, fullPage: true });
    }

    await signIn(page, h, password);
    await expect(page.locator('#rows')).toBeVisible();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(h.admin + '/#/projects');
      await expect(page.locator('#page-title')).toHaveText('项目');
      const list = await surfaces(page);
      expect(list.overflow, `projects ${width}`).toBeLessThanOrEqual(0);
      expect(rgb(list.body.background)).toEqual([15, 20, 27]);
      readable(list.heading, 4.5, `projects h1 ${width}`);
      if (list.muted) readable(list.muted, 4.5, `projects muted ${width}`);
      await page.screenshot({ path: `${out}/dark-projects-${width}.png`, fullPage: true });

      await page.goto(h.admin + '/#/settings/work-computers');
      await expect(page.locator('#settings-panel')).toContainText('工作电脑');
      const settings = await surfaces(page);
      expect(settings.overflow, `settings ${width}`).toBeLessThanOrEqual(0);
      const card = page.locator('#settings-panel .side-card').first();
      const cardColours = await card.evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
      expect(rgb(cardColours.background)).toEqual([22, 29, 39]);
      readable(cardColours, 4.5, `settings card ${width}`);
      await page.screenshot({ path: `${out}/dark-settings-${width}.png`, fullPage: true });

      await page.evaluate(() => { void confirmDialog({ title: '删除项目 fixture/project-101？', action: '删除', danger: true, body: ['项目下的任务与记录会一并删除。'] }); });
      const dialog = page.locator('dialog.confirm-dialog');
      await expect(dialog).toBeVisible();
      const dialogColours = await dialog.evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
      expect(rgb(dialogColours.background)).toEqual([22, 29, 39]);
      readable(dialogColours, 4.5, `confirm ${width}`);
      expect(await dialog.evaluate((node) => node.getBoundingClientRect().right <= innerWidth + 0.5)).toBe(true);
      await page.screenshot({ path: `${out}/dark-confirm-${width}.png`, fullPage: true });
      await page.evaluate(() => document.querySelector('dialog.confirm-dialog')?.close());
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// Review of the first version: dark tokens were in place, but the task detail, the project list head and the project
// page still painted their own light values, so dark text landed on a white card (1.09:1 – 2.09:1). These surfaces
// now read the same tokens in dark; the light baseline is untouched and stays covered by the shots in the PR.
async function colours(page, selectors) {
  return page.evaluate((list) => {
    const parse = (c) => c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)?.slice(1).map(Number) || null;
    const paint = (el) => {
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && bg !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(bg)) return bg;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    return list.map((selector) => {
      const el = document.querySelector(selector);
      if (!el) return { selector, missing: true };
      const style = getComputedStyle(el);
      return { selector, color: style.color, background: paint(el) };
    });
  }, selectors);
}

test('#750 dark theme keeps the task detail, project head and project page readable', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness();
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');
    h.store.run("UPDATE repositories SET full_name=?, owner_id=? WHERE id=?", 'fixture/project-101', '20', '101');
    h.store.run(
      "INSERT INTO tasks(id,repository_id,kind,status,priority,summary,object_number,phase,result,created_at,updated_at) VALUES('t-750','101','development.issue','running','P1','控制台深色主题：跟随系统与手动三态',750,'model',?,'2026-11-18T08:00:00Z','2026-11-18T08:12:00Z')",
      JSON.stringify({ pr_number: 1067, branch: 'feat/theme-750', sha: '4'.repeat(40) }),
    );
    await page.emulateMedia({ colorScheme: 'dark' });
    await signIn(page, h, password, '');

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const pages = [
        ['#/tasks/t-750', ['pre.output', '.step', '.task-side', '.task-archive-body', '.back-link']],
        ['#/projects', [':is(#rows[data-view=projects], .global-project-table) .project-table-head', '.project-owner-bar']],
        ['#/projects/101/overview', ['.project-page']],
      ];
      for (const [hash, selectors] of pages) {
        await page.goto(h.admin + '/' + hash);
        await page.waitForFunction(() => (document.getElementById('console-page')?.innerText || document.querySelector('#workspace')?.innerText || '').trim().length > 0);
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(600);
        const measured = await colours(page, selectors);
        for (const sample of measured) {
          if (sample.missing) continue;
          readable(sample, 4.5, `${hash} ${sample.selector} ${width}`);
        }
        // Nothing in dark may sit on a white card: every measured background has to be one of the dark tokens.
        for (const sample of measured) {
          if (sample.missing) continue;
          const [r, g, b] = rgb(sample.background);
          expect(r + g + b, `${hash} ${sample.selector} ${width} background ${sample.background}`).toBeLessThan(200);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${hash} ${width} overflow`).toBeLessThanOrEqual(0);
      }
    }
  } finally { await h.stop(); }
});
