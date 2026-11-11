import { test, expect } from '@playwright/test';
import { managementFixture } from '../test/management-fixture.mjs';

// #357 acceptance 1: costs are never converted or summed across currencies, but the page used to present one
// currency's total as if it were the whole bill. The hint has to name the other currency and its request count for
// exactly this filter, and it must come from the same read-only endpoint — nothing converted, nothing added up.
const seedUsage = h => {
  const rows = [
    // Two USD requests and three CNY requests under the same date range: whichever currency is shown, the other one
    // still had traffic and the reader has to be told.
    ['usd-1', '101', '2026-11-10T10:00:00.000Z', 'USD', 0.003],
    ['usd-2', '101', '2026-11-10T11:00:00.000Z', 'USD', 0.004],
    ['cny-1', '101', '2026-11-10T12:00:00.000Z', 'CNY', 0.02],
    ['cny-2', '101', '2026-11-10T13:00:00.000Z', 'CNY', 0.03],
    ['cny-3', '101', '2026-11-10T14:00:00.000Z', 'CNY', 0.04],
    // A project with USD traffic only: narrowed to it, the other currency had nothing and the page says nothing.
    ['usd-102', '102', '2026-11-10T15:00:00.000Z', 'USD', 0.001],
    // An unpriced request carries no currency. The hint counts the other currency only, so this row must never be
    // attributed to CNY (the /api/costs totals include it, which is why the count cannot come from summary.requests).
    ['unpriced-1', '101', '2026-11-10T16:00:00.000Z', null, null]
  ];
  for (const [id, repository, at, currency, cost] of rows) {
    h.store.run(`INSERT INTO model_requests(id,repository_id,request_id,model_id,model_name,requested_at,state,
      input_tokens,output_tokens,cached_input_tokens,currency,input_per_million,output_per_million,cache_per_million,cost)
      VALUES(?,?,?,?,?,?,'succeeded',?,?,?,?,?,?,?,?)`,
      id, repository, 'request-' + id, 'model-fixture', 'fixture-model', at, 100, 50, 0, currency, 1, 2, 0.5, cost);
  }
};

test.use({ timezoneId: 'Asia/Shanghai' });

test('the costs page says when the other currency also had requests under the same filter', async ({ page }) => {
  test.setTimeout(180000);
  const f = await managementFixture(), { h } = f;
  try {
    seedUsage(h);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.clock.setFixedTime(new Date('2026-11-11T02:00:00Z'));
    await page.goto(h.admin + '/#/costs');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('#costs-panel');
    await expect(panel).toContainText('每日费用');
    // USD is the default: two USD requests are on this page, three CNY requests are not, and the page says so.
    await expect(panel.locator('[data-other-currency]')).toContainText('还有 3 次请求属于另一币种（CNY）');
    await expect(panel.locator('[data-other-currency]')).toContainText('未计入本页金额');
    // The hint is a sentence, not a second amount: the summary still shows USD only.
    await expect(panel.locator('[data-metric="cost"] strong')).toContainText('USD');
    // Switching the filter flips the sentence, and the count follows the same date range.
    await page.getByLabel('费用币种').selectOption('CNY');
    await page.getByRole('button', { name: '查看统计', exact: true }).click();
    await expect(panel).toContainText('每日费用');
    await expect(panel.locator('[data-other-currency]')).toContainText('还有 3 次请求属于另一币种（USD）');
    // The unpriced row has no currency, so the USD view still counts exactly the three CNY requests.
    await expect(panel.locator('[data-other-currency]')).not.toContainText('4 次');
    // A filter whose other currency had no request keeps a single currency on screen and says nothing.
    await page.getByLabel('费用币种').selectOption('USD');
    await page.getByLabel('统计项目').selectOption('102');
    await page.getByRole('button', { name: '查看统计', exact: true }).click();
    await expect(panel).not.toContainText('正在加载统计');
    await expect(panel.locator('[data-other-currency]')).toHaveCount(0);
    await expect(panel).not.toContainText('另一币种');
    expect(await page.locator('#costs-panel').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  } finally { await f.close(); }
});
