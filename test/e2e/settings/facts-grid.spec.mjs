import { test, expect } from '@playwright/test';
import { identityFixture } from '../../fixtures/identity-fixture.mjs';

// Regression guard for the storage page's label/value lists (`.facts`, `static/views.css`). The grid's first column is
// `auto` and its `dt` never wraps, so a long label takes its whole max-content width out of the row and the value column
// gets the remainder: at 390 the longest labels ("最近一次 manager 重复正文清理", "任务工作区清理（各项目最近一次之和）")
// took 216 of the 298px and the value column got 70px, one character per line. main keeps the value column at least 140px
// below 560px and wraps the label there instead. This spec measures the value column, not the card height, because the
// height also depends on how much history the fixture happens to hold.
const viewports = [[390, 844], [768, 1024], [1440, 900]];
// The floor the narrow layout promises; the same floor holds at 768 and 1440, where the page has more room and the column
// is not allowed to end up narrower than the narrow layout guarantees.
const valueColumnFloor = 140;
const longestLabel = '最近一次 manager 重复正文清理';

const panel = page => page.locator('#settings-panel');

// Every label/value pair on the page, with the width the value column actually gets. The pairs are read from the same
// `.facts` list, so a label that swallowed its row is reported by its own name.
async function factColumns(page) {
  return page.evaluate(() => [...document.querySelectorAll('#settings-panel .facts')].flatMap(facts => {
    const labels = [...facts.querySelectorAll('dt')], values = [...facts.querySelectorAll('dd')], gaps = getComputedStyle(facts).columnGap;
    return labels.map((label, index) => ({
      label: (label.textContent || '').trim(),
      value: (values[index]?.textContent || '').trim().slice(0, 40),
      labelWidth: Math.round(label.getBoundingClientRect().width),
      valueWidth: Math.round(values[index]?.getBoundingClientRect().width ?? 0),
      gap: Math.round(parseFloat(gaps) || 0)
    }));
  }));
}

// A card must keep its own content inside its width: solving the squeeze by letting the list overflow sideways is not a
// fix, and measuring `scrollWidth` is how that failure is caught before a screenshot would.
async function overflowingCards(page) {
  return page.evaluate(() => [...document.querySelectorAll('#settings-panel .side-card')]
    .filter(card => card.scrollWidth > card.clientWidth + 1)
    .map(card => ({ title: (card.querySelector('h2, h3')?.textContent || '').trim(), client: card.clientWidth, scroll: card.scrollWidth })));
}

test('390 下存储页的 facts 值列不被长标签挤掉', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.h.admin + '/#/settings/storage');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // The card that holds the long labels only exists in the storage page's detail list, so waiting for one of those
    // labels is what separates "the page is still loading" from "the value column is narrow".
    await expect(panel(page)).toContainText(longestLabel);
    await expect(panel(page).getByText('正在加载…')).toHaveCount(0);
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expect(panel(page).getByText('正在加载…')).toHaveCount(0);
      await expect(panel(page)).toContainText(longestLabel);
      const columns = await factColumns(page);
      expect(columns.length, `存储页在 ${width}px 下没有画出任何 facts 列表`).toBeGreaterThan(0);
      for (const column of columns) {
        expect(column.valueWidth, `「${column.label}」在 ${width}px 下只剩 ${column.valueWidth}px 的值列（标签 ${column.labelWidth}px、间距 ${column.gap}px；值：${column.value}）`)
          .toBeGreaterThanOrEqual(valueColumnFloor);
      }
      expect(await overflowingCards(page), `存储页的卡片在 ${width}px 下横向溢出`).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
