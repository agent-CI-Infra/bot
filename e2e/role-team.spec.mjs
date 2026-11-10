import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #229 slice 1: the AI-team list carries the role facts and distinguishes saved configuration from the shared draft.
test('AI 团队列表如实区分推荐配置、各类未保存草稿与已生效版本', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Coding model', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() })).value.model;
    let config = (await admin('/api/repositories/101/roles')).value;
    const initialized = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: config.configuration.revision, enabled: config.configuration.enabled, roles: [],
      skills: [{ id: 'review-kit', source: { type: 'inline', files: [{ path: 'guide.md', content: 'Check the current state.' }] } }] });
    expect(initialized.status).toBe(200);
    config = (await admin('/api/repositories/101/roles')).value;
    const dev = config.configuration.roles.find(role => role.role_id === 'dev');
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const table = page.locator('.project-table[aria-label="角色解析结果"]'), status = page.locator('[data-role-version]');
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible();
    await expect(status).toHaveText(`配置版本 ${config.revision} · 已生效`);
    const dirty = () => expect(status).toHaveText(`配置版本 ${config.revision} · 草稿未保存`);
    const discard = async () => {
      await page.getByRole('button', { name: '放弃草稿并刷新', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '放弃并刷新', exact: true }).click();
      await expect(status).toHaveText(`配置版本 ${config.revision} · 已生效`);
    };

    await page.getByLabel('dev 模型', { exact: true }).selectOption(model.id); await dirty(); await discard();
    await page.getByLabel('dev 技能包', { exact: true }).selectOption('review-kit'); await dirty(); await discard();
    const row = table.locator('tr[data-role=dev]');
    await row.locator('details').locator('summary').click();
    await page.getByLabel('dev 工作区文件权限', { exact: true }).selectOption(dev.permissions.repository === 'read' ? 'write' : 'read'); await dirty(); await discard();
    await page.getByLabel('开启角色协调', { exact: true }).setChecked(!config.configuration.enabled); await dirty();

    await expect(table.getByRole('columnheader', { name: '职责', exact: true })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: '预算', exact: true })).toBeVisible();
    await expect(row).toContainText(dev.responsibility); await expect(row).toContainText(dev.budget_policy_ref.id);
    await expect(table.locator('tr[data-role]')).toHaveCount(config.configuration.roles.length);
    await page.getByRole('button', { name: '保存角色配置', exact: true }).click();
    await expect(page.locator('.flash')).toHaveText('角色配置已保存，新任务使用新配置');
    config = (await admin('/api/repositories/101/roles')).value;
    await expect(status).toHaveText(`配置版本 ${config.revision} · 已生效`);

    await repository(admin, a.id, '102'); await page.goto(h.admin + '/#/projects/102/roles');
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible();
    await expect(page.locator('[data-role-version]')).toHaveText('推荐配置 · 尚未保存');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
