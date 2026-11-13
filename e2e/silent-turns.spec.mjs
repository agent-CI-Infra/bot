import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { channelFixture, boundGroup, repositoryAssistant, inGroup, post, until } from '../test/channel-fixture.mjs';

// A group answer that ends with stay_silent (#489) shows in the console as kept quiet on purpose, with the assistant's reason.
async function login(page, f, hash) {
  await page.goto(f.h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('a turn ended with stay_silent shows its reason in the console and sends nothing to the group (#489)', async ({ page }) => {
  const f = await channelFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await repositoryAssistant(f); const chat = await boundGroup(f);
    const binding = f.service.serviceBindings.get(chat.id);
    expect((await f.admin(`/api/channels/chats/${chat.id}/service-binding`, 'PUT', { service_role_id: binding.service_role_id,
      scope: { kind: 'repositories', repositories: ['101'] }, participation: 'all', enabled: true, expected_revision: binding.revision })).status).toBe(200);
    f.modelState.respond = async (_body, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '（无需回复）',
        tool_calls: [{ id: 'quiet', type: 'function', function: { name: 'stay_silent', arguments: JSON.stringify({ reason: '群友在闲聊午饭' }) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    };
    const lunch = inGroup('大家中午吃什么？', 'ou_bob'); lunch.event.message.mentions = [];
    const receipt = await post(f.h, f.id, lunch);
    await until(() => f.h.store.get('SELECT state FROM channel_inbox WHERE id=?', receipt.value.operation_id)?.state === 'completed');
    expect(f.wire.sent.filter(s => JSON.stringify(s.content).includes('无需回复'))).toEqual([]);
    mkdirSync('.tmp/silent-turns', { recursive: true });
    // The binding links to its chat history, where the turn says it stayed quiet and why.
    await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, f, '#/identity/feishu/groups');
    await page.getByRole('article', { name: '群聊助手绑定' }).getByRole('link', { name: '查看聊天记录', exact: true }).click();
    for (const width of [1440, 390]) {
      if (width === 390) { await page.setViewportSize({ width, height: 844 }); await page.goto(f.h.admin + '/#/conversations/' + chat.id); }
      await expect(page.getByText('本轮保持安静，未发送回答：群友在闲聊午饭', { exact: true })).toBeVisible();
      await expect(page.getByText('本轮生成的回答', { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: `.tmp/silent-turns/conversation-${width}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
