import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { boardFixtures } from '../../fixtures/board-fixtures.mjs';

async function fixture() {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202'); boardFixtures(h.store);
  return { h, admin, password };
}
async function login(page, url, password) {
  await page.goto(url); await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('#tabs').getByRole('link', { name: '任务看板', exact: true }).click();
  await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
}

// #482, one slice: the view selector, its unsaved state and the save action stay in the toolbar. Reading them must never
// require opening the `⋯` menu, which keeps only the secondary view operations.
test('视图选择器与未保存状态常驻可见，不展开「更多视图操作」也读得到', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await login(page, h.admin, password);
    const more = page.getByRole('button', { name: '更多视图操作', exact: true });
    const view = page.getByLabel('视图', { exact: true });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#board-view-menu .board-menu-panel')).toBeHidden();
    await expect(view).toBeVisible();
    await expect(view).toHaveValue('default');
    await expect(view.locator('option:checked')).toHaveText('默认看板');
    // Editing a filter marks the view unsaved; the marker and the save action appear next to the selector, menu closed.
    await page.getByLabel('工作类型', { exact: true }).selectOption('review.issue');
    const state = page.locator('#board-view-state');
    await expect(state).toBeVisible();
    await expect(state).toHaveText('未保存');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#board-view-menu .board-menu-panel')).toBeHidden();
    const save = page.getByRole('button', { name: '保存视图', exact: true });
    await expect(save).toBeVisible();
    await save.click();
    await expect(state).toBeHidden();
    await expect(save).toBeHidden();
    // The secondary view operations stay in the menu.
    await more.click();
    await expect(page.getByRole('button', { name: '切换为列表', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '另存视图', exact: true })).toBeVisible();
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('390 下视图名与未保存状态同样在工具栏里，筛选面板关着也看得见', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await login(page, h.admin, password);
    await page.setViewportSize({ width: 390, height: 844 });
    const more = page.getByRole('button', { name: '更多视图操作', exact: true });
    const view = page.getByLabel('视图', { exact: true });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(view).toBeVisible();
    await expect(view.locator('option:checked')).toHaveText('默认看板');
    await page.locator('.board-filter-details > summary').click();
    await page.getByLabel('工作类型', { exact: true }).selectOption('review.issue');
    await page.locator('.board-filter-details > summary').click();
    await expect(page.locator('#board-view-state')).toHaveText('未保存');
    await expect(page.locator('#board-view-state')).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

// #482 review: on a narrow phone the unsaved state next to the selector used to eat the selector's own width — at 320
// it collapsed to 18px so the view name could not be read, and the save action overlapped the `⋯` button by 22px, so
// the right part of "保存视图" opened the view menu instead of saving. Reading the active view and saving it must both
// work with nothing overlapping at 320 and 390, including the separately styled new-task entry.
test('320/390 未保存态：视图、保存、新建任务与更多操作互不重叠', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await login(page, h.admin, password);
    // Editing a filter is what turns a saved view into an unsaved one; the narrow layout must then still show it.
    await page.getByLabel('工作类型', { exact: true }).selectOption('review.issue');
    await expect(page.locator('#board-view-state')).toHaveText('未保存');
    for (const [width, height] of [[320, 800], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await expect(page.locator('#board-view-state')).toBeVisible();
      await expect(page.getByLabel('视图', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '保存视图', exact: true })).toBeVisible();
      const m = await page.evaluate(() => {
        const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        const select = document.getElementById('board-view-select');
        const save = document.getElementById('board-save');
        const more = document.querySelector('#board-view-menu .board-menu-toggle');
        const state = document.getElementById('board-view-state');
        const create = document.getElementById('board-create-task');
        const work = document.getElementById('board-worktype-select');
        const style = getComputedStyle(select), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const selected = select.options[select.selectedIndex];
        const name = selected ? selected.text : '';
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const saveBox = box(save);
        const hit = (fx) => { const e = document.elementFromPoint(saveBox.left + saveBox.width * fx, saveBox.top + saveBox.height / 2); return e ? (e.id || e.tagName.toLowerCase()) : null; };
        const controls = [['view', select], ['work', work], ['state', state], ['save', save], ['more', more], ['create', create]];
        const hitAt = node => { const b = node.getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return e ? (e.id || e.tagName.toLowerCase()) : null; };
        const overlaps = [];
        for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
          if (overlap(box(controls[i][1]), box(controls[j][1]))) overlaps.push([controls[i][0], controls[j][0]]);
        }
        return { select: box(select), save: saveBox, more: box(more), work: box(work), name, textWidth: ctx.measureText(name).width, padding,
          overlaps, hitAtSaveCentre: hit(0.5), hitAtSaveRight: hit(0.95), hitAtWork: hitAt(work), docWidth: document.documentElement.scrollWidth, innerWidth };
      });
      // The view name has to fit inside the selector: its text plus the control's own padding and its arrow.
      expect(m.select.width - m.padding - 16).toBeGreaterThanOrEqual(m.textWidth);
      expect(m.select.width).toBeGreaterThanOrEqual(110);
      // The view controls and the other toolbar actions must not sit under one another.
      expect(m.overlaps).toEqual([]);
      expect(m.hitAtSaveCentre).toBe('board-save');
      expect(m.hitAtSaveRight).toBe('board-save');
      // #482 review: the work type moved out of the filter fold, so the phone must reach it too, on the first screen.
      expect(m.hitAtWork).toBe('board-worktype-select');
      expect(m.work.width).toBeGreaterThanOrEqual(90);
      expect(m.work.bottom).toBeLessThanOrEqual(height);
      expect(m.docWidth).toBeLessThanOrEqual(m.innerWidth);
    }
    // The same collision appears at 768 in the clean state (the selector's right edge ran 4px under `⋯`).
    await page.setViewportSize({ width: 768, height: 900 });
    await page.getByRole('button', { name: '保存视图', exact: true }).click().catch(() => {});
    await expect(page.locator('#board-view-state')).toBeHidden();
    await page.waitForTimeout(300);
    const clean = await page.evaluate(() => {
      const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
      const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      const select = document.getElementById('board-view-select');
      const more = document.querySelector('#board-view-menu .board-menu-toggle');
      const work = document.getElementById('board-worktype-select');
      const hitAt = node => { const b = node.getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return e ? (e.id || e.tagName.toLowerCase()) : null; };
      return { selects: box(select), more: box(more), work: box(work), workHit: hitAt(work), docWidth: document.documentElement.scrollWidth, innerWidth,
        overlaps: overlap(box(select), box(more)) || overlap(box(select), box(work)) || overlap(box(more), box(work)) };
    });
    expect(clean.overlaps).toBe(false);
    // #482 review: 768 must reach the work type too, with no neighbour on top of it and no horizontal overflow.
    expect(clean.workHit).toBe('board-worktype-select');
    expect(clean.work.width).toBeGreaterThanOrEqual(90);
    expect(clean.docWidth).toBeLessThanOrEqual(clean.innerWidth);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

// #482: the work type is the view selector's neighbour in one toolbar row — compact selects reading 视图 → 工作类型 —
// and the phone keeps both usable on its first screen without opening `⋯` or 筛选. The repository condition stays a
// chip only: a work page's address is its single scope entry, so the board must never render a second 仓库 selector
// (test/e2e/console/console-project-scope.spec.mjs asserts that contract).
test('工作类型紧挨视图：1440 一排按视图→工作类型，390 首屏命中可点，且看板没有第二个仓库选择器', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    const saved = (await admin('/api/board/views', 'POST', { name: '只看仓库 202', group_by: 'bot_stage', filters: [{ field: 'repository_id', value: '202' }], hidden_columns: [] })).value.view;
    await page.setViewportSize({ width: 1440, height: 900 }); await login(page, h.admin, password);
    const view = page.getByLabel('视图', { exact: true }), work = page.getByLabel('工作类型', { exact: true });
    await expect(work).toBeVisible();
    // The address is the only scope entry: no 仓库 select, neither in the toolbar nor in the filter fold.
    await expect(page.getByLabel('仓库', { exact: true })).toHaveCount(0);
    await expect(page.locator('.board-arrangement select[aria-label="仓库"]')).toHaveCount(0);
    // The two controls share one line and read left to right in that order, with no horizontal overflow.
    const row = await page.evaluate(() => {
      const box = node => { const r = node.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) }; };
      const select = label => [...document.querySelectorAll('.board-arrangement select')].find(node => node.getAttribute('aria-label') === label) || null;
      const node = { view: select('视图'), work: select('工作类型') };
      return { view: node.view && box(node.view), work: node.work && box(node.work),
        selects: document.querySelectorAll('.board-arrangement select').length,
        docWidth: document.documentElement.scrollWidth, innerWidth };
    });
    expect(row.work).not.toBeNull();
    expect(row.work.left).toBeGreaterThanOrEqual(row.view.right);
    expect(Math.abs(row.work.top - row.view.top)).toBeLessThanOrEqual(1);
    expect(row.selects).toBe(3);
    expect(row.docWidth).toBeLessThanOrEqual(row.innerWidth);
    // The work type select writes the same category filter the filter fold used to: the chip appears with it.
    await work.selectOption('review.issue');
    await expect(page.locator('#board-chips')).toContainText('工作类型');
    await expect(page.getByLabel('仓库', { exact: true })).toHaveCount(0);
    // A saved view that holds a repository condition keeps it as a chip, and still adds no repository select.
    await page.locator('#board-view-select').selectOption(saved.id);
    await expect(page.locator('#board-chips')).toContainText('仓库');
    await expect(page.locator('#board-chips')).toContainText('202');
    await expect(page.getByLabel('仓库', { exact: true })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    const details = page.locator('.board-filter-details');
    await expect(details).not.toHaveAttribute('open');
    const more = page.getByRole('button', { name: '更多视图操作', exact: true });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    // Both controls are on the phone's first screen and nothing covers them: a tap at their centre reaches them.
    const hit = await page.evaluate(() => {
      const ids = {};
      const pick = (element, name) => { const r = element.getBoundingClientRect(); ids[name] = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
      pick(document.getElementById('board-view-select'), 'view');
      const select = label => [...document.querySelectorAll('.board-arrangement select')].find(node => node.getAttribute('aria-label') === label);
      pick(select('工作类型'), 'work');
      const reach = ({ x, y }) => { const node = document.elementFromPoint(x, y); return node && node.tagName === 'SELECT' ? node.getAttribute('aria-label') : null; };
      return { ids, view: reach(ids.view), work: reach(ids.work), innerWidth };
    });
    expect(hit.view).toBe('视图'); expect(hit.work).toBe('工作类型');
    expect(hit.ids.view.bottom).toBeLessThanOrEqual(844);
    expect(hit.ids.work.bottom).toBeLessThanOrEqual(844);
    // Switching the view never needs the `⋯` menu: the toolbar select does it with the menu still closed.
    await page.getByLabel('视图', { exact: true }).selectOption(saved.id);
    await expect(page.getByLabel('视图', { exact: true })).toHaveValue(saved.id);
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

// #482 review, blocking: at 390 the toolbar must keep origin/main's three-line height. A fourth line took the board's
// scroll area down to 4px, so the first card's title sat under the fixed bottom bar where no scroll could reach it and a
// click could never land — CI showed it as test/e2e/management/metrics.spec.mjs:7 timing out at 30s against a 4.9s green baseline. The
// live status now closes the actions line instead of opening one of its own.
test('390 工具栏最多三行：状态非空时点第一张卡打开任务详情，固定底栏不挡', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await login(page, h.admin, password);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/reviews');
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#board-status')).toContainText('项工作');
    const layout = await page.evaluate(() => {
      const arrangement = document.querySelector('.board-arrangement');
      // Lines, not element tops: the row is centred, so a button and a select in the same line start at different y.
      const bands = [];
      for (const box of [...arrangement.children].filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect()).sort((a, b) => a.top - b.top)) {
        const band = bands.find(row => Math.min(row.bottom, box.bottom) - Math.max(row.top, box.top) > 1);
        if (band) { band.top = Math.min(band.top, box.top); band.bottom = Math.max(band.bottom, box.bottom); } else bands.push({ top: box.top, bottom: box.bottom });
      }
      const statusBox = document.querySelector('#board-status').getBoundingClientRect();
      const refreshBox = [...arrangement.querySelectorAll(':scope > button')].pop().getBoundingClientRect();
      const sharesActionsLine = Math.min(statusBox.bottom, refreshBox.bottom) - Math.max(statusBox.top, refreshBox.top) > 1;
      const nav = document.querySelector('#console-mobile-nav').getBoundingClientRect();
      const scroll = document.getElementById('board-columns').getBoundingClientRect();
      return { rows: bands.length, sharesActionsLine, navTop: Math.round(nav.top),
        scroll: { top: Math.round(scroll.top), bottom: Math.round(scroll.bottom), height: Math.round(scroll.height) },
        docWidth: document.documentElement.scrollWidth, innerWidth };
    });
    // Three lines is the ceiling, the board keeps a real scroll area, and that area ends above the fixed bottom bar.
    expect(layout.rows).toBeLessThanOrEqual(3);
    expect(layout.sharesActionsLine).toBe(true);
    expect(layout.scroll.height).toBeGreaterThan(80);
    expect(layout.scroll.bottom).toBeLessThanOrEqual(layout.navTop + 1);
    expect(layout.docWidth).toBeLessThanOrEqual(layout.innerWidth);
    // A real click on the first visible card's title — the action metrics.spec.mjs:60 could not complete.
    const title = page.locator('[data-card-key="101/issue/1"][data-card-category="review.issue"] .board-card-title');
    // The phone shows one column at a time; 当前分组 picks it, so walk the options until the task's card is on screen.
    for (const value of await page.locator('#board-mobile-group option').evaluateAll(nodes => nodes.map(node => node.value))) {
      await page.locator('#board-mobile-group').selectOption(value);
      if (await title.isVisible()) break;
    }
    await expect(title).toBeVisible();
    await title.click({ timeout: 5000 });
    // A card with several tasks asks which one first; either way the detail itself must open, not a dead tap.
    const picker = page.locator('#task-picker-dialog[open] #task-picker-actions');
    if (await picker.count()) await picker.getByRole('button').first().click();
    // The phone shows the task summary inside #task-side and, for a route-level read, the detail page itself. Both must
    // arrive: the side panel exists for the metrics read, and the visible detail is reachable above the fixed bottom bar.
    await expect(page.locator('#task-side')).toBeAttached();
    const detail = page.getByRole('heading', { name: '检视 · Issue #1', exact: true, level: 1 }).first();
    await expect(detail).toBeVisible();
    const reached = await detail.evaluate(node => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.left + Math.min(40, r.width / 2)), Math.round(r.top + r.height / 2));
      const nav = document.querySelector('#console-mobile-nav');
      const bar = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
      return { inside: !!hit && (hit === node || node.contains(hit)), bottom: Math.round(r.bottom), navTop: bar ? Math.round(bar.top) : null };
    });
    expect(reached.inside).toBe(true);
    if (reached.navTop !== null) expect(reached.bottom).toBeLessThanOrEqual(reached.navTop);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

// #482 review, blocking: moving `⋯` to the toolbar's first grid column on a narrow screen left `.board-menu-panel`
// anchored to its right edge, so the 210px panel opened to the left of the viewport (left=-168 at 390) and none of its
// items could be tapped. The panel must stay inside the viewport and every item must be hit-testable at every width,
// and it must still close from the same toggle.
test('打开「更多视图操作」后菜单面板与每一项都在视口内且可点（320/390/1440）', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await login(page, h.admin, password);
    for (const [width, height] of [[390, 844], [320, 800], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      const toggle = page.locator('#board-view-menu .board-menu-toggle');
      const panel = page.locator('#board-view-menu .board-menu-panel');
      await expect(panel).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(panel).toBeVisible();
      const m = await page.evaluate(() => {
        const round = r => ({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) });
        const box = node => round(node.getBoundingClientRect());
        const panel = document.querySelector('#board-view-menu .board-menu-panel');
        const items = [...panel.querySelectorAll('.board-menu-item')].map(node => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { text: (node.textContent || '').trim(), box: round(r),
            hitSelf: !!(hit && (hit === node || node.contains(hit))) };
        });
        return { panel: box(panel), items, innerWidth, innerHeight };
      });
      expect(m.items.length).toBeGreaterThanOrEqual(2);
      // The whole panel sits inside the viewport, level with the toolbar rather than off its left edge.
      expect(m.panel.left).toBeGreaterThanOrEqual(0);
      expect(m.panel.right).toBeLessThanOrEqual(m.innerWidth);
      for (const item of m.items) {
        expect({ text: item.text, left: item.box.left >= 0 }).toEqual({ text: item.text, left: true });
        expect({ text: item.text, right: item.box.right <= m.innerWidth }).toEqual({ text: item.text, right: true });
        expect({ text: item.text, hit: item.hitSelf }).toEqual({ text: item.text, hit: true });
      }
      // The same toggle closes it again, at every width.
      await toggle.click();
      await expect(panel).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
