import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { transport, connector, bindFixture, inGroup, post } from '../test/channel-fixture.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

for (const width of [1440, 390]) test(`maintainer binds a group to the repository assistant over chosen repositories, registers a notification destination, reads local history and disables it at ${width}px (protocol fixtures)`, async ({ page }) => {
  const wire = transport(), errors = [], h = await harness(undefined, undefined, store => ({
    engine: new TaskEngine(store, { call: async () => null }), channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }
  }));
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    const id = await connector(admin), principal = (await admin('/api/auth/me')).value.id;
    bindFixture(h, id, principal); const quiet = inGroup('', 'ou_alice'); quiet.event.message.mentions = []; quiet.event.message.content = JSON.stringify({ text: 'Original local group decision' }); await post(h, id, quiet);
    await page.setViewportSize({ width, height: 900 }); await page.goto(h.admin + '/#/identity');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '飞书群聊助手', exact: true })).toBeVisible();
    await expect(page.getByLabel('服务角色', { exact: true })).toHaveValue('repository-assistant');
    await expect(page.getByText(/群内所有成员都能看到助手读取的所选仓库内容/)).toBeVisible();
    await page.getByLabel('fixture/project-101', { exact: true }).check(); await page.getByLabel('fixture/project-102', { exact: true }).check();
    await page.getByRole('button', { name: '保存群聊助手', exact: true }).click();
    const binding = page.getByRole('article', { name: '群聊助手绑定' });
    await expect(binding.getByText('生效中 · 仓库问答助手', { exact: true })).toBeVisible();
    await expect(binding.getByText('项目范围：fixture/project-101、fixture/project-102', { exact: true })).toBeVisible();
    const row = h.store.get('SELECT * FROM channel_service_bindings');
    expect(row.service_role_id).toBe('repository-assistant');
    expect(h.store.all('SELECT project_id FROM scoped_grants WHERE principal_id=? ORDER BY project_id', row.principal_id).map(g => g.project_id)).toEqual(['101', '102']);
    expect(h.store.get('SELECT kind FROM principals WHERE id=?', row.principal_id).kind).toBe('service');
    await binding.getByRole('button', { name: '查询该群本地记录', exact: true }).click();
    await expect(page.getByText('Original local group decision', { exact: true })).toBeVisible();
    await page.getByLabel('查询关键词', { exact: true }).fill('absent-local-term');
    await page.getByRole('button', { name: '搜索本地记录', exact: true }).click();
    await expect(page.getByText('本地已同步范围没有匹配记录；这不代表飞书历史中从未存在。', { exact: true })).toBeVisible();
    // Notification destinations are registered here, for a project inside the group's scope (#312).
    await binding.getByLabel('通知项目', { exact: true }).selectOption('101');
    await binding.getByRole('button', { name: '登记为通知目的地', exact: true }).click();
    await expect(page.getByRole('article', { name: '群聊助手绑定' }).getByText(/^已登记：fixture\/project-101/)).toBeVisible();
    expect(h.store.get("SELECT count(*) n FROM channel_outbox WHERE state='registered'").n).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mkdirSync('.tmp/channel-service-bindings-312', { recursive: true }); await page.screenshot({ path: `.tmp/channel-service-bindings-312/binding-${width}.png`, fullPage: true });
    await page.getByRole('article', { name: '群聊助手绑定' }).getByRole('button', { name: '撤销此通知目的地', exact: true }).click();
    await expect.poll(() => h.store.get("SELECT count(*) n FROM channel_outbox WHERE state='registered'").n).toBe(0);
    await page.getByRole('article', { name: '群聊助手绑定' }).getByRole('button', { name: '停用群聊助手', exact: true }).click();
    await expect(page.getByRole('article', { name: '群聊助手绑定' }).getByText('已停用 · 仓库问答助手', { exact: true })).toBeVisible();
    expect(h.store.get('SELECT active FROM principals WHERE id=?', row.principal_id).active).toBe(0); expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
