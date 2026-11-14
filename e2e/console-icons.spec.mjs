import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, testPassword } from '../test/helpers.mjs';

// #554: workspace navigation uses one linear SVG set; glyphs ⌂▤◷⋯ are gone,
// and every entry keeps its visible text as the accessible name.
const out = resolve('.tmp/console-icons-554');
const glyphs = /[⌂▤◷⋯]/;

test('#554 侧栏与移动端底栏使用线性图标，1440 与 390 可识别且无横向溢出', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
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
    await expect(sidebar.getByRole('button', { name: '项目', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '管理对话', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '看板', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '统计', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Webhook 投递', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('link', { name: '待处理', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '个人设置', exact: true }).locator('svg.console-icon')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '全局设置', exact: true }).locator('svg.console-icon')).toBeVisible();
    const sidebarText = await sidebar.innerText();
    expect(sidebarText).not.toMatch(glyphs);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: `${out}/projects-icons-1440.png`, fullPage: true });

    // Switching the language re-translates every [data-i18n] node; the sidebar entries must keep their icons both ways.
    const sidebarEntries = sidebar.locator('#tabs [data-tab], #console-inbox-link');
    const entryCount = await sidebarEntries.count();
    expect(entryCount).toBeGreaterThanOrEqual(9);
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(sidebar.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
    for (let i = 0; i < entryCount; i++) await expect(sidebarEntries.nth(i).locator('svg.console-icon')).toHaveCount(1);
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await expect(sidebar.getByRole('button', { name: '项目', exact: true })).toBeVisible();
    for (let i = 0; i < entryCount; i++) await expect(sidebarEntries.nth(i).locator('svg.console-icon')).toHaveCount(1);

    await page.goto(h.admin + '/#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    const moreLinks = page.locator('.console-groups .console-link-with-icon');
    expect(await moreLinks.count()).toBeGreaterThan(4);
    expect(await moreLinks.locator('svg.console-icon').count()).toBe(await moreLinks.count());
    await page.screenshot({ path: `${out}/more-icons-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    const mobile = page.locator('#console-mobile-nav');
    await expect(mobile).toBeVisible();
    // #481: five phone destinations, each with one decorative SVG.
    await expect(mobile.locator('svg.console-icon')).toHaveCount(5);
    for (const name of ['项目', '任务', '待处理', '助手', '更多']) {
      const item = mobile.getByRole('link', { name, exact: true });
      await expect(item).toBeVisible();
      await expect(item.locator('svg.console-icon')).toBeVisible();
    }
    expect(await mobile.innerText()).not.toMatch(glyphs);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/projects-icons-390.png`, fullPage: true });

    await mobile.getByRole('link', { name: '更多', exact: true }).click();
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    expect(await page.locator('.console-groups .console-link-with-icon svg.console-icon').count()).toBeGreaterThan(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/more-icons-390.png`, fullPage: true });

    // Empty and error states carry an inline SVG mark (a data: mask image would be blocked by the console CSP).
    const stateIcon = async (selector, name) => {
      const state = page.locator(selector).first();
      await expect(state).toBeVisible();
      const icon = state.locator('svg.console-state-icon.console-icon-' + name);
      await expect(icon).toBeVisible();
      const box = await icon.boundingBox();
      expect(Math.round(box.width)).toBe(32);
      expect(await icon.evaluate(el => el.querySelectorAll('path, circle').length)).toBeGreaterThan(0);
      expect(await state.evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
    };
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.unrouteAll({ behavior: 'wait' });
      // Leave the inbox first: the second pass would otherwise keep the failed read from the first.
      await page.goto(h.admin + '/#/more');
      await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
      await page.goto(h.admin + '/#/inbox');
      await stateIcon('.console-state:not(.console-state-error)', 'tray');
      await page.screenshot({ path: `${out}/state-empty-${width}.png`, fullPage: true });
      await page.route('**/api/tasks?attention=*', route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
      await page.reload();
      await stateIcon('.console-state-error', 'alert');
      await page.screenshot({ path: `${out}/state-error-${width}.png`, fullPage: true });
    }
  } finally { await h.stop(); }
});

test('#554 项目管理员的桌面侧栏「更多功能」也用线性图标（1440）', async ({ browser }) => {
  const h = await harness();
  mkdirSync(out, { recursive: true });
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
    const more = page.locator('#console-sidebar #console-more-link');
    await expect(more).toBeVisible();
    await expect(more).toHaveAccessibleName('更多功能');
    await expect(more.locator('svg.console-icon.console-icon-more')).toBeVisible();
    expect(await page.locator('#console-sidebar').innerText()).not.toMatch(glyphs);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: `${out}/projects-icons-project-admin-1440.png`, fullPage: true });
    await context.close();
  } finally { await h.stop(); }
});
