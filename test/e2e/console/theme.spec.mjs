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

// The first review found dark tokens in place while the task detail, the project list head and the project page still
// painted their own light values (1.09 – 2.09:1). The next ones found the same on the task goal box, the step and role
// folds, the cancel button and the project detail tabs. Every one of those rules keeps its light value and is repainted
// from the two dark blocks in static/views.css, so this test measures both halves: the dark reads at 390 and 1440, and
// the light values that must stay exactly as they were at the base.
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
      const box = el.getBoundingClientRect();
      // Review of 10892948: a hidden skeleton used to count as covered. An element only counts when the reader
      // could actually see it, so a hidden one fails the same way a missing one does.
      const visible = !!el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) && box.width > 1 && box.height > 1;
      return { selector, color: style.color, background: paint(el), visible };
    });
  }, selectors);
}

function rendered(sample, label) {
  expect(sample.missing, `${label} must exist`).toBeFalsy();
  expect(sample.visible, `${label} must be visible, not hidden markup`).toBe(true);
}

function darkCard(sample, label) {
  const [r, g, b] = rgb(sample.background);
  expect(r + g + b, `${label} background ${sample.background}`).toBeLessThan(200);
}

const DARK_TASK_DETAIL = [
  'pre.output', '.step', '.task-side', '.task-archive-body', '.back-link',
  '.task-goal-box', '.task-goal-line', '.task-next-text', '.task-ext-label', '.task-archive-fold > summary',
  '.live', '.task-metrics', '.task-cancel-btn',
  '.step-fold-title', '.step-fold-num', '.step-fold-meta', '.step-fold-summary',
  '.role-run-title-row', '.role-run-meta', '.role-run-summary',
];

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
    // Review of 10892948: .step and the step/role folds only exist once a run has receipts, so the fixture used to leave
    // them hidden and the test passed without measuring them. One finished run with one tool log renders the real folds.
    h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,ended_at,status,context_snapshot,config_snapshot,role) VALUES('run-1','t-750','execution',1,1,'2026-11-18T08:00:00Z','2026-11-18T08:10:00Z','done','{}','{}','dev')");
    h.store.run("INSERT INTO task_logs(id,task_id,content,created_at,run_id,role) VALUES('l-750','t-750',?,?, 'run-1','dev')",
      JSON.stringify({ type: 'tool', name: 'read', summary: '读取 static/views.css', ok: true }), '2026-11-18T08:05:00Z');
    await page.emulateMedia({ colorScheme: 'dark' });
    await signIn(page, h, password, '');

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const pages = [
        ['#/tasks/t-750', DARK_TASK_DETAIL],
        ['#/projects', width === 390 ? ['.project-owner-bar'] : [':is(#rows[data-view=projects], .global-project-table) .project-table-head', '.project-owner-bar']],
        ['#/projects/101/overview', ['.project-page', '.workbench-tab', '.workbench-tab[aria-current=page]', '.workbench-quick-link', '.workbench-live-stats', '.role-backend-line', '.role-board-row', ...(width === 390 ? ['.role-mobile-label'] : [])]],
      ];
      for (const [hash, selectors] of pages) {
        await page.goto(h.admin + '/' + hash);
        await page.waitForFunction(() => (document.getElementById('console-page')?.innerText || document.querySelector('#workspace')?.innerText || '').trim().length > 0);
        await page.waitForLoadState('networkidle').catch(() => {});
        // The folds are closed by default; opening them is what a reader does before the step text is on screen.
        await page.evaluate(() => document.querySelectorAll('details').forEach((node) => { node.open = true; }));
        await page.waitForTimeout(600);
        const measured = await colours(page, selectors);
        for (const sample of measured) {
          rendered(sample, `${hash} ${sample.selector} ${width}`);
          readable(sample, 4.5, `${hash} ${sample.selector} ${width}`);
          darkCard(sample, `${hash} ${sample.selector} ${width}`);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${hash} ${width} overflow`).toBeLessThanOrEqual(0);
      }
    }

    // The row, switch and preview hover fills stayed light, so the row name read 1.14:1 and the preview link 1.99:1 on
    // hover. Hover for real and measure what a reader sees.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/');
    await page.waitForSelector('#rows .project-list-row');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('#rows .project-list-row').first().hover();
    await page.waitForTimeout(250);
    const hovered = await colours(page, ['.project-list-row', '.project-cell strong', '.project-task-preview']);
    for (const sample of hovered) {
      rendered(sample, `hover ${sample.selector}`);
      readable(sample, 4.5, `hover ${sample.selector}`);
      darkCard(sample, `hover ${sample.selector}`);
    }
    await page.locator('#rows .project-task-preview').first().hover();
    await page.waitForTimeout(250);
    readable((await colours(page, ['.project-task-preview']))[0], 4.5, 'hover .project-task-preview');

    // The project detail tabs, the current tab, the footer link and the role-board row hover kept their light values
    // (1.51 / 1.59 / 1.14 / 3.00:1). Measure the computed pairs at both layouts, and hover the row for real because its
    // fill only changes on hover.
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(h.admin + '/#/projects/101/overview');
      await page.waitForSelector('.role-board-row');
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
      for (const sample of await colours(page, ['.workbench-tab', '.workbench-tab[aria-current=page]', '.workbench-quick-link', '.role-board-row'])) {
        rendered(sample, `project detail ${sample.selector} ${width}`);
        readable(sample, 4.5, `project detail ${sample.selector} ${width}`);
        darkCard(sample, `project detail ${sample.selector} ${width}`);
      }
      await page.locator('.role-board-row').first().hover();
      await page.waitForTimeout(250);
      for (const sample of await colours(page, ['.role-board-row', '.role-board-row .role-title-line'])) {
        rendered(sample, `project detail hover ${sample.selector} ${width}`);
        readable(sample, 4.5, `project detail hover ${sample.selector} ${width}`);
        darkCard(sample, `project detail hover ${sample.selector} ${width}`);
      }
    }

    // The other half of the contract: in light every one of those rules paints the value it painted at the base. This
    // is the check behind "the light baseline does not move"; the before/after shots carry the pixel proof.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(h.admin + '/#/projects/101/overview');
    await page.waitForSelector('.role-board-row');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
    for (const sample of await colours(page, ['.workbench-tab', '.workbench-quick-link', '.workbench-live-stats', '.role-backend-line'])) {
      rendered(sample, `light project detail ${sample.selector}`);
      // The fixture has a single tab and it is the current one, so it paints --color-brand; the non-current tab keeps
      // #334155 and is pinned in test/ut/static/console-tokens.test.mjs instead. `.role-backend-line` carries the
      // `muted` class, and `shell.css`'s `.console-ready .muted` wins over workspace.css in both themes.
      const expected = { '.workbench-tab': 'rgb(36, 93, 224)', '.workbench-quick-link': 'rgb(36, 93, 224)', '.workbench-live-stats': 'rgb(71, 85, 105)', '.role-backend-line': 'rgb(96, 112, 135)' }[sample.selector];
      expect(sample.color, `light project detail ${sample.selector} keeps its base colour`).toBe(expected);
    }
    await page.locator('.role-board-row').first().hover();
    await page.waitForTimeout(250);
    expect((await colours(page, ['.role-board-row']))[0].background, 'light role board hover keeps #fafcfe').toBe('rgb(250, 252, 254)');
    await page.goto(h.admin + '/#/tasks/t-750');
    await page.waitForSelector('.task-next-text');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.evaluate(() => document.querySelectorAll('details').forEach((node) => { node.open = true; }));
    await page.waitForTimeout(500);
    const light = await colours(page, ['.task-next-text', '.task-ext-label', '.task-archive-fold > summary', '.step-fold-num', '.step-fold-meta', '.task-goal-box', '.live', '.task-metrics', '.task-cancel-btn']);
    const LIGHT_VALUES = {
      '.task-next-text': ['color', 'rgb(71, 85, 105)'],
      '.task-ext-label': ['color', 'rgb(71, 85, 105)'],
      '.task-archive-fold > summary': ['color', 'rgb(71, 85, 105)'],
      '.step-fold-num': ['color', 'rgb(71, 85, 105)'],
      '.step-fold-meta': ['color', 'rgb(71, 85, 105)'],
      '.task-goal-box': ['background', 'rgb(248, 250, 252)'],
      '.live': ['color', 'rgb(44, 87, 145)'],
      '.task-metrics': ['color', 'rgb(82, 110, 124)'],
      // The cancel button is `.quiet`, so `button.quiet` paints --color-text in light; its red is a dark-only value.
      '.task-cancel-btn': ['color', 'rgb(23, 36, 59)'],
    };
    for (const sample of light) {
      rendered(sample, `light task detail ${sample.selector}`);
      const [key, value] = LIGHT_VALUES[sample.selector];
      expect(sample[key], `light task detail ${sample.selector} keeps ${value}`).toBe(value);
    }
  } finally { await h.stop(); }
});
