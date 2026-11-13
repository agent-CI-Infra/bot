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

test('键盘滚动与移动端空列都能触发续页，列表视图同样续页', async ({ page }) => {
  const { h, offsets } = await fixture(page);
  try {
    await page.getByRole('group', { name: '按…分列', exact: true }).locator('button[data-value="repository"]').click();
    const list = page.locator('[data-column-id="101"] .board-column-list');
    await list.evaluate(element => { element.tabIndex = 0; element.focus(); });
    await page.keyboard.press('End');
    await expect.poll(() => continuations(offsets)).toEqual(['100']);
    // A phone shows one column at a time. Its first group can have a count but no card in the loaded page: the board must
    // keep reading instead of leaving 「请加载更多」 as a dead end.
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => continuations(offsets).length).toBeGreaterThan(1);
    await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
    // Switching to the populated group keeps the page and scrolling its own container continues from there.
    await page.getByRole('combobox', { name: '当前分组', exact: true }).selectOption({ label: '已检视 · ' + (await page.locator('#board-mobile-group option').last().innerText()).split(' · ')[1] }).catch(async () => {});
    const scroll = page.locator('#board-columns');
    const before = (await continuations(offsets)).length;
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => continuations(offsets).length).toBeGreaterThan(before);
    // The list layout scrolls the board container itself and continues the same way.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '更多视图操作', exact: true }).click();
    await page.getByRole('button', { name: '切换为列表', exact: true }).click();
    await expect(page.locator('#board-columns')).toHaveClass(/board-list-layout/);
    const listBefore = (await continuations(offsets)).length;
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => continuations(offsets).length).toBeGreaterThan(listBefore);
  } finally { await close(h); }
});
