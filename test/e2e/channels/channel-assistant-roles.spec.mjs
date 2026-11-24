import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { transport, connector, bindFixture, inGroup, post } from '../../fixtures/channel-fixture.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';

// #849 / #1249: a project administrator configures a group binding's model and prompt directly on the group
// binding editor (#/identity/feishu/groups/new), choosing project-owned models for single-repo groups and shared models
// for multi-repo groups, without hopping to a separate service-role page.
for (const width of [1440, 390]) test(`a project administrator configures a group binding's model and prompt inline at ${width}px (protocol fixtures)`, async ({ page }) => {
  const wire = transport(), errors = [], h = await harness(undefined, undefined, store => ({
    engine: new TaskEngine(store, { call: async () => null }), channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }
  }));
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    const id = await connector(admin);
    const projectModel = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Project 101 model', api_url: 'http://127.0.0.1:9/v1', api_key: 'fixture-provider-key' })).value.model;
    const sharedModel = (await admin('/api/models', 'POST', { model_name: 'Shared team model', api_url: 'http://127.0.0.1:9/v1', api_key: 'fixture-provider-key' })).value.model;
    // A project administrator of both repositories, bound to Feishu and in two groups; no super administrator from here on.
    const password = testPassword(), owner = (await admin('/api/users', 'POST', { username: 'project-owner', password, repository_ids: ['101', '102'] })).value.user;
    bindFixture(h, id, owner.id, 'ou_owner'); wire.state.members.push({ member_id_type: 'open_id', member_id: 'ou_owner', tenant_key: 'actor-tenant' });
    const quiet = inGroup('', 'ou_owner'); quiet.event.message.mentions = []; quiet.event.message.content = JSON.stringify({ text: 'Group discussion' }); await post(h, id, quiet);
    const quiet2 = inGroup('', 'ou_owner'); quiet2.event.message.chat_id = 'oc_group_2'; quiet2.event.message.mentions = []; quiet2.event.message.content = JSON.stringify({ text: 'Second group' }); await post(h, id, quiet2);
    await page.setViewportSize({ width, height: 900 }); await page.goto(h.admin + '/#/identity/feishu');
    await page.getByLabel('用户名', { exact: true }).fill('project-owner'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // Separate project assistant role links are gone; everything lives in the group binding editor.
    await expect(page.locator('#feishu-group-bindings').getByRole('link', { name: 'fixture/project-101', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: '创建群绑定', exact: true }).click();
    await expect(page).toHaveURL(/#\/identity\/feishu\/groups\/new$/);
    await page.getByRole('checkbox', { name: 'fixture/project-101', exact: true }).check();
    // Single-repo scope offers project 101's own model and shared models.
    const modelSelect = page.getByLabel('助手模型', { exact: true });
    await modelSelect.selectOption(projectModel.id);
    await page.getByLabel('提示词与职责说明', { exact: true }).fill('先给结论，再列出处。');
    // A group assistant runs only on Pi (#1337): the editor offers no backend. This deployment has no assistant computers,
    // so the editor says why its turns would fail (#1254).
    await expect(page.getByLabel('Agent 后端', { exact: true })).toHaveCount(0);
    await expect(page.getByText('高级设置：Agent 后端', { exact: true })).toHaveCount(0);
    await expect(page.locator('#feishu-group-editor').getByRole('status').filter({ hasText: '助手电脑现在不可用' })).toContainText('控制面没有挂载 assistant-homes 卷');
    // Widening scope to include 102 keeps the stale choice visible with a warning and refuses save naming 102.
    await page.getByRole('checkbox', { name: 'fixture/project-102', exact: true }).check();
    await expect(page.locator('#feishu-group-editor .feishu-model-warning')).toContainText('fixture/project-102');
    const save = page.getByRole('button', { name: '保存群聊助手', exact: true }), alert = page.locator('form').filter({ has: save }).getByRole('alert');
    await save.click();
    await expect(alert).toHaveText('所选模型没有授权给 fixture/project-102。群助手只能用对范围内每个项目都可用的模型：请换一个模型，或请超级管理员把共享模型授权给这些项目。');
    // Unchecking 102 clears the warning and saves cleanly with project 101's own model.
    await page.getByRole('checkbox', { name: 'fixture/project-102', exact: true }).uncheck();
    await expect(page.locator('#feishu-group-editor .feishu-model-warning')).toBeHidden();
    await save.click();
    const binding = page.getByRole('article', { name: '群聊助手绑定' });
    await expect(binding.getByText('生效中', { exact: true })).toBeVisible();
    // The binding names the model's provider too (#1332): a model created alone is named after its host.
    await expect(binding.getByText('Project 101 model · 127.0.0.1:9', { exact: true })).toBeVisible();
    await expect(binding).toContainText('先给结论，再列出处。');
    expect(h.store.get('SELECT scope,model_id,prompt,harness FROM channel_service_bindings')).toEqual({ scope: 'repositories', model_id: projectModel.id, prompt: '先给结论，再列出处。', harness: 'pi' });
    // There is no backend badge.
    await expect(binding.locator('.feishu-binding-badge-info')).toHaveCount(0);
    // Now bind the second group across both 101 and 102 with a shared model, copying prompt from the first group.
    await page.getByRole('link', { name: '创建群绑定', exact: true }).click();
    await page.getByRole('checkbox', { name: 'fixture/project-101', exact: true }).check();
    await page.getByRole('checkbox', { name: 'fixture/project-102', exact: true }).check();
    await page.getByRole('button', { name: '复制模型与提示词', exact: true }).click();
    await expect(page.getByLabel('提示词与职责说明', { exact: true })).toHaveValue('先给结论，再列出处。');
    await page.getByLabel('助手模型', { exact: true }).selectOption(sharedModel.id);
    await expect(page.locator('#feishu-group-editor').getByRole('status').filter({ hasText: '助手电脑现在不可用' })).toContainText('助手的每一轮都在助手电脑上用 Pi 运行');
    await save.click();
    await expect(page.getByRole('article', { name: '群聊助手绑定' })).toHaveCount(2);
    await expect(page.getByRole('article', { name: '群聊助手绑定' }).last()).toContainText('Shared team model');
    expect(h.store.all('SELECT harness FROM channel_service_bindings').map(row => row.harness)).toEqual(['pi', 'pi']);
    // Project Settings -> Roles no longer displays a separate 群助手角色 view.
    await page.goto(h.admin + '/#/projects/101/roles');
    await expect(page.locator('[data-testid="role-assistant-roles-link"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
