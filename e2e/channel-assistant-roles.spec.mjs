import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { transport, connector, bindFixture, inGroup, post } from '../test/channel-fixture.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #849: a project administrator keeps a group assistant role for their project with the project's own model, without a super
// administrator, and binds it only to a group scoped to that project.
for (const width of [1440, 390]) test(`a project administrator creates a project assistant role with the project's model and binds it to a single-project group at ${width}px (protocol fixtures)`, async ({ page }) => {
  const wire = transport(), errors = [], h = await harness(undefined, undefined, store => ({
    engine: new TaskEngine(store, { call: async () => null }), channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }
  }));
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    const id = await connector(admin);
    await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Project 101 model', api_url: 'http://127.0.0.1:9/v1', api_key: 'fixture-provider-key' });
    // A project administrator of both repositories, bound to Feishu and in the group; no super administrator from here on.
    const password = testPassword(), owner = (await admin('/api/users', 'POST', { username: 'project-owner', password, repository_ids: ['101', '102'] })).value.user;
    bindFixture(h, id, owner.id, 'ou_owner'); wire.state.members.push({ member_id_type: 'open_id', member_id: 'ou_owner', tenant_key: 'actor-tenant' });
    const quiet = inGroup('', 'ou_owner'); quiet.event.message.mentions = []; quiet.event.message.content = JSON.stringify({ text: 'Group discussion' }); await post(h, id, quiet);
    await page.setViewportSize({ width, height: 900 }); await page.goto(h.admin + '/#/identity/feishu');
    await page.getByLabel('用户名', { exact: true }).fill('project-owner'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const roles = page.getByRole('region', { name: '项目群助手角色', exact: true });
    await expect(roles).toContainText('你的项目还没有自己的群助手角色。');
    await roles.getByLabel('所属项目', { exact: true }).selectOption('101');
    await roles.getByLabel('名称', { exact: true }).fill('101 群助手');
    await roles.getByRole('button', { name: '新建项目角色', exact: true }).click();
    const card = roles.locator('section').filter({ has: page.getByRole('heading', { name: '101 群助手', exact: true }) }).last();
    await expect(card).toContainText('项目角色'); await expect(card).toContainText('fixture/project-101');
    // The project's own model is offered; the role is saved with it.
    await card.locator('select[name=model_id]').selectOption({ label: 'Project 101 model · 127.0.0.1:9（项目专属）' });
    await card.locator('textarea[name=prompt]').fill('先给结论，再列出处。');
    await card.getByRole('button', { name: '保存', exact: true }).click();
    await expect(card).toContainText('已保存'); await expect(card).toContainText('Project 101 model');
    expect(h.store.get("SELECT project_id,prompt FROM service_roles WHERE name='101 群助手'")).toEqual({ project_id: '101', prompt: '先给结论，再列出处。' });
    // A group that also covers 102 is refused, naming 102; scoped to 101 it is saved.
    await page.getByRole('button', { name: '创建群绑定', exact: true }).click();
    await page.getByLabel('fixture/project-101', { exact: true }).check(); await page.getByLabel('fixture/project-102', { exact: true }).check();
    await page.getByLabel('助手角色', { exact: true }).selectOption({ label: '101 群助手（fixture/project-101 专属）' });
    await expect(page.locator('#feishu-group-editor')).toContainText('只能用于范围只有 fixture/project-101 的群');
    const save = page.getByRole('button', { name: '保存群聊助手', exact: true }), alert = page.locator('form').filter({ has: save }).getByRole('alert');
    await save.click();
    await expect(alert).toHaveText('「fixture/project-101」的专属助手角色只能用于范围只有这个项目的群；fixture/project-102 不属于它。请改选全局角色，或把范围缩小到这个项目。');
    mkdirSync('.tmp/channel-assistant-roles', { recursive: true }); await page.screenshot({ path: `.tmp/channel-assistant-roles/refused-${width}.png`, fullPage: true });
    await page.getByLabel('fixture/project-102', { exact: true }).uncheck(); await save.click();
    const binding = page.getByRole('article', { name: '群聊助手绑定' });
    await expect(binding.getByText('生效中 · 101 群助手', { exact: true })).toBeVisible();
    expect(h.store.get('SELECT b.scope,r.project_id FROM channel_service_bindings b JOIN service_roles r ON r.id=b.service_role_id')).toEqual({ scope: 'repositories', project_id: '101' });
    await page.screenshot({ path: `.tmp/channel-assistant-roles/bound-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
