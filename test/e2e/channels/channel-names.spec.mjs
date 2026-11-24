import { test, expect } from '@playwright/test';
import { boundGroup, channelFixture, privateChat } from '../../fixtures/channel-fixture.mjs';
import { login } from '../helpers/channel-console-login.mjs';

for (const width of [1440, 390]) test(`Feishu names identify private chats and groups with enterprise context at ${width}px`, async ({ page }) => {
  const f = await channelFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    // Binding the group reads its name (#1360).
    f.wire.state.chatName = '基础设施讨论群';
    await boundGroup(f); const mine = await privateChat(f);
    const tenant = f.h.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', '101').tenant_id;
    f.h.store.run("UPDATE channel_connectors SET app_name='研发助手',tenant_name='示例企业',owner_tenant=? WHERE id=?", tenant, f.id);
    f.h.store.run("UPDATE external_identities SET external_tenant='install-tenant' WHERE principal_id=?", f.principal);
    f.h.store.run("UPDATE channel_personal_owners SET actor_tenant='install-tenant' WHERE chat_id=?", mine.id);
    await page.setViewportSize({ width, height: 1000 }); await login(page, f, '#/conversations');
    const list = page.getByLabel('可查看的飞书会话');
    await expect(list.getByRole('link', { name: /群聊 · 基础设施讨论群/ })).toBeVisible();
    await expect(list.getByRole('link', { name: /私聊 · 张小明/ })).toBeVisible();
    await expect(list).toContainText('示例企业'); await expect(list).toContainText('应用所属组织：agent-test-zone');
    const search = page.getByLabel('搜索飞书会话'); await search.fill('张小明');
    await expect(list.locator('.channel-chat-choice')).toHaveCount(1); await search.fill('基础设施');
    await expect(list.locator('.channel-chat-choice')).toHaveCount(1); await search.fill('示例企业');
    await expect(list.locator('.channel-chat-choice')).toHaveCount(2); await search.clear();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto(f.h.admin + '/#/identity/feishu/groups');
    const binding = page.getByRole('article', { name: '群聊助手绑定' });
    await expect(binding).toContainText('基础设施讨论群');
    await binding.getByText('群与应用信息', { exact: true }).click();
    await expect(binding).toContainText('所属企业：示例企业');
    f.wire.state.chatName = '<img src=x onerror=alert(1)> 更名群';
    await binding.getByRole('button', { name: '刷新群名称', exact: true }).click();
    await expect(binding).toContainText(f.wire.state.chatName); await expect(binding.locator('img')).toHaveCount(0);
    f.wire.state.chatCode = 99991672;
    await binding.getByRole('button', { name: '刷新群名称', exact: true }).click();
    await expect(binding).toContainText('保留上次读取的名称'); await expect(binding).toContainText(f.wire.state.chatName);
    await binding.getByRole('link', { name: '配置群聊助手', exact: true }).click();
    await expect(page.getByLabel('助手所在群')).toContainText(`${f.wire.state.chatName} · 示例企业 · 研发助手`);
    await page.goto(f.h.admin + '/#/identity/feishu/conversations');
    const conversations = page.getByLabel('可查看的飞书会话');
    await expect(conversations.getByRole('link', { name: /私聊 · 张小明/ })).toBeVisible();
    await expect(conversations.locator('article').filter({ hasText: '私聊 · 张小明' })).toContainText('示例企业');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

// #870: a name the provider refuses (here: the app lacks the contact scope) is read once for the page, not again on
// every redraw, and the retry belongs to the reader. `chatRequests` counts the provider lookups the console started.
test('a refused Feishu name is read once, not on every redraw, and the button still retries it', async ({ page }) => {
  const f = await channelFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    // The lookup when binding (#1360) is refused as well, so the group is bound without a name.
    f.wire.state.chatCode = 99991672;
    await boundGroup(f);
    f.h.store.run("UPDATE channel_connectors SET app_name='研发助手',tenant_name='示例企业' WHERE id=?", f.id);
    await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, f, '#/identity/feishu');
    const binding = page.getByRole('article', { name: '群聊助手绑定' });
    await expect(binding).toContainText('暂时无法读取名称。');
    await page.waitForTimeout(500);
    const first = f.wire.state.chatRequests.length;
    expect(first).toBeGreaterThan(0);
    // The console is one page: leave and come back by hash, as a reader does, so the page state that remembers the
    // refused lookup survives — a full reload is a new page and may try again.
    await page.evaluate(() => { location.hash = '#/conversations'; });
    await expect(page.getByLabel('可查看的飞书会话')).toBeVisible();
    await page.evaluate(() => { location.hash = '#/identity/feishu'; });
    await binding.getByText('群与应用信息', { exact: true }).click();
    await expect(binding.getByRole('button', { name: '刷新群名称', exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    expect(f.wire.state.chatRequests.length, 'a redraw does not ask the provider again').toBe(first);
    f.wire.state.chatCode = 0; f.wire.state.chatName = '基础设施讨论群';
    await binding.getByRole('button', { name: '刷新群名称', exact: true }).click();
    await expect(binding).toContainText('基础设施讨论群');
    expect(f.wire.state.chatRequests.length, 'the reader can still retry by hand').toBe(first + 1);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

// #870: the personal binding row on this page is the third automatic entry: it reads a missing name on its own, so it
// has to remember a refusal too. `profileRequests` counts the provider lookups the server made on the page's behalf.
test('a refused Feishu personal name is read once, not on every redraw of the binding page', async ({ page }) => {
  const f = await channelFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    // Only a binding in the robot's own enterprise reads names (`can_read_name`).
    f.h.store.run("UPDATE external_identities SET external_tenant='install-tenant' WHERE connector LIKE ?", f.id + ':%');
    f.wire.state.profileCode = 99991672;
    await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, f, '#/identity/feishu');
    const row = page.getByRole('article', { name: '我的飞书账号' });
    await expect(row).toContainText('飞书暂未提供姓名');
    const first = f.wire.state.profileRequests.length;
    expect(first).toBeGreaterThan(0);
    await page.evaluate(() => { location.hash = '#/projects'; });
    await page.evaluate(() => { location.hash = '#/identity/feishu'; });
    await page.waitForTimeout(500);
    expect(f.wire.state.profileRequests.length, 'a redraw does not ask the provider again').toBe(first);
    // The redrawn row starts from its resting copy; the refusal text of the earlier draw is not carried over.
    await expect(row).toContainText('飞书姓名暂不可读取');
    f.wire.state.profileCode = 0; f.wire.state.profileName = '张小明';
    await row.getByRole('button', { name: '刷新飞书姓名', exact: true }).click();
    await expect(row).toContainText('张小明');
    expect(f.wire.state.profileRequests.length, 'the reader can still retry by hand').toBe(first + 1);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
