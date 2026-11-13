import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { channelFixture, boundGroup, privateChat, bindFixture, repositoryAssistant, scriptedModel, inGroup, envelope, post, finished, until } from '../test/channel-fixture.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { testPassword } from '../test/helpers.mjs';

async function login(page, f, hash, username = 'administrator', password = f.password) {
  await page.goto(f.h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('conversation shows the actual messages merged into a running turn on wide and narrow screens (#458)', async ({ page }) => {
  const f = await channelFixture(); let release, calls = 0, executing = false;
  const held = new Promise(resolve => { release = resolve; });
  try {
    await repositoryAssistant(f); const chat = await boundGroup(f);
    f.wire.state.members = f.wire.state.members.map(m => ({ ...m, name: m.member_id === 'ou_bob' ? 'Bob' : 'Alice' }));
    f.service.serviceSessions.own.invoke = async () => { executing = true; await held; return { conclusion: '核对完成' }; };
    f.modelState.respond = async (_body, res) => {
      calls++;
      const message = calls === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'own', type: 'function', function: { name: 'start_own_task', arguments: '{}' } }] }
        : { role: 'assistant', content: '已一并回应两位提问人。' };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    };
    const original = await post(f.h, f.id, inGroup('请查一下项目。')); await until(() => executing);
    const followup = inGroup('顺便看看我的问题。', 'ou_bob');
    expect((await post(f.h, f.id, followup)).value.state).toBe('merged');
    await login(page, f, '#/conversations/' + chat.id);
    const inputs = page.getByLabel('回合并入的消息'); await inputs.getByText('并入的消息（1）', { exact: true }).click();
    await expect(inputs).toContainText(followup.event.message.message_id); await expect(inputs).toContainText('Bob（ou_bob）');
    await expect(inputs).toContainText('@助手');
    release(); await until(() => f.h.store.get('SELECT state FROM channel_inbox WHERE id=?', original.value.operation_id)?.state === 'completed');
    await page.getByRole('button', { name: '刷新会话', exact: true }).click();
    await page.getByLabel('回合并入的消息').getByText('并入的消息（1）', { exact: true }).click();
    await page.getByText('本轮生成的回答', { exact: true }).click(); await expect(page.getByLabel('消息与执行时间线')).toContainText('已一并回应两位提问人。');
    mkdirSync('.tmp/channel-console', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.tmp/channel-console/turn-messages-${width}.png`, fullPage: true });
    }
    expect(calls).toBe(2); expect(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n).toBe(1);
  } finally { release?.(); await f.close(); }
});

for (const width of [1440, 390]) test(`Feishu console shows real messages, steps and binding counts at ${width}px`, async ({ page }) => {
  const f = await channelFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await repositoryAssistant(f); const group = await boundGroup(f); await privateChat(f);
    f.h.store.run("UPDATE channel_connectors SET app_name='研发助手',tenant_name='示例企业' WHERE id=?", f.id);
    scriptedModel(f, [['list_projects', {}], '根据群里的讨论，先核对项目证据。']);
    const receipt = await post(f.h, f.id, inGroup('大家先核对当前的项目范围。', 'ou_bob'));
    expect((await finished(f.h, receipt.value.operation_id)).state).toBe('completed');
    expect((await f.admin('/api/channels/chats/' + group.id + '/service-binding', 'PUT', {
      service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['102'] }, enabled: true, expected_revision: 1
    })).status).toBe(200);
    await page.setViewportSize({ width, height: 1000 }); await login(page, f, '#/conversations/' + group.id);
    const thread = page.getByRole('region', { name: '当前飞书会话' });
    await expect(page.getByLabel('消息与执行时间线')).toContainText('大家先核对当前的项目范围。');
    await page.getByText('查看执行过程', { exact: true }).click();
    await expect(page.locator('.channel-step')).toContainText(['开始执行', '请求模型', '模型已返回', '调用工具 · 查看项目范围', '工具已返回 · 查看项目范围', '请求模型', '模型已返回', '本轮完成']);
    await page.getByText('本轮生成的回答', { exact: true }).click();
    await expect(page.getByLabel('消息与执行时间线')).toContainText('根据群里的讨论，先核对项目证据。');
    await expect(page.getByLabel('会话派生任务')).toContainText('项目任务');
    await expect(thread).not.toContainText('来源或授权范围已变化');
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
    await expect(page.getByLabel('个人飞书绑定列表')).toContainText('私聊会话已建立');
    await expect(page.getByLabel('飞书群绑定列表')).toContainText('项目讨论群');
    await expect(page.getByLabel('飞书群绑定列表').getByRole('button', { name: '配置仓库与权限', exact: true })).toBeVisible();
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    await page.screenshot({ path: `.tmp/channel-console/bindings-${width}.png`, fullPage: true });
    await page.goto(f.h.admin + '/#/preferences'); await expect(page.getByRole('heading', { name: '身份与权限', exact: true })).toBeVisible();
    await expect(page.locator('#console-secondary-nav .project-nav [aria-current=page]')).toHaveText('身份与权限');
    const identityOverview = page.getByRole('region', { name: '飞书绑定概览' });
    await identityOverview.getByText('查看维护的群与绑定范围', { exact: true }).click();
    await expect(identityOverview).toContainText('项目讨论群');
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
    await expect(page.getByRole('button', { name: '禁用项目', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '删除项目', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    const password = testPassword(); await f.admin('/api/users', 'POST', { username: 'project-owner', password, repository_ids: ['101'] });
    await page.getByLabel('用户名', { exact: true }).fill('project-owner'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.goto(f.h.admin + '/#/preferences');
    await expect(page.locator('#tabs [data-tab=more]')).toHaveText('更多功能');
    await expect(page.locator('#tabs [data-tab=settings]')).toBeHidden();
    await page.getByLabel('切换项目').selectOption('101');
    await page.locator('#console-secondary-nav .project-nav').getByRole('link', { name: '基本设置', exact: true }).click();
    await expect(page.getByLabel('基准分支', { exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '删除项目', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '禁用项目', exact: true })).toHaveCount(0);
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
    await page.goto(f.h.admin + '/#/preferences'); release(); await expect(page.getByRole('heading', { name: '身份与权限', exact: true })).toBeVisible();
    await expect(page.getByLabel('消息与执行时间线')).toHaveCount(0); await page.unroute('**/timeline?*');
    await page.goto(f.h.admin + '/#/conversations/' + chat.id); await expect(page.getByLabel('消息与执行时间线')).toContainText('Group discussion');
    await page.clock.install(); let revokedReads = 0;
    await page.route('**/timeline?*', route => { revokedReads++; return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'channel_history_forbidden' }) }); });
    // The 403 response removes the checkbox during its change handler; dispatch the click without waiting on the removed control.
    await page.getByLabel('自动刷新（5 秒）', { exact: true }).evaluate(control => control.click());
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
    await expect(page.getByRole('heading', { name: '身份与权限', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '生成绑定串', exact: true })).toHaveCount(0);
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


test('binding overview pairs private chats with their exact Feishu identity and removes only the revoked identity from current counts', async ({ page }) => {
  const f = await channelFixture();
  try {
    const first = await privateChat(f);
    bindFixture(f.h, f.id, f.principal, 'ou_second');
    const second = await privateChat(f, 'ou_second', f.principal, 'oc_second');
    await login(page, f, '#/identity/feishu');
    const overview = page.getByRole('region', { name: '飞书绑定概览' });
    await expect(overview.locator('.feishu-metric')).toContainText(['已绑定身份2', '本人私聊2']);
    const listRows = page.getByLabel('个人飞书绑定列表').getByRole('article', { name: '我的飞书账号' });
    await expect(listRows).toHaveCount(2);
    for (const row of await listRows.all()) await expect(row.getByRole('link', { name: '查看聊天记录', exact: true })).toHaveCount(1);
    expect(new Set(await listRows.getByRole('link', { name: '查看聊天记录', exact: true }).evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))))).toEqual(new Set(['#/conversations/' + first.id, '#/conversations/' + second.id]));
    await page.goto(f.h.admin + '/#/identity');
    const identityOverview = page.getByRole('region', { name: '飞书绑定概览' });
    const identities = identityOverview.locator('.feishu-bound-summary > .feishu-summary-row');
    await expect(identities).toHaveCount(2);
    for (const row of await identities.all()) await expect(row.getByRole('link', { name: '打开私聊会话', exact: true })).toHaveCount(1);
    expect(new Set(await identities.locator('a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))))).toEqual(new Set(['#/conversations/' + first.id, '#/conversations/' + second.id]));
    f.h.store.run("UPDATE external_identities SET status='revoked' WHERE principal_id=? AND provider='feishu' AND external_actor='ou_second'", f.principal);
    await page.reload();
    await expect(identityOverview.locator('.feishu-metric')).toContainText(['已绑定身份1', '本人私聊1']);
    await expect(identityOverview).toContainText('另有 1 个历史会话');
    await expect(identityOverview.getByRole('link', { name: '打开私聊会话', exact: true })).toHaveAttribute('href', '#/conversations/' + first.id);
    await page.goto(f.h.admin + '/#/identity/feishu');
    await expect(overview.locator('.feishu-metric')).toContainText(['已绑定身份1', '本人私聊1']);
    await expect(overview).toContainText('另有 1 个历史会话');
  } finally { await f.close(); }
});

for (const width of [1440, 390]) test(`Feishu names identify private chats and groups with enterprise context at ${width}px`, async ({ page }) => {
  const f = await channelFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await boundGroup(f); const mine = await privateChat(f);
    const tenant = f.h.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', '101').tenant_id;
    f.h.store.run("UPDATE channel_connectors SET app_name='研发助手',tenant_name='示例企业',owner_tenant=? WHERE id=?", tenant, f.id);
    f.h.store.run("UPDATE external_identities SET external_tenant='install-tenant' WHERE principal_id=?", f.principal);
    f.h.store.run("UPDATE channel_personal_owners SET actor_tenant='install-tenant' WHERE chat_id=?", mine.id);
    f.wire.state.chatName = '基础设施讨论群';
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
    mkdirSync('.tmp/channel-console', { recursive: true });
    await page.screenshot({ path: `.tmp/channel-console/names-${width}.png`, fullPage: true });
    await page.goto(f.h.admin + '/#/identity/feishu/groups');
    const binding = page.getByRole('article', { name: '群聊助手绑定' });
    await expect(binding).toContainText('基础设施讨论群'); await expect(binding).toContainText('所属企业：示例企业');
    await binding.getByRole('button', { name: '配置仓库与权限', exact: true }).click();
    await expect(page.getByLabel('助手所在群')).toContainText('基础设施讨论群 · 示例企业 · 研发助手');
    f.wire.state.chatName = '<img src=x onerror=alert(1)> 更名群';
    await binding.getByRole('button', { name: '刷新群名称', exact: true }).click();
    await expect(binding).toContainText(f.wire.state.chatName); await expect(binding.locator('img')).toHaveCount(0);
    f.wire.state.chatCode = 99991672;
    await binding.getByRole('button', { name: '刷新群名称', exact: true }).click();
    await expect(binding).toContainText('保留上次读取的名称'); await expect(binding).toContainText(f.wire.state.chatName);
    await page.goto(f.h.admin + '/#/identity/feishu/conversations');
    const conversations = page.getByLabel('可查看的飞书会话');
    await expect(conversations.getByRole('link', { name: /私聊 · 张小明/ })).toBeVisible();
    await expect(conversations.locator('article').filter({ hasText: '私聊 · 张小明' })).toContainText('示例企业');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});


for (const width of [1440, 390]) test(`a platform administrator reads another user's complete private conversation at ${width}px`, async ({ page }) => {
  const f = await channelFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const owner = await f.member('private-conversation-owner', { repository_ids: ['101'] });
    bindFixture(f.h, f.id, owner.id, 'ou_console_owner');
    f.h.store.run("UPDATE external_identities SET display_name='李明' WHERE principal_id=?", owner.id);
    scriptedModel(f, [['send_message', { text: '正在核对私聊的问题。' }], '这是成员私聊中已经生成的完整回答。']);
    const receipt = await post(f.h, f.id, envelope('请核对我的项目问题', { sender: { sender_id: { open_id: 'ou_console_owner' } }, message: { chat_id: 'oc_console_owner' } }));
    expect((await finished(f.h, receipt.value.operation_id)).state).toBe('completed');
    const chat = f.h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_console_owner'");
    f.h.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', chat.id);
    f.h.store.run('UPDATE principals SET authorization_revision=authorization_revision+1 WHERE id=?', owner.id);
    await page.setViewportSize({ width, height: 1000 }); await login(page, f, '#/conversations');
    await page.getByRole('link', { name: /私聊 · 李明/ }).click();
    const timeline = page.getByLabel('消息与执行时间线');
    await expect(timeline).toContainText('请核对我的项目问题');
    await expect(timeline).toContainText('这是成员私聊中已经生成的完整回答。');
    await expect(timeline).toContainText('正在核对私聊的问题。');
    await timeline.getByText('查看执行过程', { exact: true }).click();
    await expect(timeline.locator('.channel-step')).not.toHaveCount(0);
    await expect(timeline).not.toContainText('来源或授权范围已变化');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mkdirSync('.tmp/channel-console', { recursive: true });
    await page.screenshot({ path: `.tmp/channel-console/admin-private-history-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

for (const type of ['text', 'post']) test(`a mention-only ${type} message remains visible and gives the assistant its group name and preceding question`, async ({ page }) => {
  const f = await channelFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await repositoryAssistant(f);
    const question = inGroup(''); question.event.message.mentions = [];
    question.event.message.content = JSON.stringify({ text: '你可以创建 issue 吗？' });
    await post(f.h, f.id, question);
    const chat = f.h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group'");
    expect((await f.admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', {
      service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['101'] }, enabled: true, expected_revision: 0
    })).status).toBe(200);
    scriptedModel(f, [(done, input) => {
      expect(input.request).toBe('@LaunchPad-Test');
      expect(input.context.bot_identity.name).toBe('LaunchPad-Test');
      expect(input.context.current_message.is_direct_mention).toBe(true);
      expect(input.context.recent_messages.some(m => m.content === '你可以创建 issue 吗？')).toBe(true);
      return '我看到了你在 @LaunchPad-Test，刚才的问题是创建 Issue 的能力。';
    }]);
    const call = inGroup(''); call.event.message.message_type = type;
    call.event.message.content = JSON.stringify(type === 'text' ? { text: '@_user_1' } : { zh_cn: { content: [[{ tag: 'at', user_id: '@_user_1' }]] } });
    call.event.message.mentions[0].name = 'LaunchPad-Test';
    const receipt = await post(f.h, f.id, call); expect((await finished(f.h, receipt.value.operation_id)).state).toBe('completed');
    await login(page, f, '#/conversations/' + chat.id);
    const timeline = page.getByLabel('消息与执行时间线');
    await expect(timeline.getByText('@LaunchPad-Test', { exact: true })).toBeVisible();
    await expect(timeline).toContainText('你可以创建 issue 吗？');
    await timeline.getByText('本轮生成的回答', { exact: true }).click();
    await expect(timeline).toContainText('我看到了你在 @LaunchPad-Test');
    mkdirSync('.tmp/channel-console', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.tmp/channel-console/self-mention-${type}-${width}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
