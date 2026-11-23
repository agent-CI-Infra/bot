import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { harness, setup } from '../../fixtures/helpers.mjs';
import { consoleNavigate } from '../helpers/console-navigation.mjs';

// #553: empty, loading and error share consoleState(). A failed read must not
// look like an empty list, and a retry button must recover the page.

test('#553 项目列表空状态与读取失败可区分，失败可重试，1440 与 390 无溢出', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness();
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    await page.goto(h.admin + '/#/projects');

    const empty = page.locator('[data-testid=console-state-empty]');
    await expect(empty.getByRole('heading', { name: '还没有仓库', exact: true })).toBeVisible();
    await expect(empty).toContainText('不是读取失败');
    await expect(empty).toHaveAttribute('role', 'status');
    await expect(page.locator('[data-testid=console-state-error]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(empty.getByRole('heading', { name: '还没有仓库', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.route('**/api/installations*', route => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'upstream failed' }),
    }));
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    const failed = page.locator('[data-testid=console-state-error]');
    await expect(failed.getByRole('heading', { name: '项目列表未能读取', exact: true })).toBeVisible();
    await expect(failed).toContainText('这不是空列表');
    await expect(failed).toHaveAttribute('role', 'alert');
    await expect(page.locator('[data-testid=console-state-empty]')).toHaveCount(0);
    const retry = page.getByTestId('console-state-retry');
    await expect(retry).toHaveText('重新加载');
    const headingColor = await failed.locator('h2').evaluate(el => getComputedStyle(el).color);
    const danger = await page.evaluate(() => {
      const el = document.createElement('div');
      el.style.color = 'var(--color-danger)';
      document.body.append(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    });
    expect(headingColor).toBe(danger);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.unroute('**/api/installations*');
    await retry.click();
    await expect(page.locator('[data-testid=console-state-empty]').getByRole('heading', { name: '还没有仓库', exact: true })).toBeVisible();
    await expect(page.locator('[data-testid=console-state-error]')).toHaveCount(0);

    await page.goto(h.admin + '/#/design');
    await expect(page.locator('#design-empty')).toHaveAttribute('data-testid', 'console-state-empty');
    await expect(page.locator('#design-loading')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#design-error').getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  } finally { await h.stop(); }
});

test('#553 统计页读取失败显示错误状态而不是红条，可重试', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness();
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();

    await page.route('**/api/costs*', route => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'costs upstream failed' }),
    }));
    await page.goto(h.admin + '/#/costs');
    const failed = page.locator('#cost-body [data-testid=console-state-error]');
    await expect(failed.getByRole('heading', { name: '统计未能读取', exact: true })).toBeVisible();
    await expect(failed).toContainText('这不是空结果');
    await expect(page.locator('#message')).toHaveText('');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.unroute('**/api/costs*');
    await page.getByTestId('console-state-retry').click();
    await expect(page.locator('#cost-body [data-testid=console-state-error]')).toHaveCount(0);
    await expect(page.locator('#cost-body .cost-summary')).toBeVisible();
    await expect(page.getByRole('heading', { name: '没有模型请求记录', exact: true })).toBeVisible();
  } finally { await h.stop(); }
});

// #876: the identity branch of render() cleared #rows' aria-busy without asking whether its own request was still the
// newest. Leaving the identity page while its read is still out therefore ended the loading state of the list the reader
// had just opened: a screen reader was told that page had loaded before its data arrived.
test('#876 身份页读取未返回时切到项目列表，旧请求不会提前清掉新列表的 aria-busy', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness();
  let releaseIdentity = () => {}, releaseProjects = () => {};
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    // The identity page's read is held; the list read the reader switches to is held as well.
    const identityHeld = new Promise(resolve => { releaseIdentity = resolve; });
    const projectsHeld = new Promise(resolve => { releaseProjects = resolve; });
    await page.route('**/api/identity', async route => { await identityHeld; await route.continue(); });
    await page.goto(h.admin + '/#/identity');
    await expect(page.locator('#identity-panel')).toContainText('正在读取身份与权限');
    const rows = page.locator('#rows');
    await expect(rows).toHaveAttribute('aria-busy', 'true');
    await page.route('**/api/installations*', async route => { await projectsHeld; await route.continue(); });
    await consoleNavigate(page, '项目');
    await expect(page).toHaveURL(/#\/projects$/);
    await expect(rows).toHaveAttribute('aria-busy', 'true');
    // The identity read, which nobody is waiting for any more, answers now: the list has not loaded, and must keep saying so.
    const identityAnswered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/identity');
    releaseIdentity(); await identityAnswered; await page.waitForTimeout(300);
    await expect(rows).toHaveAttribute('aria-busy', 'true');
    // The state the guard keeps, at each width: the list says it is loading while its own read is out.
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    // The list's own read answers: now, and only now, the loading state ends.
    releaseProjects();
    await expect(rows).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-testid=console-state-empty]').getByRole('heading', { name: '还没有仓库', exact: true })).toBeVisible();
  } finally { releaseIdentity(); releaseProjects(); await h.stop(); }
});
