import { test, expect } from '@playwright/test';
import { managementFixture, command } from '../test/management-fixture.mjs';

// #355: a receipt is the record of one command, and the command came from one conversation message. The page used to
// show who, when, what and which project, but not which conversation or message asked for it — so walking a receipt
// back to the request meant matching timestamps by eye. This asserts the receipt names its source and links back.
test('a command receipt names the conversation and message it came from', async ({ page }) => {
  test.setTimeout(90000);
  const f = await managementFixture(), { h, admin, password } = f;
  try {
    // The fixture's own command helper records source_conversation=fixture-conversation and source_message=<key>.
    const key = 'receipt-source-message';
    await command(admin, 'task.pause', { project_id: '101', task_id: 'blocked' }, {}, key);
    const receipt = h.store.get('SELECT id,source_conversation,source_message FROM management_commands WHERE source_message=?', key);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.goto(h.admin + '/#/management/commands/' + receipt.id);
    const source = page.locator('[data-receipt-source]');
    await expect(source).toBeVisible();
    await expect(source).toContainText(receipt.source_conversation);
    await expect(source).toContainText(receipt.source_message);
    // The line is a way back, not just two opaque ids.
    await expect(source.getByRole('link', { name: '回到管理会话', exact: true })).toHaveAttribute('href', '#/management');
    // A phone keeps the ids readable without pushing the page sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await f.close(); }
});
