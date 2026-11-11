import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { channelFixture, inGroup, envelope, post, until } from '../test/channel-fixture.mjs';
import { roleApi } from '../dist/roles/api.js';
import { resolvePrincipalActor } from '../dist/identity/authorization.js';
import { TaskEngine } from '../dist/agent/engine.js';

for (const width of [1440, 390]) test(`continuous group/private management conversation and shared task board at ${width}px (protocol/model fixtures)`, async ({ page }) => {
  const f = await channelFixture(undefined, store => ({ engine: new TaskEngine(store, { call: async () => ({ state: 'stopped' }) }) })), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    roleApi(f.h.store, { id: f.principal, role: 'super_admin', repositories: [] }, 'PUT', new URL('http://local/api/repositories/101/roles'), {
      expected_revision: 0, enabled: false, roles: [{ role_id: 'reviewer', harness_ref: { id: 'native' }, permissions: { task_management: 'write', delegation: 'deny' } }]
    });
    const quiet = inGroup('', 'ou_alice'); quiet.event.message.mentions = []; quiet.event.message.content = JSON.stringify({ text: '未 @ 的共同决定：先核对本地证据' }); await post(f.h, f.id, quiet);
    const chat = f.h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group'");
    await f.service.employees.configure(resolvePrincipalActor(f.h.store, f.principal, null, '101'), chat.id, {
      project_id: '101', role_id: 'reviewer', capabilities: ['tasks.read', 'tasks.manage_own', 'knowledge.read'], enabled: true, expected_revision: 0
    });
    let create = true;
    f.modelState.respond = async (body, res) => {
      if (body.tools.some(t => t.function.name === 'management_query')) {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好！可按项目名称管理任务，私信沿用同一会话。' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); return;
      }
      const name = create && !body.messages.some(m => m.role === 'tool') ? 'create_task' : 'finish';
      const args = name === 'create_task' ? { request: '待执行的群报告', criteria: ['附上本地证据'], execute: false } : { message: create ? '已记录独立事项，聊天仍可继续。' : '私信沿用同一会话。' };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    };
    const receipt = await post(f.h, f.id, inGroup('请记录一个独立报告事项', 'ou_bob'));
    await until(() => f.h.store.get('SELECT state FROM channel_inbox WHERE id=?', receipt.value.operation_id), r => r?.state === 'completed');
    create = false;
    const privateReceipt = await post(f.h, f.id, envelope('你好'));
    await until(() => f.h.store.get('SELECT state FROM channel_inbox WHERE id=?', privateReceipt.value.operation_id), r => r?.state === 'completed');
    await page.setViewportSize({ width, height: 900 }); await page.goto(f.h.admin + '/#/identity');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '查看连续会话', exact: true }).click();
    await expect(page.getByText('已记录独立事项，聊天仍可继续。', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '查看同一项目任务看板', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '查询该群本地记录', exact: true }).click();
    await expect(page.getByText('未 @ 的共同决定：先核对本地证据', { exact: true })).toBeVisible();
    await expect(page.getByText(/私信与控制台管理对话共用管理助手/)).toBeVisible();
    await expect(page.getByLabel('私信使用角色', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '查看私信连续会话', exact: true }).click();
    await expect(page.getByText('你好！可按项目名称管理任务，私信沿用同一会话。', { exact: true })).toBeVisible();
    await expect(page.getByText('我：你好', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '打开管理对话与执行记录', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mkdirSync('.tmp/channel-conversation-245', { recursive: true }); await page.screenshot({ path: `.tmp/channel-conversation-245/conversation-${width}.png`, fullPage: true });
    await page.goto(f.h.admin + '/#/board');
    if (width < 760) await page.getByRole('combobox', { name: '当前分组', exact: true }).selectOption('attention');
    const task = page.locator('.board-card').filter({ hasText: '待执行的群报告' }); await expect(task).toBeVisible();
    await expect(task.getByText(/reviewer → reviewer（自己执行）/)).toBeVisible();
    await task.locator('.board-card-title').click();
    await expect(page.getByRole('heading', { name: '任务来源与执行者', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.task-execution')).toContainText('任务执行角色：reviewer');
    await page.screenshot({ path: `.tmp/channel-conversation-245/shared-task-${width}.png`, fullPage: true }); expect(errors).toEqual([]);
  } finally { await f.close(); }
});
