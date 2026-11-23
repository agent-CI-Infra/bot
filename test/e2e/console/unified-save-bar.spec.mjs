import { test, expect } from '@playwright/test';
import { promptEditor, promptReading } from '../helpers/prompt-editor.mjs';
import { randomBytes } from 'node:crypto';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { managerFixture } from '../../fixtures/project-manager-fixture.mjs';
import { RuleService } from '../../../dist/rules/service.js';
import { consoleSave, consoleSaveStatus, confirmDiscard } from '../helpers/console-save.mjs';


// 390 CSS px: the dirty bar keeps its「保存」on screen without horizontal overflow; then back to the desktop width.
async function capture390(page, name) {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(consoleSave(page)).toBeVisible();
  await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function login(page, url, password) {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('角色、基本设置和模型共用一条「保存」栏，放弃可恢复，保存写入服务器', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Default', api_url: 'https://model.invalid/v1', api_key: testPassword() })).value.model;
    const other = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Other', api_url: 'https://model.invalid/v1', api_key: testPassword() })).value.model;
    await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });

    await page.setViewportSize({ width: 1440, height: 900 });
    // A saved configuration of the project's own, so the bar starts from 已保存.
    expect((await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0 })).status).toBe(200);
    await login(page, h.admin + '/#/projects/101/roles', password);
    await page.goto(h.admin + '/#/projects/101/roles/dev');
    await expect(page.getByTestId('role-form')).toBeVisible();
    await expect(consoleSaveStatus(page)).toHaveText('已保存');
    await expect(consoleSave(page)).toBeHidden();
    await expect(page.getByRole('button', { name: '读取最新版本并比较', exact: true })).toBeVisible();
    await expect(page.getByTestId('console-save-advanced')).toHaveCount(0);
    const prompt = await promptEditor(page, '角色提示词');
    const previous = await prompt.inputValue();
    await prompt.fill('统一保存栏提示词');
    await expect(consoleSaveStatus(page)).toContainText('有未保存的更改');
    await expect(consoleSave(page)).toBeVisible();
    await expect(consoleSave(page)).toBeInViewport();
    await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(1);
    await capture390(page, 'role');
    await confirmDiscard(page);
    await expect(prompt).toHaveValue(previous);
    await expect(consoleSave(page)).toBeHidden();
    await prompt.fill('统一保存栏已写入');
    await consoleSave(page).click();
    await expect(page.locator('.flash')).toContainText('角色配置已保存');
    const saved = (await admin('/api/repositories/101/roles')).value.configuration.roles.find(r => r.role_id === 'dev');
    expect(saved.persona_prompt).toBe('统一保存栏已写入');

    await page.goto(h.admin + '/#/projects/101/basic');
    await expect(consoleSaveStatus(page)).toHaveText('已保存');
    await expect(page.getByTestId('console-save-advanced')).toHaveCount(0);
    const groupDiscards = page.getByTestId('console-save-group-discard');
    await expect(groupDiscards).toHaveCount(2);
    await expect(groupDiscards.first()).toBeVisible();
    await expect(groupDiscards.nth(1)).toBeVisible();
    const statusBox = await consoleSaveStatus(page).boundingBox();
    const discardBox = await groupDiscards.first().boundingBox();
    expect(Math.abs(statusBox.y + statusBox.height / 2 - discardBox.y - discardBox.height / 2)).toBeLessThanOrEqual(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(groupDiscards.first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByLabel('基准分支', { exact: true }).fill('feature/unified-save');
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改');
    await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(1);
    await capture390(page, 'basic');
    await consoleSave(page).click();
    await expect(page.locator('#project-page .flash')).toHaveText('已保存');
    expect((await admin('/api/repositories/101')).value.policy.base_branch).toBe('feature/unified-save');

    await page.goto(h.admin + '/#/projects/101/model');
    const defaultCard = page.locator('[data-overview-anchor="project-default-model"]');
    await defaultCard.getByRole('combobox', { name: '默认模型', exact: true }).selectOption(other.id);
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改');
    await capture390(page, 'model');
    await consoleSave(page).click();
    await expect(page.locator('#project-page .flash')).toHaveText('已保存模型设置');
    expect((await admin('/api/repositories/101')).value.policy.model_id).toBe(other.id);
  } finally { await h.stop(); }
});

test('机器配置把「重新读取」直接放进保存栏，有草稿时先确认，保存仍重建电脑', async ({ page }) => {
  test.setTimeout(90000);
  const cleanup = [], manager = await managerFixture({ after: action => cleanup.push(action) });
  const h = await harness(undefined, manager.manager);
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await h.projects.reconcile();
    const saved = await admin('/api/environments/101/configure', 'POST', {
      operation_id: randomBytes(24).toString('hex'), generation: 1, spec: { cpus: 3 }
    });
    expect(saved.status).toBe(201);
    new RuleService(h.store).cache('101', 'a'.repeat(40), { '.bot/computer.yaml': '' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/projects/101/machine', password);
    await expect(page.locator('.machine-config-card')).toBeVisible();
    await expect(consoleSave(page)).toBeHidden();
    const reread = page.getByRole('button', { name: '重新读取电脑配置', exact: true });
    await expect(reread).toBeVisible();
    await expect(page.getByTestId('console-save-advanced')).toHaveCount(0);
    const cpu = page.getByLabel('CPU（核）', { exact: true });
    await cpu.fill('2');
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改');
    await expect(consoleSave(page)).toBeVisible();
    await reread.click();
    const confirmation = page.getByRole('dialog');
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await expect(cpu).toHaveValue('2');
    await reread.click();
    await confirmation.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(cpu).toHaveValue('3');
    await expect(consoleSave(page)).toBeHidden();
    await cpu.fill('2');
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改');
    await expect(consoleSave(page)).toBeVisible();
    await capture390(page, 'machine');
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
  } finally {
    await h.stop();
    for (const action of cleanup) await action();
  }
});

async function loginAs(page, url, username, password) {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
test('Manager 角色页通过统一保存栏按角色设置模型，不再展示独立的任务类型模型选择器', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Default', api_url: 'https://model.invalid/v1', api_key: testPassword() })).value.model;
    const other = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Dispatch', api_url: 'https://model.invalid/v1', api_key: testPassword() })).value.model;
    await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });

    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, h.admin + '/#/projects/101/roles/manager', 'administrator', password);
    await expect(promptReading(page, 'Manager 提示词')).toBeVisible();
    await expect(page.locator('.task-model-editor')).toHaveCount(0);
    await page.getByLabel('manager 模型', { exact: true }).selectOption(other.id);
    await consoleSave(page).click();
    await expect.poll(async () => (await admin('/api/repositories/101/roles')).value.configuration.roles.find(r => r.role_id === 'manager')?.model_profile_ref?.model_id).toBe(other.id);

    await page.getByLabel('manager 模型', { exact: true }).selectOption('');
    await consoleSave(page).click();
    await expect.poll(async () => (await admin('/api/repositories/101/roles')).value.configuration.roles.find(r => r.role_id === 'manager')?.model_profile_ref).toBeNull();
  } finally { await h.stop(); }
});

test('项目管理员在机器配置里通过保存栏修改「同时运行的任务」，电脑规格保持只读', async ({ page }) => {
  test.setTimeout(90000);
  const cleanup = [], manager = await managerFixture({ after: action => cleanup.push(action) });
  const h = await harness(undefined, manager.manager);
  try {
    const { admin } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await h.projects.reconcile();
    const memberPassword = testPassword();
    expect((await admin('/api/users', 'POST', { username: 'machine-member', password: memberPassword, role: 'project_admin', repository_ids: ['101'] })).status).toBe(201);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, h.admin + '/#/projects/101/machine', 'machine-member', memberPassword);
    await expect(page.locator('.machine-config-card')).toBeVisible();
    await expect(page.getByLabel('CPU（核）', { exact: true })).toBeDisabled();
    await expect(consoleSaveStatus(page)).toHaveText('已保存');
    await page.getByLabel('这台虚拟电脑同时运行的任务数', { exact: true }).fill('3');
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改');
    await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(1);
    await consoleSave(page).click();
    await expect.poll(async () => (await admin('/api/repositories/101')).value.policy.task_concurrency).toBe(3);
  } finally {
    await h.stop();
    for (const action of cleanup) await action();
  }
});

test('读不到电脑记录时，「同时运行的任务」仍有保存栏可以保存', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, h.admin + '/#/projects/101/machine', 'administrator', password);
    await expect(page.getByText('暂时读不到虚拟电脑规格', { exact: false })).toBeVisible();
    await page.getByLabel('这台虚拟电脑同时运行的任务数', { exact: true }).fill('2');
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改');
    await consoleSave(page).click();
    await expect.poll(async () => (await admin('/api/repositories/101')).value.policy.task_concurrency).toBe(2);
  } finally { await h.stop(); }
});

test('基本设置放弃分支草稿时保留 监听与触发页的策略草稿', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, h.admin + '/#/projects/101/basic', 'administrator', password);
    const branch = page.getByLabel('基准分支', { exact: true });
    await expect(branch).toBeVisible();
    const initialBranch = await branch.inputValue();
    await branch.fill('feature/group-discard');
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改');
    // The bar spans the two-column basic-settings layout instead of taking one cell.
    const widths = await page.evaluate(() => [document.querySelector('.console-save-bar').getBoundingClientRect().width, document.querySelector('.project-settings-layout').getBoundingClientRect().width]);
    expect(widths[0]).toBeGreaterThan(widths[1] * 0.9);
    await page.getByRole('link', { name: /监听与触发设置/ }).click();
    // A choice of the capability ceiling (#850) is a draft of its own: the test repository starts at read.
    const develop = page.getByLabel('可开发并开 PR', { exact: true });
    await expect(page.getByLabel('只读问答', { exact: true })).toBeChecked(); await develop.check();
    await page.locator('.project-nav a[href="#/projects/101/basic"]').click();
    await expect(branch).toHaveValue('feature/group-discard');
    await page.getByRole('button', { name: '放弃「分支」的更改', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '放弃本组更改', exact: true }).click();
    await expect(branch).toHaveValue(initialBranch);
    await page.getByRole('link', { name: /监听与触发设置/ }).click();
    await expect(develop).toBeChecked();
    await page.getByRole('button', { name: '保存能力上限', exact: true }).click();
    await expect.poll(async () => (await admin('/api/repositories/101')).value.policy.capability_ceiling).toBe('develop');
    expect((await admin('/api/repositories/101')).value.policy.base_branch || '').toBe(initialBranch);
  } finally { await h.stop(); }
});
