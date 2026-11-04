import { test, expect } from '@playwright/test';
import { publicBoardFixture } from '../test/public-board-fixtures.mjs';

test.use({ locale: 'zh-CN' });

test('public dashboard and repository board render the existing pages without console login', async ({ page }) => {
  const cleanup = [], f = await publicBoardFixture({ after: fn => cleanup.push(fn) });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // The browser and collectors use only this test's local services.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  try {
    await page.goto(f.h.webhook + '/dashboard/#/gate');
    await expect(page.getByText('没有匹配的仓库', { exact: true })).toBeVisible();
    await expect(page.getByText('sciencediscovery', { exact: true })).toHaveCount(0);
    await f.hook('browser-first'); await f.boards.drain();
    await page.reload();
    await expect(page.getByText('hello', { exact: true }).first()).toBeVisible();
    await expect(page.locator('a[href*="github.io"]')).toHaveCount(0);
    await page.screenshot({ path: '.tmp/public-dashboard-desktop.png', fullPage: true });
    await page.getByRole('link', { name: '单仓看板', exact: true }).click();
    await expect(page).toHaveURL(f.h.webhook + '/boards/');
    await page.locator('a.card').click();
    await expect(page.locator('#repo-link')).toHaveText('octo/hello');
    await expect(page.locator('#tabs')).toContainText('Coverage');
    await expect(page.locator('#meta')).not.toContainText('载入中');
    await page.locator('[data-tab="ci"]').click();
    await expect(page.locator('#tab-ci')).toBeVisible();
    await page.screenshot({ path: '.tmp/public-board-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.tmp/public-board-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});

test('repository list switches replace legacy board execution and control public visibility before activation', async ({ page }) => {
  const cleanup = [], f = await publicBoardFixture({ after: fn => cleanup.push(fn) });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    f.state.private = true; f.h.store.run('UPDATE installed_repositories SET private=1');
    f.h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at)
      VALUES(?,'202','octo/public-project','10','octo',0,1,?)`, f.owner.id, new Date().toISOString());
    await page.goto(f.h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const row = id => page.locator(`#rows [data-repository-id="${id}"]`);
    const privateSwitch = row('101').getByRole('switch', { name: 'octo/hello 看板', exact: true });
    const publicSwitch = row('202').getByRole('switch', { name: 'octo/public-project 看板', exact: true });
    await expect(privateSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(privateSwitch).toBeEnabled();
    await expect(publicSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(row('101')).toContainText('未启动');
    await row('101').getByRole('button', { name: '接入门禁', exact: true }).click();
    await expect(page.getByRole('heading', { name: '接入门禁 · octo/hello', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '执行单仓看板', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '执行Dashboard 登记', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '执行门禁 PR', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.route('**/api/installations/101/board', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary_unavailable"}' }));
    await privateSwitch.click();
    await expect(row('101').getByRole('status')).toContainText('看板保存失败');
    await expect(privateSwitch).toHaveAttribute('aria-checked', 'false');
    await page.unroute('**/api/installations/101/board');
    await publicSwitch.click(); await expect(publicSwitch).toHaveAttribute('aria-checked', 'false');
    await privateSwitch.click(); await expect(privateSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(row('101').getByRole('status')).toHaveText('看板已开启；数据公开可访问');
    await f.boards.drain();
    await expect(row('101').getByRole('link', { name: '查看看板', exact: true })).toBeVisible({ timeout: 10000 });
    expect((await f.get('/boards/octo/hello/data/snapshot.json')).status).toBe(200);
    await page.reload(); await expect(privateSwitch).toHaveAttribute('aria-checked', 'true'); await expect(publicSwitch).toHaveAttribute('aria-checked', 'false');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: '.tmp/board-switch-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(privateSwitch).toBeVisible();
    await page.screenshot({ path: '.tmp/board-switch-mobile.png', fullPage: true });
    await privateSwitch.click(); await expect(privateSwitch).toHaveAttribute('aria-checked', 'false');
    expect((await f.get('/boards/octo/hello/data/snapshot.json')).status).toBe(404);
    expect((await f.get('/dashboard/data/index.json')).data.repos).toEqual([]);
    expect(f.h.store.get('SELECT count(*) n FROM repositories').n).toBe(0);
    expect(errors).toEqual([]);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});
