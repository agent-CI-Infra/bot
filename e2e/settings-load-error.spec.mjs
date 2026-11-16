import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #976: the three global settings tabs (项目管理 / 存储 / 模型) drew 正在加载… and then awaited their loader with no
// catch. Any refused read rejected renderSettings as a whole, so the placeholder stayed on the page forever: no error
// card, no retry, only a transient strip message. #/costs and #/identity already replaced their panel with the shared
// consoleState error; the settings panel now fails the same way, once, for every tab.
const outage = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture outage"}' });

async function signIn(page, base, password) {
  await page.goto(base + '/');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('body.console-ready')).toHaveCount(1);
}

// A refused read replaces the category's placeholder with the shared error card; the retry has to bring the real card
// back once the service answers again, so the page is never left on the failure after one bad read.
async function readFailureRecovers(page, base, { hash, patterns, heading, recovered }) {
  for (const pattern of patterns) await page.route(pattern, outage);
  await page.goto(base + '/');
  await page.evaluate(target => { location.hash = target; }, hash);
  // A signed-in reload is the harshest path: the settings panel is drawn from the first render with the read already
  // failing, which is the case the report measured.
  await page.reload();
  const panel = page.locator('#settings-panel');
  const failed = panel.locator('[data-testid=console-state-error]');
  await expect(failed.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(failed).toContainText('这不是空结果');
  await expect(failed).toContainText('503 · fixture outage');
  // The tab it replaced is named, and the placeholder it replaced is gone.
  await expect(panel).not.toContainText('正在加载…');
  await expect(page.locator('#count')).toHaveText('读取失败');
  const retry = failed.getByTestId('console-state-retry');
  await expect(retry).toHaveText('重新加载');
  await expect(retry).toBeEnabled();
  for (const pattern of patterns) await page.unroute(pattern);
  await retry.click();
  await expect(panel.locator('[data-testid=console-state-error]')).toHaveCount(0);
  await expect(panel).toContainText(recovered);
  await expect(panel).not.toContainText('正在加载…');
}

test('项目管理 read failure shows the error card and recovers through 重新加载', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(), { password, admin } = await setup(h), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    // One real project: the recovery has to bring the list back, not just remove the card.
    await repository(admin, (await account(admin)).id, '101');
    await signIn(page, h.admin, password);
    await readFailureRecovers(page, h.admin, {
      hash: '#/settings/projects', patterns: [/\/api\/installations\?/],
      heading: '项目管理读取失败', recovered: 'fixture/project-101'
    });
    await expect(page.locator('#settings-panel .global-project-table')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('存储 read failure shows the error card and recovers through 重新加载', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(), { password, admin } = await setup(h), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    // A real project, so the recovered page has its 按项目 table to show again.
    await repository(admin, (await account(admin)).id, '101');
    await signIn(page, h.admin, password);
    await readFailureRecovers(page, h.admin, {
      hash: '#/settings/storage', patterns: [/\/api\/storage(\?|$)/],
      heading: '存储读取失败', recovered: '这里统计'
    });
    await expect(page.locator('#settings-panel .storage-projects').first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('模型 read failure (接入向导 + 模型列表) shows the error card and recovers through 重新加载', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(), { password } = await setup(h), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await signIn(page, h.admin, password);
    // The tab reads two endpoints together; both refused is the reported shape of the failure.
    await readFailureRecovers(page, h.admin, {
      hash: '#/settings/models', patterns: [/\/api\/onboarding(\?|$)/, /\/api\/models(\?|$)/],
      heading: '模型读取失败', recovered: '默认共享模型'
    });
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// The control pages keep their own error cards and retry: the same mock that fails the settings tabs proves the
// fixture is real, and neither page regressed.
test('对照页 用量与成本 / 身份与权限 的错误态不回归', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(), { password } = await setup(h);
  try {
    await signIn(page, h.admin, password);
    await page.route('**/api/costs*', outage);
    await page.evaluate(() => { location.hash = '#/costs'; });
    const costs = page.locator('#cost-body [data-testid=console-state-error]');
    await expect(costs.getByRole('heading', { name: '统计未能读取', exact: true })).toBeVisible();
    await expect(costs.getByTestId('console-state-retry')).toHaveText('重新加载');
    await page.unroute('**/api/costs*');
    await costs.getByTestId('console-state-retry').click();
    await expect(page.locator('#cost-body [data-testid=console-state-error]')).toHaveCount(0);
    await expect(page.locator('#cost-body .cost-summary')).toBeVisible();
    await page.route('**/api/identity', outage);
    await page.evaluate(() => { location.hash = '#/identity'; });
    await expect(page.getByRole('heading', { name: '身份与权限读取失败', exact: true })).toBeVisible();
    await page.unroute('**/api/identity');
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
  } finally { await h.stop(); }
});
