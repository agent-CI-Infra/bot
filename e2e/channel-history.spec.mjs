import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { channelFixture, envelope, post } from '../test/channel-fixture.mjs';

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`local chat history, coverage and explicit resync at ${viewport.width}px (protocol fixtures)`, async ({ page }) => {
    test.setTimeout(90000);
    const f = await channelFixture(), { h, service, id, wire } = f, errors = [];
    page.on('pageerror', e => errors.push(e.message));
    service.historySync.close();
    try {
      for (let i = 0; i < 125; i++) {
        const e = envelope(`discussion ${String(i).padStart(3, '0')}`, { sender: { sender_id: { open_id: 'user-' + i % 3 } },
          message: { chat_id: 'oc_continuous', chat_type: 'group', thread_id: i % 2 ? 'omt_fixture' : '', create_time: String(Date.now() - (130 - i) * 86400000) } });
        expect((await post(h, id, e)).status).toBe(200);
      }
      const secret = envelope('确认绑定 fixture-private-confirmation', { message: { chat_id: 'oc_continuous', chat_type: 'group' } });
      await post(h, id, secret);
      expect(h.store.get('SELECT count(*) n FROM channel_chats').n).toBe(1);
      await page.setViewportSize(viewport); await page.goto(h.admin + '/#/settings/feishu/' + id + '/4');
      await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByRole('heading', { name: '本地消息与历史同步' })).toBeVisible();
      const results = page.getByLabel('本地消息搜索结果');
      await expect(results).toContainText('discussion 000'); await expect(results.locator('article')).toHaveCount(50);
      await page.getByRole('button', { name: '读取下一页本地消息' }).click();
      await expect(results.locator('article')).toHaveCount(100);
      await page.getByRole('button', { name: '读取下一页本地消息' }).click();
      await expect(results.locator('article')).toHaveCount(126); await expect(results).toContainText('discussion 124');
      await expect(results).not.toContainText('fixture-private-confirmation');
      await page.getByLabel('发送者 ID', { exact: true }).fill('user-1');
      await page.getByRole('button', { name: '搜索本地记录', exact: true }).click();
      await expect(results.locator('article')).toHaveCount(42);
      await page.getByLabel('消息关键词', { exact: true }).fill('not-in-local-cache');
      await page.getByRole('button', { name: '搜索本地记录', exact: true }).click();
      await expect(results).toContainText('这不代表飞书历史中从未存在');
      expect(wire.state.historyRequests).toHaveLength(0);
      await page.getByRole('button', { name: '显式重新同步可见历史' }).click();
      await expect(page.getByRole('status').filter({ hasText: '同步：syncing' })).toBeVisible();
      await page.getByLabel('保留天数（留空保留至显式清理）').fill('30');
      await page.getByRole('button', { name: '保存本地保留策略' }).click();
      await expect(page.getByRole('status').filter({ hasText: '保留策略：30 天' })).toBeVisible();
      expect(wire.state.historyRequests).toHaveLength(0); expect(wire.sent).toHaveLength(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      mkdirSync('.tmp/channel-history-245', { recursive: true });
      await page.screenshot({ path: `.tmp/channel-history-245/history-${viewport.width}.png`, fullPage: true });
      expect(errors).toEqual([]);
    } finally { await f.close(); rmSync(h.directory, { recursive: true, force: true }); }
  });
}
