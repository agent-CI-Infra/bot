// Captures the real usage and cost page for #238: same fixture data as e2e/costs-usage.spec.mjs, two widths.
import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { managementFixture } from '../test/management-fixture.mjs';

const dir = process.env.EVIDENCE_DIR || 'docs/verification/238/after';
const seedUsage = h => {
  const rows = [
    ['req-complete', '101', 'fixture-model', '2026-11-10T10:00:00.000Z', 1000, 500, 400, 'USD', 1, 2, 0.5, 0.003],
    ['req-unpriced-usage', '101', 'fixture-model', '2026-11-10T11:00:00.000Z', 800, 200, 100, null, null, null, null, null],
    ['req-usage-missing', '102', 'fixture-model', '2026-11-10T12:00:00.000Z', null, null, null, 'USD', 1, 2, 0.5, 0.001],
    ['req-unpriced-only', '201', 'fixture-model', '2026-11-10T13:00:00.000Z', 600, 300, 50, null, null, null, null, null]
  ];
  for (const [id, repository, model, at, input, output, cached, currency, inputPrice, outputPrice, cachePrice, cost] of rows) {
    h.store.run(`INSERT INTO model_requests(id,repository_id,request_id,model_id,model_name,requested_at,state,
      input_tokens,output_tokens,cached_input_tokens,currency,input_per_million,output_per_million,cache_per_million,cost)
      VALUES(?,?,?,?,?,?,'succeeded',?,?,?,?,?,?,?,?)`,
      id, repository, 'request-' + id, 'model-fixture', model, at, input, output, cached, currency, inputPrice, outputPrice, cachePrice, cost);
  }
};

test('usage and cost page at 390 and 1440', async ({ page }) => {
  test.setTimeout(180000);
  const f = await managementFixture();
  try {
    seedUsage(f.h);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(f.h.admin + '/#/costs');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('#costs-panel').getByRole('heading', { name: '每日费用' }).waitFor();
    mkdirSync(dir, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 900 : 1100 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/costs-${width}.png`, fullPage: true });
    }
  } finally { await f.close(); }
});
