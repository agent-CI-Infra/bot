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
        const style = getComputedStyle(select), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const selected = select.options[select.selectedIndex];
        const name = selected ? selected.text : '';
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const saveBox = box(save);
        const hit = (fx) => { const e = document.elementFromPoint(saveBox.left + saveBox.width * fx, saveBox.top + saveBox.height / 2); return e ? (e.id || e.tagName.toLowerCase()) : null; };
        const controls = [['view', select], ['state', state], ['save', save], ['more', more], ['create', create]];
        const overlaps = [];
        for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
          if (overlap(box(controls[i][1]), box(controls[j][1]))) overlaps.push([controls[i][0], controls[j][0]]);
        }
        return { select: box(select), save: saveBox, more: box(more), name, textWidth: ctx.measureText(name).width, padding,
          overlaps, hitAtSaveCentre: hit(0.5), hitAtSaveRight: hit(0.95), docWidth: document.documentElement.scrollWidth, innerWidth };
      });
      // The view name has to fit inside the selector: its text plus the control's own padding and its arrow.
      expect(m.select.width - m.padding - 16).toBeGreaterThanOrEqual(m.textWidth);
      expect(m.select.width).toBeGreaterThanOrEqual(110);
      // The view controls and the other toolbar actions must not sit under one another.
      expect(m.overlaps).toEqual([]);
      expect(m.hitAtSaveCentre).toBe('board-save');
      expect(m.hitAtSaveRight).toBe('board-save');
      expect(m.docWidth).toBeLessThanOrEqual(m.innerWidth);
    }
    // The same collision appears at 768 in the clean state (the selector's right edge ran 4px under `⋯`).
    await page.setViewportSize({ width: 768, height: 900 });
    await page.getByRole('button', { name: '保存视图', exact: true }).click().catch(() => {});
    await expect(page.locator('#board-view-state')).toBeHidden();
    await page.waitForTimeout(300);
    const clean = await page.evaluate(() => {
      const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      const select = document.getElementById('board-view-select');
      const more = document.querySelector('#board-view-menu .board-menu-toggle');
      return { selects: box(select), more: box(more), overlaps: overlap(box(select), box(more)) };
    });
    expect(clean.overlaps).toBe(false);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

// #482: repository and work type are the view selector's neighbours in one toolbar row — compact selects reading
// 视图 → 仓库 → 工作类型 — and the phone keeps all three usable on its first screen without opening `⋯` or 筛选.
test('仓库与工作类型紧挨视图：1440 一排按视图→仓库→工作类型，390 首屏三个控件命中可点', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    const saved = (await admin('/api/board/views', 'POST', { name: '只看仓库 202', group_by: 'bot_stage', filters: [{ field: 'repository_id', value: '202' }], hidden_columns: [] })).value.view;
    await page.setViewportSize({ width: 1440, height: 900 }); await login(page, h.admin, password);
    const view = page.getByLabel('视图', { exact: true }), repo = page.getByLabel('仓库', { exact: true }), work = page.getByLabel('工作类型', { exact: true });
    await expect(repo).toBeVisible();
    await expect(work).toBeVisible();
    // The three controls share one line and read left to right in that order, with no horizontal overflow.
    const row = await page.evaluate(() => {
      const box = node => { const r = node.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) }; };
      const select = label => [...document.querySelectorAll('.board-arrangement select')].find(node => node.getAttribute('aria-label') === label) || null;
      const node = { view: select('视图'), repo: select('仓库'), work: select('工作类型') };
      return { view: node.view && box(node.view), repo: node.repo && box(node.repo), work: node.work && box(node.work),
        docWidth: document.documentElement.scrollWidth, innerWidth };
    });
    expect(row.repo).not.toBeNull(); expect(row.work).not.toBeNull();
    expect(row.repo.left).toBeGreaterThanOrEqual(row.view.right);
    expect(row.work.left).toBeGreaterThanOrEqual(row.repo.right);
    expect(Math.abs(row.repo.top - row.view.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(row.work.top - row.view.top)).toBeLessThanOrEqual(1);
    expect(row.docWidth).toBeLessThanOrEqual(row.innerWidth);
    // The repository select is the same repository filter the chips already carried: choosing one sets the condition.
    await repo.selectOption('202');
    await expect(page.locator('#board-chips')).toContainText('仓库');
    await expect(page.locator('#board-chips')).toContainText('202');
    await page.getByLabel('工作类型', { exact: true }).selectOption('');
    // A saved view that already holds a repository condition shows it in the select instead of an empty one.
    await page.locator('#board-view-select').selectOption(saved.id);
    await expect(page.getByLabel('仓库', { exact: true })).toHaveValue('202');

    await page.setViewportSize({ width: 390, height: 844 });
    const details = page.locator('.board-filter-details');
    await expect(details).not.toHaveAttribute('open');
    const more = page.getByRole('button', { name: '更多视图操作', exact: true });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    // All three controls are on the phone's first screen and nothing covers them: a tap at their centre reaches them.
    const hit = await page.evaluate(() => {
      const ids = {};
      const pick = (element, name) => { const r = element.getBoundingClientRect(); ids[name] = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
      pick(document.getElementById('board-view-select'), 'view');
      const select = label => [...document.querySelectorAll('.board-arrangement select')].find(node => node.getAttribute('aria-label') === label);
      pick(select('仓库'), 'repo'); pick(select('工作类型'), 'work');
      const reach = ({ x, y }) => { const node = document.elementFromPoint(x, y); return node && node.tagName === 'SELECT' ? node.getAttribute('aria-label') : null; };
      return { ids, view: reach(ids.view), repo: reach(ids.repo), work: reach(ids.work), innerWidth };
    });
    expect(hit.view).toBe('视图'); expect(hit.repo).toBe('仓库'); expect(hit.work).toBe('工作类型');
    expect(hit.ids.view.bottom).toBeLessThanOrEqual(844);
    expect(hit.ids.repo.bottom).toBeLessThanOrEqual(844);
    expect(hit.ids.work.bottom).toBeLessThanOrEqual(844);
    // Switching the view never needs the `⋯` menu: the toolbar select does it with the menu still closed.
    await page.getByLabel('视图', { exact: true }).selectOption(saved.id);
    await expect(page.getByLabel('视图', { exact: true })).toHaveValue(saved.id);
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
