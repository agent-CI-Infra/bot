import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { transport, connector, bindFixture, inGroup, post } from '../test/channel-fixture.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

for (const width of [1440, 390]) test(`maintainer saves narrow group authorization, reads local history and disables it at ${width}px (protocol fixtures)`, async ({ page }) => {
  const wire = transport(), errors = [], h = await harness(undefined, undefined, store => ({
    engine: new TaskEngine(store, { call: async () => null }), channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }
  }));
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const id = await connector(admin), principal = (await admin('/api/auth/me')).value.id;
    bindFixture(h, id, principal); await post(h, id, inGroup('Original local group decision', 'ou_alice'));
    const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: false,
      roles: [{ role_id: 'reviewer', permissions: { task_management: 'write', delegation: 'deny' } }] });
    expect(saved.status).toBe(200);
    await page.setViewportSize({ width, height: 900 }); await page.goto(h.admin + '/#/identity');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我维护的群员工', exact: true })).toBeVisible();
    await page.getByLabel('员工授权项目', { exact: true }).selectOption('101');
    await page.getByLabel('员工使用角色', { exact: true }).selectOption('reviewer');
    await page.getByRole('button', { name: '保存群员工授权', exact: true }).click();
    await expect(page.getByText('授权有效 · 项目 101 · reviewer', { exact: true })).toBeVisible();
    const grant = h.store.get('SELECT * FROM channel_employee_grants');
    expect(JSON.parse(grant.capabilities)).toEqual(['tasks.read', 'tasks.manage_own', 'knowledge.read']);
    expect(h.store.get('SELECT kind FROM principals WHERE id=?', grant.principal_id).kind).toBe('service');
    await page.getByRole('button', { name: '查询该群本地记录', exact: true }).click();
    await expect(page.getByText('Original local group decision', { exact: true })).toBeVisible();
    await page.getByLabel('查询关键词', { exact: true }).fill('absent-local-term');
    await page.getByRole('button', { name: '搜索本地记录', exact: true }).click();
    await expect(page.getByText('本地已同步范围没有匹配记录；这不代表飞书历史中从未存在。', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mkdirSync('.tmp/channel-employees-245', { recursive: true }); await page.screenshot({ path: `.tmp/channel-employees-245/maintainer-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: '停用此群员工授权', exact: true }).click();
    await expect(page.getByText('已停用 · 项目 101 · reviewer', { exact: true })).toBeVisible();
    expect(h.store.get('SELECT active FROM principals WHERE id=?', grant.principal_id).active).toBe(0); expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
