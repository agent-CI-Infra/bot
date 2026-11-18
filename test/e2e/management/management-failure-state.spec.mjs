import { test, expect } from '@playwright/test';
import { managementFixture } from '../../fixtures/management-fixture.mjs';
import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';

// #616: with no started project to manage, the assistant cannot open a conversation. The failure has to be stated
// once, its recovery links have to be on the first screen at phone heights, and nothing may look able to send.
test('a management assistant that cannot open states the reason once and leaves no usable composer or header actions', async ({ page }) => {
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
    // One statement of the failure: the card carries it, the status line does not repeat it as a second alert.
    await expect(panel.locator('p').filter({ hasText: sentence })).toHaveCount(1);
    await expect(panel.locator('.management-status')).toHaveText('');
    // Nothing that looks able to send: the composer is gone, and the two header controls are unusable with a reason.
    await expect(panel.getByLabel('管理消息')).toBeHidden();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeHidden();
    const fresh = panel.getByRole('button', { name: '新建会话', exact: true }), tools = panel.getByRole('button', { name: '快捷操作', exact: true });
    await expect(fresh).toBeDisabled(); await expect(tools).toBeDisabled();
    await expect(fresh).toHaveAttribute('title', /恢复管理会话/); await expect(tools).toHaveAttribute('title', /恢复管理会话/);
    await expect(fresh).toHaveAttribute('aria-describedby', 'management-access-reason'); await expect(tools).toHaveAttribute('aria-describedby', 'management-access-reason');
    for (const [width, height] of [[1440, 900], [390, 844], [390, 700]]) {
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

// #616: a failed open must also take away what the previous scope left on screen. With a working conversation and the
// shortcut drawer open, a failing 新建会话 used to leave that drawer under the card, its query buttons still looking
// usable while submit() quietly returned false.
test('a failed 新建会话 closes an open shortcut drawer and disables both header controls', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(f.h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click(); await switchConsoleProject(page, '101');
    await page.locator('#tabs').getByRole('link', { name: '管理助手', exact: true }).click();
    const fresh = page.getByRole('button', { name: '新建会话', exact: true }), tools = page.getByRole('button', { name: '快捷操作', exact: true });
    await expect(page.getByLabel('管理消息', { exact: true })).toBeVisible({ timeout: 10_000 });
    await tools.click(); await expect(page.locator('#management-tools')).toBeVisible();
    await page.route('**/api/management/conversations', route => route.request().method() === 'GET' ? route.fulfill({ status: 403, json: { error: 'scope_forbidden' } }) : route.continue());
    await fresh.click();
    await expect(page.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#management-tools')).toBeHidden();
    await expect(page.getByLabel('管理消息', { exact: true })).toBeHidden();
    await expect(fresh).toBeDisabled(); await expect(tools).toBeDisabled();
  } finally { await f.close(); }
});
