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

// #238: a work type's count is the entry to the tasks behind it. The console has shown the type of every task for a
// while; without this the number is a total nobody can check.
const seedWorkTypeTasks = h => {
  const rows = [
    ['238-review-issue', '101', 'review.issue', 'succeeded', 'REVIEW-ISSUE-ONLY 检视一个 issue'],
    ['238-development-issue', '101', 'development.issue', 'waiting_environment', 'DEV-ISSUE-ONLY 实现一个 issue']
  ];
  for (const [id, repository, kind, status, summary] of rows)
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,created_at,updated_at) VALUES(?,?,?,?,'task',?,?,?)",
      id, repository, kind, status, summary, '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z');
};

test('a work type count opens only its tasks and an empty type says there are none', async ({ page }) => {
  test.setTimeout(180000);
  const f = await managementFixture(), { h } = f;
  try {
    seedWorkTypeTasks(h);
    const calls = [];
    page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/tasks') calls.push(url); });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.clock.setFixedTime(new Date('2026-11-11T02:00:00Z'));
    await page.goto(h.admin + '/#/costs');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('#costs-panel');
    const summary = panel.locator('.statistics-task-summary');
    await expect(summary).toContainText('任务数');
    const review = summary.locator('tr[data-kind="review.issue"]'), development = summary.locator('tr[data-kind="development.issue"]');
    await expect(review).toHaveCount(1);
    await expect(development).toHaveCount(1);
    // The cell still reads as the count; only the entry itself changes.
    await expect(review.locator('button')).toHaveText('1');

    await review.locator('button').click();
    const drill = panel.locator('tr.statistics-drill');
    await expect(drill).toHaveCount(1);
    await expect(drill).toContainText('REVIEW-ISSUE-ONLY');
    await expect(drill).not.toContainText('DEV-ISSUE-ONLY');
    await expect(drill).toContainText('共 1 项');
    // The list ignores the date range, which is stated where a longer list would otherwise look like a bug.
    await expect(drill).toContainText('不限制任务列表');
    await expect(review.locator('button')).toHaveAttribute('aria-expanded', 'true');
    expect(calls.at(-1).searchParams.get('workflow')).toBe('review.issue');
    expect(calls.at(-1).searchParams.get('repository_id')).toBeNull();

    // Pressing the same count again closes the list.
    await review.locator('button').click();
    await expect(drill).toHaveCount(0);

    // One list at a time, and always the type whose count was pressed.
    await development.locator('button').click();
    await expect(drill).toHaveCount(1);
    await expect(drill).toContainText('DEV-ISSUE-ONLY');
    await expect(drill).not.toContainText('REVIEW-ISSUE-ONLY');
    expect(calls.at(-1).searchParams.get('workflow')).toBe('development.issue');

    // A type without tasks in the range says so instead of leaving an empty box.
    await summary.locator('tr[data-kind="review.pr"] button').click();
    await expect(drill).toContainText('没有该工作类型的任务');
    await expect(drill.locator('table')).toHaveCount(0);

    // The opened list follows the project filter, so it covers the same scope as the summary above it.
    await panel.getByLabel('统计项目').selectOption('101');
    await panel.getByRole('button', { name: '查看统计' }).click();
    await expect(panel.locator('tr.statistics-drill')).toHaveCount(0);
    await summary.locator('tr[data-kind="review.issue"] button').click();
    await expect(panel.locator('tr.statistics-drill')).toContainText('REVIEW-ISSUE-ONLY');
    expect(calls.at(-1).searchParams.get('workflow')).toBe('review.issue');
    expect(calls.at(-1).searchParams.get('repository_id')).toBe('101');

    // Phone width: the list stays inside the table's own horizontal scroll instead of becoming an overlay.
    await page.setViewportSize({ width: 390, height: 900 });
    await panel.locator('tr[data-kind="development.issue"] button').click();
    await expect(panel.locator('tr.statistics-drill')).toContainText('DEV-ISSUE-ONLY');
  } finally { await f.close(); }
});
