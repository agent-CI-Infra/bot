import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup } from '../../fixtures/helpers.mjs';

async function fixture() {
  const h = await harness(), { admin, password } = await setup(h);
  return { h, password };
}
async function login(page, url, password) {
  await page.goto(url); await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

// #482, the pending F2 decision: only the methodology and role explanations at the top of the storage and service-role
// settings pages fold. The current numbers and status stay on the first screen, and the folded text is reachable from
// the keyboard, not only by pointer.
test('存储与服务角色页顶部的长说明折进可展开的说明，数字与状态仍在首屏', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/settings/storage', password);
    const panel = page.locator('#settings-panel');
    const storage = panel.getByTestId('advanced-help').filter({ hasText: '存储' }).first();
    await expect(storage).toBeVisible();
    await expect(storage).not.toHaveAttribute('open');
    // The long explanation is folded; what the page is about and when it was last refreshed is not.
    await expect(panel.getByText('这里统计已采集的文件与项目工作卷')).toBeHidden();
    await expect(panel).toContainText(/最近刷新|尚未刷新/);
    // The disclosure opens from the keyboard: focus the summary and press Enter.
    await storage.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(storage).toHaveAttribute('open', '');
    await expect(panel.getByText('这里统计已采集的文件与项目工作卷')).toBeVisible();

    await page.goto(h.admin + '/#/settings/service-roles');
    const roles = panel.getByTestId('advanced-help').filter({ hasText: '服务角色' }).first();
    await expect(roles).toBeVisible();
    await expect(roles).not.toHaveAttribute('open');
    await expect(panel.getByText('服务角色是平台级的助手')).toBeHidden();
    // The role cards themselves are not hidden behind the explanation.
    await expect(panel.locator('.side-card').first()).toContainText('服务角色');
    await roles.locator('summary').click();
    await expect(roles).toHaveAttribute('open', '');
    await expect(panel.getByText('服务角色是平台级的助手')).toBeVisible();
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
