import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { channelFixture, envelope, post, finished, until, directQuery, inGroup } from '../test/channel-fixture.mjs';

test('Feishu user scenarios show the same management operation in Web and refuse unproved binding and private group data', async ({ page }) => {
  test.setTimeout(90000);
  const f = await channelFixture(), { h, admin, password, wire, id } = f, errors = [];
  page.on('pageerror', e => errors.push(e.message)); mkdirSync('.tmp/channels-165', { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto(h.admin + '/#/channels');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '飞书身份绑定' })).toBeVisible();
    await expect(page).toHaveURL(/#\/identity\/feishu$/);
    await expect(page.getByRole('button', { name: '消息渠道', exact: true })).toHaveCount(0);
    await page.goto(h.admin + '/#/settings/feishu/' + id + '/2');
    await expect(page.getByLabel('HTTP 回调地址', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.tmp/channels-165/configuration-desktop.png', fullPage: true });
    const query = await post(h, id, envelope(directQuery())); const queried = await finished(h, query.value.operation_id);
    const changed = await post(h, id, envelope('/project 101 修改提示词')); const result = await finished(h, changed.value.operation_id);
    const operation = h.store.get("SELECT * FROM management_commands WHERE channel='im'"); expect(operation.state).toBe('succeeded');
    await until(() => wire.sent.some(s => JSON.stringify(s.content).includes(operation.id)));
    await page.getByRole('button', { name: '管理对话', exact: true }).click();
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    await page.getByText('会话记录', { exact: true }).click();
    await page.getByLabel('持久会话').selectOption(result.conversation_id);
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await expect(feed).toContainText(operation.id); await expect(feed).toContainText('操作 workflow.update · succeeded');
    await page.getByRole('button', { name: '快捷操作', exact: true }).click();
    await expect(page.getByLabel('默认提示词', { exact: true })).toHaveValue('Inspect evidence and cite the original logs.');
    await page.screenshot({ path: '.tmp/channels-165/shared-operation-desktop.png', fullPage: true });
    const grantsBefore = h.store.get('SELECT count(*) n FROM scoped_grants').n;
    const unproved = await post(h, id, envelope('确认绑定 forwarded-or-unverified-token'));
    const unprovedResult = await finished(h, unproved.value.operation_id);
    expect(unprovedResult.error).toBe('binding_confirmation_invalid'); expect(h.store.get('SELECT count(*) n FROM scoped_grants').n).toBe(grantsBefore);
    h.store.run("UPDATE installed_repositories SET private=1 WHERE repository_id='101'");
    const group = await post(h, id, inGroup(directQuery())); const refused = await finished(h, group.value.operation_id);
    expect(refused.error).toBe('channel_group_scope_required');
    await until(() => wire.sent.some(s => s.receive_id === 'oc_group'));
    const groupReplies = wire.sent.filter(s => s.receive_id === 'oc_group');
    expect(JSON.stringify(groupReplies)).not.toMatch(/Project computer is stopped|environment_not_ready|Inspect task facts/);
    await page.goto(h.admin + '/#/settings/feishu/' + id + '/4');
    await expect(page.getByText('channel_group_scope_required', { exact: false })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/channels-165/diagnostics-mobile.png', fullPage: true });
    const web = (await admin('/api/management/commands/' + operation.id)).value;
    writeFileSync('.tmp/channels-165/evidence.json', JSON.stringify({ transport: 'signed local HTTP callbacks and protocol fixtures; no live Feishu credentials',
      query: { channel_operation: query.value.operation_id, state: queried.state, conversation_id: queried.conversation_id },
      prompt: { channel_operation: changed.value.operation_id, conversation_id: result.conversation_id, operation_id: operation.id, state: web.state, channel: web.channel,
        before_revision: web.before_revision, after_revision: web.after_revision, result: web.result },
      binding_failure: { state: unprovedResult.state, error: unprovedResult.error, grants_before: grantsBefore, grants_after: h.store.get('SELECT count(*) n FROM scoped_grants').n },
      group_rejection: { operation_id: group.value.operation_id, state: refused.state, error: refused.error, leaked_private_facts: false }, page_errors: errors }, null, 2));
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(h.directory, { recursive: true, force: true }); }
});
