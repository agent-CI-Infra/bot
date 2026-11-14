import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { releaseFixture } from '../test/release-fixtures.mjs';

async function login(page, address, username, password) {
  await page.goto(address); await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
}

test('没有发布 CI 时发版本页提供打开接入门禁，读取时间格式与空值用语一致（#691）', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    delete f.state.files['.github/ci-gates.json'];
    await page.route('**/api/repositories/*/rules', route => route.fulfill({ json: { rules: { files: [], computer: {} } } }));
    await login(page, f.h.admin, 'administrator', f.password);
    await page.goto(f.h.admin + '/#/projects/101/release');
    await expect(page.getByRole('heading', { name: '发版本', exact: true })).toBeVisible();
    await expect(page.locator('#project-page')).toContainText('这个仓库还没有接入发布用的 CI。请先在「接入门禁」中创建门禁 PR。');
    const open = page.getByRole('button', { name: '打开接入门禁', exact: true });
    await expect(open).toBeVisible();
    await expect(page.locator('#project-page')).not.toContainText('这是读取时间');
    await expect(page.locator('#project-page')).toContainText(/记录读取于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    const factValue = label => page.locator('.release-preview .facts dt', { hasText: new RegExp('^' + label + '$') }).locator('xpath=following-sibling::dd[1]');
    await expect(factValue('已有标签')).toHaveText('暂无');
    await expect(factValue('已有 Release')).toHaveText('暂无');
    mkdirSync('.tmp/release-noci-691', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(open).toBeVisible();
    await page.screenshot({ path: '.tmp/release-noci-691/desktop-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(open).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/release-noci-691/noci-390.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '接入门禁 · fixture/project-101', exact: true })).toBeVisible();
    await page.screenshot({ path: '.tmp/release-noci-691/gate-dialog-1440.png' });
    expect(errors).toEqual([]);
  } finally { for (const close of cleanup.reverse()) await close(); }
});
