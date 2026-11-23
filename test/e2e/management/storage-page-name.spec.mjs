import { test, expect } from '@playwright/test';
import { identityFixture } from '../../fixtures/identity-fixture.mjs';

// #799: a project administrator reaches #/settings/storage from 更多功能, but the shell used to call it
// 平台管理 / 全局设置. The page names its own category now; the platform keeps its path, and both roles read plain table
// headers at 1440 and 390.
// The control plane harness has no project computer yet; a scanned volume is enough for the second table's headers,
// which are the ones this page has to rename. The response is the real one with that one field added.
const withComputer = async route => {
  const response = await route.fetch(), json = await response.json();
  for (const project of json.projects ?? []) project.computer ??= { total_bytes: 1024, complete: true, scanned_at: '2026-11-15T08:00:00.000Z' };
  await route.fulfill({ response, json });
};
const login = async (page, f, username = 'administrator', password = f.password) => {
  await page.goto(f.h.admin + '/#/settings/storage');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
};

test('the storage page names itself for both roles and drops the jargon from its headers', async ({ page, browser }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const password = 'member-password'; await f.admin('/api/users', 'POST', { username: 'member', password, role: 'project_admin', repository_ids: ['101'] });
    await page.route(/\/api\/storage(\?|$)/, withComputer);
    await login(page, f);
    const panel = page.locator('#settings-panel');
    await expect(panel).toContainText('这里统计');
    // A super administrator keeps the platform path, but the current page is named after its own category.
    await expect(page.locator('#page-title')).toHaveText('存储');
    await expect(page.locator('#console-area')).toHaveText('平台管理');
    await expect(page.locator('#console-context')).toHaveText('存储');
    await expect(page).toHaveTitle(/^存储 · /);
    await page.getByText('查看采集、回收与项目明细', { exact: true }).click();
    const headers = panel.locator('.storage-projects thead');
    await expect(headers).toHaveCount(2);
    for (const term of ['blob', 'manager 轨迹', 'runner journal', 'git 存储', 'HOME 缓存'])
      for (const row of await headers.all()) await expect(row, `no ${term} header`).not.toContainText(term);
    await expect(panel.locator('th', { hasText: '文件块' })).toHaveAttribute('title', 'blob');
    await expect(panel.locator('th', { hasText: '管理过程记录' })).toHaveAttribute('title', 'manager 轨迹');
    await expect(panel.locator('th', { hasText: '运行日志' })).toHaveAttribute('title', 'runner journal');
    await expect(panel.locator('th', { hasText: 'Git 仓库缓存' })).toHaveAttribute('title', 'git 存储');
    await expect(panel.locator('th', { hasText: '工作目录缓存' })).toHaveAttribute('title', 'HOME 缓存');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.waitForTimeout(200);
    }

    // The project administrator reaches the same address with a workspace path and a plain category bar.
    const context = await browser.newContext(), member = await context.newPage();
    member.on('pageerror', error => errors.push(error.message));
    try {
      await member.route(/\/api\/storage(\?|$)/, withComputer);
      await login(member, f, 'member', password);
      const memberPanel = member.locator('#settings-panel');
      await expect(memberPanel).toContainText('这里统计');
      await expect(member.locator('#page-title')).toHaveText('存储');
      await expect(member.locator('#console-area')).toHaveText('工作区');
      await expect(member.locator('#console-context')).toHaveText('存储');
      await expect(member).toHaveTitle(/^存储 · /);
      await expect(member.getByRole('navigation', { name: '设置类别' })).toBeVisible();
      await expect(member.getByRole('navigation', { name: '全局设置类别' })).toHaveCount(0);
      for (const row of await memberPanel.locator('.storage-projects thead').all()) await expect(row).not.toContainText('runner journal');
      await expect(memberPanel.locator('th', { hasText: '工作目录缓存' })).toHaveAttribute('title', 'HOME 缓存');
      // The phone control mirrors the same single category, and the address does not overflow.
      await member.setViewportSize({ width: 390, height: 844 });
      await expect(member.locator('#console-section')).toHaveAccessibleName('当前页面');
      await expect(member.locator('#console-section option')).toHaveText(['存储']);
      expect(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const width of [1440, 390]) {
        await member.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await member.waitForTimeout(200);
      }
    } finally { await context.close(); }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
