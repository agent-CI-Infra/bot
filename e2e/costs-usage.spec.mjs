import { test, expect } from '@playwright/test';
import { managementFixture } from '../test/management-fixture.mjs';

// Usage is recorded once per model request. A cached prompt is part of the input, an unpriced request is not a zero
// cost, and a request without token counts is not a zero-token request: the page has to say so instead of printing 0.
const seedUsage = h => {
  const rows = [
    // 101: complete usage, priced.
    ['req-complete', '101', 'fixture-model', '2026-11-10T10:00:00.000Z', 1000, 500, 400, 'USD', 1, 2, 0.5, 0.003],
    // 101: complete usage, no price recorded.
    ['req-unpriced-usage', '101', 'fixture-model', '2026-11-10T11:00:00.000Z', 800, 200, 100, null, null, null, null, null],
    // 102: priced, but the usage numbers are missing.
    ['req-usage-missing', '102', 'fixture-model', '2026-11-10T12:00:00.000Z', null, null, null, 'USD', 1, 2, 0.5, 0.001],
    // 201: complete usage, never priced.
    ['req-unpriced-only', '201', 'fixture-model', '2026-11-10T13:00:00.000Z', 600, 300, 50, null, null, null, null, null]
  ];
  for (const [id, repository, model, at, input, output, cached, currency, inputPrice, outputPrice, cachePrice, cost] of rows) {
    h.store.run(`INSERT INTO model_requests(id,repository_id,request_id,model_id,model_name,requested_at,state,
      input_tokens,output_tokens,cached_input_tokens,currency,input_per_million,output_per_million,cache_per_million,cost)
      VALUES(?,?,?,?,?,?,'succeeded',?,?,?,?,?,?,?,?)`,
      id, repository, 'request-' + id, 'model-fixture', model, at, input, output, cached, currency, inputPrice, outputPrice, cachePrice, cost);
  }
};

// The page defaults to the last 30 days of the browser clock, so the test pins both: the same local day on every runner
// and a fixed today. Without this the fixture falls out of the default window and the assertions rot on a real calendar.
test.use({ timezoneId: 'Asia/Shanghai' });

test('usage and cost page separates cached input, unpriced requests and missing usage from zero', async ({ page }) => {
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

    // A mocked provider's cached prompt is still input: 1000+800+600 input tokens, never plus the 550 cached ones.
    await expect(panel.locator('[data-metric="input_tokens"] strong')).toHaveText('2,400');
    await expect(panel.locator('[data-metric="cached_input_tokens"] strong')).toHaveText('550');

    // Missing price is named, not counted as zero; the priced total still shows the currency it was priced in.
    await expect(panel.locator('[data-metric="cost"] strong')).toContainText('USD');
    await expect(panel).toContainText('未定价');
    // Missing usage is named, not counted as zero tokens.
    await expect(panel).toContainText('未计量');
    // Partial coverage is called out instead of reading as a complete total.
    await expect(panel).toContainText('不完整');

    // A day without any request is empty, not unmetered: the daily table keeps the same rule as the summary card.
    const daily = panel.locator('details.cost-breakdown').filter({ hasText: '每日费用与 token 明细' });
    await daily.locator('summary').click();
    const emptyDay = daily.locator('tbody tr').filter({ hasText: '2026-11-09' });
    await expect(emptyDay).toHaveCount(1);
    const cells = await emptyDay.locator('td').allTextContents();
    expect(cells.join(' ')).toBe('2026-11-09 USD 0.00 0 — — — 0');
  } finally { await f.close(); }
});
