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
  // Review of 5084b13c: the role run fold body and its findings were never repainted in dark.
  '.role-run-fold', '.role-run-fold .role-step-toolbar > .muted', '.role-run-fold .role-empty-steps', '.role-run-findings',
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
    // #750: `.step-fold-stat` and the muted line inside `.step-fold-body` only exist for a log entry the timeline can
    // summarise, so pinning them without this row would pin nothing (the `read` entry above falls through to the raw
    // fallback and renders no badge). `result.bytes` is what the reviewer measured at 2.10:1 on the un-fixed dark block.
    h.store.run("INSERT INTO task_logs(id,task_id,content,created_at,run_id,role) VALUES('l-750b','t-750',?,?, 'run-1','dev')",
      JSON.stringify({ type: 'tool', name: 'read_file', arguments: { path: 'static/views.css' }, result: { bytes: 61234 }, ok: true }), '2026-11-18T08:06:00Z');
    // A `read_file` entry WITH content: the timeline renders it as `pre.output` inside the same fold body, and that
    // node inherits the fold's muted colour in light. Test caught a light baseline move exactly there (the light
    // `pre.output` rule briefly carried `color: var(--color-code-text)`), so it is pinned rather than left implicit.
    h.store.run("INSERT INTO task_logs(id,task_id,content,created_at,run_id,role) VALUES('l-750c','t-750',?,?, 'run-1','dev')",
      JSON.stringify({ type: 'tool', name: 'read_file', arguments: { path: 'static/shell.css' }, result: { bytes: 41, content: ':root{--color-brand:#245de0}' }, ok: true }), '2026-11-18T08:07:00Z');
    // The project detail role board shows a chip only while a role run is running, so one live run keeps the row: the
    // review measured `button.role-task-chip` at 1.12:1 and the running fill at 1.08:1 on a surface that was still light.
    h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role) VALUES('run-2','t-750','execution',2,2,'2026-11-18T08:11:00Z','running','{}','{}','dev')");
    // The findings list inside a role run fold paints #78350f in light and is repainted from --color-warning in dark, so
    // the fixture keeps one reviewer result that carries a finding instead of leaving the list unrendered (review of 5084b13c).
    h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,ended_at,status,context_snapshot,config_snapshot,role,assignment_id) VALUES('run-3','t-750','execution',1,1,'2026-11-18T08:12:00Z','2026-11-18T08:13:00Z','succeeded','{}','{}','reviewer','asg-750')");
    h.store.run("INSERT INTO task_history(task_id,type,data,created_at,run_id,actor) VALUES('t-750','role_handoff',?,'2026-11-18T08:11:30Z','run-3','role:manager')",
      JSON.stringify({ assignment_id: 'asg-750', role: 'reviewer', purpose: '核对深色主题的对比度' }));
    h.store.run("INSERT INTO task_history(task_id,type,data,created_at,run_id,actor) VALUES('t-750','role_result',?,'2026-11-18T08:13:00Z','run-3','role:reviewer')",
      JSON.stringify({ role: 'reviewer', assignment_id: 'asg-750', result: { summary: '退回 1 项问题', findings: [{ description: '深色下折叠体仍是白纸', evidence: ['static/views.css'] }], inspected_scope: ['static/'], unknowns: [] } }));
    await page.emulateMedia({ colorScheme: 'dark' });
    await signIn(page, h, password, '');

    for (const width of [768, 390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const pages = [
        ['#/tasks/t-750', DARK_TASK_DETAIL],
        ['#/projects', width >= 1280 ? [':is(#rows[data-view=projects], .global-project-table) .project-table-head', '.project-owner-bar'] : ['.project-owner-bar']],
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
    // (1.51 / 1.59 / 1.14 / 3.00:1). Measure the computed pairs at 768/1440/390, and hover the row for real because its
    // fill only changes on hover.
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(h.admin + '/#/projects/101/overview');
      await page.waitForSelector('.role-board-row');
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
      for (const sample of await colours(page, ['.workbench-tab:not([aria-current=page])', '.workbench-tab[aria-current=page]', '.workbench-quick-link', '.role-board-row'])) {
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
      // The tab hover is a state, not a resting value: views.css:1057/:1104 repaint a hovered tab with --color-hover.
      // This is the state that produced e2e run 44710842421 (a pointer left on a tab at 768), so it is driven here for
      // both tabs at all three widths instead of being inferred from the resting rows.
      for (const [selector, color] of [
        ['.workbench-tab:not([aria-current=page])', 'rgb(231, 237, 246)'],
        // The current tab keeps --color-brand-text (views.css:1058/:1105) while the hover rule supplies the fill.
        ['.workbench-tab[aria-current=page]', 'rgb(150, 180, 255)'],
      ]) {
        // The strip renders several non-current tabs (`main` added a third view), so the hover targets the first one;
        // `colours()` reads the first match too, which keeps the hovered node and the measured node the same.
        await page.locator(selector).first().hover();
        await page.waitForTimeout(250);
        const hovered = (await colours(page, [selector]))[0];
        rendered(hovered, `tab hover ${selector} ${width}`);
        readable(hovered, 4.5, `tab hover ${selector} ${width}`);
        darkCard(hovered, `tab hover ${selector} ${width}`);
        expect(hovered.background, `dark tab hover ${selector} ${width}`).toBe('rgb(29, 39, 51)');
        expect(hovered.color, `dark tab hover ${selector} ${width}`).toBe(color);
        await page.mouse.move(0, 0);
      }
    }

    // The rest of the project detail the review measured: the role task chip in its three states, the tab count badge,
    // the filter pills and the task row hover. Each is measured at 1440/768/390; the chip has to exist, so the fixture
    // keeps one running role run (see the seed above) instead of letting a hidden element pass again.
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(h.admin + '/#/projects/101/overview');
      await page.waitForSelector('button.role-task-chip');
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
      const chipStates = await page.evaluate(() => {
        const el = document.querySelector('button.role-task-chip');
        const read = () => { const style = getComputedStyle(el); return { color: style.color, background: style.backgroundColor }; };
        const running = read();
        el.classList.remove('role-task-running');
        const plain = read();
        el.classList.add('role-task-running');
        return { plain, running };
      });
      readable(chipStates.plain, 4.5, `chip plain ${width}`);
      darkCard(chipStates.plain, `chip plain ${width}`);
      readable(chipStates.running, 4.5, `chip running ${width}`);
      darkCard(chipStates.running, `chip running ${width}`);
      await page.locator('button.role-task-chip').first().hover();
      await page.waitForTimeout(250);
      const chipHover = (await colours(page, ['button.role-task-chip']))[0];
      rendered(chipHover, `chip hover ${width}`);
      readable(chipHover, 4.5, `chip hover ${width}`);
      darkCard(chipHover, `chip hover ${width}`);
      for (const sample of await colours(page, ['.role-chip-summary', '.workbench-tab[aria-current=page] .workbench-tab-count'])) {
        rendered(sample, `chip row ${sample.selector} ${width}`);
        readable(sample, 4.5, `chip row ${sample.selector} ${width}`);
        darkCard(sample, `chip row ${sample.selector} ${width}`);
      }
      // The pills live in the tasks view: the plain one keeps --color-text-muted and the selected one brand-text on
      // brand-weak. `tasks.active` selects the second pill, so both are on screen at once.
      await page.goto(h.admin + '/#/projects/101/overview/tasks.active');
      await page.waitForSelector('.workbench-filter-pill[aria-current=page]');
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
      for (const sample of await colours(page, ['.workbench-filter-pill', '.workbench-filter-pill[aria-current=page]', '.workbench-task-row'])) {
        rendered(sample, `tasks ${sample.selector} ${width}`);
        readable(sample, 4.5, `tasks ${sample.selector} ${width}`);
        darkCard(sample, `tasks ${sample.selector} ${width}`);
      }
      await page.locator('.workbench-task-row').first().hover();
      await page.waitForTimeout(250);
      const rowHover = (await colours(page, ['.workbench-task-row']))[0];
      rendered(rowHover, `task row hover ${width}`);
      readable(rowHover, 4.5, `task row hover ${width}`);
      darkCard(rowHover, `task row hover ${width}`);
    }

    // The other half of the contract: in light every one of those rules paints the value it painted at the base. This
    // is the check behind "the light baseline does not move"; the before/after shots carry the pixel proof.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(h.admin + '/#/projects/101/overview');
    await page.waitForSelector('.role-board-row');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
    for (const sample of await colours(page, ['.workbench-tab:not([aria-current=page])', '.workbench-quick-link', '.workbench-live-stats', '.role-backend-line'])) {
      rendered(sample, `light project detail ${sample.selector}`);
      // The tab strip renders both views, so the strip is measured in both states: the one without `aria-current` keeps
      // `#334155` (workspace.css, not a token) and is its own PIN_TABLE row; the current one paints --color-brand.
      // `.role-backend-line` carries the `muted` class, and `shell.css`'s `.console-ready .muted` wins over workspace.css
      // in both themes.
      const expected = { '.workbench-tab:not([aria-current=page])': 'rgb(51, 65, 85)', '.workbench-quick-link': 'rgb(36, 93, 224)', '.workbench-live-stats': 'rgb(71, 85, 105)', '.role-backend-line': 'rgb(96, 112, 135)' }[sample.selector];
      expect(sample.color, `light project detail ${sample.selector} keeps its base colour`).toBe(expected);
    }
    await page.locator('.role-board-row').first().hover();
    await page.waitForTimeout(250);
    expect((await colours(page, ['.role-board-row']))[0].background, 'light role board hover keeps #fafcfe').toBe('rgb(250, 252, 254)');
    // Light keeps its own hover rule from workspace.css: the non-current tab washes to rgba(255,255,255,.7) with
    // --color-text, and the current tab keeps its surface fill and --color-brand because its [aria-current] rule wins.
    // This is a state and it is viewport-dependent, so it is driven at 1440/768/390 like the dark hover above: left
    // outside the dark loop it silently measured whichever width that loop ended on (390), which is how the review
    // found the "three widths" claim overstated. The loop leaves the viewport at 390, the width the chip block below
    // has always measured at.
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(h.admin + '/#/projects/101/overview');
      await page.waitForSelector('.workbench-tab');
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
      for (const [selector, background, color] of [
        ['.workbench-tab:not([aria-current=page])', 'rgba(255, 255, 255, 0.7)', 'rgb(23, 36, 59)'],
        ['.workbench-tab[aria-current=page]', 'rgb(255, 255, 255)', 'rgb(36, 93, 224)'],
      ]) {
        await page.locator(selector).first().hover();
        await page.waitForTimeout(250);
        const hovered = (await colours(page, [selector]))[0];
        rendered(hovered, `light tab hover ${selector} ${width}`);
        readable(hovered, 4.5, `light tab hover ${selector} ${width}`);
        expect(hovered.background, `light tab hover ${selector} ${width} background`).toBe(background);
        expect(hovered.color, `light tab hover ${selector} ${width} colour`).toBe(color);
        await page.mouse.move(0, 0);
      }
    }
    await page.goto(h.admin + '/#/projects/101/overview');
    await page.waitForSelector('button.role-task-chip');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
    const lightChip = await page.evaluate(() => {
      const el = document.querySelector('button.role-task-chip');
      const read = () => { const style = getComputedStyle(el); return { color: style.color, background: style.backgroundColor }; };
      const running = read();
      el.classList.remove('role-task-running');
      const plain = read();
      el.classList.add('role-task-running');
      return { plain, running, badge: (() => { const b = document.querySelector('.workbench-tab[aria-current=page] .workbench-tab-count'); const style = getComputedStyle(b); return { color: style.color, background: style.backgroundColor }; })() };
    });
    // The chip is also `.quiet`, so `button.quiet` paints white in light and the module fill is a dark-only value.
    expect(lightChip.plain.background, 'light chip keeps white').toBe('rgb(255, 255, 255)');
    expect(lightChip.plain.color, 'light chip keeps --color-text').toBe('rgb(23, 36, 59)');
    expect(lightChip.running.background, 'light running chip keeps #eff6ff').toBe('rgb(239, 246, 255)');
    expect(lightChip.badge.color, 'light tab count keeps --color-brand').toBe('rgb(36, 93, 224)');
    expect(lightChip.badge.background, 'light tab count keeps --color-brand-weak').toBe('rgb(237, 242, 255)');
    await page.locator('button.role-task-chip').first().hover();
    await page.waitForTimeout(250);
    expect((await colours(page, ['button.role-task-chip']))[0].background, 'light chip hover keeps #f0f9ff').toBe('rgb(240, 249, 255)');
    await page.goto(h.admin + '/#/projects/101/overview/tasks.active');
    await page.waitForSelector('.workbench-filter-pill[aria-current=page]');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
    const lightPills = await colours(page, ['.workbench-filter-pill', '.workbench-filter-pill[aria-current=page]']);
    expect(lightPills[0].color, 'light plain pill keeps #334155').toBe('rgb(51, 65, 85)');
    expect(lightPills[1].color, 'light selected pill keeps --color-brand').toBe('rgb(36, 93, 224)');
    expect(lightPills[1].background, 'light selected pill keeps --color-brand-weak').toBe('rgb(237, 242, 255)');
    await page.locator('.workbench-task-row').first().hover();
    await page.waitForTimeout(250);
    expect((await colours(page, ['.workbench-task-row']))[0].background, 'light task row hover keeps #fafcfe').toBe('rgb(250, 252, 254)');
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

    // The review of 5084b13c caught the other half of the same contract: seven light declarations had been pointed at
    // theme tokens, so the light baseline moved (#a02b31 -> #ad3039 and friends). They are literals again and only the
    // two dark blocks repaint them; these pins are what makes a future token swap fail here instead of on the review.
    await page.goto(h.admin + '/#/settings/work-computers');
    await page.waitForSelector('.settings-body');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.settings-body')).borderTopColor),
      'light settings body keeps #e3eaf0').toBe('rgb(227, 234, 240)');
    // No view renders `.settings-rows` today; probing the rule keeps the pin alive for the view that will.
    expect(await page.evaluate(() => {
      const host = document.querySelector('.settings-body'), probe = document.createElement('div');
      probe.className = 'settings-rows'; host.append(probe);
      const value = getComputedStyle(probe).borderTopColor; probe.remove(); return value;
    }), 'light settings rows keep #e8eef2').toBe('rgb(232, 238, 242)');

    // The audit page is not in the evidence set, so this is the only record that its pressed pill is #e8f3f4 in light.
    await page.goto(h.admin + '/#/projects/101/activity');
    await page.waitForSelector('.audit-filters button[aria-pressed=true]');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.audit-filters button[aria-pressed=true]')).backgroundColor),
      'light audit pill keeps #e8f3f4').toBe('rgb(232, 243, 244)');

    // The confirmation dialog's four light values, including the error line a failed action writes.
    await page.evaluate(() => { void confirmDialog({ title: '删除项目 fixture/project-101？', action: '删除', danger: true, input: { label: '确认名称' },
      body: ['项目下的任务与记录会一并删除。'], run: () => Promise.reject(new Error('fixture_refused')) }); });
    const lightDialog = page.locator('dialog.confirm-dialog');
    await expect(lightDialog).toBeVisible();
    const lightConfirm = await lightDialog.evaluate((node) => {
      const read = (selector, key) => { const el = node.querySelector(selector); return el ? getComputedStyle(el)[key] : null; };
      return {
        iconBackground: read('.confirm-icon.danger', 'backgroundColor'), iconColor: read('.confirm-icon.danger', 'color'),
        label: read('.confirm-body label', 'color'),
        actionsBackground: read('.confirm-actions', 'backgroundColor'), actionsBorder: read('.confirm-actions', 'borderTopColor'),
      };
    });
    expect(lightConfirm.iconBackground, 'light danger icon keeps #fbeaea').toBe('rgb(251, 234, 234)');
    expect(lightConfirm.iconColor, 'light danger icon keeps #a02b31').toBe('rgb(160, 43, 49)');
    expect(lightConfirm.label, 'light confirm label keeps #22313a').toBe('rgb(34, 49, 58)');
    expect(lightConfirm.actionsBackground, 'light confirm actions keep #f6f9fa').toBe('rgb(246, 249, 250)');
    expect(lightConfirm.actionsBorder, 'light confirm actions keep #e3eaf0').toBe('rgb(227, 234, 240)');
    await lightDialog.getByRole('button', { name: '删除', exact: true }).click();
    await expect(lightDialog.locator('.confirm-status.error')).toBeVisible();
    expect(await lightDialog.evaluate((node) => getComputedStyle(node.querySelector('.confirm-status.error')).color),
      'light confirm error keeps #a02b31').toBe('rgb(160, 43, 49)');
    await page.evaluate(() => document.querySelector('dialog.confirm-dialog')?.close());
  } finally { await h.stop(); }
});

// Chief 2026-11-20: every rule inside the two dark blocks must be pinned by its measured value, in dark and in light,
// not only by "contrast >= 4.5". A token swap that loses one dark override then fails for its author, not for the
// reviewer. Hover-only and state-variant rules stay where they are measured by driving them (see the test above); this
// table covers every rule whose painted value can be read in a resting state. `::before` parts are read through
// getComputedStyle(el, '::before'); the background of a text element is the surface it is painted on, resolved through
// its ancestors, because a transparent computed background says nothing about what a reader sees.
// `main` removed the overview capability card in #1123 (`e431a703`, after this branch started). The two
// `.capability-links a` rows are gone from both tables, but the two dark overrides stay in `static/views.css`
// (`:1079-1082`, `:1124-1127`) on purpose: this head's own base still renders the card, so deleting the overrides would
// regress the head itself. Pin rows removed, overrides retained -- after the merge they are dead code.
const PIN_ROWS = [
  ['task', '.step'], ['task', '.task-side'], ['task', '.task-archive-body'], ['task', 'pre.output'],
  ['task', '.task-goal-box'], ['task', '.role-run-conclusion'], ['task', '.role-run-summary'],
  ['task', '.task-next-text'], ['task', '.task-ext-label'], ['task', '.step-fold-num'], ['task', '.step-fold-meta'], ['task', '.step-fold-stat'],
  ['task', '.step-fold-body'], ['task', '.step-fold-body .muted'], ['task', '.step-fold-body pre.output'], ['task', '.task-archive-body pre.output'],
  ['task', '.role-run-brief'], ['task', '.role-run-meta'], ['task', '.task-archive-fold > summary'],
  ['task', '.task-metrics'], ['task', '.live'], ['task', '.task-cancel-btn'], ['task', '.task-elapsed-chip'],
  ['task', '.role-run-fold'], ['task', '.role-run-fold.role-run-running'],
  ['task', '.role-run-fold.role-run-returned'], ['taskpaused', '.role-run-fold.role-run-paused'],
  ['task', '.role-run-findings'],
  ['task', '.role-step-toolbar > .muted'], ['task', '.role-empty-steps'],
  ['task', '.live::before'], ['overview', '.role-chip-time'],
  ['task', '.step-fold-title::before'], ['task', '.role-run-title-row::before'], ['task', '.task-archive-fold > summary::before'],
  ['projects', '.project-owner-bar'], ['projects', '.project-table-head'],
  ['overview', '.project-page'], ['overview', '.workbench-tab:not([aria-current=page])'],
  ['overview', '.workbench-tab[aria-current=page]'], ['overview', '.workbench-tab[aria-current=page] .workbench-tab-count'],
  ['overview', '.workbench-quick-link'], ['overview', '.workbench-live-stats'], ['overview', '.role-backend-line'], ['overview', '.role-board-table'],
  ['overview', '.role-chip-ref'], ['overview', '.role-chip-summary'],
  ['tasks', '.workbench-filter-pill'], ['tasks', '.workbench-filter-pill[aria-current=page]'],
  ['settings', '.settings-body'], ['settings', '.project-nav'], ['settings', '.settings-rows'],
  ['audit', '.audit-filters button[aria-pressed=true]'],
  ['confirm', '.confirm-icon.danger'], ['confirm', '.confirm-body label'], ['confirm', '.confirm-actions'],
  ['confirm', '.confirm-status.error'], ['confirm', '.confirm-status.progress'],
];

// The values below were measured on this head, once, and are now the pin: [page, selector, dark [color, background],
// light [color, background], optional darkBorder, lightBorder]. The light column is what this head paints in light.
// For the 17 frames that compare to b6b67bbf at 0 px it is also the base value; the three task frames are not 0 px
// (they carry live request-generated values), and their light values were measured on both trees instead of being
// inferred from a pixel count. The two `pre.output` rows differ on purpose: `.step-fold-body pre.output` inherits the
// body text colour on the base (that fold has no `.fold` ancestor), while `.task-archive-body pre.output` inherits
// `.fold`'s muted colour — pinning either to the other's value would lock a drift as the baseline.
// A border pin exists where the base paints a border that a token swap had already moved once
// (settings / confirm / role-run folds): color+background alone would not catch that drift.
const PIN_TABLE = [
  ['task', '.step', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)']],
  ['task', '.task-side', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(248, 250, 252)']],
  ['task', '.task-archive-body', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(248, 250, 252)']],
  ['task', 'pre.output', ['rgb(231, 237, 246)', 'rgb(27, 36, 48)'], ['rgb(23, 36, 59)', 'rgb(245, 248, 250)']],
  ['task', '.task-goal-box', ['rgb(231, 237, 246)', 'rgb(27, 36, 48)'], ['rgb(23, 36, 59)', 'rgb(248, 250, 252)']],
  ['task', '.role-run-conclusion', ['rgb(231, 237, 246)', 'rgb(27, 36, 48)'], ['rgb(23, 36, 59)', 'rgb(248, 250, 252)']],
  ['task', '.role-run-summary', ['rgb(231, 237, 246)', 'rgb(27, 36, 48)'], ['rgb(23, 36, 59)', 'rgb(248, 250, 252)']],
  ['task', '.task-next-text', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(71, 85, 105)', 'rgb(255, 255, 255)']],
  ['task', '.task-ext-label', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(71, 85, 105)', 'rgb(255, 255, 255)']],
  ['task', '.step-fold-num', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(71, 85, 105)', 'rgb(255, 255, 255)']],
  ['task', '.step-fold-meta', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(71, 85, 105)', 'rgb(255, 255, 255)']],
  ['task', '.role-run-brief', ['rgb(163, 179, 199)', 'rgb(27, 36, 48)'], ['rgb(71, 85, 105)', 'rgb(248, 250, 252)']],
  ['task', '.role-run-meta', ['rgb(163, 179, 199)', 'rgb(27, 36, 48)'], ['rgb(71, 85, 105)', 'rgb(248, 250, 252)']],
  ['task', '.task-archive-fold > summary', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(71, 85, 105)', 'rgb(255, 255, 255)']],
  ['task', '.task-metrics', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(82, 110, 124)', 'rgb(255, 255, 255)']],
  ['task', '.live', ['rgb(168, 198, 245)', 'rgb(22, 29, 39)'], ['rgb(44, 87, 145)', 'rgb(255, 255, 255)']],
  ['task', '.task-cancel-btn', ['rgb(255, 156, 156)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)']],
  ['task', '.task-elapsed-chip', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(96, 112, 135)', 'rgb(255, 255, 255)']],
  ['task', '.role-run-fold', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)'], 'rgb(85, 104, 138)', 'rgb(219, 228, 238)'],
  ['task', '.role-run-fold.role-run-running', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)'], 'rgb(45, 69, 112)', 'rgb(96, 165, 250)'],
  ['task', '.role-run-fold.role-run-returned', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)'], 'rgb(107, 85, 36)', 'rgb(252, 211, 77)'],
  ['taskpaused', '.role-run-fold.role-run-paused', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)'], 'rgb(107, 85, 36)', 'rgb(252, 211, 77)'],
  ['task', '.role-run-findings', ['rgb(240, 200, 130)', 'rgb(27, 36, 48)'], ['rgb(120, 53, 15)', 'rgb(248, 250, 252)']],
  ['task', '.live::before', ['rgb(168, 198, 245)', 'rgb(168, 198, 245)'], ['rgb(44, 87, 145)', 'rgb(44, 87, 145)']],
  ['overview', '.role-chip-time', ['rgb(163, 179, 199)', 'rgb(22, 35, 58)'], ['rgb(71, 85, 105)', 'rgb(239, 246, 255)']],
  ['task', '.role-step-toolbar > .muted', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(96, 112, 135)', 'rgb(255, 255, 255)']],
  ['task', '.role-empty-steps', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(96, 112, 135)', 'rgb(255, 255, 255)']],
  ['task', '.step-fold-title::before', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(100, 116, 139)', 'rgb(255, 255, 255)']],
  ['task', '.role-run-title-row::before', ['rgb(163, 179, 199)', 'rgb(27, 36, 48)'], ['rgb(71, 85, 105)', 'rgb(248, 250, 252)']],
  ['task', '.task-archive-fold > summary::before', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(100, 116, 139)', 'rgb(255, 255, 255)']],
  ['projects', '.project-owner-bar', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(243, 247, 249)']],
  ['projects', '.project-table-head', ['rgb(163, 179, 199)', 'rgb(27, 36, 48)'], ['rgb(96, 112, 135)', 'rgb(251, 253, 254)']],
  ['overview', '.project-page', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)']],
  ['overview', '.workbench-tab:not([aria-current=page])', ['rgb(163, 179, 199)', 'rgb(27, 36, 48)'], ['rgb(51, 65, 85)', 'rgb(248, 250, 252)']],
  ['overview', '.workbench-tab[aria-current=page]', ['rgb(150, 180, 255)', 'rgb(22, 29, 39)'], ['rgb(36, 93, 224)', 'rgb(255, 255, 255)']],
  ['overview', '.workbench-tab[aria-current=page] .workbench-tab-count', ['rgb(150, 180, 255)', 'rgb(27, 44, 77)'], ['rgb(36, 93, 224)', 'rgb(237, 242, 255)']],
  ['overview', '.workbench-quick-link', ['rgb(150, 180, 255)', 'rgb(22, 29, 39)'], ['rgb(36, 93, 224)', 'rgb(255, 255, 255)']],
  ['overview', '.workbench-live-stats', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(71, 85, 105)', 'rgb(255, 255, 255)']],
  // `.role-backend-line` sits in a role-board row whose fill is a state paint (the board's first row carries
  // --color-surface-alt on some visits and not on others, with the same fixture), so only its colour is pinned here and
  // the surface it is read against is pinned separately as `.role-board-table`. Pinning the row fill would make the
  // table red for a reason that has nothing to do with the dark block.
  ['overview', '.role-backend-line', ['rgb(163, 179, 199)', '*'], ['rgb(96, 112, 135)', '*']],
  ['overview', '.role-board-table', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)']],
  ['overview', '.role-chip-ref', ['rgb(150, 180, 255)', 'rgb(22, 35, 58)'], ['rgb(30, 58, 138)', 'rgb(239, 246, 255)']],
  ['overview', '.role-chip-summary', ['rgb(231, 237, 246)', 'rgb(22, 35, 58)'], ['rgb(23, 36, 59)', 'rgb(239, 246, 255)']],
  ['tasks', '.workbench-filter-pill', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(51, 65, 85)', 'rgb(255, 255, 255)']],
  ['tasks', '.workbench-filter-pill[aria-current=page]', ['rgb(150, 180, 255)', 'rgb(27, 44, 77)'], ['rgb(36, 93, 224)', 'rgb(237, 242, 255)']],
  ['settings', '.settings-body', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)'], 'rgb(85, 104, 138)', 'rgb(227, 234, 240)'],
  ['settings', '.project-nav', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)']],
  ['settings', '.settings-rows', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(23, 36, 59)', 'rgb(255, 255, 255)'], 'rgb(85, 104, 138)', 'rgb(232, 238, 242)'],
  ['audit', '.audit-filters button[aria-pressed=true]', ['rgb(150, 180, 255)', 'rgb(27, 44, 77)'], ['rgb(36, 93, 224)', 'rgb(232, 243, 244)']],
  ['confirm', '.confirm-icon.danger', ['rgb(255, 156, 156)', 'rgb(58, 29, 31)'], ['rgb(160, 43, 49)', 'rgb(251, 234, 234)']],
  ['confirm', '.confirm-body label', ['rgb(231, 237, 246)', 'rgb(22, 29, 39)'], ['rgb(34, 49, 58)', 'rgb(255, 255, 255)']],
  ['confirm', '.confirm-actions', ['rgb(231, 237, 246)', 'rgb(27, 36, 48)'], ['rgb(23, 36, 59)', 'rgb(246, 249, 250)'], 'rgb(85, 104, 138)', 'rgb(227, 234, 240)'],
  ['confirm', '.confirm-status.error', ['rgb(255, 156, 156)', 'rgb(22, 29, 39)'], ['rgb(160, 43, 49)', 'rgb(255, 255, 255)']],
  ['task', '.step-fold-body', ['rgb(231, 237, 246)', 'rgb(27, 36, 48)'], ['rgb(23, 36, 59)', 'rgb(252, 253, 254)'], 'rgb(85, 104, 138)', 'rgb(241, 245, 249)'],
  // #1207 put the step input/output sections inside `.step-fold-body`; the first `.muted` in that body is the
  // section note, and `.step-io-block` is the nearest painted ancestor (white in light, `--color-surface-alt` in
  // dark). The row therefore pins that card, not the fold body it used to sit on.
  ['task', '.step-fold-body .muted', ['rgb(163, 179, 199)', 'rgb(27, 36, 48)'], ['rgb(96, 112, 135)', 'rgb(255, 255, 255)']],
  ['task', '.step-fold-stat', ['rgb(163, 179, 199)', 'rgb(22, 29, 39)'], ['rgb(51, 65, 85)', 'rgb(241, 245, 249)']],
  ['confirm', '.confirm-status.progress', ['rgb(168, 198, 245)', 'rgb(22, 29, 39)'], ['rgb(44, 87, 145)', 'rgb(255, 255, 255)']],
  ['task', '.step-fold-body pre.output', ['rgb(231, 237, 246)', 'rgb(27, 36, 48)'], ['rgb(23, 36, 59)', 'rgb(245, 248, 250)']],
  ['task', '.task-archive-body pre.output', ['rgb(231, 237, 246)', 'rgb(27, 36, 48)'], ['rgb(96, 112, 135)', 'rgb(245, 248, 250)']],
];

async function pinValues(page, rows) {
  return page.evaluate((rows) => {
    // Open every fold in the same task as the read, so a streamed re-render cannot close a fold between "make it
    // visible" and "measure it" — the raw-data fold's `pre.output` is only laid out while its ancestors are open.
    document.querySelectorAll('details').forEach((node) => { node.open = true; });
    const painted = (el) => {
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && bg !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(bg)) return bg;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const out = {};
    for (const [pageName, selector] of rows) {
      const pseudo = selector.includes('::') ? selector.slice(selector.indexOf('::')) : null;
      const base = pseudo ? selector.slice(0, selector.indexOf('::')) : selector;
      const el = document.querySelector(base);
      if (!el) { out[`${pageName} ${selector}`] = { missing: true }; continue; }
      const visible = !!el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 1;
      const style = getComputedStyle(el, pseudo || undefined);
      const own = style.backgroundColor;
      const paints = own && own !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(own);
      out[`${pageName} ${selector}`] = {
        color: style.color,
        background: pseudo && paints ? own : painted(el),
        border: style.borderTopColor,
        visible,
      };
    }
    return out;
  }, rows);
}

test('#750 every dark-block rule keeps its measured value in dark and in light', async ({ page }) => {
  test.setTimeout(420000);
  const h = await harness();
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');
    h.store.run("UPDATE repositories SET full_name=?, owner_id=? WHERE id=?", 'fixture/project-101', '20', '101');
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,priority,summary,object_number,phase,result,created_at,updated_at) VALUES('t-750','101','development.issue','running','P1','控制台深色主题：跟随系统与手动三态',750,'model',?,'2026-11-18T08:00:00Z','2026-11-18T08:12:00Z')",
      JSON.stringify({ pr_number: 1067, branch: 'feat/theme-750', sha: '4'.repeat(40) }));
    h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,ended_at,status,context_snapshot,config_snapshot,role) VALUES('run-1','t-750','execution',1,1,'2026-11-18T08:00:00Z','2026-11-18T08:10:00Z','done','{}','{}','dev')");
    h.store.run("INSERT INTO task_logs(id,task_id,content,created_at,run_id,role) VALUES('l-750','t-750',?,?, 'run-1','dev')",
      JSON.stringify({ type: 'tool', name: 'read', summary: '读取 static/views.css', ok: true }), '2026-11-18T08:05:00Z');
    // #750: `.step-fold-stat` and the muted line inside `.step-fold-body` only exist for a log entry the timeline can
    // summarise, so pinning them without this row would pin nothing (the `read` entry above falls through to the raw
    // fallback and renders no badge). `result.bytes` is what the reviewer measured at 2.10:1 on the un-fixed dark block.
    h.store.run("INSERT INTO task_logs(id,task_id,content,created_at,run_id,role) VALUES('l-750b','t-750',?,?, 'run-1','dev')",
      JSON.stringify({ type: 'tool', name: 'read_file', arguments: { path: 'static/views.css' }, result: { bytes: 61234 }, ok: true }), '2026-11-18T08:06:00Z');
    // A `read_file` entry WITH content: the timeline renders it as `pre.output` inside the same fold body, and that
    // node inherits the fold's muted colour in light. Test caught a light baseline move exactly there (the light
    // `pre.output` rule briefly carried `color: var(--color-code-text)`), so it is pinned rather than left implicit.
    h.store.run("INSERT INTO task_logs(id,task_id,content,created_at,run_id,role) VALUES('l-750c','t-750',?,?, 'run-1','dev')",
      JSON.stringify({ type: 'tool', name: 'read_file', arguments: { path: 'static/shell.css' }, result: { bytes: 41, content: ':root{--color-brand:#245de0}' }, ok: true }), '2026-11-18T08:07:00Z');
    h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role) VALUES('run-2','t-750','execution',2,2,'2026-11-18T08:11:00Z','running','{}','{}','dev')");
    h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,ended_at,status,context_snapshot,config_snapshot,role,assignment_id) VALUES('run-3','t-750','execution',1,1,'2026-11-18T08:12:00Z','2026-11-18T08:13:00Z','succeeded','{}','{}','reviewer','asg-750')");
    h.store.run("INSERT INTO task_history(task_id,type,data,created_at,run_id,actor) VALUES('t-750','role_handoff',?,'2026-11-18T08:11:30Z','run-3','role:manager')",
      JSON.stringify({ assignment_id: 'asg-750', role: 'reviewer', purpose: '核对深色主题的对比度' }));
    h.store.run("INSERT INTO task_history(task_id,type,data,created_at,run_id,actor) VALUES('t-750','role_result',?,'2026-11-18T08:13:00Z','run-3','role:reviewer')",
      JSON.stringify({ role: 'reviewer', assignment_id: 'asg-750', result: { summary: '退回 1 项问题', findings: [{ description: '深色下折叠体仍是白纸', evidence: ['static/views.css'] }], inspected_scope: ['static/'], unknowns: [] } }));
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,priority,summary,object_number,phase,created_at,updated_at) VALUES('t-750p','101','development.issue','paused','P2','暂停中的任务：折叠体边框',751,'model','2026-11-18T09:00:00Z','2026-11-18T09:10:00Z')");
    h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role) VALUES('run-p1','t-750p','execution',1,1,'2026-11-18T09:00:00Z','paused','{}','{}','dev')");
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, h, password);
    const pages = { task: '#/tasks/t-750', taskpaused: '#/tasks/t-750p', projects: '#/projects', overview: '#/projects/101/overview', tasks: '#/projects/101/overview/tasks.active', settings: '#/settings/work-computers', audit: '#/projects/101/activity' };
    const collect = async () => {
      const values = {};
      for (const [name, hash] of Object.entries(pages)) {
        await page.goto(h.admin + '/' + hash);
        await page.waitForFunction(() => (document.getElementById('console-page')?.innerText || document.querySelector('#workspace')?.innerText || '').trim().length > 0).catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});
        // The task page streams its run folds and re-renders them; keep opening details until every pinned row of
        // this page is actually laid out, otherwise the visibility assertion below can read a fold mid-render.
        const rows = PIN_ROWS.filter(([p]) => p === name);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const ready = await page.evaluate((rows) => {
            document.querySelectorAll('details').forEach((node) => { node.open = true; });
            return rows.every(([, selector]) => {
              const base = selector.includes('::') ? selector.slice(0, selector.indexOf('::')) : selector;
              const el = document.querySelector(base);
              return !el || (!!el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 1);
            });
          }, rows);
          if (ready) break;
          await page.waitForTimeout(150);
        }
        if (name === 'settings') await page.evaluate(() => { const host = document.querySelector('.settings-body'); const probe = document.createElement('div'); probe.className = 'settings-rows'; host?.append(probe); });
        // A pointer left where the confirmation dialog's button was clicked keeps its screen position across
        // navigations. At 768 it landed on `.workbench-tab`, `:hover` repainted that tab with --color-hover
        // (rgb(29, 39, 51)) instead of the surface this table had measured, and e2e run 44710842421 went red on
        // `overview .workbench-tab dark background at 768` while the same table passed locally. Every value below is a
        // resting-state measurement, so the pointer is parked in the corner before the values are read.
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        Object.assign(values, await pinValues(page, PIN_ROWS.filter(([p]) => p === name)));
      }
      // The confirmation dialog, in both themes, is the one surface that is not a page.
      await page.evaluate(() => { void confirmDialog({ title: '删除项目 fixture/project-101？', action: '删除', danger: true, input: { label: '确认名称' }, body: ['项目下的任务与记录会一并删除。'], run: () => Promise.reject(new Error('fixture_refused')) }); });
      await page.locator('dialog.confirm-dialog').waitFor({ state: 'visible' });
      await page.locator('dialog.confirm-dialog').getByRole('button', { name: '删除', exact: true }).click();
      await page.locator('dialog.confirm-dialog .confirm-status.error').waitFor({ state: 'visible' });
      Object.assign(values, await pinValues(page, PIN_ROWS.filter(([p]) => p === 'confirm')));
      await page.evaluate(() => document.querySelector('dialog.confirm-dialog')?.close());
      // The second confirm state: the action never settles, so the dialog keeps `.confirm-status.progress` on screen.
      // `widgets.js:111` writes this class on every async confirm; before this row the state had no input at all and
      // its 2.3:1 dark reading could not fail a test.
      await page.evaluate(() => { void confirmDialog({ title: '执行 fixture 动作？', action: '执行', body: ['这条动作故意不结束，用来把「执行中…」这一态留在屏幕上。'], run: () => new Promise(() => {}) }); });
      await page.locator('dialog.confirm-dialog').waitFor({ state: 'visible' });
      await page.locator('dialog.confirm-dialog').getByRole('button', { name: '执行', exact: true }).click();
      await page.locator('dialog.confirm-dialog .confirm-status.progress').waitFor({ state: 'visible' });
      // Only this one row: the progress dialog carries neither the danger icon nor an input label, so copying the whole
      // `confirm` slice here would overwrite the two rows measured on the dialog above with `missing`.
      Object.assign(values, await pinValues(page, PIN_ROWS.filter(([p, selector]) => p === 'confirm' && selector === '.confirm-status.progress')));
      await page.evaluate(() => document.querySelector('dialog.confirm-dialog')?.close());
      return values;
    };
    // #750: the pin runs at all three layouts, not only 1440. A row the narrow layout removes from the render path
    // (`display: none`, or a block that only the wide layout paints) is skipped at that width, but 1440 has to render
    // every row and stay visible — so no regression can hide by switching a row off at the one width it was pinned on.
    const VIEWPORTS = [390, 768, 1440];
    const shots = {};
    for (const width of VIEWPORTS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: 'dark' });
      const dark = await collect();
      await page.emulateMedia({ colorScheme: 'light' });
      const light = await collect();
      shots[width] = { dark, light };
      if (process.env.PIN_DUMP) console.log(`PIN_${width}=` + JSON.stringify({ dark, light }));
    }
    if (process.env.PIN_DUMP) return;
    for (const [pageName, selector, expectedDark, expectedLight, darkBorder, lightBorder] of PIN_TABLE) {
      const key = `${pageName} ${selector}`;
      const wide = shots[1440];
      expect(wide.dark[key]?.missing, `${key} must render at 1440`).toBeFalsy();
      expect(wide.light[key]?.missing, `${key} must render at 1440 in light`).toBeFalsy();
      expect(wide.dark[key].visible, `${key} must be visible in dark at 1440`).toBe(true);
      expect(wide.light[key].visible, `${key} must be visible in light at 1440`).toBe(true);
      for (const width of VIEWPORTS) {
        const d = shots[width].dark[key], l = shots[width].light[key];
        if (d?.missing || l?.missing) continue;
        // Narrow layouts legitimately fold some rows away; only 1440 is required to keep every row visible.
        if (width !== 1440 && (!d.visible || !l.visible)) continue;
        expect(d.visible, `${key} must be visible in dark at ${width}`).toBe(true);
        expect(l.visible, `${key} must be visible in light at ${width}`).toBe(true);
        for (const [theme, sample, expected, expectedBorder] of [['dark', d, expectedDark, darkBorder], ['light', l, expectedLight, lightBorder]]) {
          expect(sample.color, `${key} ${theme} color at ${width}`).toBe(expected[0]);
          // '*' = this field is not pinned for this row; see the `.role-backend-line` note in PIN_TABLE.
          if (expected[1] !== '*') expect(sample.background, `${key} ${theme} background at ${width}`).toBe(expected[1]);
          if (expectedBorder) expect(sample.border, `${key} ${theme} border at ${width}`).toBe(expectedBorder);
        }
      }
    }
  } finally { await h.stop(); }
});
