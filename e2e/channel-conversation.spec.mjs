import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { channelFixture, inGroup, envelope, post, until } from '../test/channel-fixture.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

for (const width of [1440, 390]) test(`continuous group assistant and private management conversations open from unified bindings list at ${width}px (protocol/model fixtures)`, async ({ page }) => {
  const f = await channelFixture(undefined, store => ({ engine: new TaskEngine(store, { call: async () => ({ state: 'stopped' }) }) })), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const role = (await f.admin('/api/service-roles')).value.service_roles.find(r => r.id === 'repository-assistant');
    await f.admin('/api/service-roles/repository-assistant', 'PATCH', { expected_revision: role.revision, model_id: f.assistantModel.id });
    const quiet = inGroup('', 'ou_alice'); quiet.event.message.mentions = []; quiet.event.message.content = JSON.stringify({ text: '未 @ 的共同决定：先核对本地证据' }); await post(f.h, f.id, quiet);
    const chat = f.h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group'");
    expect((await f.admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['101'] }, enabled: true, expected_revision: 0 })).status).toBe(200);
    f.modelState.respond = async (body, res) => {
      const content = body.tools.some(t => t.function.name === 'management_query') ? '你好！可按项目名称管理任务，私信沿用同一会话。' : '本群可用 admin-fixture-101，已按本地记录回答。';
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    };
    const receipt = await post(f.h, f.id, inGroup('我们刚才的决定是什么？', 'ou_bob'));
    await until(() => f.h.store.get('SELECT state FROM channel_inbox WHERE id=?', receipt.value.operation_id), r => r?.state === 'completed');
    const privateReceipt = await post(f.h, f.id, envelope('你好'));
    await until(() => f.h.store.get('SELECT state FROM channel_inbox WHERE id=?', privateReceipt.value.operation_id), r => r?.state === 'completed');
    await page.setViewportSize({ width, height: 900 }); await page.goto(f.h.admin + '/#/identity/feishu');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const binding = page.getByRole('article', { name: '群聊助手绑定' });
    await expect(binding).toBeVisible();
    await binding.getByRole('link', { name: '查看聊天记录', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/conversations/${chat.id}$`));
    await expect(page.getByLabel('消息与执行时间线')).toContainText('未 @ 的共同决定：先核对本地证据');
    await page.getByText('本轮生成的回答', { exact: true }).click();
    await expect(page.getByLabel('消息与执行时间线')).toContainText('本群可用 admin-fixture-101，已按本地记录回答。');
    await expect(page.getByText(/当前群绑定：仓库问答助手/)).toBeVisible();
    await page.getByRole('link', { name: '返回飞书绑定', exact: true }).click();
    const personal = page.getByLabel('我的飞书账号', { exact: true });
    await expect(personal.getByRole('link', { name: '查看聊天记录', exact: true })).toBeVisible();
    await personal.locator('.feishu-row-title strong').click();
    await expect(page.getByLabel('消息与执行时间线')).toContainText('你好');
    await expect(page.getByLabel('消息与执行时间线')).toContainText('你好！可按项目名称管理任务，私信沿用同一会话。');
    await expect(page.getByRole('link', { name: '打开管理对话与执行记录', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mkdirSync('.tmp/channel-conversation-312', { recursive: true }); await page.screenshot({ path: `.tmp/channel-conversation-312/conversation-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
