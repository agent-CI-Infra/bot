import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { boardFixtures, boardTask } from '../test/board-fixtures.mjs';

// #503: a board longer than one page continues by itself when the reader reaches the end of what is loaded,
// and the permanent 「加载更多」 button is gone. 230 fixtures on top of the suite's own cards make three pages.
async function fixture(page) {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202'); boardFixtures(h.store);
  for (let i = 0; i < 230; i++) boardTask(h.store, `many-${i}`, 100 + i, 'review.issue', 'succeeded');
  const offsets = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/board/cards' && request.method() === 'GET') offsets.push(url.searchParams.get('offset'));
  });
  await page.goto(h.admin + '/#/board');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.board-card').first()).toBeVisible();
  await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
  h.consolePassword = password; return { h, offsets };
}
const close = async h => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); };
const cards = page => page.locator('.board-card');
// The page number each fetch asked for; offset 0 is the first page and is not a continuation.
const continuations = offsets => offsets.filter(offset => offset !== null && offset !== '0');
// Desktop columns scroll one by one; the tallest list is the one the reader is actually paging through.
const scrollDeepest = page => page.locator('.board-column-list').evaluateAll(lists => {
  const list = lists.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  list.scrollTop = list.scrollHeight;
});

test('滚到底自动加载下一页，常驻「加载更多」按钮消失', async ({ page }) => {
  const { h, offsets } = await fixture(page);
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.getByRole('group', { name: '按…分列', exact: true }).locator('button[data-value="repository"]').click();
    const first = await cards(page).count();
    expect(first).toBe(100);
    expect(continuations(offsets)).toEqual([]);
    await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
    await scrollDeepest(page);
    await expect.poll(() => cards(page).count()).toBeGreaterThan(first);
    await expect.poll(() => continuations(offsets)).toEqual(['100']);
    // The same page is never asked for twice, however often the reader sits at the bottom.
    await scrollDeepest(page);
    await page.waitForTimeout(600);
    const loaded = continuations(offsets);
    expect(loaded.filter(offset => offset === '100')).toHaveLength(1);
    expect(new Set(loaded).size).toBe(loaded.length);
  } finally { await close(h); }
});

test('继续滚动可读完全部三页，到末页后不再请求', async ({ page }) => {
  const { h, offsets } = await fixture(page);
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await scrollDeepest(page);
    await expect.poll(() => continuations(offsets)).toEqual(['100']);
    for (let i = 0; i < 8 && !(await page.locator('#board-status').innerText()).includes('已全部加载'); i++) {
      await scrollDeepest(page);
      await page.waitForTimeout(400);
    }
    await expect(page.locator('#board-status')).toContainText('已全部加载');
    expect(await cards(page).count()).toBeGreaterThan(200);
    expect(continuations(offsets)).toEqual(['100', '200']);
    // At the end of the data a further reach of the bottom asks for nothing.
    await scrollDeepest(page);
    await page.waitForTimeout(800);
    expect(continuations(offsets)).toEqual(['100', '200']);
  } finally { await close(h); }
});

test('键盘滚动、列表视图与 390px 看板容器都能续页，末页后不再请求', async ({ page }) => {
  const { h, offsets } = await fixture(page);
  try {
    await page.getByRole('group', { name: '按…分列', exact: true }).locator('button[data-value="repository"]').click();
    // Keyboard scrolling reaches the same trigger as a pointer scroll.
    const list = page.locator('[data-column-id="101"] .board-column-list');
    await list.evaluate(element => { element.tabIndex = 0; element.focus(); });
    await page.keyboard.press('End');
    await expect.poll(() => continuations(offsets)).toEqual(['100']);
    // The list layout scrolls the board container itself; its height settles a frame after the switch.
    await page.getByRole('button', { name: '更多视图操作', exact: true }).click();
    await page.getByRole('button', { name: '切换为列表', exact: true }).click();
    await expect(page.locator('#board-columns')).toHaveClass(/board-list-layout/);
    const scroll = page.locator('#board-columns');
    await expect.poll(async () => {
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
      return continuations(offsets).length;
    }).toBe(2);
    await expect(page.locator('#board-status')).toContainText('已全部加载');
    // A phone shows one column, and the board container itself scrolls it. The last page is already loaded, so reaching
    // its end asks for nothing more and never leaves a permanent button behind.
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForTimeout(600);
    expect(continuations(offsets)).toEqual(['100', '200']);
  } finally { await close(h); }
});

test('续页失败只给一次性「重试」，没有自动退避重试', async ({ page }) => {
  const { h, offsets } = await fixture(page);
  try {
    let failOnce = true;
    await page.route('**/api/board/cards?*', async route => {
      const url = new URL(route.request().url());
      // The reader's own continuation fails once; a retry is let through to the server.
      if (url.searchParams.get('offset') === '100' && failOnce) {
        failOnce = false;
        return route.fulfill({ status: 503, json: { error: 'temporary_unavailable' } });
      }
      return route.continue();
    });
    await page.setViewportSize({ width: 1600, height: 900 });
    await scrollDeepest(page);
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await expect(page.locator('#board-status')).toContainText('读取失败');
    // The failed page is not asked for again by itself: no backoff loop, no second request for the same offset.
    expect(continuations(offsets).filter(offset => offset === '100')).toHaveLength(1);
    const again = page.waitForRequest(request => new URL(request.url()).searchParams.get('offset') === '100', { timeout: 2500 })
      .then(() => true, () => false);
    expect(await again).toBe(false);
    // The retry asks for that same page once and the card list continues from where it stopped.
    const before = await cards(page).count();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect.poll(() => cards(page).count()).toBeGreaterThan(before);
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    expect(continuations(offsets).filter(offset => offset === '100')).toHaveLength(2);
  } finally { await close(h); }
});

test('已翻到第二页后，15s 静默刷新只刷计数，不换掉已加载的卡片', async ({ page }) => {
  test.setTimeout(60000);
  const { h, offsets } = await fixture(page);
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await scrollDeepest(page);
    await expect.poll(() => continuations(offsets)).toEqual(['100']);
    const loaded = await cards(page).count();
    const handle = await page.locator('.board-card').first().elementHandle();
    expect(await cards(page).count()).toBe(loaded);
    // The server gains a card while the reader is on page two; the quiet refresh must report it in the counts only.
    boardTask(h.store, 'late-arrival', 900, 'review.issue', 'succeeded');
    const polls = page.waitForRequest(request => new URL(request.url()).searchParams.get('offset') === '0', { timeout: 20000 });
    await polls;
    await expect(page.locator('#board-status')).toContainText('项工作');
    // The same card node is still in the document and the appended pages are still there: nothing was re-rendered.
    expect(await page.evaluate(element => element.isConnected, handle)).toBe(true);
    expect(await cards(page).count()).toBe(loaded);
    expect(continuations(offsets)).toEqual(['100']);
  } finally { await close(h); }
});
