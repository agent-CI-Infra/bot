import { test, expect } from '@playwright/test';
import { channelFixture, connector, envelope, post, finished } from '../test/channel-fixture.mjs';

async function login(page, f, user) {
  await page.goto(f.h.admin + '/#/identity/feishu');
  await page.getByLabel('用户名', { exact: true }).fill(user.name);
  await page.getByLabel('密码', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '飞书身份绑定', exact: true })).toBeVisible();
}
const app = (page, id) => page.locator('[data-binding-connector="' + id + '"]');
async function issue(page, id, keyboard = false) {
  const reply = page.waitForResponse(r => new URL(r.url()).pathname === '/api/channels/bindings/issue' && r.request().method() === 'POST');
  const button = app(page, id).getByRole('button', { name: '生成绑定串', exact: true });
  if (keyboard) { await button.focus(); await page.keyboard.press('Enter'); } else await button.click();
  const issued = await (await reply).json();
  await expect(app(page, id).locator('.channel-binding-console code')).toHaveText('绑定 ' + issued.code);
  return issued;
}
async function redeem(f, issued, actor, id = f.id, appId = 'cli_fixture') {
  const sent = await post(f.h, id, envelope('绑定 ' + issued.code, { header: { app_id: appId, tenant_key: f.service.connector(id).installation_tenant },
    sender: { sender_id: { open_id: actor } }, message: { chat_id: 'oc_' + actor } }));
  expect(sent.status).toBe(200);
  expect((await finished(f.h, sent.value.operation_id)).state).toBe('completed');
}

for (const width of [1440, 390]) {
  test(`one private message binds and rebinds the same identity, without relying on a larger list (${width}px)`, async ({ page }) => {
    test.setTimeout(60000);
    const f = await channelFixture(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const name = 'binding-user-with-a-long-account-name-for-rebind-' + width, user = { ...await f.member(name, { repository_ids: ['101'] }), name };
      const actor = 'ou_browser_' + width, grants = f.h.store.get('SELECT count(*) n FROM scoped_grants').n;
      await page.setViewportSize({ width, height: 844 }); await login(page, f, user);
      await expect(page.getByRole('link', { name: '管理员：连接或管理飞书应用', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('助手所在群', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('飞书认证字符串', { exact: true })).toBeHidden();
      const first = await issue(page, f.id), slot = app(page, f.id).locator('.channel-binding-console');
      await slot.getByRole('button', { name: '复制绑定串', exact: true }).click();
      await expect(page.getByLabel('我的飞书账号', { exact: true })).toHaveCount(0);
      await redeem(f, first, actor);
      const binding = page.getByLabel('我的飞书账号', { exact: true });
      await expect(binding).toContainText('已绑定', { timeout: 15000 });
      const identity = f.h.store.get('SELECT id FROM external_identities WHERE external_actor=?', actor);
      const count = f.h.store.get('SELECT count(*) n FROM external_identities').n;
      await expect(page.locator('.feishu-binding-steps')).toBeHidden();
      await expect(app(page, f.id).getByRole('button', { name: '重新绑定', exact: true })).toBeVisible();
      page.once('dialog', dialog => dialog.accept());
      await binding.getByRole('button', { name: '解除飞书绑定', exact: true }).click();
      await expect(binding).toContainText('已解绑');
      const next = await issue(page, f.id, width === 390); await redeem(f, next, actor);
      await expect(binding).toContainText('已绑定', { timeout: 15000 });
      expect(f.h.store.get('SELECT id FROM external_identities WHERE external_actor=?', actor).id).toBe(identity.id);
      expect(f.h.store.get('SELECT count(*) n FROM external_identities').n).toBe(count);
      expect(f.h.store.get('SELECT count(*) n FROM scoped_grants').n).toBe(grants);
      await expect(app(page, f.id).locator('.channel-binding-console code')).toHaveCount(0);
      await page.goto(f.h.admin + '/#/projects'); await page.goto(f.h.admin + '/#/identity/feishu');
      await expect(binding).toContainText('已绑定');
      await page.getByRole('link', { name: '我维护的群助手', exact: true }).click();
      await expect(page.getByRole('heading', { name: '飞书群聊助手', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '飞书身份绑定', exact: true })).toHaveCount(0);
      await page.getByRole('link', { name: '个人飞书绑定', exact: true }).click();
      await expect(binding).toContainText('已绑定');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await f.close(); }
  });
}

test('another bot completing a binding cannot complete the request this page is waiting for', async ({ page }) => {
  const f = await channelFixture();
  try {
    const other = await connector(f.admin, { app_id: 'cli_other', installation_tenant: 'install-other', bot_open_id: 'ou_bot_other' });
    const name = 'two-bots-user', user = { ...await f.member(name, { repository_ids: ['101'] }), name };
    await login(page, f, user); const waiting = await issue(page, f.id);
    const separate = (await user.client('/api/channels/bindings/issue', 'POST', { connector_id: other })).value;
    await redeem(f, separate, 'ou_other_bot', other, 'cli_other');
    const read = await page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/requests/' + waiting.request_id));
    expect((await read.json()).state).toBe('pending'); await read.finished();
    await expect(app(page, f.id).locator('.channel-binding-console code')).toHaveText('绑定 ' + waiting.code);
    await expect(app(page, f.id).locator('.channel-binding-console')).toContainText('等待飞书中发送');
    expect((await user.client('/api/channels/bindings/requests/' + separate.request_id)).value.state).toBe('completed');
  } finally { await f.close(); }
});

test('the chosen bot has its own simple flow and a failed group-management read does not hide personal binding', async ({ page }) => {
  const f = await channelFixture();
  try {
    const other = await connector(f.admin, { app_id: 'cli_other', installation_tenant: 'install-other', bot_open_id: 'ou_bot_other' });
    const name = 'separate-entry-user', user = { ...await f.member(name, {}), name };
    await page.route('**/api/channels/service-bindings', route => route.fulfill({ status: 503, json: { error: 'fixture_groups_unavailable' } }));
    await page.setViewportSize({ width: 390, height: 844 }); await login(page, f, user);
    await expect(app(page, f.id)).toBeVisible(); await expect(app(page, other)).toBeHidden();
    await page.getByLabel('选择飞书机器人', { exact: true }).selectOption(other);
    await expect(app(page, f.id)).toBeHidden(); await expect(app(page, other)).toBeVisible();
    await issue(page, other, true);
    await expect(app(page, other).locator('code')).toBeVisible();
    await expect(page.getByLabel('飞书认证字符串', { exact: true })).toBeHidden();
    await page.getByRole('link', { name: '我维护的群助手', exact: true }).click();
    await expect(page.getByRole('heading', { name: '飞书设置读取失败', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '个人飞书绑定', exact: true }).click();
    await expect(page.getByRole('heading', { name: '飞书身份绑定', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await f.close(); }
});

test('expired and inaccessible requests clear the string; weak reads and late results never claim success', async ({ page }) => {
  test.setTimeout(60000);
  const f = await channelFixture(), urls = []; let release;
  page.on('request', request => urls.push(request.url()));
  try {
    const name = 'binding-recovery-user', user = { ...await f.member(name, { repository_ids: ['101'] }), name };
    await page.setViewportSize({ width: 390, height: 844 }); await login(page, f, user);
    const first = await issue(page, f.id);
    f.h.store.run('UPDATE channel_bind_requests SET expires_at=0 WHERE challenge_hash=?', first.request_id);
    const slot = () => app(page, f.id).locator('.channel-binding-console');
    await expect(slot()).toContainText('绑定串已过期', { timeout: 10000 }); await expect(slot().locator('code')).toHaveCount(0);
    const second = await issue(page, f.id, true); let mode = 'down', entered;
    const seen = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/channels/bindings/requests/' + second.request_id, async route => {
      if (mode === 'down') { await route.fulfill({ status: 503, json: { error: 'fixture_read_unavailable' } }); return; }
      entered(); await gate; await route.fulfill({ json: { request_id: second.request_id, state: 'completed', identity_id: 'stale-result' } });
    });
    await expect(slot()).toContainText('暂时无法读取服务端绑定状态', { timeout: 10000 });
    await expect(page.getByLabel('我的飞书账号', { exact: true })).toHaveCount(0);
    mode = 'hold'; await seen;
    const latest = await issue(page, f.id), returned = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/requests/' + second.request_id));
    release(); await (await returned).finished();
    await expect(slot().locator('code')).toHaveText('绑定 ' + latest.code);
    await page.route('**/api/channels/bindings/requests/' + latest.request_id, route => route.fulfill({ status: 403, json: { error: 'authorization_changed' } }));
    await expect(slot()).toContainText('无法继续读取这次绑定', { timeout: 10000 }); await expect(slot().locator('code')).toHaveCount(0);
    await expect(slot().getByRole('button', { name: '复制绑定串', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('我的飞书账号', { exact: true })).toHaveCount(0);
    expect(urls.some(url => /FSB-/.test(url))).toBe(false);
  } finally { release?.(); await f.close(); }
});
