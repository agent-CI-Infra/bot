import { test, expect } from '@playwright/test';
import { harness, setup, testPassword } from '../../fixtures/helpers.mjs';

// #554: workspace navigation uses one linear SVG set; glyphs ⌂▤◷⋯ are gone,
// and every entry keeps its visible text as the accessible name.
const glyphs = /[⌂▤◷⋯]/;

test('#554 侧栏与移动端底栏使用线性图标，1440 与 390 可识别且无横向溢出', async ({ page }) => {
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
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();

    const sidebar = page.locator('#console-sidebar');
    await expect(sidebar.getByRole('link', { name: '项目', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('link', { name: '管理助手', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('link', { name: '用量与成本', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '仓库事件', exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: '待处理', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('link', { name: '个人设置', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('link', { name: '全局设置', exact: true }).locator('svg.console-icon')).toBeVisible();
    const sidebarText = await sidebar.innerText();
    expect(sidebarText).not.toMatch(glyphs);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);

    // Switching the language re-translates every [data-i18n] node; the sidebar entries must keep their icons both ways.
    const sidebarEntries = sidebar.locator('#tabs [data-console-nav]');
    const entryCount = await sidebarEntries.count();
    expect(entryCount).toBe(6);
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(sidebar.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Repository events', exact: true })).toHaveCount(0);
    for (let i = 0; i < entryCount; i++) await expect(sidebarEntries.nth(i).locator('svg.console-icon')).toHaveCount(1);
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await expect(sidebar.getByRole('link', { name: '项目', exact: true })).toBeVisible();
    for (let i = 0; i < entryCount; i++) await expect(sidebarEntries.nth(i).locator('svg.console-icon')).toHaveCount(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    const mobile = page.locator('#console-mobile-nav');
    await expect(mobile).toBeVisible();
    // #1222: four phone destinations, each with one decorative SVG.
    await expect(mobile.locator('svg.console-icon')).toHaveCount(4);
    for (const name of ['项目', '待处理', '助手', '用量与成本']) {
      const item = mobile.getByRole('link', { name, exact: true });
      await expect(item).toBeVisible();
      await expect(item.locator('svg.console-icon')).toBeVisible();
    }
    expect(await mobile.innerText()).not.toMatch(glyphs);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await mobile.getByRole('link', { name: '用量与成本', exact: true }).click();
    await expect(page.getByRole('heading', { name: '用量与成本', exact: true })).toBeVisible();
    await expect(mobile.locator('.console-icon-chart')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    // Empty and error states carry an inline SVG mark (a data: mask image would be blocked by the console CSP).
    const stateIcon = async (selector, name, size) => {
      const state = page.locator(selector).first();
      await expect(state).toBeVisible();
      const icon = state.locator('svg.console-state-icon.console-icon-' + name);
      await expect(icon).toBeVisible();
      // Bootstrap can replace the visible list state between locating its icon and measuring it.
      await expect.poll(async () => {
        const box = await icon.boundingBox();
        return box ? Math.round(box.width) : null;
      }).toBe(size);
      expect(await icon.evaluate(el => el.querySelectorAll('path, circle').length)).toBeGreaterThan(0);
      expect(await state.evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
    };
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.unrouteAll({ behavior: 'wait' });
      // Leave the inbox first: the second pass would otherwise keep the failed read from the first.
      await page.goto(h.admin + '/#/costs');
      await expect(page.getByRole('heading', { name: '用量与成本', exact: true })).toBeVisible();
      await page.goto(h.admin + '/#/inbox');
      // Pages keep other (hidden) list states in the DOM since #553; read the one on screen. Phones use a 24px mark.
      await stateIcon('.console-state-empty:visible', 'tray', width === 390 ? 24 : 32);
      await page.route('**/api/tasks?attention=*', route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
      await page.reload();
      await stateIcon('.console-state-error:visible', 'alert', width === 390 ? 24 : 32);
    }
  } finally { await h.stop(); }
});

test('#554 #1369 项目管理员的桌面侧栏与超管同样用线性图标，没有「更多功能」（1440）', async ({ browser }) => {
  const h = await harness();
  try {
    const { admin } = await setup(h);
    const memberPassword = testPassword();
    await admin('/api/users', 'POST', { username: 'member', password: memberPassword, role: 'project_admin', repository_ids: [] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
    await page.goto(h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('member');
    await page.getByLabel('密码', { exact: true }).fill(memberPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await expect(page.locator('#who')).toContainText('项目管理员');
    const sidebar = page.locator('#console-sidebar'), entries = sidebar.locator('#tabs [data-console-nav]');
    await expect(entries).toHaveText(['项目', '待处理', '管理助手', '用量与成本', '个人设置']);
    for (let i = 0; i < 5; i++) await expect(entries.nth(i).locator('svg.console-icon')).toHaveCount(1);
    await expect(sidebar.getByRole('link', { name: '用量与成本', exact: true }).locator('svg.console-icon-chart')).toBeVisible();
    await expect(sidebar.getByRole('link', { name: '更多功能', exact: true })).toHaveCount(0);
    expect(await page.locator('#console-sidebar').innerText()).not.toMatch(glyphs);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await context.close();
  } finally { await h.stop(); }
});
