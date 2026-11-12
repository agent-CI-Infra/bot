import { test, expect } from '@playwright/test';
import { channelFixture, envelope, post, finished } from '../test/channel-fixture.mjs';

// #236: the console issues one binding string for the chosen bot, and the page shows 已绑定 only after the private-chat
// message carrying it has been accepted and read back from the server. Copying or waiting alone is never a success.
test('the console issues a binding string and only the server-confirmed binding is shown', async ({ page }) => {
  test.setTimeout(90000);
  const f = await channelFixture(), { h, admin, password, id } = f, errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const identities = () => h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_console'").n;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/channels');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '飞书身份绑定' })).toBeVisible();
    await page.getByRole('button', { name: /^(生成绑定串|重新绑定)$/ }).first().click();
    const issued = page.locator('.channel-binding-console code').first();
    await expect(issued).toContainText('绑定 FSB-');
    const previous = (await issued.textContent()).trim();
    await expect(page.getByText('等待飞书中发送这条消息…', { exact: false })).toBeVisible();
    // The code is issued, not bound: copying it changes only the clipboard.
    expect(identities()).toBe(0);
    await page.getByRole('button', { name: '复制绑定串', exact: true }).first().click();
    // Copying only touches the clipboard; a blocked clipboard is reported as a failed copy, never as a binding.
    await expect(page.getByText(/已复制。复制只影响剪贴板|复制失败，请选中上面的文字手动复制。/)).toBeVisible();
    expect(identities()).toBe(0);
    // Asking for another string replaces the one on screen instead of stacking a second box, and the newer string wins.
    await page.getByRole('button', { name: /^(生成绑定串|重新绑定)$/ }).first().click();
    await expect(page.locator('.channel-binding-console')).toHaveCount(1);
    await expect(page.locator('.channel-binding-console code')).toHaveCount(1);
    await expect(page.locator('.channel-binding-console code')).not.toHaveText(previous, { timeout: 15000 });
    const command = (await page.locator('.channel-binding-console code').textContent()).trim();
    expect(command).not.toBe(previous);
    // The private-chat message carrying the console's own string is the proof; one message binds.
    const sent = await post(h, id, envelope(command, { sender: { sender_id: { open_id: 'ou_console' } }, message: { chat_id: 'oc_console' } }));
    expect((await finished(h, sent.value.operation_id)).state).toBe('completed');
    expect(identities()).toBe(1);
    // Only after the server confirms does the page show the new binding, and it names the bound account.
    await expect(page.locator('.channel-binding').filter({ hasText: '已绑定' })).toHaveCount(2, { timeout: 15000 });
    await page.screenshot({ path: '.tmp/channels-console/1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.channel-binding').filter({ hasText: '已绑定' })).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const first = page.locator('.channel-binding').filter({ hasText: '已绑定' }).first();
    await first.scrollIntoViewIfNeeded();
    const bound = await first.evaluate(el => {
      const b = el.getBoundingClientRect(), hit = document.elementFromPoint(b.left + 8, b.top + b.height / 2);
      return { top: b.top, bottom: b.bottom, hit: !!hit && el.contains(hit), inside: b.top >= 0 && b.top <= innerHeight - 40 };
    });
    expect(bound.hit).toBe(true); expect(bound.inside).toBe(true);
    await page.screenshot({ path: '.tmp/channels-console/390.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
