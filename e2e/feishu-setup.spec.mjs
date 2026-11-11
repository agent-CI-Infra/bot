import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { managementFixture } from '../test/management-fixture.mjs';
import { identityFixture } from '../test/identity-fixture.mjs';
import { transport, connector, envelope, post, finished, credentials, bindFixture, until } from '../test/channel-fixture.mjs';
import { harness, setup } from '../test/helpers.mjs';
import { FEISHU_SCOPES } from '../dist/channels/feishu.js';

const output = '.tmp/feishu-setup-165';
async function login(page, h, password, username = 'administrator') {
  await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
test('missing reaction permission gives an administrator an actionable hint on desktop and mobile', async ({ page }) => {
  const wire = transport(), h = await harness(null, undefined, { channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false } });
  try {
    const { admin, password } = await setup(h), id = await connector(admin);
    wire.state.scopes = FEISHU_SCOPES.filter(s => s.scope !== 'im:message.reactions:write_only').map(s => ({ scope_name: s.scope, grant_status: 1, scope_type: 'tenant' }));
    wire.state.reactionHandler = request => request.method === 'POST' ? Response.json({ code: 99991672 }, { status: 403 }) : undefined;
    const receipt = await post(h, id, envelope('/identity'));
    await finished(h, receipt.value.operation_id);
    await until(() => h.store.get('SELECT state FROM channel_reactions WHERE source_event=?', receipt.value.operation_id)?.state === 'failed');
    await page.goto(h.admin + '/#/settings/feishu'); await login(page, h, password);
    await expect(page.getByRole('group', { name: 'cli_fixture', exact: true }).getByLabel('飞书权限检查')).toContainText('im:message.reactions:write_only');
    await page.getByRole('link', { name: '连接诊断与收发记录' }).click();
    await expect(page.getByText('处理中表情暂不可用：', { exact: false })).toContainText('im:message.reactions:write_only');
    await expect(page.getByText('处理中表情暂不可用：', { exact: false })).toContainText('普通消息回复不受影响');
    mkdirSync(output, { recursive: true });
    for (const [name, width, height] of [['desktop', 1440, 1100], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: output + '/processing-reaction-permission-' + name + '.png', fullPage: true });
    }
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
test('global administrator connects an app through the wizard, resumes it and sees credential and revision failures', async ({ page }) => {
  test.setTimeout(90000);
  const wire = transport(), h = await harness(null, undefined, { channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false } });
  const f = { h, ...await setup(h), close: () => h.stop() };
  const errors = []; page.on('pageerror', e => errors.push(e.message)); mkdirSync(output, { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto(f.h.admin + '/#/settings/feishu'); await login(page, f.h, f.password);
    await expect(page.getByRole('heading', { name: '飞书应用连接', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '新增飞书应用连接' }).click();
    await expect(page.getByRole('navigation', { name: '飞书连接步骤' })).toBeVisible();
    await page.getByRole('combobox', { name: '应用类型', exact: true }).selectOption('saas');
    await expect(page.getByLabel('事件接收方式')).toHaveValue('http');
    const scopes = JSON.parse(await page.getByLabel('完整权限 JSON').inputValue());
    expect(scopes.scopes.tenant).toEqual(['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot', 'im:message.reactions:write_only', 'cardkit:card:write',
      'im:message.group_msg', 'im:message:readonly', 'im:chat.members:bot_access', 'im:chat.members:read']);
    expect(scopes.scopes.user).toEqual([]);
    await expect(page.getByText('卡片是默认功能：', { exact: false })).toContainText('权限导入不会自动订阅回调');
    await page.getByRole('combobox', { name: '应用类型', exact: true }).selectOption('enterprise');
    const enterpriseScopes = JSON.parse(await page.getByLabel('完整权限 JSON').inputValue());
    expect(enterpriseScopes.scopes.tenant).toEqual(FEISHU_SCOPES.map(s => s.scope));
    expect(enterpriseScopes.scopes.tenant).toContain('im:message.group_msg.include_bot:read');
    expect(scopes.scopes.tenant).not.toContain('im:message.group_msg.include_bot:read');
    expect(enterpriseScopes.scopes.user).toEqual([]);
    await expect(page.getByText('企业自建应用需先开通', { exact: false })).toContainText('再进入下一步保存连接');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedFeishuScopes = value; } } }));
    await page.getByRole('button', { name: '复制完整权限 JSON', exact: true }).click();
    expect(JSON.parse(await page.evaluate(() => window.copiedFeishuScopes))).toEqual(enterpriseScopes);
    await page.getByRole('button', { name: '应用已准备，填写凭据' }).click();
    expect(f.h.store.get('SELECT count(*) n FROM tenants').n).toBe(0);
    await expect(page.getByRole('heading', { name: '应用凭据', exact: true })).toBeVisible();
    await expect(page.getByLabel('项目所属组织')).toHaveCount(0);
    await expect(page.getByText('此应用连接全局共用', { exact: false })).toContainText('不限制操作者所属飞书企业');
    await page.getByLabel('App ID', { exact: true }).fill('cli_wizard'); await page.getByLabel('App Secret', { exact: true }).fill(credentials.app_secret);
    wire.state.authCode = 10003; await page.getByRole('button', { name: '检查凭据并读取机器人' }).click();
    await expect(page.getByRole('alert')).toContainText('无法通过鉴权');
    wire.state.authCode = 0; await page.getByRole('button', { name: '检查凭据并读取机器人' }).click();
    await expect(page.getByLabel('机器人 open_id', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('凭据已验证');
    await expect(page.getByText('应用安装企业由系统在保存时自动获取', { exact: false })).toBeVisible();
    await expect(page.getByLabel('应用安装租户 tenant_key')).toHaveCount(0);
    await expect(page.locator('input[name="actor_tenants"]')).toHaveCount(0);
    await page.getByLabel('Verification Token', { exact: true }).fill(credentials.verification_token);
    await page.getByLabel('Encrypt Key', { exact: true }).fill(credentials.encrypt_key);
    wire.state.authCode = 10003;
    await page.getByRole('button', { name: '保存连接并继续' }).click();
    await expect(page.getByRole('alert')).toContainText('无法通过鉴权');
    expect(f.h.store.get('SELECT count(*) n FROM channel_connectors').n).toBe(0);
    wire.state.authCode = 0; wire.state.botOpenId = 'ou_automatic_save';
    wire.state.tenantCode = 1184001;
    await page.getByRole('button', { name: '保存连接并继续' }).click();
    await expect(page.getByRole('alert')).toContainText('tenant:tenant:readonly');
    await expect(page.getByRole('alert')).toContainText('发布并通过必要审核后重新保存');
    expect(f.h.store.get('SELECT count(*) n FROM channel_connectors').n).toBe(0);
    expect(f.h.store.get('SELECT count(*) n FROM channel_credentials').n).toBe(0);
    wire.state.tenantCode = 0;
    await page.getByRole('button', { name: '保存连接并继续' }).click();
    await expect(page.getByLabel('HTTP 回调地址')).toHaveValue(/https:\/\/console.example.test\/hooks\/feishu\/[a-f0-9]{48}/);
    const steps = page.getByRole('list', { name: '事件与回调配置步骤' }).getByRole('listitem');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0).getByLabel('HTTP 回调地址')).toBeVisible();
    await expect(steps.nth(0)).toContainText('将事件发送至开发者服务器');
    await expect(steps.nth(0)).toContainText('保存并通过地址验证');
    await expect(steps.nth(1)).toContainText('将回调发送至开发者服务器');
    await expect(steps.nth(1)).toContainText('第 1 步的同一个 HTTP 回调地址');
    await expect(steps.nth(1)).toContainText('单独保存并通过地址验证');
    await expect(steps.nth(1)).toContainText('card.action.trigger，推荐');
    await expect(steps.nth(2).getByRole('button', { name: '事件与卡片回调已保存，前往发布' })).toBeVisible();
    const c = f.h.store.get("SELECT * FROM channel_connectors WHERE app_id='cli_wizard'"); expect(c.enabled).toBe(1); expect(c.transport).toBe('http'); expect(c.bot_open_id).toBe('ou_automatic_save'); expect(c.installation_tenant).toBe('install-tenant');
    await page.screenshot({ path: output + '/events-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '事件与卡片回调已保存，前往发布' }).click(); await page.getByRole('button', { name: '检查已发布的机器人', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '凭据已验证' })).toContainText('尚未验证事件投递');
    expect(f.h.store.get('SELECT last_received_at FROM channel_connectors WHERE id=?', c.id).last_received_at).toBe(null);
    await page.getByRole('button', { name: '进入绑定与试用' }).click();
    await expect(page.getByRole('heading', { name: '连接健康与收发记录' })).toBeVisible();
    await expect(page.getByText('尚未收到', { exact: true })).toBeVisible();
    await expect(page.getByText('绑定后直接在私聊发送', { exact: false })).toContainText('确认收到助手回复后才完成接入');
    await expect(page.getByText('/project', { exact: false })).toHaveCount(0);
    await page.getByRole('link', { name: '前往个人飞书身份绑定' }).click();
    await expect(page.getByRole('heading', { name: '飞书身份绑定' })).toBeVisible();
    await expect(page.getByRole('button', { name: '消息渠道', exact: true })).toHaveCount(0);
    await page.goto(f.h.admin + '/#/settings/feishu/' + c.id + '/1');
    await expect(page.getByLabel('App Secret（留空保留）')).toHaveValue('');
    await expect(page.getByLabel('Verification Token（留空保留）')).toHaveValue('');
    await page.getByLabel('App Secret（留空保留）').fill('rotated-fixture-secret');
    await page.getByRole('button', { name: '保存连接并继续' }).click(); await expect(page).toHaveURL(new RegExp(c.id + '/2$'));
    const updated = f.h.store.get('SELECT * FROM channel_connectors WHERE id=?', c.id), sealed = f.h.store.get('SELECT sealed FROM channel_credentials WHERE id=?', updated.credential_ref);
    expect(f.h.store.secrets.open(sealed.sealed, 'channel-credential:' + updated.credential_ref)).toEqual({ ...credentials, app_secret: 'rotated-fixture-secret' });
    await page.goto(f.h.admin + '/#/settings/feishu/' + c.id + '/1'); await expect(page.getByLabel('App Secret（留空保留）')).toBeVisible();
    await f.admin('/api/channels/connectors/' + c.id, 'PATCH', { expected_revision: updated.revision, enabled: false });
    await page.getByRole('button', { name: '保存连接并继续' }).click();
    await expect(page.getByRole('alert')).toContainText('连接已被其他操作更新');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: output + '/credentials-mobile.png', fullPage: true }); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('connection list refreshes current app names even when bot metadata is stale, with permission diagnostics on desktop and mobile', async ({ page }) => {
  const wire = transport(), f = await managementFixture(null, { channels: { fetch: wire.fetch, longConnections: false } });
  mkdirSync(output, { recursive: true });
  try {
    const id = await connector(f.admin);
    await page.goto(f.h.admin + '/#/settings/feishu'); await login(page, f.h, f.password);
    const row = page.getByRole('group', { name: 'cli_fixture', exact: true });
    await expect(row.getByText('Fixture bot', { exact: true })).toBeVisible();
    wire.state.currentAppName = '研发协作助手'; wire.state.tenantName = '示例研发企业';
    await row.getByRole('button', { name: '刷新应用信息' }).click();
    await expect(row.getByRole('status')).toHaveText('应用与企业信息已检查。');
    await expect(row.getByText('研发协作助手', { exact: true })).toBeVisible();
    await expect(row.getByText('企业：示例研发企业', { exact: true })).toBeVisible();
    await expect(row.getByText('App ID：cli_fixture', { exact: true })).toBeVisible();
    const grants = row.locator('.feishu-scope-check');
    await expect(grants).toContainText(`所需的 ${FEISHU_SCOPES.length} 项均已开通`);
    expect(f.h.store.get('SELECT revision FROM channel_connectors WHERE id=?', id).revision).toBe(1);
    const requests = wire.state.authRequests.length;
    await page.reload();
    await expect(row.getByText('企业：示例研发企业', { exact: true })).toBeVisible();
    await expect(row.getByRole('status')).toHaveText('应用与企业信息已检查。');
    expect(wire.state.authRequests.length).toBeGreaterThan(requests);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: output + '/connections-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: output + '/connections-mobile.png', fullPage: true });
    // A partly configured app lists what is missing, links Feishu's request page for exactly those scopes and offers the full import JSON.
    wire.state.scopes = FEISHU_SCOPES.filter(s => !['im:message.group_msg', 'im:message.group_msg.include_bot:read', 'im:chat.members:read'].includes(s.scope)).map(s => ({ scope_name: s.scope, grant_status: 1, scope_type: 'tenant' }));
    await row.getByRole('button', { name: '刷新应用信息与权限' }).click();
    await expect(grants).toContainText('缺少 3 项');
    await expect(grants.getByRole('listitem')).toHaveText([/^im:message\.group_msg · /, /^im:message\.group_msg\.include_bot:read · 接收群内用户及其他机器人消息/, /^im:chat\.members:read · 核验群成员/]);
    const request = new URL(await grants.getByRole('link', { name: '在飞书开通缺少的权限' }).getAttribute('href'));
    expect(request.origin + request.pathname).toBe('https://open.feishu.cn/app/cli_fixture/auth');
    expect(request.searchParams.get('q')).toBe('im:message.group_msg,im:message.group_msg.include_bot:read,im:chat.members:read');
    expect(JSON.parse(await grants.getByLabel('完整权限 JSON').inputValue()).scopes.tenant).toEqual(FEISHU_SCOPES.map(s => s.scope));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: output + '/connections-mobile-missing-scopes.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: output + '/connections-desktop-missing-scopes.png', fullPage: true });
    wire.state.scopeCode = 99991663;
    await row.getByRole('button', { name: '刷新应用信息与权限' }).click();
    await expect(grants).toContainText('暂时无法自动检查飞书权限');
    await expect(row.getByRole('status')).toHaveText('应用与企业信息已检查。');
    wire.state.scopeCode = 0; wire.state.scopes = null;
    wire.state.applicationCode = 99991672;
    await row.getByRole('button', { name: '刷新应用信息' }).click();
    await expect(row.getByRole('status')).toContainText('admin:app.info:readonly');
    await expect(row.getByText('研发协作助手', { exact: true })).toBeVisible();
    wire.state.applicationCode = 0; wire.state.tenantCode = 1184001;
    await row.getByRole('button', { name: '刷新应用信息' }).click();
    await expect(row.getByRole('status')).toContainText('tenant:tenant:readonly');
    await expect(row.getByText('企业：示例研发企业', { exact: true })).toBeVisible();
    wire.state.tenantCode = 0; wire.state.authCode = 10003;
    await row.getByRole('button', { name: '刷新应用信息' }).click();
    await expect(row.getByRole('status')).toContainText('无法通过鉴权');
    await expect(row.getByText('研发协作助手', { exact: true })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain(credentials.app_secret);
    wire.state.authCode = 0; wire.state.currentAppName = null; wire.state.appName = '<img src=x onerror=alert(1)> 研发协作助手';
    wire.state.tenantName = '跨团队持续交付与基础设施研发企业'.repeat(8);
    await row.getByRole('button', { name: '刷新应用信息' }).click();
    await expect(row.getByText(wire.state.appName, { exact: true })).toBeVisible();
    await expect(row.locator('img')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: output + '/connections-mobile-long-names.png', fullPage: true });
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('store apps save without manual bot identity and synchronize it after receiving the installation ticket', async ({ page }) => {
  const wire = transport(), h = await harness(null, undefined, { channels: { fetch: wire.fetch, longConnections: false } });
  const f = { h, ...await setup(h) };
  try {
    await page.goto(h.admin + '/#/settings/feishu/new/0'); await login(page, h, f.password);
    await page.getByRole('combobox', { name: '应用类型', exact: true }).selectOption('saas');
    await page.getByRole('button', { name: '应用已准备，填写凭据' }).click();
    await expect(page.getByLabel('机器人 open_id')).toHaveCount(0);
    await page.getByLabel('App ID', { exact: true }).fill('cli_store_wizard');
    await page.getByLabel('App Secret', { exact: true }).fill(credentials.app_secret);
    await page.getByLabel('应用安装租户 tenant_key').fill('install-tenant');
    await expect(page.locator('input[name="actor_tenants"]')).toHaveCount(0);
    await page.getByLabel('Verification Token', { exact: true }).fill(credentials.verification_token);
    await page.getByLabel('Encrypt Key', { exact: true }).fill(credentials.encrypt_key);
    await page.getByRole('button', { name: '保存连接并继续' }).click();
    await expect(page.getByRole('heading', { name: '事件与回调', exact: true })).toBeVisible();
    const events = page.getByRole('list', { name: '事件与回调配置步骤' }).getByRole('listitem').nth(0);
    await expect(events.getByRole('link', { name: '配置公网 HTTPS 地址' })).toBeVisible();
    await expect(events).toContainText('app_ticket');
    const c = h.store.get("SELECT * FROM channel_connectors WHERE app_id='cli_store_wizard'"); expect(c.bot_open_id).toBe('');
    await page.getByRole('button', { name: '事件与卡片回调已保存，前往发布' }).click();
    await page.getByRole('button', { name: '检查已发布的机器人', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '尚未收到有效的商店应用票据' })).toBeVisible();
    const ticket = { ts: String(Date.now() / 1000), uuid: 'wizard-ticket', token: credentials.verification_token, type: 'event_callback',
      event: { type: 'app_ticket', app_id: 'cli_store_wizard', app_ticket: 'fixture-store-ticket' } };
    expect((await post(h, c.id, ticket, { encrypted: true })).value.state).toBe('completed');
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: '检查已发布的机器人', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: '机器人身份已自动同步' })).toBeVisible();
    }
    const updated = h.store.get('SELECT * FROM channel_connectors WHERE id=?', c.id);
    expect(updated.bot_open_id).toBe('ou_bot'); expect(updated.revision).toBe(2);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('enterprise long connections require callback configuration as well as message events', async ({ page }) => {
  const wire = transport(), f = await managementFixture(null, { channels: { fetch: wire.fetch, longConnections: false } });
  mkdirSync(output, { recursive: true });
  try {
    const id = await connector(f.admin, { transport: 'websocket' });
    await page.goto(f.h.admin + '/#/settings/feishu/' + id + '/2'); await login(page, f.h, f.password);
    const steps = page.getByRole('list', { name: '事件与回调配置步骤' }).getByRole('listitem');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('等待上方传输状态显示已连接');
    await expect(steps.nth(0)).toContainText('使用长连接接收事件');
    await expect(steps.nth(0)).toContainText('im.message.receive_v1');
    await expect(steps.nth(0)).toContainText('im.chat.member.user.deleted_v1');
    await steps.nth(0).getByRole('button', { name: '刷新连接状态' }).click();
    await expect(steps.nth(1)).toContainText('使用长连接接收回调');
    await expect(steps.nth(1)).toContainText('card.action.trigger，推荐');
    await expect(steps.nth(1)).toContainText('card.action.trigger_v1），旧版不支持长连接');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: output + '/events-websocket-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: output + '/events-websocket-mobile.png', fullPage: true });
    const current = f.h.store.get('SELECT revision FROM channel_connectors WHERE id=?', id);
    await f.admin('/api/channels/connectors/' + id, 'PATCH', { expected_revision: current.revision, enabled: false });
    await page.reload();
    await expect(steps.nth(0).getByRole('link', { name: '前往启用连接' })).toHaveAttribute('href', '#/settings/feishu/' + id + '/1');
    await page.getByRole('button', { name: '1. 创建应用', exact: true }).click();
    const scopes = JSON.parse(await page.getByLabel('完整权限 JSON').inputValue());
    expect(scopes.scopes.tenant).toContain('cardkit:card:write');
    await expect(page.getByText('卡片是默认功能：', { exact: false })).toContainText('已有应用也需补齐并发布新版本');
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('the trial step sends group scope to the group assistant binding instead of a per-project group form', async ({ page }) => {
  const wire = transport(), f = await managementFixture(null, { channels: { fetch: wire.fetch, longConnections: false } });
  try {
    const id = await connector(f.admin);
    await page.goto(f.h.admin + '/#/settings/feishu/' + id + '/4'); await login(page, f.h, f.password);
    await expect(page.getByRole('heading', { name: '连接健康与收发记录' })).toBeVisible();
    await expect(page.getByRole('button', { name: '批准或更新群范围' })).toHaveCount(0);
    await expect(page.getByLabel('群 chat_id')).toHaveCount(0);
    await expect(page.getByText('在「身份与权限 → 飞书群聊助手」为该群选择服务角色和项目范围', { exact: false })).toBeVisible();
    expect((await f.admin('/api/channels/connectors/' + id + '/groups')).status).toBe(404);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('ordinary users see connected bot names and private-chat links, confirm a private code and get an administrator contact empty state', async ({ page }) => {
  test.setTimeout(90000);
  const wire = transport(), f = await managementFixture(null, { channels: { fetch: wire.fetch, longConnections: false } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); mkdirSync(output, { recursive: true });
  try {
    const local = await f.member('code-browser-user', {});
    await page.goto(f.h.admin + '/#/identity/feishu'); await login(page, f.h, local.password, 'code-browser-user');
    const identity = page.locator('#feishu-identity');
    await expect(identity.getByText('请联系超级管理员配置飞书应用。', { exact: true })).toBeVisible();
    await expect(identity.getByRole('link', { name: '管理员：连接或管理飞书应用' })).toHaveCount(0);
    await expect(identity.getByLabel('飞书认证字符串', { exact: true })).toHaveCount(0);
    const id = await connector(f.admin, { installation_tenant: undefined, bot_open_id: undefined });
    await page.getByRole('button', { name: '刷新飞书绑定状态' }).click();
    await expect(identity.getByLabel('可绑定的飞书应用')).toContainText('Fixture enterprise · Fixture bot');
    await expect(identity.getByRole('link', { name: '打开机器人私聊' })).toHaveAttribute('href', 'https://applink.feishu.cn/client/bot/open?appId=cli_fixture');
    await expect(identity.getByLabel('可绑定的飞书应用')).not.toContainText('cli_fixture');
    await expect(identity.getByRole('link', { name: '管理员：连接或管理飞书应用' })).toHaveCount(0);
    const started = await post(f.h, id, envelope('/bind', { sender: { sender_id: { open_id: 'ou_code_browser' } } }));
    expect((await finished(f.h, started.value.operation_id)).state).toBe('completed');
    const outbox = f.h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', started.value.operation_id);
    const reply = JSON.stringify(f.h.store.secrets.open(outbox.payload, 'channel-outbox:' + outbox.id)), code = /FSB-[a-f0-9]{48}/.exec(reply)[0];
    await identity.getByLabel('飞书认证字符串', { exact: true }).fill('FSB-invalid');
    await identity.getByRole('button', { name: '确认绑定到当前账户' }).click();
    await expect(identity.getByRole('alert')).toContainText('认证字符串无效');
    await identity.getByLabel('飞书认证字符串', { exact: true }).fill(code);
    await page.setViewportSize({ width: 1440, height: 1100 }); await page.screenshot({ path: output + '/code-binding-desktop.png', fullPage: true });
    const grants = f.h.store.get('SELECT count(*) n FROM scoped_grants').n;
    await identity.getByRole('button', { name: '确认绑定到当前账户' }).click();
    await expect(identity).toContainText('code-browser-user 的飞书账号 · 已绑定');
    expect(f.h.store.get("SELECT principal_id FROM external_identities WHERE provider='feishu'").principal_id).toBe(local.id);
    expect(f.h.store.get('SELECT count(*) n FROM scoped_grants').n).toBe(grants);
    const replay = await page.evaluate(input => api('/api/channels/bindings/confirm', 'POST', input).catch(e => e.message), { code, connector_id: id });
    expect(replay).toContain('binding_replayed');
    expect(await page.evaluate(async () => (await fetch('/api/channels/setup')).status)).toBe(403);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: output + '/code-binding-mobile.png', fullPage: true });
    await page.evaluate(() => api('/api/auth/logout', 'POST', {})); await page.reload(); await login(page, f.h, f.password);
    await expect(identity.getByRole('link', { name: '管理员：连接或管理飞书应用' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('a linked account shows readable names without blocking on directory lookup, and preserves names when lookup is unavailable', async ({ page }) => {
  test.setTimeout(90000);
  const wire = transport(), f = await managementFixture(null, { channels: { fetch: wire.fetch, longConnections: false } });
  let release; wire.state.profileGate = new Promise(resolve => { release = resolve; });
  wire.state.appName = '项目协作助手'; wire.state.tenantName = '示例企业';
  mkdirSync(output, { recursive: true }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const id = await connector(f.admin, { installation_tenant: undefined, bot_open_id: undefined }), local = await f.member('readable-user', {});
    bindFixture(f.h, id, local.id, 'ou_unreadable', 'install-tenant');
    await page.goto(f.h.admin + '/#/identity/feishu'); await login(page, f.h, local.password, 'readable-user');
    const binding = page.getByLabel('我的飞书账号', { exact: true });
    await expect(binding).toContainText('readable-user 的飞书账号 · 已绑定');
    await expect(binding).toContainText('机器人：项目协作助手；所属企业：示例企业');
    await expect(binding.getByRole('button', { name: '刷新飞书姓名' })).toBeDisabled();
    await expect(binding).not.toContainText('ou_unreadable');
    await expect(binding).not.toContainText('cli_fixture');
    await expect(binding).not.toContainText('install-tenant');
    release();
    await expect(binding).toContainText('张小明 · 已绑定');
    await expect(binding).toContainText('关联平台账户：readable-user');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: output + '/readable-identity-desktop.png', fullPage: true });
    wire.state.profileCode = 99991672;
    await binding.getByRole('button', { name: '刷新飞书姓名' }).click();
    await expect(binding).toContainText('保留上次读取的姓名');
    await expect(binding).toContainText('张小明 · 已绑定');
    expect(await binding.innerText()).not.toContain('fixture-only-access-token');
    wire.state.profileCode = 0; wire.state.profileName = '<img src=x onerror=alert(1)> 张小明';
    await binding.getByRole('button', { name: '刷新飞书姓名' }).click();
    await expect(binding).toContainText(wire.state.profileName + ' · 已绑定');
    await expect(binding.locator('img')).toHaveCount(0);
    wire.state.profileName = '张小明';
    await binding.getByRole('button', { name: '刷新飞书姓名' }).click();
    await expect(binding).toContainText('张小明 · 已绑定');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: output + '/readable-identity-mobile.png', fullPage: true });
    page.once('dialog', dialog => dialog.accept()); await binding.getByRole('button', { name: '解除飞书绑定' }).click();
    await expect(binding).toContainText('已解绑'); await expect(binding).not.toContainText('ou_unreadable');
    await expect(binding.getByRole('button', { name: '刷新飞书姓名' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { release(); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('personal Feishu guide completes both ends, shows the current identity and unlinks without exposing app configuration', async ({ page }) => {
  test.setTimeout(90000);
  const wire = transport(), f = await identityFixture(null, { channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); mkdirSync(output, { recursive: true });
  try {
    const id = await connector(f.admin, { installation_tenant: undefined, bot_open_id: undefined }), started = await post(f.h, id, envelope('/bind')); await finished(f.h, started.value.operation_id);
    const outbox = f.h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', started.value.operation_id);
    const body = f.h.store.secrets.open(outbox.payload, 'channel-outbox:' + outbox.id), challenge = /challenge=([a-f0-9]+)/.exec(JSON.stringify(body))[1];
    await page.goto(f.h.admin + '/auth/channels/start?challenge=' + challenge);
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '使用 GitHub 登录', exact: true }).click();
    await expect(page).toHaveURL(/#\/identity\/feishu$/);
    await expect(page.getByRole('heading', { name: '飞书身份绑定' })).toBeVisible();
    await expect(page.getByLabel('待确认的飞书身份')).toContainText('等待原飞书操作者确认');
    await expect(page.getByLabel('待确认的飞书身份')).toContainText('Fixture bot');
    await expect(page.getByLabel('待确认的飞书身份')).toContainText('Fixture enterprise');
    await expect(page.getByLabel('待确认的飞书身份')).not.toContainText('ou_alice');
    await expect(page.getByLabel('待确认的飞书身份')).not.toContainText('cli_fixture');
    const confirmation = await page.getByLabel('在原私聊发送的确认指令', { exact: true }).inputValue();
    expect(f.h.store.get("SELECT count(*) n FROM external_identities WHERE provider='feishu'").n).toBe(0);
    const grants = f.h.store.get('SELECT count(*) n FROM scoped_grants').n;
    await expect(page.getByRole('button', { name: '全局设置', exact: true })).toBeHidden();
    await expect(page.getByRole('link', { name: '管理员：连接或管理飞书应用' })).toHaveCount(0);
    await expect(page.locator('input[name="app_secret"]')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1100 }); await page.screenshot({ path: output + '/personal-pending-desktop.png', fullPage: true });
    const confirming = await post(f.h, id, envelope(confirmation)); expect((await finished(f.h, confirming.value.operation_id)).state).toBe('completed');
    await page.getByRole('button', { name: '刷新飞书绑定状态' }).click();
    await expect(page.getByLabel('我的飞书账号', { exact: true })).toContainText('已绑定');
    await expect(page.getByLabel('我的飞书账号', { exact: true })).not.toContainText('ou_alice');
    expect(f.h.store.get('SELECT count(*) n FROM scoped_grants').n).toBe(grants);
    const denied = await page.evaluate(async () => (await fetch('/api/channels/setup')).status); expect(denied).toBe(403);
    await page.goto(f.h.admin + '/#/settings/feishu'); await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await page.goto(f.h.admin + '/#/channels'); await expect(page).toHaveURL(/#\/identity\/feishu$/);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: output + '/personal-bound-mobile.png', fullPage: true });
    const unlinkResponse = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().includes('/api/identity/bindings/'));
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '解除飞书绑定' }).click();
    const unlinkResult = await (await unlinkResponse).json();
    expect(unlinkResult).toEqual({ ok: true });
    await expect(page.getByLabel('我的飞书账号', { exact: true })).toContainText('已解绑');
    await expect(page.locator('#feishu-identity')).toContainText('/reauth'); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('a local account completes Feishu binding without GitHub login and keeps its existing repository scope', async ({ page }) => {
  test.setTimeout(90000);
  const wire = transport(), f = await managementFixture(null, { channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); mkdirSync(output, { recursive: true });
  try {
    const id = await connector(f.admin), local = await f.member('local-feishu-user', { repository_ids: ['101'] });
    const actor = { sender: { sender_id: { open_id: 'ou_local_browser' } } };
    const started = await post(f.h, id, envelope('/bind', actor)); await finished(f.h, started.value.operation_id);
    const outbox = f.h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', started.value.operation_id);
    const body = f.h.store.secrets.open(outbox.payload, 'channel-outbox:' + outbox.id), challenge = /challenge=([a-f0-9]+)/.exec(JSON.stringify(body))[1];
    await page.goto(f.h.admin + '/auth/channels/start?challenge=' + challenge);
    await expect(page.getByRole('link', { name: '使用 GitHub 登录', exact: true })).toBeHidden();
    await login(page, f.h, local.password, 'local-feishu-user');
    await expect(page.getByRole('heading', { name: '飞书身份绑定' })).toBeVisible();
    await expect(page.locator('#feishu-identity')).toContainText('将绑定到当前平台账户：local-feishu-user');
    await expect(page.getByText('先在上方关联 GitHub 账号', { exact: false })).toHaveCount(0);
    expect(f.h.store.get('SELECT principal_id FROM channel_bind_requests').principal_id).toBe(null);
    await page.getByRole('button', { name: '绑定到当前平台账户' }).click();
    await expect(page).toHaveURL(/#\/identity\/feishu$/);
    await expect(page.getByLabel('待确认的飞书身份')).toContainText('local-feishu-user');
    const confirmation = await page.getByLabel('在原私聊发送的确认指令').inputValue();
    expect(f.h.store.get("SELECT count(*) n FROM external_identities WHERE provider='feishu'").n).toBe(0);
    const grants = f.h.store.get('SELECT count(*) n FROM scoped_grants').n;
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: output + '/local-binding-pending-desktop.png', fullPage: true });
    const confirmed = await post(f.h, id, envelope(confirmation, actor));
    expect((await finished(f.h, confirmed.value.operation_id)).state).toBe('completed');
    await page.getByRole('button', { name: '刷新飞书绑定状态' }).click();
    await expect(page.locator('#feishu-identity')).toContainText('local-feishu-user 的飞书账号 · 已绑定');
    expect(f.h.store.get("SELECT principal_id FROM external_identities WHERE provider='feishu'").principal_id).toBe(local.id);
    expect(f.h.store.get('SELECT count(*) n FROM scoped_grants').n).toBe(grants);
    expect(f.h.store.get("SELECT count(*) n FROM external_identities WHERE provider='github'").n).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: output + '/local-binding-bound-mobile.png', fullPage: true });
    const denied = await page.evaluate(async () => (await fetch('/api/channels/setup')).status);
    expect(denied).toBe(403); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
