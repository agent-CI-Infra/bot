import { test, expect } from '@playwright/test';
import { releaseFixture } from '../../fixtures/release-fixtures.mjs';

async function login(page, address, username, password) {
  await page.goto(address); await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
}

const factValue = (page, label) => page.locator('.release-preview .facts dt', { hasText: new RegExp('^' + label + '$') }).locator('xpath=following-sibling::dd[1]');

test('发版本页读取时间与全站日期时间格式一致，空的标签和 Release 写暂无（#691）', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/api/repositories/*/rules', route => route.fulfill({ json: { rules: { files: [], computer: {} } } }));
    await login(page, f.h.admin, 'administrator', f.password);
    await page.goto(f.h.admin + '/#/projects/101/release');
    await expect(page.getByRole('heading', { name: '发版本', level: 1, exact: true })).toBeVisible();
    await expect(page.locator('#project-page')).not.toContainText('这是读取时间');
    await expect(page.locator('#project-page')).not.toContainText(/记录读取于 \d{1,2}:\d{2}:\d{2} (AM|PM)/);
    await expect(page.locator('.release-panel p[role="status"]')).toHaveText(/记录读取于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await expect(factValue(page, '已有标签')).toHaveText('暂无');
    await expect(factValue(page, '已有 Release')).toHaveText('暂无');
    await expect(page.getByRole('button', { name: '打开接入门禁', exact: true })).toHaveCount(0);
    await expect(page.locator('.release-preflight-checks').getByRole('button')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.release-panel p[role="status"]')).toBeVisible();
    await expect(factValue(page, '已有标签')).toHaveText('暂无');
    await expect(factValue(page, '已有 Release')).toHaveText('暂无');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { for (const close of cleanup.reverse()) await close(); }
});
