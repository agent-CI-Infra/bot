import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { RuleService } from '../dist/rules/service.js';

test('工作流表按需编辑规则，模型独立管理且项目不能修改共享模型', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync('.tmp/task-overview', { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
    new RuleService(h.store).cache('101', 'a'.repeat(40), { '.bot/guide.md': 'Repository behavior guide', '.agents/skills/demo/SKILL.md': 'Demo skill' });
    const create = async (name, repository_id = '101') => (await admin('/api/models', 'POST', { repository_id, model_name: name, api_url: 'https://model.invalid/v1', api_key: testPassword() })).value.model;
    const defaultModel = await create('Project default'), review = await create('Review model'), obsolete = await create('Deleted model'), shared = await create('Shared model', null);
    await admin(`/api/models/${shared.id}/projects`, 'PUT', { repository_ids: ['101', '202'] });
    await admin('/api/onboarding/model', 'POST', { model_id: shared.id });
    await admin('/api/repositories/202/policy', 'PATCH', { model_id: shared.id });
    const sharedBefore = (await admin(`/api/models/${shared.id}`)).value;
    await admin('/api/repositories/101/policy', 'PATCH', { model_id: defaultModel.id, task_models: { 'custom.science': obsolete.id } });
    await admin(`/api/models/${obsolete.id}`, 'DELETE', {});
    const policy = async () => (await admin('/api/repositories/101')).value.policy;
    const row = kind => page.locator(`[data-task-kind="${kind}"]`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/projects/101/tasks');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // The old task overview address opens the workflows page.
    await expect(page).toHaveURL(/#\/projects\/101\/workflows$/);
    await expect(page.getByRole('link', { name: '工作流', exact: true })).toHaveAttribute('aria-current', 'page');
    for (const caption of ['使用的模型', '检视', '开发', '规则总览', '任务总览']) await expect(page.getByRole('link', { name: caption, exact: true })).toHaveCount(0);
    const list = page.getByRole('complementary', { name: '工作流列表', exact: true }), item = id => list.locator(`[data-workflow-item="${id}"]`);
    await expect(list.locator('.workflow-list:not(.shared) a')).toHaveCount(8);
    for (const [kind, title] of [['review.issue', '检视 Issue'], ['review.pr', '检视 PR'], ['development.issue', '开发 Issue'], ['development.pr', '跟进 bot PR'], ['release.observe', 'CI 观察'], ['release.notes', '发行说明'], ['actions.failures', 'Actions 失败处理']]) {
      await expect(item(kind)).toContainText(title);
    }
    await expect(item('rules.guide').locator('[data-rule-source]')).toHaveText('仓库文件');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.screenshot({ path: '.tmp/task-overview/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/task-overview/mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // The workflow switch, the development test command and a console prompt are saved from the editor.
    const detail = title => page.getByRole('region', { name: '工作流：' + title, exact: true });
    const save = async title => { await detail(title).getByRole('button', { name: '保存', exact: true }).click(); await expect(detail(title).locator('.flash')).toHaveText('已保存工作流'); };
    await item('review.issue').click();
    await expect(detail('检视 Issue')).toContainText('项目的检视开关已关');
    await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true }); await page.reload();
    await expect(item('review.issue')).toContainText('运行中');
    await detail('检视 Issue').getByLabel('启用这条工作流', { exact: true }).uncheck(); await save('检视 Issue');
    await expect(item('review.issue')).toContainText('已关闭');
    expect((await policy()).review_enabled).toBe(1);
    await item('development.issue').click();
    await detail('开发 Issue').getByRole('tab', { name: '权限与模型', exact: true }).click();
    await detail('开发 Issue').getByLabel('测试命令', { exact: true }).fill('npm test'); await save('开发 Issue');
    expect((await policy()).test_command).toBe('npm test');
    await item('review.pr').click();
    await detail('检视 PR').getByRole('tab', { name: '提示词与流程', exact: true }).click();
    await expect(detail('检视 PR').locator('[data-prompt-meta]')).toContainText('生效：内置默认');
    await expect(detail('检视 PR').locator('[data-prompt-meta]')).toContainText('.bot/rules/pr-review.md');
    await detail('检视 PR').getByLabel('控制台提示词', { exact: true }).fill('Console PR review rule'); await save('检视 PR');
    await expect(detail('检视 PR').locator('[data-prompt-meta]')).toContainText('生效：项目控制台');
    await page.screenshot({ path: '.tmp/task-overview/rules-desktop.png', fullPage: true });
    await page.reload();
    await detail('检视 PR').getByRole('tab', { name: '提示词与流程', exact: true }).click();
    await expect(detail('检视 PR').getByLabel('控制台提示词', { exact: true })).toHaveValue('Console PR review rule');
    await item('release.notes').click();
    await detail('发行说明').getByRole('tab', { name: '提示词与流程', exact: true }).click();
    await expect(detail('发行说明').locator('[data-prompt-meta]')).toContainText('release-notes-v1');
    for (const [legacy, selected] of [['review', 'review.issue'], ['development', 'development.issue'], ['rules', 'rules.files'], ['tasks', null]]) {
      await page.goto(h.admin + '/#/projects/101/' + legacy);
      await expect(page).toHaveURL(/#\/projects\/101\/workflows$/);
      if (selected) await expect(item(selected)).toHaveAttribute('aria-current', 'page');
      if (legacy === 'rules') { await expect(page.getByRole('button', { name: '刷新默认分支文件', exact: true })).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0); }
    }
    await item('rules.guide').click();
    await expect(page.locator('[data-rule-path=".bot/guide.md"]')).toContainText('Repository behavior guide');
    await page.goto(h.admin + '/#/projects/101/model');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/projects\/101\/model$/);
    await expect(page.getByRole('table', { name: '工作流', exact: true })).toHaveCount(0);
    const sharedCard = page.locator('.side-card').filter({ has: page.getByRole('heading', { name: '部署共享模型', exact: true }) });
    await expect(sharedCard).toContainText('Shared model');
    await expect(sharedCard.locator('button, input, select, form')).toHaveCount(0);
    const custom = row('custom.science');
    await expect(custom.getByRole('combobox', { name: '任务模型', exact: true })).toHaveValue(obsolete.id);
    await expect(custom.locator('option:checked')).toContainText('模型不可用');
    const reviewRow = row('review.pr'), reviewModel = reviewRow.getByRole('combobox', { name: '任务模型', exact: true });
    await expect(reviewModel).toHaveValue('');
    await reviewModel.selectOption(review.id);
    await page.route('**/api/repositories/101/policy', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"storage_unavailable"}' }));
    await reviewRow.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(reviewRow.locator('.view-error')).toContainText('storage_unavailable');
    await expect(reviewModel).toHaveValue(review.id);
    await page.screenshot({ path: '.tmp/task-overview/save-error.png', fullPage: true });
    await page.unroute('**/api/repositories/101/policy');
    await custom.getByRole('combobox', { name: '任务模型', exact: true }).selectOption(shared.id);
    await custom.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.locator('#project-page .flash')).toHaveText('已保存custom.science的模型');
    await expect.poll(async () => JSON.parse((await policy()).task_models)).toEqual({ 'custom.science': shared.id });
    await reviewModel.selectOption(review.id);
    await reviewRow.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect.poll(async () => JSON.parse((await policy()).task_models)).toEqual({ 'review.pr': review.id, 'custom.science': shared.id });
    await page.reload(); await expect(reviewModel).toHaveValue(review.id);
    await reviewRow.getByRole('button', { name: '恢复继承', exact: true }).click();
    await expect.poll(async () => JSON.parse((await policy()).task_models)).toEqual({ 'custom.science': shared.id });
    expect((await policy()).model_id).toBe(defaultModel.id);
    await page.reload(); await expect(reviewModel).toHaveValue('');
    await custom.getByRole('button', { name: '移除自定义任务', exact: true }).click();
    await expect.poll(async () => JSON.parse((await policy()).task_models)).toEqual({});
    await expect(custom).toHaveCount(0);
    const defaultCard = page.locator('[data-overview-anchor="project-default-model"]');
    await defaultCard.getByRole('combobox', { name: '默认模型', exact: true }).selectOption(shared.id);
    await defaultCard.getByRole('button', { name: '保存默认模型', exact: true }).click();
    await expect.poll(async () => (await policy()).model_id).toBe(shared.id);
    await page.reload(); await expect(defaultCard.getByRole('combobox', { name: '默认模型', exact: true })).toHaveValue(shared.id);
    expect((await admin('/api/onboarding')).value.model_id).toBe(shared.id);
    expect((await admin('/api/repositories/202')).value.policy.model_id).toBe(shared.id);
    expect((await admin(`/api/models/${shared.id}`)).value).toEqual({ model: { ...sharedBefore.model, used_by: [
      { repository_id: '101', full_name: 'fixture/project-101' }, { repository_id: '202', full_name: 'fixture/project-202' }
    ] } });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '.tmp/task-overview/models-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/task-overview/models-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
