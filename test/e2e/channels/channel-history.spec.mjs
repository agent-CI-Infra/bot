import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { bindFixture, channelFixture, envelope, post } from '../../fixtures/channel-fixture.mjs';

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`local chat history, connector filter, explicit resync and retention in Feishu conversations at ${viewport.width}px (#1228)`, async ({ page }) => {
    test.setTimeout(90000);
    const f = await channelFixture(), { h, service, id, wire } = f, errors = [];
    page.on('pageerror', e => errors.push(e.message));
    service.historySync.close();
    try {
      wire.state.appName = '研发协作助手'; wire.state.tenantName = '示例企业';
      h.store.run("UPDATE channel_connectors SET app_name='研发协作助手',tenant_name='示例企业' WHERE id=?", id);
      for (let i = 0; i < 125; i++) {
        const e = envelope(`discussion ${String(i).padStart(3, '0')}`, { sender: { sender_id: { open_id: 'user-' + i % 3 } },
          message: { chat_id: 'oc_continuous', chat_type: 'group', thread_id: i % 2 ? 'omt_fixture' : '', create_time: String(Date.now() - (130 - i) * 86400000) } });
        if(i===0)Object.assign(e.event.message,{message_type:'post',content:JSON.stringify({title:'',content:[[{tag:'text',text:'discussion 000'}],[{tag:'img',image_key:'img_browser_fixture'}]]})});
        expect((await post(h, id, e)).status).toBe(200);
      }
      const secret = envelope('确认绑定 fixture-private-confirmation', { message: { chat_id: 'oc_continuous', chat_type: 'group' } });
      await post(h, id, secret);
      const chat = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_continuous'");
      expect(chat).toBeTruthy();

      // Step 1: Feishu app detail page no longer embeds the large local-history form; it links to #/conversations?connector=<id>.
      await page.setViewportSize(viewport);
      await page.goto(h.admin + '/#/settings/feishu/' + id);
      await page.getByLabel('用户名', { exact: true }).fill('administrator');
      await page.getByLabel('密码', { exact: true }).fill(f.password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByRole('heading', { name: '连接健康与收发记录', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '本地消息与历史同步' })).toHaveCount(0);
      const convLink = page.getByRole('link', { name: '查看该应用的飞书会话', exact: true });
      await expect(convLink).toHaveAttribute('href', '#/conversations?connector=' + id);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      mkdirSync('.tmp/issue-1228', { recursive: true });
      await convLink.evaluate(node => node.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: `.tmp/issue-1228/app-detail-${viewport.width}.png` });

      // Step 2: Follow the link into #/conversations?connector=<id>, verify active connector filter and open the chat.
      await convLink.click();
      await expect(page).toHaveURL(new RegExp('#/conversations\\?connector=' + id + '$'));
      await expect(page.locator('.channel-filter-banner')).toContainText('按应用筛选：研发协作助手 · 示例企业');
      await expect(page.getByRole('link', { name: '显示全部会话', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.tmp/issue-1228/conversations-filter-${viewport.width}.png` });
      await page.locator('.channel-chat-choice').first().click();
      await expect(page).toHaveURL(new RegExp('#/conversations/' + chat.id + '\\?connector=' + id + '$'));

      // Step 3: Expand local search inside the conversation and verify full search, pagination, attachments, and redaction.
      const searchFold = page.locator('.channel-local-search');
      await searchFold.locator('summary').click();
      const results = page.getByLabel('本地消息搜索结果');
      await expect(results).toContainText('discussion 000');
      await expect(results.locator('article')).toHaveCount(50);
      await expect(results).toContainText('附件：image-1 · 待下载');
      expect(wire.state.resourceRequests).toHaveLength(0);
      await page.getByRole('button', { name: '读取下一页本地消息' }).click();
      await expect(results.locator('article')).toHaveCount(100);
      await page.getByRole('button', { name: '读取下一页本地消息' }).click();
      await expect(results.locator('article')).toHaveCount(126);
      await expect(results).toContainText('discussion 124');
      await expect(results).not.toContainText('fixture-private-confirmation');
      await page.getByLabel('发送者 ID', { exact: true }).fill('user-1');
      await page.getByRole('button', { name: '搜索本地记录', exact: true }).click();
      await expect(results.locator('article')).toHaveCount(42);
      await page.getByLabel('消息关键词', { exact: true }).fill('not-in-local-cache');
      await page.getByRole('button', { name: '搜索本地记录', exact: true }).click();
      await expect(results).toContainText('这不代表飞书历史中从未存在');
      expect(wire.state.historyRequests).toHaveLength(0);

      // Step 4: Expand sync & usage details and trigger explicit visible-history resync.
      const syncFold = page.locator('.channel-sync-details');
      await syncFold.locator('summary').click();
      await syncFold.getByRole('button', { name: '显式重新同步可见历史', exact: true }).click();
      await expect(syncFold.getByRole('status')).toContainText('同步：正在同步');
      await syncFold.evaluate(node => node.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: `.tmp/issue-1228/conversations-sync-${viewport.width}.png` });

      // Step 5: Expand super-admin retention & cleanup panel, save retention days, and perform confirmed cleanup.
      const retentionFold = page.locator('.channel-retention-details');
      await retentionFold.locator('summary').click();
      await retentionFold.getByLabel('保留天数（留空保留至显式清理）').fill('30');
      await retentionFold.getByRole('button', { name: '保存本地保留策略', exact: true }).click();
      await expect(retentionFold.getByRole('status')).toContainText('保留策略：30 天');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await retentionFold.evaluate(node => node.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: `.tmp/issue-1228/conversations-admin-${viewport.width}.png` });
      // Perform explicit cleanup before 100 days ago and verify confirm dialog, deletion, and formatted policy text.
      const cutoff = new Date(Date.now() - 100 * 86400000);
      const pad = n => String(n).padStart(2, '0');
      const localValue = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}T${pad(cutoff.getHours())}:${pad(cutoff.getMinutes())}`;
      await retentionFold.getByLabel('显式清理此时间之前的记录').fill(localValue);
      await retentionFold.getByRole('button', { name: '清理指定时间之前的本地记录', exact: true }).click();
      const cleanDialog = page.getByRole('dialog');
      await expect(cleanDialog).toContainText('清理本地消息记录');
      await page.screenshot({ path: `.tmp/issue-1228/cleanup-dialog-${viewport.width}.png` });
      await cleanDialog.getByRole('button', { name: '确认清理', exact: true }).click();
      await expect(retentionFold.getByRole('status')).toContainText('已清理');
      await expect(retentionFold.getByRole('status')).toContainText('保留策略：30 天');
      await expect(retentionFold.getByRole('status')).not.toContainText('undefined');
      expect(h.store.get('SELECT count(*) n FROM channel_messages WHERE chat_id=?', chat.id).n).toBeLessThan(126);
      expect(h.store.get('SELECT retained_after FROM channel_chats WHERE id=?', chat.id).retained_after).toBeGreaterThan(0);
      expect(wire.state.historyRequests).toHaveLength(0);
      expect(wire.sent).toHaveLength(0);

      // Step 6: Non-super-admin personal chat owner sees local search & resync, but NEVER sees super-admin retention/cleanup.
      const ordinary = await f.member('conv-owner-e2e', { repository_ids: ['101'] });
      bindFixture(h, id, ordinary.id, 'ou_e2e_owner');
      await post(h, id, envelope('my private message', { sender: { sender_id: { open_id: 'ou_e2e_owner' } }, message: { chat_id: 'oc_e2e_owner', chat_type: 'p2p' } }));
      const p2pChat = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_e2e_owner'");
      await page.evaluate(() => api('/api/auth/logout', 'POST', {}));
      await page.goto(h.admin + '/#/conversations/' + p2pChat.id);
      await page.reload();
      await page.getByLabel('用户名', { exact: true }).fill('conv-owner-e2e');
      await page.getByLabel('密码', { exact: true }).fill(ordinary.password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByRole('heading', { name: '飞书会话', exact: true })).toBeVisible();
      await expect(page.locator('.channel-retention-details')).toBeHidden();
      await page.locator('.channel-sync-details summary').click();
      await expect(page.getByRole('button', { name: '显式重新同步可见历史', exact: true })).toBeVisible();
      await page.locator('.channel-local-search summary').click();
      await expect(page.getByLabel('本地消息搜索结果')).toContainText('my private message');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('.channel-local-search').evaluate(node => node.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: `.tmp/issue-1228/conversations-member-${viewport.width}.png` });
      expect(errors).toEqual([]);
    } finally { await f.close(); rmSync(h.directory, { recursive: true, force: true }); }
  });
}
