import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #978: the settings project table gave 门禁 and 看板 columns less width than their chips need, and the table-scoped
// white-space:nowrap (static/views.css:211, a ≥1280 rule) let the shared ellipsis (:234) cut「发布检查未完成」down to
//「发布检…」— the administrator read half a state at 1280 and 1440. The rule this pins: a chip in this table wraps to
// another line instead of losing characters, the row grows with it (行高自适应), and below the 1280 breakpoint the
// two-column card layout — which already fits every chip — stays as it is.
// #1011 review: wrapping the chip alone left the 看板 sentence readable in the DOM and unreadable on screen. That cell
// also hosts the row's board switch, and the cell's nowrap squeezed the chip to a one-character-per-line column while
// the 96px switch parked on top of it and covered three characters. So readable now also means hit-testable — the
// topmost element at the centre and quarter points of every rendered line is the chip or its descendant — and a chip
// must never fold into a single-character column.
const row = (page, id) => page.locator(`.global-project-row[data-repository-id="${id}"]`);

test('#978 设置页项目管理表：门禁与看板徽章在 1280/1440 完整可读，换行后行高自适应', async ({ page }) => {
  test.setTimeout(180000);
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Whether the sentence survived is read from the rendered lines, not from scrollWidth: wrapping turns the chip into a
  // flex box whose centered text item can leave a ~2px scrollable extent while every glyph is still visible, so the
  // honest reading is「every rendered line lies inside the chip's own box」. A chip that keeps one line loses its tail
  // past the right edge; a row that refused to grow would clip the wrapped lines past the bottom.
  const fits = async (chip, label) => {
    const box = await chip.evaluate(el => {
      const chipBox = el.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(el);
      const lines = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      const inside = lines.every(rect => rect.left >= chipBox.left - 0.5 && rect.right <= chipBox.right + 0.5
        && rect.top >= chipBox.top - 0.5 && rect.bottom <= chipBox.bottom + 0.5);
      return { inside, lines: lines.length, clippedDown: el.scrollHeight > el.clientHeight + 1 };
    });
    expect(box.lines, `${label} 有渲染文字`).toBeGreaterThan(0);
    expect(box.inside, `${label} 每一行都在徽章内`).toBe(true);
    expect(box.clippedDown, `${label} 高度不被裁剪`).toBe(false);
    return box;
  };
  // A line rect inside the chip's own box still proves nothing on screen: another element can paint over it — the
  // #1011 review measured the board switch sitting on three of the chip's five characters while every line rect was
  // inside. The topmost element at the centre and the quarter points of every rendered line must be the chip or one
  // of its descendants; anything else means the sentence is not what an administrator can actually read.
  const hittable = async (chip, label) => {
    const misses = await chip.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const misses = [];
      [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).forEach((rect, line) => {
        for (const fx of [0.25, 0.5, 0.75]) {
          const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height / 2);
          if (!hit || !el.contains(hit)) misses.push({ line, fx, hit: hit ? `${hit.tagName}.${hit.className}` : 'off-document' });
        }
      });
      return misses;
    });
    expect(misses, `${label} 每行命中测试（不得被开关等元素盖住）`).toEqual([]);
  };
  const readRow = async (id, width) => {
    const line = row(page, id);
    const gate = line.locator('.project-cell[data-label="门禁"] [data-integration]');
    const board = line.locator('.project-cell[data-label="看板"] [data-board-status]');
    // The exact sentences the columns used to lose: the gate chip has no integration to report (so it is the full
    // 发布检查未完成), and the board was just switched on (看板采集中).
    await expect(gate).toHaveText('发布检查未完成');
    await expect(board).toHaveText('看板采集中');
    const gateBox = await fits(gate, `${width} 门禁`);
    const boardBox = await fits(board, `${width} 看板`);
    await hittable(gate, `${width} 门禁`);
    await hittable(board, `${width} 看板`);
    // A chip squeezed to one character per line technically keeps every glyph inside its box, and that shape is what
    // the 看板 cell used to fold into while the switch covered it; a five-character sentence must not read as a
    // five-line column.
    expect(boardBox.lines, `${width} 看板不折叠成单字列`).toBeLessThanOrEqual(2);
    // 行高自适应：the row keeps its 84px floor and holds the wrapped chip inside itself, so the taller chip never
    // leans on the next row or the actions menu.
    const box = await line.evaluate(el => ({ height: el.getBoundingClientRect().height, cw: el.clientWidth, sw: el.scrollWidth, ch: el.clientHeight, sh: el.scrollHeight }));
    expect(box.height, `${width} 行高保底`).toBeGreaterThanOrEqual(84);
    expect(box.sw <= box.cw + 1, `${width} 行不横向溢出`).toBe(true);
    expect(box.sh <= box.ch + 1, `${width} 行内容不溢出行高`).toBe(true);
  };
  try {
    for (const id of ['101', '202']) {
      await repository(admin, a.id, id);
      // A collecting board is a five-character state sentence, the same shape the issue saw truncated next to the
      // row's 看板 switch.
      await admin(`/api/installations/${id}/board`, 'PATCH', { enabled: true });
    }
    await page.goto(h.admin + '/#/settings/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.global-project-table')).toBeVisible();
    await expect(page.locator('.global-project-row')).toHaveCount(2);
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('.project-table-head')).toBeVisible();
      for (const id of ['101', '202']) await readRow(id, width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(width)).toBe(true);
    }
    // Below the breakpoint the same cells become labelled pairs, and that card layout already fits every chip; the
    // wrapping rule must not follow it down there.
    for (const width of [1279, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(row(page, '101').locator('.project-cell[data-label="门禁"]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(width)).toBe(true);
      for (const id of ['101', '202']) {
        await fits(row(page, id).locator('[data-integration]'), `${width} 门禁`);
        await fits(row(page, id).locator('[data-board-status]'), `${width} 看板`);
      }
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
