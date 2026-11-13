import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { managerFixture } from '../test/project-manager-fixture.mjs';
import { RuleService } from '../dist/rules/service.js';
import { consoleSave, consoleSaveStatus, confirmDiscard, openSaveAdvanced } from './console-save.mjs';

const out = '.tmp/unified-save-bar';

async function login(page, url, password) {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('角色、基本设置和模型共用一条「保存」栏，放弃可恢复，保存写入服务器', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Default', api_url: 'https://model.invalid/v1', api_key: testPassword() })).value.model;
    const other = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Other', api_url: 'https://model.invalid/v1', api_key: testPassword() })).value.model;
    await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });

    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/projects/101/roles', password);
    await page.getByTestId('adopt-recommended-roles').click();
    await expect(page.locator('.flash')).toContainText('已使用推荐配置');
    await page.goto(h.admin + '/#/projects/101/roles/dev');
    await expect(page.getByTestId('role-form')).toBeVisible();
    await expect(consoleSaveStatus(page)).toHaveText('已保存');
    await expect(consoleSave(page)).toBeHidden();
    const prompt = page.getByLabel('角色提示词', { exact: true });
    const previous = await prompt.inputValue();
    await prompt.fill('统一保存栏提示词');
    await expect(consoleSaveStatus(page)).toContainText('有未保存的更改');
    await expect(consoleSave(page)).toBeVisible();
    await expect(consoleSave(page)).toBeInViewport();
    await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(1);
    await page.screenshot({ path: `${out}/role-1440.png`, fullPage: true });
    await confirmDiscard(page);
    await expect(prompt).toHaveValue(previous);
    await expect(consoleSave(page)).toBeHidden();
    await prompt.fill('统一保存栏已写入');
    await consoleSave(page).click();
    await expect(page.locator('.flash')).toContainText('角色配置已保存');
    const saved = (await admin('/api/repositories/101/roles')).value.configuration.roles.find(r => r.role_id === 'dev');
    expect(saved.persona_prompt).toBe('统一保存栏已写入');

    await page.goto(h.admin + '/#/projects/101/basic');
    await page.getByLabel('基准分支', { exact: true }).fill('feature/unified-save');
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改');
    await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(1);
    await page.screenshot({ path: `${out}/basic-1440.png`, fullPage: true });
    await consoleSave(page).click();
    await expect(page.locator('#project-page .flash')).toHaveText('已保存');
    expect((await admin('/api/repositories/101')).value.policy.base_branch).toBe('feature/unified-save');

    await page.goto(h.admin + '/#/projects/101/model');
    const defaultCard = page.locator('[data-overview-anchor="project-default-model"]');
    await defaultCard.getByRole('combobox', { name: '默认模型', exact: true }).selectOption(other.id);
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改');
    await page.screenshot({ path: `${out}/model-1440.png`, fullPage: true });
    await consoleSave(page).click();
    await expect(page.locator('#project-page .flash')).toHaveText('已保存模型设置');
    expect((await admin('/api/repositories/101')).value.policy.model_id).toBe(other.id);
  } finally { await h.stop(); }
});

test('机器配置把「重新读取」放进保存栏的高级区，保存仍重建电脑', async ({ page }) => {
  test.setTimeout(90000);
  const cleanup = [], manager = await managerFixture({ after: action => cleanup.push(action) });
  const h = await harness(undefined, manager.manager);
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await h.projects.reconcile();
    const saved = await admin('/api/environments/101/configure', 'POST', {
      operation_id: randomBytes(24).toString('hex'), generation: 1, spec: { cpus: 3 }
    });
    expect(saved.status).toBe(201);
    new RuleService(h.store).cache('101', 'a'.repeat(40), { '.bot/computer.yaml': 'memory_mb: 8192\n' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/projects/101/machine', password);
    await expect(page.locator('.machine-config-card')).toBeVisible();
    await expect(consoleSave(page)).toBeHidden();
    await expect(page.getByRole('button', { name: '重新读取电脑配置', exact: true })).toBeHidden();
    await openSaveAdvanced(page);
    await expect(page.getByRole('button', { name: '重新读取电脑配置', exact: true })).toBeVisible();
    await page.getByLabel('CPU（核）', { exact: true }).fill('2');
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改');
    await expect(consoleSave(page)).toBeVisible();
    await page.screenshot({ path: `${out}/machine-1440.png`, fullPage: true });
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
  } finally {
    await h.stop();
    for (const action of cleanup) await action();
  }
});
