import { test, expect } from '@playwright/test';
import { harness, setup } from '../../fixtures/helpers.mjs';

// #800: a read that fails on the network printed the browser's own English text. Chromium's TypeError message is
// "Failed to fetch", Firefox's is "NetworkError when attempting to fetch resource.", Safari's is "Load failed" — the
// card must say the same thing in the page's language whatever the browser calls it, and keep its retry.
test('#800 统计读取遇到网络失败时用中文说明，不露出 Failed to fetch（390 宽）', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness();
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // Signed in once the console shell marks the body; the sign-in form stays in the DOM but hidden.
    await expect(page.locator('body.console-ready')).toHaveCount(1);

    // route.abort() is a fetch that never reaches the service: the browser raises its own TypeError, which is exactly
    // the case a 500 response fixture does not cover.
    await page.route('**/api/costs*', route => route.abort());
    await page.goto(h.admin + '/#/costs');
    const failed = page.locator('#cost-body [data-testid=console-state-error]');
    await expect(failed.getByRole('heading', { name: '统计未能读取', exact: true })).toBeVisible();
    await expect(failed).toContainText('网络连接失败，请稍后重试。');
    await expect(failed).not.toContainText('Failed to fetch');
    await expect(failed).toContainText('这不是空结果');
    // The longer Chinese sentence must not push the page sideways at the width the report came from.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.unroute('**/api/costs*');
    await page.getByTestId('console-state-retry').click();
    await expect(page.locator('#cost-body [data-testid=console-state-error]')).toHaveCount(0);
    await expect(page.locator('#cost-body .cost-summary')).toBeVisible();
  } finally { await h.stop(); }
});

test('#800 待处理列表读取遇到网络失败时用同一句中文说明', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness();
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // Signed in once the console shell marks the body; the sign-in form stays in the DOM but hidden.
    await expect(page.locator('body.console-ready')).toHaveCount(1);

    await page.route('**/api/tasks?attention=*', route => route.abort());
    await page.goto(h.admin + '/#/inbox');
    const failed = page.locator('.console-state');
    await expect(page.getByRole('heading', { name: '待处理事项未能读取' })).toBeVisible();
    await expect(failed).toContainText('网络连接失败，请稍后重试。');
    await expect(failed).not.toContainText('Failed to fetch');
    await expect(failed).toContainText('尚不能判断');
    await page.unroute('**/api/tasks?attention=*');
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(page.locator('.console-state')).not.toContainText('待处理事项未能读取');
  } finally { await h.stop(); }
});
