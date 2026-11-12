import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { channelFixture, boundGroup, privateChat, repositoryAssistant, scriptedModel, inGroup, envelope, post, finished, until } from '../test/channel-fixture.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { testPassword } from '../test/helpers.mjs';

async function login(page, f, hash, username = 'administrator', password = f.password) {
  await page.goto(f.h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

for (const width of [1440, 390]) test(`Feishu console shows real messages, steps and binding counts at ${width}px`, async ({ page }) => {
  const f = await channelFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await repositoryAssistant(f); const group = await boundGroup(f); await privateChat(f);
    f.h.store.run("UPDATE channel_connectors SET app_name='研发助手',tenant_name='示例企业' WHERE id=?", f.id);
    scriptedModel(f, [['list_projects', {}], '根据群里的讨论，先核对项目证据。']);
    const receipt = await post(f.h, f.id, inGroup('大家先核对当前的项目范围。', 'ou_bob'));
    expect((await finished(f.h, receipt.value.operation_id)).state).toBe('completed');
    await page.setViewportSize({ width, height: 1000 }); await login(page, f, '#/conversations/' + group.id);
    const thread = page.getByRole('region', { name: '当前飞书会话' });
    await expect(page.getByLabel('消息与执行时间线')).toContainText('大家先核对当前的项目范围。');
    await page.getByText('查看执行过程', { exact: true }).click();
    await expect(page.locator('.channel-step')).toContainText(['开始执行', '请求模型', '模型已返回', '调用工具 · 查看项目范围', '工具已返回 · 查看项目范围', '请求模型', '模型已返回', '本轮完成']);
    await page.getByText('本轮生成的回答', { exact: true }).click();
    await expect(page.getByLabel('消息与执行时间线')).toContainText('根据群里的讨论，先核对项目证据。');
    await expect(page.getByLabel('会话派生任务')).toContainText('项目任务');
    if (width === 1440) for (const breakpoint of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width: breakpoint, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(breakpoint)).toBe(true);
    }
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    mkdirSync('.tmp/channel-console', { recursive: true }); await page.screenshot({ path: `.tmp/channel-console/conversation-${width}.png`, fullPage: width >= 768 });
    await page.goto(f.h.admin + '/#/identity/feishu');
    const overview = page.getByRole('region', { name: '飞书绑定概览' });
    await expect(overview.locator('.feishu-metric')).toContainText(['已绑定身份1', '本人私聊1', '维护的群1']);
    await expect(overview).toContainText('私聊已建立 1 个');
    await overview.getByText('查看维护的群与绑定范围', { exact: true }).click(); await expect(overview).toContainText('oc_group');
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    await page.screenshot({ path: `.tmp/channel-console/bindings-${width}.png`, fullPage: true });
    await page.goto(f.h.admin + '/#/preferences'); await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await page.getByLabel('要设置的项目').selectOption('101'); await expect(page.locator('#console-page')).toContainText('基本设置');
    await page.screenshot({ path: `.tmp/channel-console/settings-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('project tasks, independent conclusions and private assistant answers remain reachable from the conversation', async ({ page }) => {
  const f = await channelFixture();
  try {
    await repositoryAssistant(f, { conversation_history: 'read', github: 'read', project_tasks: 'read', delegation: 'allow' });
    const chat = await boundGroup(f);
    f.modelState.respond = async (body, res) => {
      let message;
      if (body.messages[0].content.includes('You are now working on one of your own independent tasks')) message = { role: 'assistant', content: '文档核对结论：入口已列出。' };
      else {
        const done = body.messages.filter(m => m.role === 'tool').length;
        const steps = [['start_own_task', { title: '核对入口文档', instruction: '整理入口文档并给出结论。' }],
          ['create_project_task', { repository: 'agent-test-zone/admin-fixture-101', request: '核对群助手页面入口并提交报告', contract: { goal: '核对页面入口', scope: ['static/channels.js'], criteria: ['记录实际入口'], endpoint: '提交报告' } }]];
        message = done < steps.length ? { role: 'assistant', content: null, tool_calls: [{ id: 'step-' + done, type: 'function', function: { name: steps[done][0], arguments: JSON.stringify(steps[done][1]) } }] }
          : { role: 'assistant', content: '文档已核对，项目任务已创建。' };
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    };
    const receipt = await post(f.h, f.id, inGroup('请先核对文档，再创建项目任务。', 'ou_bob'));
    expect((await finished(f.h, receipt.value.operation_id)).state).toBe('completed');
    await login(page, f, '#/conversations/' + chat.id);
    const related = page.getByLabel('会话派生任务'); await expect(related).toContainText('核对群助手页面入口'); await expect(related).toContainText('核对入口文档');
    await related.getByText('查看最近结论', { exact: true }).click(); await expect(related).toContainText('文档核对结论：入口已列出。');
    await related.getByRole('button', { name: '查看任务过程', exact: true }).click(); await expect(page.locator('#task-view')).toBeVisible(); await page.keyboard.press('Escape');
    scriptedModel(f, ['这是本人私聊的管理助手回答。']);
    const privateReceipt = await post(f.h, f.id, envelope('你好，请继续私聊。')); expect((await finished(f.h, privateReceipt.value.operation_id)).state).toBe('completed');
    const personal = f.h.store.get("SELECT id FROM channel_chats WHERE chat_type='p2p'");
    await page.goto(f.h.admin + '/#/conversations/' + personal.id);
    await expect(page.getByLabel('消息与执行时间线').getByText('这是本人私聊的管理助手回答。', { exact: true })).toBeVisible();
  } finally { await f.close(); }
});

test('settings keep platform mutations in global settings and project administrators retain their settings', async ({ page }) => {
  const f = await channelFixture();
  try {
    await login(page, f, '#/projects/101/basic');
    await expect(page.getByRole('button', { name: '删除项目', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '禁用项目', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: '在全局设置中管理项目', exact: false }).click();
    await expect(page).toHaveURL(/#\/settings\/projects\/101$/);
    await expect(page.getByRole('button', { name: '禁用项目', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '删除项目', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    const password = testPassword(); await f.admin('/api/users', 'POST', { username: 'project-owner', password, repository_ids: ['101'] });
    await page.getByLabel('用户名', { exact: true }).fill('project-owner'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.goto(f.h.admin + '/#/preferences');
    await expect(page.locator('#tabs [data-tab=preferences]')).toHaveText('设置');
    await expect(page.locator('#tabs [data-tab=settings]')).toBeHidden();
    await page.getByLabel('要设置的项目').selectOption('101');
    await page.getByRole('link', { name: '基本设置', exact: false }).click();
    await expect(page.getByLabel('基准分支', { exact: true })).toBeEnabled();
    await page.goto(f.h.admin + '/#/settings/projects/101'); await expect(page.locator('#settings-panel')).toBeHidden();
    await page.goto(f.h.admin + '/#/more'); await expect(page.getByRole('heading', { name: '全局设置', exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test('conversation refresh reports stale data, clears revoked content and ignores a late response after navigation', async ({ page }) => {
  const f = await channelFixture();
  try {
    const chat = await boundGroup(f); await login(page, f, '#/conversations/' + chat.id);
    await expect(page.getByLabel('消息与执行时间线')).toContainText('Group discussion');
    await page.route('**/timeline?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_unavailable' }) }));
    await page.getByRole('button', { name: '刷新会话', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '刷新失败' })).toContainText('旧记录');
    await expect(page.getByLabel('消息与执行时间线')).toContainText('Group discussion'); await page.unroute('**/timeline?*');
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/timeline?*', async route => { await gate; await route.continue().catch(() => {}); });
    await page.getByRole('button', { name: '刷新会话', exact: true }).click();
    await page.goto(f.h.admin + '/#/preferences'); release(); await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.getByLabel('消息与执行时间线')).toHaveCount(0); await page.unroute('**/timeline?*');
    await page.goto(f.h.admin + '/#/conversations/' + chat.id); await expect(page.getByLabel('消息与执行时间线')).toContainText('Group discussion');
    await page.clock.install(); let revokedReads = 0;
    await page.route('**/timeline?*', route => { revokedReads++; return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'channel_history_forbidden' }) }); });
    await page.getByLabel('自动刷新（5 秒）', { exact: true }).check();
    await expect(page.getByRole('heading', { name: '会话访问已变化', exact: true })).toBeVisible();
    await expect(page.getByLabel('消息与执行时间线')).toHaveCount(0); await expect(page.getByLabel('会话派生任务')).toHaveCount(0);
    await page.clock.runFor(15000); expect(revokedReads).toBe(1);
  } finally { await f.close(); }
});


test('binding generation remains available while optional group metadata is slow and late metadata cannot replace another page', async ({ page }) => {
  const f = await channelFixture(); let release;
  try {
    f.h.store.run("UPDATE external_identities SET status='revoked' WHERE principal_id=? AND provider='feishu'", f.principal);
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/channels/service-bindings', async route => { await gate; await route.continue().catch(() => {}); });
    await login(page, f, '#/identity/feishu');
    await expect(page.getByRole('button', { name: '生成绑定串', exact: true })).toBeVisible();
    await page.goto(f.h.admin + '/#/preferences'); release();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '飞书绑定概览' })).toHaveCount(0);
  } finally { release?.(); await f.close(); }
});


test('conversation workspace shows a running group progress message and lets its manager confirm stopping the answer', async ({ page }) => {
  const f = await channelFixture(undefined, store => ({ engine: new TaskEngine(store, { call: async () => ({ state: 'stopped' }) }) }));
  try {
    await repositoryAssistant(f); const chat = await boundGroup(f);
    f.modelState.respond = async (body, res) => {
      if (body.messages.some(m => m.role === 'tool')) return await new Promise(() => {});
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'progress', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ text: '正在核对项目证据，请稍等。' }) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    };
    await post(f.h, f.id, inGroup('请核对项目证据。', 'ou_bob'));
    await until(() => f.wire.sent.find(row => JSON.stringify(row.content).includes('正在核对项目证据')));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, f, '#/conversations/' + chat.id);
    const progress = page.getByRole('region', { name: '助手进展消息' });
    await expect(progress).toContainText('正在核对项目证据，请稍等。'); await expect(progress).toContainText('已发送至飞书');
    await page.screenshot({ path: '.tmp/channel-console/progress-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/channel-console/progress-390.png', fullPage: true });
    await page.getByRole('button', { name: '停止回答', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '停止回答', exact: true }).click();
    await expect(page.locator('.channel-run .status')).toHaveText('已停止');
    await expect(progress).toContainText('正在核对项目证据，请稍等。');
    await expect(page.getByRole('button', { name: '停止回答', exact: true })).toHaveCount(0);
    await until(() => f.wire.sent.find(row => JSON.stringify(row.content).includes('已在控制台停止')));
    await page.getByText('查看执行过程', { exact: true }).click();
    await expect(page.locator('.channel-step').last()).toContainText('已停止');
  } finally { await f.close(); }
});
