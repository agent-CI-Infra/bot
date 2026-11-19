import { test, expect } from '@playwright/test';
import { managementFixture } from '../../fixtures/management-fixture.mjs';

// #616: with no started project to manage, the assistant cannot open a conversation. The failure has to be stated
// once, its recovery links have to be on the first screen at phone heights, and nothing may look able to send.
test('a management assistant that cannot open states the reason once and leaves no usable composer or new action', async ({ page }) => {
  const f = await managementFixture(), empty = await f.member('no-project', {});
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('no-project');
    await page.getByLabel('密码', { exact: true }).fill(empty.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('.management-panel');
    await expect(panel.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible({ timeout: 10_000 });
    const sentence = (await panel.locator('.console-state p').first().textContent()).trim();
    expect(sentence.length).toBeGreaterThan(10);
    await expect(panel.locator('p').filter({ hasText: sentence })).toHaveCount(1);
    await expect(panel.locator('.management-status')).toHaveText('');
    await expect(panel.getByLabel('管理消息')).toBeHidden();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeHidden();
    const fresh = panel.locator('.management-new-conversation');
    await expect(fresh).toBeDisabled();
    await expect(fresh).toHaveAttribute('title', /恢复管理会话/);
    await expect(fresh).toHaveAttribute('aria-describedby', 'management-access-reason');
    await expect(panel.getByRole('button', { name: '快捷操作', exact: true })).toHaveCount(0);
    for (const [width, height] of [[1440, 900], [390, 844], [390, 700], [390, 568], [320, 568]]) {
      await page.setViewportSize({ width, height });
      await expect(panel.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible();
      for (const name of ['查看项目列表', '查看身份与权限']) {
        const link = panel.getByRole('link', { name, exact: true });
        await expect(link).toBeInViewport({ ratio: 1 });
        expect(await link.evaluate(el => { const box = el.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return !!hit && el.contains(hit); }), name).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(await panel.locator('.management-access-state').evaluate(el => el.scrollHeight <= el.clientHeight + 1), String(height)).toBe(true);
    }
  } finally { await f.close(); }
});

test('a failed new conversation removes the previous composer and disables the new action', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(f.h.admin + '/#/projects/101/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const fresh = page.locator('.management-new-conversation');
    await expect(page.getByLabel('管理消息', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.route('**/api/management/conversations', route => route.request().method() === 'GET' ? route.fulfill({ status: 403, json: { error: 'scope_forbidden' } }) : route.continue());
    await fresh.click();
    await expect(page.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel('管理消息', { exact: true })).toBeHidden();
    await expect(fresh).toBeDisabled();
  } finally { await f.close(); }
});
