import { mkdirSync } from 'node:fs';
import { switchConsoleProject } from './console-scope-picker.mjs';
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
    const daily = panel.locator('details.cost-breakdown').filter({ hasText: '每日费用与用量明细' });
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
    await switchConsoleProject(page, '101');
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

// #643: the axis of the token chart is a whole count, not `max * 1.1` printed to six decimals. Seeded near the size
// that produced `1,439,074.45` on the live console, so a regression prints the decimal again.
const seedTokenAxis = h => {
  const rows = [
    ['643-token-a', '101', '2026-11-10T10:00:00.000Z', 900000, 400000],
    ['643-token-b', '101', '2026-11-10T11:00:00.000Z', 100000, 40074]
  ];
  for (const [id, repository, at, input, output] of rows)
    h.store.run(`INSERT INTO model_requests(id,repository_id,request_id,model_id,model_name,requested_at,state,
      input_tokens,output_tokens,cached_input_tokens,currency,input_per_million,output_per_million,cache_per_million,cost)
      VALUES(?,?,?,'model-fixture','fixture-model',?,'succeeded',?,?,0,null,null,null,null,null)`,
      id, repository, 'request-' + id, at, input, output);
};

test('the token chart axis is whole numbers, abbreviated instead of printed as decimals', async ({ page }) => {
  test.setTimeout(180000);
  const f = await managementFixture(), { h } = f;
  try {
    seedTokenAxis(h);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.clock.setFixedTime(new Date('2026-11-11T02:00:00Z'));
    await page.goto(h.admin + '/#/costs');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('#costs-panel');
    const svg = panel.locator('.cost-chart-section svg[data-metric=tokens]');
    await expect(svg).toHaveCount(1);
    const labels = await svg.locator('text').allTextContents();
    expect(labels.some(label => /万$/.test(label))).toBe(true);
    // No axis reading is a decimal any more; the date ticks below the plot are `MM-DD` and carry no dot either.
    expect(labels.filter(label => label.includes('.'))).toEqual([]);
    // The top of the axis still covers the tallest bar, so a whole label never cuts the data off.
    const toValue = label => label.endsWith('亿') ? Number(label.slice(0, -1)) * 1e8
      : label.endsWith('万') ? Number(label.slice(0, -1)) * 1e4 : Number(label);
    const ticks = labels.filter(label => /^(\d+(?:\.\d+)?)[万亿]?$/.test(label)).map(toValue);
    const values = await svg.locator('rect').evaluateAll(nodes => nodes.map(node => Number(node.dataset.value)));
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(Math.max(...values));
  } finally { await f.close(); }
});

test('an all-unpriced range says why and links a super admin to the model prices', async ({ page }) => {
  test.setTimeout(180000);
  const f = await managementFixture(), { h } = f;
  try {
    seedTokenAxis(h);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.clock.setFixedTime(new Date('2026-11-11T02:00:00Z'));
    await page.goto(h.admin + '/#/costs');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('#costs-panel');
    const card = panel.locator('[data-metric=cost]');
    await expect(card).toContainText('未定价');
    await expect(card).toContainText('还没有为这些模型设置单价');
    const link = card.getByRole('link', { name: '去设置模型单价' });
    await expect(link).toHaveAttribute('href', '#/settings/models');
    // 390: the sentence and the link stay inside the card instead of pushing the summary sideways.
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/#\/settings\/models$/);
  } finally { await f.close(); }
});

// #875: an outer role="img" flattens the focusable bars, so a screen reader never reached the per-bar label; and the
// two tables below the chart sum by project and by day, so neither carried the value behind one bar.
test('the chart is a group of labelled bars and a date × project table carries the same values', async ({ page }) => {
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
    const svg = panel.locator('.cost-chart-section svg[data-metric=cost]');
    await expect(svg).toHaveCount(1);
    // The chart itself is a labelled group, not one image.
    await expect(svg).toHaveAttribute('role', 'group');
    await expect(svg).toHaveAttribute('aria-label', /每日模型估算费用/);
    // No bar sits inside a role=img subtree any more: each bar is its own image, and the svg above it is not one.
    expect(await svg.evaluate(node => [...node.querySelectorAll('rect')].every(rect => rect.closest('[role=img]') === rect))).toBe(true);
    expect(await svg.evaluate(node => node.closest('[role=img]') === null)).toBe(true);
    const labels = await svg.locator('rect').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).toMatch(/^\d{4}-\d{2}-\d{2} · .+ · .+ · 当日 \d+\.\d%$/);
    // One row per bar, with the same date · project · amount · share the bar announces.
    const bars = panel.locator('details.cost-chart-table').filter({ hasText: '日期 × 项目费用明细' });
    await expect(bars).toHaveCount(1);
    await bars.locator('summary').click();
    await expect(bars.locator('tbody tr')).toHaveCount(labels.length);
    const first = (await bars.locator('tbody tr').first().locator('td').allTextContents()).map(cell => cell.trim());
    const firstLabel = labels.find(label => label.startsWith(first[0] + ' · ' + first[1] + ' · '));
    expect(firstLabel).toBeTruthy();
    expect(firstLabel).toContain(first[2]);
    expect(firstLabel.endsWith('当日 ' + first[3])).toBe(true);
    // Focusing a bar still reports it through the existing live line.
    await svg.locator('rect').first().focus();
    await expect(panel.locator('.cost-chart-detail').first()).toHaveText(labels[0]);
    // The two pre-existing tables keep their place and scope.
    await expect(panel.locator('section.cost-breakdown').filter({ hasText: '项目占比' })).toHaveCount(1);
    await expect(panel.locator('details.cost-breakdown').filter({ hasText: '每日费用与用量明细' })).toHaveCount(1);
  } finally { await f.close(); }
});
test('all-project cost rows link to the project address and keep its query scope', async ({ page }) => {
  const f = await managementFixture(), { h } = f;
  try {
    seedUsage(h); mkdirSync('.tmp/project-scope-routes', { recursive: true });
    await page.clock.setFixedTime(new Date('2026-11-11T02:00:00Z'));
    await page.goto(h.admin + '/#/costs');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const project = page.locator('section.cost-breakdown a[href="#/projects/101/costs"]').first();
    await expect(project).toContainText('admin-fixture-101');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await project.click({ trial: true });
      await expect.poll(() => project.evaluate(node => {
        const box = node.getBoundingClientRect(), line = parseFloat(getComputedStyle(node).lineHeight);
        const cell = node.parentElement, style = getComputedStyle(cell), padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        return { oneLine: box.height <= line + 1 && cell.offsetHeight <= line + padding + 2, hit: node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) };
      })).toMatchObject({ oneLine: true, hit: true });
      await page.screenshot({ path: `.tmp/project-scope-routes/cost-project-links-${width}.png` });
    }
    const scoped = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/api/costs' && url.searchParams.get('repository_id') === '101';
    });
    await project.click(); await scoped;
    await expect(page).toHaveURL(/#\/projects\/101\/costs$/);
    await expect(page.locator('.cost-token-summary [data-metric="input_tokens"] strong')).toHaveText('1,800');
  } finally { await f.close(); }
});
