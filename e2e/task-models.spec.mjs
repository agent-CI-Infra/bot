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
    const close = async () => page.locator('#project-detail').getByRole('button', { name: '收起', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/projects/101/tasks');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // The old task overview address opens the workflows page.
    await expect(page).toHaveURL(/#\/projects\/101\/workflows$/);
    await expect(page.getByRole('link', { name: '工作流', exact: true })).toHaveAttribute('aria-current', 'page');
    for (const caption of ['使用的模型', '检视', '开发', '规则总览', '任务总览']) await expect(page.getByRole('link', { name: caption, exact: true })).toHaveCount(0);
    const table = page.getByRole('table', { name: '工作流', exact: true }), flow = id => table.locator(`tr[data-workflow="${id}"]`);
    await expect(table.locator('tr[data-workflow]')).toHaveCount(6);
    await expect(page.locator('#project-page .rule-card, #project-page .workflow-editor')).toHaveCount(0);
    for (const [kind, title] of [['review.issue', '检视 Issue'], ['review.pr', '检视 PR'], ['development.issue', '开发 Issue'], ['development.pr', '跟进 bot PR'], ['release.observe', 'CI 观察'], ['release.notes', '发行说明']]) {
      await expect(flow(kind)).toContainText(title);
    }
    const common = page.locator('.common-rules');
    await expect(common).toContainText('通用准则');
    await expect(common.locator('[data-rule-source=".bot/guide.md"]')).toHaveText('仓库文件');
    await expect(flow('review.pr').locator('[data-prompt-source]')).toHaveText('内置默认');
    await expect(flow('review.pr')).toContainText('.bot/rules/pr-review.md');
    await expect(flow('release.notes')).toContainText('release-notes-v1');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await common.boundingBox()).y).toBeLessThan((await table.boundingBox()).y);
    await page.screenshot({ path: '.tmp/task-overview/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/task-overview/mobile.png', fullPage: true });
    // The project review switch, the development test command and a console prompt are saved from the editor.
    const edit = async (id, title) => { await flow(id).getByRole('button', { name: '编辑', exact: true }).click(); return page.getByRole('region', { name: '编辑工作流：' + title, exact: true }); };
    let editor = await edit('review.issue', '检视 Issue');
    await editor.getByLabel('启用这条工作流', { exact: true }).check();
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('region', { name: '编辑工作流：检视 Issue', exact: true }).locator('.flash')).toHaveText('已保存工作流');
    expect((await policy()).review_enabled).toBe(1); await close();
    await expect(flow('review.issue')).toContainText('已开启');
    editor = await edit('development.issue', '开发 Issue');
    await editor.getByLabel('测试命令', { exact: true }).fill('npm test');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('region', { name: '编辑工作流：开发 Issue', exact: true }).locator('.flash')).toHaveText('已保存工作流');
    expect((await policy()).test_command).toBe('npm test'); await close();
    editor = await edit('review.pr', '检视 PR');
    await editor.getByLabel('控制台提示词', { exact: true }).fill('Console PR review rule');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    editor = page.getByRole('region', { name: '编辑工作流：检视 PR', exact: true });
    await expect(editor.locator('.flash')).toHaveText('已保存工作流');
    await expect(editor).toContainText('生效：项目控制台');
    await expect(flow('review.pr').locator('[data-prompt-source]')).toHaveText('项目控制台');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.screenshot({ path: '.tmp/task-overview/rules-mobile.png', fullPage: true }); await close();
    await page.reload(); await flow('review.pr').getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByRole('region', { name: '编辑工作流：检视 PR', exact: true }).getByLabel('控制台提示词', { exact: true })).toHaveValue('Console PR review rule'); await close();
    await flow('release.notes').getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByRole('region', { name: '编辑工作流：发行说明', exact: true })).toContainText('release-notes-v1'); await close();
    for (const legacy of ['review', 'development', 'rules', 'tasks']) {
      await page.goto(h.admin + '/#/projects/101/' + legacy);
      await expect(page).toHaveURL(/#\/projects\/101\/workflows$/);
      if (legacy === 'rules') { await expect(page.getByRole('button', { name: '刷新默认分支文件', exact: true })).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0); }
    }
    await common.locator('summary').filter({ hasText: '行为指南' }).click();
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
