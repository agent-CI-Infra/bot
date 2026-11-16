import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { metricTask, usageRequest } from '../test/metrics-fixtures.mjs';
import { identityFixture } from '../test/identity-fixture.mjs';

// #904: at 390px a cost table is 520px wide inside a ~342px column, so it scrolls sideways. A bare `div` that scrolls
// is unreachable: axe reports `scrollable-region-focusable`, and a keyboard user never sees the right-hand columns.
// The two things have to hold together — the box that really overflows enters the Tab order and says what it holds, a
// table that fits adds no stop, and a table revealed by opening a fold is measured when it appears.
test.use({ timezoneId: 'Asia/Shanghai' });

const boxes = (page, panel) => page.locator(`${panel} .cost-table-scroll`).evaluateAll(nodes => nodes.map(node => ({
  name: node.getAttribute('aria-label') || '', role: node.getAttribute('role'), tabindex: node.getAttribute('tabindex'),
  overflow: node.scrollWidth > node.clientWidth, visible: node.checkVisibility(),
})));

// Every visible scroll box is a named group, and only a box that actually overflows takes a Tab stop.
const assertBoxes = (list, where) => {
  for (const box of list) {
    expect(box.role, `${where}: a scroll box is a named group`).toBe('group');
    expect(box.name.length, `${where}: a scroll box says what it holds`).toBeGreaterThan(0);
    if (!box.visible) continue;
    if (box.overflow) expect(box.tabindex, `${where}: "${box.name}" overflows so it is reachable`).toBe('0');
    else expect(box.tabindex, `${where}: "${box.name}" fits so it adds no Tab stop`).toBeNull();
  }
  return list;
};

// Tab really enters it: press Tab from the last filter control until a scroll box has focus.
const tabIntoScrollBox = async (page, panel) => {
  await page.locator(`${panel} .cost-filters input, ${panel} input`).first().focus();
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.classList?.contains('cost-table-scroll'))) return true;
  }
  return false;
};

// The focus ring has to be the site's ring, not the browser default clipped by the box.
const focusRing = (page) => page.evaluate(() => {
  const style = getComputedStyle(document.activeElement);
  return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
});

async function loginCosts(page, url, username, password) {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.goto(url + '/#/costs');
  await expect(page.getByRole('heading', { name: '用量与成本', exact: true })).toBeVisible();
}

test('the cost tables that scroll at 390 are reachable, named, and measured again when a fold opens', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await repository(admin, a.id, '202');
  for (const [kind, repo] of [['review.issue', '101'], ['review.pr', '101'], ['development.pr', '202'], ['development.issue', '101']]) {
    metricTask(h.store, kind, repo, kind);
    h.store.run('UPDATE tasks SET created_at=? WHERE id=?', '2026-11-03T16:30:00.000Z', kind);
  }
  for (const [task, cost] of [['review.issue', 2], ['review.pr', 3], ['development.pr', 4], ['development.issue', 5]]) {
    const id = usageRequest(h.store, task, 'fixture-model', { cost });
    h.store.run('UPDATE model_requests SET requested_at=? WHERE id=?', '2026-11-03T16:30:00.000Z', id);
  }
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync('.tmp/904-captures', { recursive: true });
  try {
    await page.clock.setFixedTime(new Date('2026-11-03T16:45:00Z'));
    await loginCosts(page, h.admin, 'administrator', password);

    // 1440: every table fits, so nothing extra joins the Tab sequence.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator('.cost-summary')).toContainText('USD 14.00');
    const wide = assertBoxes(await boxes(page, '#costs-panel'), 'costs at 1440');
    expect(wide.filter(box => box.overflow && box.visible)).toHaveLength(0);
    await page.screenshot({ path: '.tmp/904-captures/costs-1440.png', fullPage: true });

    // 390: the wide tables overflow, so each one is a reachable, named group.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const narrow = assertBoxes(await boxes(page, '#costs-panel'), 'costs at 390');
    expect(narrow.filter(box => box.overflow && box.visible).length).toBeGreaterThan(0);

    // Tab reaches the first scroll box, the site focus ring is drawn, and the arrow key really scrolls it.
    expect(await tabIntoScrollBox(page, '#costs-panel'), 'Tab enters a scroll box').toBe(true);
    const ring = await focusRing(page);
    expect(ring.style, 'the scroll box draws the site focus ring').not.toBe('none');
    expect(parseFloat(ring.width), 'the focus ring has width').toBeGreaterThan(0);
    const scrolled = await page.evaluate(async () => {
      const box = document.activeElement, before = box.scrollLeft;
      return { before, right: box.scrollWidth > box.clientWidth };
    });
    expect(scrolled.right, 'the focused box can scroll').toBe(true);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement.scrollLeft), 'the arrow key scrolls the focused table').toBeGreaterThan(scrolled.before);
    await page.screenshot({ path: '.tmp/904-captures/costs-390-focused.png', fullPage: true });

    // A table inside a closed fold is measured when the fold opens, not once at load.
    const folds = page.locator('#costs-panel details');
    const folded = await folds.count();
    expect(folded, 'the cost page has its daily-detail folds').toBeGreaterThan(0);
    for (let index = 0; index < folded; index++) await folds.nth(index).locator(':scope > summary').click();
    await page.waitForTimeout(200);
    const opened = assertBoxes(await boxes(page, '#costs-panel'), 'costs at 390 with the folds open');
    const insideFold = await page.locator('#costs-panel details .cost-table-scroll').evaluateAll(nodes => nodes.map(node => node.scrollWidth > node.clientWidth && node.getAttribute('tabindex') === '0'));
    expect(insideFold.some(Boolean), 'a table revealed by a fold is reachable').toBe(true);
    expect(opened.filter(box => box.overflow && box.visible).length).toBeGreaterThan(0);
    await page.screenshot({ path: '.tmp/904-captures/costs-390-folds.png', fullPage: true });

    expect(errors).toEqual([]);
  } finally {
    await h.stop();
    rmSync(h.directory, { recursive: true, force: true });
  }
});

test('the storage tables that scroll at 390 are reachable and named, and a table that fits adds no stop', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  const withComputer = async route => {
    const response = await route.fetch(), json = await response.json();
    for (const project of json.projects ?? []) project.computer ??= { total_bytes: 1024, complete: true, scanned_at: '2026-11-15T08:00:00.000Z' };
    await route.fulfill({ response, json });
  };
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync('.tmp/904-captures', { recursive: true });
  try {
    await page.route(/\/api\/storage(\?|$)/, withComputer);
    await page.goto(f.h.admin + '/#/settings/storage');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('#settings-panel');
    await expect(panel).toContainText('这里统计');

    // 1440: a table that fits keeps no Tab stop of its own.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(200);
    assertBoxes(await boxes(page, '#settings-panel'), 'storage at 1440');
    await page.screenshot({ path: '.tmp/904-captures/storage-1440.png', fullPage: true });

    // 390: the storage tables are 520px wide in a ~342px column; the ones that overflow are reachable and named.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const narrow = assertBoxes(await boxes(page, '#settings-panel'), 'storage at 390');
    expect(narrow.filter(box => box.overflow && box.visible).length, 'the storage tables overflow at 390').toBeGreaterThan(0);
    const reachable = await page.locator('#settings-panel .storage-projects[tabindex="0"]').count();
    expect(reachable, 'a scrolling storage table is a Tab stop').toBeGreaterThan(0);
    expect(await tabIntoScrollBox(page, '#settings-panel'), 'Tab enters a storage scroll box').toBe(true);
    await page.screenshot({ path: '.tmp/904-captures/storage-390-focused.png', fullPage: true });

    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});
