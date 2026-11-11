import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { boardFixtures, boardTask } from '../test/board-fixtures.mjs';

async function fixture(page, unavailable = false) {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202'); boardFixtures(h.store);
  if (unavailable) await page.route(unavailable === 'views' ? '**/api/board' : '**/api/board/cards?*', route => route.fulfill({ status: 503, json: { error: 'temporary_unavailable' } }));
  await page.goto(h.admin + '/#/board');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  if (unavailable === 'views') await expect(page.getByText('看板未能读取', { exact: true })).toBeVisible();
  else if (unavailable) await expect(page.locator('#board-status')).toContainText('工作数量未知');
  else await expect(page.locator('.board-card').first()).toBeVisible();
  h.consolePassword = password; return h;
}
async function layout(page, name) {
  await page.getByRole('button', { name: '更多视图操作', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}
const keys = page => page.locator('.board-card').evaluateAll(cards => cards.map(c => c.dataset.cardKey + '/' + c.dataset.cardCategory).sort());
const close = async h => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); };

test('list and columns share filters, grouping and counts at six widths without writing execution stages', async ({ page }) => {
  const h = await fixture(page), writes = [];
  page.on('request', req => { if (req.method() !== 'GET' && req.url().includes('/api/board/')) writes.push(req.method()); });
  try {
    await page.getByRole('group', { name: '工作类型', exact: true }).locator('button[data-value="review.issue"]').click();
    await page.getByRole('group', { name: '按…分列', exact: true }).locator('button[data-value="repository"]').click();
    const before = await keys(page), count = await page.locator('#board-status').innerText();
    await layout(page, '切换为列表');
    await expect(page.locator('#board-columns')).toHaveClass(/board-list-layout/);
    expect(await keys(page)).toEqual(before); await expect(page.locator('#board-status')).toHaveText(count);
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('.board-card[draggable=true]')).toHaveCount(0);
      if ([390, 1440].includes(width)) {
        mkdirSync('.tmp/board-list-227', { recursive: true });
        await page.screenshot({ path: `.tmp/board-list-227/list-${width}.png` });
      }
      await expect(page.locator('[role=group][aria-label="工作类型"] [aria-pressed=true]')).toHaveAttribute('data-value', 'review.issue');
    }
    await layout(page, '切换为分栏'); await expect(page.locator('#board-columns')).not.toHaveClass(/board-list-layout/);
    expect(await keys(page)).toEqual(before); expect(writes).toEqual([]);
  } finally { await close(h); }
});

test('list refresh and page return preserve the current reading position and unsaved filters', async ({ page }) => {
  const h = await fixture(page);
  try {
    for (let i = 0; i < 35; i++) boardTask(h.store, 'list-' + i, 100 + i, 'review.issue', 'succeeded');
    await page.getByRole('group', { name: '工作类型', exact: true }).locator('button[data-value="review.issue"]').click();
    await page.getByRole('group', { name: '按…分列', exact: true }).locator('button[data-value="repository"]').click();
    await layout(page, '切换为列表');
    await page.locator('#board-columns').evaluate(el => { el.scrollTop = 500; });
    await expect.poll(() => page.evaluate(() => boardState.positions?.list?.top)).toBe(500);
    boardTask(h.store, 'list-new', 200, 'review.issue', 'running');
    await page.evaluate(async () => { document.activeElement.blur(); await boardPoll(); });
    await expect.poll(() => page.locator('#board-columns').evaluate(el => el.scrollTop)).toBe(500);
    await page.evaluate(() => { location.hash = '#/more'; });
    await expect(page.getByRole('heading', { name: '更多功能' })).toBeVisible();
    await page.goBack(); await expect(page.locator('#board-columns')).toHaveClass(/board-list-layout/);
    await expect.poll(() => page.locator('#board-columns').evaluate(el => el.scrollTop)).toBe(500);
    await expect(page.locator('[role=group][aria-label="工作类型"] [aria-pressed=true]')).toHaveAttribute('data-value', 'review.issue');
  } finally { await close(h); }
});

test('access loss clears cards and view caches before an older successful poll can return', async ({ page }) => {
  const h = await fixture(page); let release = () => {}, held = false, reads = 0;
  try {
    await layout(page, '切换为列表');
    await page.route('**/api/board/cards?*', async route => {
      reads++;
      if (reads === 1) { const response = await route.fetch(); await new Promise(resolve => { release = resolve; held = true; }); await route.fulfill({ response }); }
      else if (reads === 2) await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'capability_forbidden' }) });
      else await route.continue();
    });
    await page.evaluate(() => { document.activeElement.blur(); window.oldBoardPoll = boardPoll(); });
    await expect.poll(() => held).toBe(true);
    await page.evaluate(() => boardPoll());
    await expect(page.getByText('看板访问权限已变化', { exact: true })).toBeVisible();
    await expect(page.locator('.board-card')).toHaveCount(0); expect(await page.evaluate(() => boardState)).toBe(null);
    release(); await page.evaluate(() => window.oldBoardPoll);
    await expect(page.locator('.board-card')).toHaveCount(0);
    await page.getByRole('button', { name: '重新读取看板', exact: true }).click();
    await expect(page.locator('.board-card').first()).toBeVisible();
  } finally { release(); await close(h); }
});


for (const failedRead of ['cards', 'views']) test(`an unreadable first ${failedRead} read stays in the workspace and a read-only retry recovers real work`, async ({ page }) => {
  const h = await fixture(page, failedRead);
  try {
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#boot')).toBeHidden();
    if (failedRead === 'cards') await expect(page.locator('#board-status')).not.toContainText('共 0');
    else await expect(page.locator('#board-status')).toHaveCount(0);
    await expect(page.locator('.board-card')).toHaveCount(0);
    await page.unroute(failedRead === 'views' ? '**/api/board' : '**/api/board/cards?*');
    await page.getByRole('button', { name: failedRead === 'views' ? '重新读取看板' : '刷新', exact: true }).click();
    await expect(page.locator('.board-card').first()).toBeVisible();
    await expect(page.locator('#board-status')).toContainText('项工作');
  } finally { await close(h); }
});


test('logout clears list presentation, cached cards and reading positions before the same identity signs in again', async ({ page }) => {
  const h = await fixture(page);
  try {
    await layout(page, '切换为列表');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => boardState)).toBe(null);
    await expect(page.locator('.board-card')).toHaveCount(0);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(h.consolePassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#workspace')).toBeVisible();
    await page.evaluate(() => { location.hash = '#/board'; });
    await expect(page.locator('.board-card').first()).toBeVisible();
    await expect(page.locator('#board-columns')).not.toHaveClass(/board-list-layout/);
  } finally { await close(h); }
});
