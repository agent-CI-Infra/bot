import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { managementFixture } from '../test/management-fixture.mjs';
import { identityFixture } from '../test/identity-fixture.mjs';
import { transport, connector, envelope, post, finished, credentials } from '../test/channel-fixture.mjs';
import { harness, setup } from '../test/helpers.mjs';

const output = '.tmp/feishu-setup-165';
async function login(page, h, password, username = 'administrator') {
  await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
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
    const scopes = JSON.parse(await page.getByLabel('基础权限 JSON').inputValue());
    expect(scopes.scopes.tenant).toEqual(['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot', 'cardkit:card:write']);
    expect(scopes.scopes.user).toEqual([]);
    await expect(page.getByText('卡片是默认功能：', { exact: false })).toContainText('权限导入不会自动订阅回调');
    await page.getByRole('combobox', { name: '应用类型', exact: true }).selectOption('enterprise');
    const enterpriseScopes = JSON.parse(await page.getByLabel('基础权限 JSON').inputValue());
    expect(enterpriseScopes.scopes.tenant).toEqual([...scopes.scopes.tenant, 'tenant:tenant:readonly']);
    expect(enterpriseScopes.scopes.user).toEqual([]);
    await expect(page.getByText('企业自建应用需先开通', { exact: false })).toContainText('再进入下一步保存连接');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedFeishuScopes = value; } } }));
    await page.getByRole('button', { name: '复制基础权限 JSON', exact: true }).click();
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
    await expect(page.getByText('还必须在“事件与回调 → 回调配置”', { exact: false })).toContainText('两处地址验证均通过');
    await expect(page.getByText('必须在“回调配置 → 添加回调”', { exact: false })).toContainText('card.action.trigger');
    const c = f.h.store.get("SELECT * FROM channel_connectors WHERE app_id='cli_wizard'"); expect(c.enabled).toBe(1); expect(c.transport).toBe('http'); expect(c.bot_open_id).toBe('ou_automatic_save'); expect(c.installation_tenant).toBe('install-tenant');
    await page.screenshot({ path: output + '/events-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '事件与卡片回调已保存，前往发布' }).click(); await page.getByRole('button', { name: '检查已发布的机器人', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '凭据已验证' })).toContainText('尚未验证事件投递');
    expect(f.h.store.get('SELECT last_received_at FROM channel_connectors WHERE id=?', c.id).last_received_at).toBe(null);
    await page.getByRole('button', { name: '进入绑定与试用' }).click();
    await expect(page.getByRole('heading', { name: '连接健康与群接收范围' })).toBeVisible();
    await expect(page.getByText('尚未收到', { exact: true })).toBeVisible();
    await expect(page.getByText('必须点击返回卡片上的', { exact: false })).toContainText('确认收到更新结果后才完成接入');
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
  try {
    const id = await connector(f.admin, { transport: 'websocket' });
    await page.goto(f.h.admin + '/#/settings/feishu/' + id + '/2'); await login(page, f.h, f.password);
    await expect(page.getByText('等待下方传输状态显示已连接', { exact: false })).toContainText('使用长连接接收回调');
    await expect(page.getByText('必须在“回调配置 → 添加回调”', { exact: false })).toContainText('不要选旧版 card.action.trigger_v1');
    await page.getByRole('button', { name: '1. 创建应用', exact: true }).click();
    const scopes = JSON.parse(await page.getByLabel('基础权限 JSON').inputValue());
    expect(scopes.scopes.tenant).toContain('cardkit:card:write');
    await expect(page.getByText('卡片是默认功能：', { exact: false })).toContainText('已有应用也需补齐并发布新版本');
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('a global connection can map groups to projects from either GitHub organization', async ({ page }) => {
  const wire = transport(), f = await managementFixture(null, { channels: { fetch: wire.fetch, longConnections: false } });
  try {
    const id = await connector(f.admin);
    await page.goto(f.h.admin + '/#/settings/feishu'); await login(page, f.h, f.password);
    await expect(page.getByRole('heading', { name: '飞书应用连接', exact: true })).toBeVisible();
    await page.evaluate(() => api('/api/identity/tenant', 'POST', { tenant_id: 'github.com:10' }));
    await page.reload();
    await expect(page.getByText('全局共用 · 启用', { exact: false })).toBeVisible();
    // Return to all organizations before selecting a project belonging to the other one.
    await page.evaluate(() => api('/api/identity/tenant', 'POST', { tenant_id: null }));
    await page.goto(f.h.admin + '/#/settings/feishu/' + id + '/4');
    await page.getByRole('combobox', { name: '项目', exact: true }).selectOption('201');
    await page.getByLabel('群 chat_id').fill('oc_cross_org');
    await page.getByLabel('允许的敏感级别').selectOption('private');
    await page.getByLabel('我已核实群受众（授权一小时；成员变更即失效）').check();
    await page.getByRole('button', { name: '批准或更新群范围' }).click();
    await expect(page.getByText('oc_cross_org → 项目 201', { exact: false })).toBeVisible();
    expect(f.h.store.get('SELECT project_id FROM channel_group_scopes WHERE connector_id=?', id).project_id).toBe('201');
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('personal Feishu guide completes both ends, shows the current identity and unlinks without exposing app configuration', async ({ page }) => {
  test.setTimeout(90000);
  const wire = transport(), f = await identityFixture(null, { channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); mkdirSync(output, { recursive: true });
  try {
    const id = await connector(f.admin), started = await post(f.h, id, envelope('/bind')); await finished(f.h, started.value.operation_id);
    const outbox = f.h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', started.value.operation_id);
    const body = f.h.store.secrets.open(outbox.payload, 'channel-outbox:' + outbox.id), challenge = /challenge=([a-f0-9]+)/.exec(JSON.stringify(body))[1];
    await page.goto(f.h.admin + '/auth/channels/start?challenge=' + challenge);
    await expect(page).toHaveURL(/#\/identity\/feishu$/);
    await expect(page.getByRole('heading', { name: '飞书身份绑定' })).toBeVisible();
    await expect(page.getByLabel('待确认的飞书身份')).toContainText('等待原飞书操作者确认');
    const confirmation = await page.getByLabel('在原私聊发送的确认指令', { exact: true }).inputValue();
    expect(f.h.store.get("SELECT count(*) n FROM external_identities WHERE provider='feishu'").n).toBe(0);
    const grants = f.h.store.get('SELECT count(*) n FROM scoped_grants').n;
    await expect(page.getByRole('button', { name: '全局设置', exact: true })).toBeHidden();
    await expect(page.getByRole('link', { name: '管理员：连接或管理飞书应用' })).toHaveCount(0);
    await expect(page.locator('input[name="app_secret"]')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1100 }); await page.screenshot({ path: output + '/personal-pending-desktop.png', fullPage: true });
    const confirming = await post(f.h, id, envelope(confirmation)); expect((await finished(f.h, confirming.value.operation_id)).state).toBe('completed');
    await page.getByRole('button', { name: '刷新飞书绑定状态' }).click();
    await expect(page.locator('#feishu-identity')).toContainText('ou_alice · 已绑定');
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
    await expect(page.locator('#feishu-identity')).toContainText('ou_alice · 已解绑');
    await expect(page.locator('#feishu-identity')).toContainText('/reauth'); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
