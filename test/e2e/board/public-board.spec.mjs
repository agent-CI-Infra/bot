import { test, expect } from '@playwright/test';
import { calendarRuns, publicBoardFixture, scheduledNightly } from '../../fixtures/public-board-fixtures.mjs';
import { mkdirSync } from 'node:fs';

test.use({ locale: 'zh-CN' });

test('public dashboard and repository board show generic data without console login (#938)', async ({ page }) => {
  const cleanup = [], f = await publicBoardFixture({ after: fn => cleanup.push(fn) });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // The browser and collectors use only this test's local services.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const shots = '.tmp/board-938'; mkdirSync(shots, { recursive: true });
  const capture = async (name, focus) => {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      // Charts are drawn again at the new width shortly after a resize.
      await page.waitForTimeout(400);
      if (focus) await focus.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} ${width}`).toBe(true);
      await page.screenshot({ path: `${shots}/${name}-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  try {
    scheduledNightly(f.state);
    await f.hook('browser-first'); await f.boards.drain();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.webhook + '/dashboard/');
    const repoLink = page.getByRole('link', { name: /octo\/hello/ }).first();
    await expect(repoLink).toBeVisible();
    await expect(page.locator('a[href*="github.io"]')).toHaveCount(0);
    // The gate pages and the template examples are gone; the sidebar leads to the repository boards instead.
    const sidebar = page.locator('[data-sidebar="sidebar"]').first();
    for (const text of ['质量门禁', '接入门禁']) await expect(sidebar.getByText(text, { exact: true })).toHaveCount(0);
    await capture('dashboard');
    await page.goto(f.h.webhook + '/dashboard/#/about');
    await expect(page.locator('main').getByText('单仓看板', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'docker/control-plane.Dockerfile' })).toHaveAttribute('href', 'https://github.com/agent-CI-Infra/bot/blob/main/docker/control-plane.Dockerfile');
    await expect(page.getByText('质量门禁')).toHaveCount(0);
    await capture('about');
    for (const route of ['gate', 'gate-onboarding', 'sign-in', 'tasks', 'users', 'chats', 'apps', 'settings']) {
      await page.goto(f.h.webhook + `/dashboard/#/${route}`);
      await expect(page.getByRole('link', { name: /octo\/hello/ })).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 }).first()).not.toHaveText(/门禁|Sign in|Tasks|Users|Chats|Apps|Settings/);
    }
    await page.goto(f.h.webhook + '/dashboard/');
    await page.getByRole('link', { name: '单仓看板', exact: true }).click();
    await expect(page).toHaveURL(f.h.webhook + '/boards/');
    await page.locator('a.card').click();
    await expect(page.locator('#repo-link')).toHaveText('octo/hello');
    await expect(page.locator('#tabs a')).toHaveText(['总览', 'Issue', 'PR', 'CI']);
    await expect(page.locator('#meta')).not.toContainText('载入中');
    await expect(page.locator('#tab-overview')).toContainText('流水线');
    await expect(page.locator('#tab-overview')).toContainText('CI');
    await capture('board-overview');
    await page.locator('[data-tab="ci"]').click();
    await expect(page.locator('#tab-ci')).toBeVisible();
    await expect(page.locator('#tab-ci')).toContainText('Workflow 健康');
    // Each workflow's duration spread and the job that fails most often.
    const nightlyRow = page.locator('#tab-ci tr', { hasText: 'Nightly' }).first();
    await expect(nightlyRow).toContainText('unit ×1');
    await expect(page.locator('#tab-ci')).not.toContainText('质量门禁');
    // The scheduled workflow's runs: the first reported metric over the runs, a ring for the failed one, the runs below.
    const scheduled = page.locator('#tab-ci .card', { has: page.locator('[data-sched-chart]') });
    await expect(scheduled).toContainText('Nightly');
    await expect(scheduled.locator('svg circle.trend-dot')).toHaveCount(7);
    await expect(scheduled.locator('svg circle.sched-miss')).toHaveCount(1);
    await expect(scheduled.locator('select[data-sched-metric]')).toHaveValue('m:tests');
    await expect(scheduled.locator('tbody tr').first()).toContainText('1,222');
    await scheduled.locator('select[data-sched-metric]').selectOption('duration');
    await expect(page.locator('#tab-ci .card', { has: page.locator('[data-sched-chart]') }).locator('thead')).toContainText('运行耗时');
    await page.locator('#tab-ci select[data-sched-metric]').selectOption('m:tests');
    await capture('board-ci', page.locator('#tab-ci [data-sched-chart]'));
    await capture('board-ci-workflows', page.locator('#tab-ci h2', { hasText: 'Workflow 健康' }));
    expect(errors).toEqual([]);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});

test('the Actions calendar shows run details and keeps the date a reader scrolled to', async ({ page }, testInfo) => {
  const cleanup = [], f = await publicBoardFixture({ after: fn => cleanup.push(fn) });
  try {
    f.state.failRunBackfill = true;
    calendarRuns(f.state);
    await f.hook('run-calendar'); await f.boards.drain();
    // An existing board can serve a schema 2 snapshot until its next collection.
    const legacy = (await f.get('/boards/octo/hello/data/snapshot.json')).data;
    legacy.schema_version = 2;
    legacy.sections.ci.data.lanes = { zone: 'Asia/Shanghai', days: ['2026-01-01'], lanes: {}, order: [] };
    await page.route('**/data/snapshot.json?*', route => route.fulfill({ json: legacy }), { times: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.webhook + '/boards/');
    await page.locator('a.card').click();
    await page.locator('[data-tab="ci"]').click();
    const calendar = page.getByRole('table', { name: '近 30 天运行记录' });
    await expect(page.locator('#tab-ci')).toContainText('Workflow 健康');
    await expect(calendar).toHaveCount(0);
    await page.getByRole('button', { name: '刷新视图' }).click();
    await expect(calendar.getByRole('rowheader')).toHaveText(['PR', '合并队列', 'Daily', '版本', '主干', '其他']);
    const latestAttempt = calendar.getByRole('link', { name: /Build packages · pull_request/ });
    await expect(latestAttempt).toHaveText('45s');
    await expect(latestAttempt).toHaveClass(/success/);
    await latestAttempt.hover();
    await expect(page.locator('#tooltip')).toContainText('分支 topic · bcdef01');
    await latestAttempt.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(latestAttempt).toBeFocused();
    await expect(page.locator('#tooltip')).toContainText('23:59:00（Asia/Shanghai）');
    await expect(calendar.locator('.ci-run.failure').first()).toBeVisible();
    await expect(calendar.locator('td.uncollected').first()).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.locator('.ci-calendar').scrollIntoViewIfNeeded();
      await page.mouse.move(1, 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`calendar-${width}.png`) });
      await latestAttempt.hover();
      await expect(page.locator('#tooltip')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`calendar-detail-${width}.png`) });
    }
    const scroll = page.locator('.ci-lanes-scroll');
    await expect.poll(() => scroll.evaluate(el => el.scrollWidth > el.clientWidth && el.scrollLeft === 0)).toBe(true);
    await scroll.hover();
    await page.mouse.wheel(-200, 0);
    await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBeLessThan(-50);
    const away = await scroll.evaluate(el => el.scrollLeft);
    const oldTable = await calendar.elementHandle();
    await page.getByRole('button', { name: '刷新视图' }).click();
    await expect.poll(() => oldTable.evaluate(el => el.isConnected)).toBe(false);
    expect(await scroll.evaluate(el => el.scrollLeft)).toBeCloseTo(away, 0);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});

test('repository list switches replace legacy board execution and control public visibility before activation', async ({ page }) => {
  const cleanup = [], f = await publicBoardFixture({ after: fn => cleanup.push(fn) });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    f.state.private = true; f.h.store.run('UPDATE installed_repositories SET private=1');
    f.h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at)
      VALUES(?,'202','octo/public-project','10','octo',0,1,?)`, f.owner.id, new Date().toISOString());
    await page.goto(f.h.admin + '/#/settings/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const row = id => page.locator(`.global-project-row[data-repository-id="${id}"]`);
    const privateSwitch = row('101').getByRole('switch', { name: 'octo/hello 看板', exact: true });
    const publicSwitch = row('202').getByRole('switch', { name: 'octo/public-project 看板', exact: true });
    await expect(privateSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(privateSwitch).toBeEnabled();
    await expect(publicSwitch).toHaveAttribute('aria-checked', 'true');
    let writes = 0;
    page.on('request', request => { if (request.method() === 'PATCH' && /\/api\/installations\/\d+\/board$/.test(request.url())) writes++; });
    await privateSwitch.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('项目：octo/hello'); await expect(dialog).toContainText('允许无需登录访问');
    mkdirSync('.tmp/public-board-confirm-226/previews', { recursive: true });
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(width)).toBe(true);
      await expect(dialog.getByRole('button', {name: '取消', exact: true})).toBeInViewport();
      if ([390, 1440].includes(width)) await page.screenshot({ path: `.tmp/public-board-confirm-226/previews/public-board-open-${width}.png` });
    }
    await expect(privateSwitch).toHaveAttribute('aria-checked', 'false'); expect(writes).toBe(0);
    await dialog.getByRole('button', {name: '取消', exact: true}).click();
    await expect(row('101').getByRole('status')).toHaveText('已取消公开看板变更'); expect(writes).toBe(0);
    await expect(row('101')).toContainText('未启动');
    // Gate onboarding is gone (#931): the row offers no CI entry of its own.
    await expect(row('101').getByRole('button', { name: '接入门禁', exact: true })).toHaveCount(0);
    mkdirSync('.tmp/project-list-931', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await row('101').scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(width)).toBe(true);
      await page.screenshot({ path: `.tmp/project-list-931/row-${width}.png` });
    }
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.route('**/api/installations/101/board', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary_unavailable"}' }));
    await privateSwitch.click();
    await dialog.getByRole('button', {name: '开启公开看板', exact: true}).click();
    await expect(row('101').getByRole('status')).toContainText('看板保存失败');
    await expect(privateSwitch).toHaveAttribute('aria-checked', 'false');
    await page.unroute('**/api/installations/101/board');
    await publicSwitch.click(); await dialog.getByRole('button', {name: '关闭公开看板', exact: true}).click(); await expect(publicSwitch).toHaveAttribute('aria-checked', 'false');
    await privateSwitch.click(); await dialog.getByRole('button', {name: '开启公开看板', exact: true}).click(); await expect(privateSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(row('101').getByRole('status')).toHaveText('看板已开启；数据公开可访问');
    await f.boards.drain(); await page.reload();
    await expect(row('101').getByRole('link', { name: '查看看板', exact: true })).toBeVisible({ timeout: 10000 });
    expect((await f.get('/boards/octo/hello/data/snapshot.json')).status).toBe(200);
    await page.reload(); await expect(privateSwitch).toHaveAttribute('aria-checked', 'true'); await expect(publicSwitch).toHaveAttribute('aria-checked', 'false');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: '.tmp/board-switch-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(privateSwitch).toBeVisible();
    await page.screenshot({ path: '.tmp/board-switch-mobile.png', fullPage: true });
    const previousWrites = writes;
    await privateSwitch.click(); await expect(dialog).toContainText('保存后停止对外提供本项目看板');
    mkdirSync('.tmp/public-board-confirm-226/previews', { recursive: true });
    await page.screenshot({ path: '.tmp/public-board-confirm-226/previews/public-board-close-390.png' });
    await dialog.getByRole('button', {name: '取消', exact: true}).click();
    await expect(privateSwitch).toHaveAttribute('aria-checked', 'true'); expect(writes).toBe(previousWrites);
    await privateSwitch.click(); await dialog.getByRole('button', {name: '关闭公开看板', exact: true}).click(); await expect(privateSwitch).toHaveAttribute('aria-checked', 'false');
    expect((await f.get('/boards/octo/hello/data/snapshot.json')).status).toBe(404);
    expect((await f.get('/dashboard/data/index.json')).data.repos).toEqual([]);
    expect(f.h.store.get('SELECT count(*) n FROM repositories').n).toBe(0);
    expect(errors).toEqual([]);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});

test('a public-board choice cannot write after leaving the page that opened it', async ({ page }) => {
  const cleanup = [], f = await publicBoardFixture({ after: fn => cleanup.push(fn) });
  try {
    f.state.private = true; f.h.store.run('UPDATE installed_repositories SET private=1');
    await page.goto(f.h.admin + '/#/settings/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    let writes = 0; page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith('/api/installations/101/board')) writes++; });
    await page.getByRole('switch', { name: 'octo/hello 看板', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '开启公开看板？', exact: true }); await expect(dialog).toBeVisible();
    await page.evaluate(() => { location.hash = '#/more'; }); await expect(page).toHaveURL(/#\/more$/);
    await dialog.getByRole('button', { name: '开启公开看板', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect(writes).toBe(0); expect((await f.get('/boards/octo/hello/data/snapshot.json')).status).toBe(404);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});
