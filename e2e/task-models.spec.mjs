import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { RuleService } from '../dist/rules/service.js';

test('Manager 页按需编辑规则章节与工作类型，模型独立管理且项目不能修改共享模型', async ({ page }) => {
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
    // The old task overview address opens the Manager page, which replaced the workflows page.
    await expect(page).toHaveURL(/#\/projects\/101\/roles$/);
    await expect(page.getByRole('link', { name: 'Manager 与角色', exact: true })).toHaveAttribute('aria-current', 'page');
    for (const caption of ['使用的模型', '检视', '开发', '规则总览', '任务总览', '工作流']) await expect(page.getByRole('link', { name: caption, exact: true })).toHaveCount(0);
    const work = id => page.locator(`[data-work-type="${id}"]`);
    await expect(page.locator('[data-work-type]')).toHaveCount(10);
    for (const [kind, title] of [['review.issue', '检视 Issue'], ['review.pr', '检视 PR'], ['development.issue', '开发 Issue'], ['development.pr', '跟进 bot PR'], ['release.observe', 'CI 观察'], ['release.notes', '发行说明'], ['actions.failures', 'Actions 失败处理']]) {
      await expect(work(kind)).toContainText(title);
    }
    await expect(page.locator('[data-rule-file=".bot/guide.md"] [data-rule-source]')).toHaveText('仓库文件');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.screenshot({ path: '.tmp/task-overview/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/task-overview/mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // A work type's switch and the development test command are saved from the work type table; a rule section from the prompt.
    const saveWork = async () => { await page.getByRole('button', { name: '保存工作类型', exact: true }).click(); await expect(page.getByText('已保存工作类型', { exact: true })).toBeVisible(); };
    await expect(work('review.issue')).toContainText('项目的检视开关已关');
    await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true }); await page.reload();
    await expect(work('review.issue')).toContainText('运行中');
    await work('review.issue').getByLabel('开启', { exact: true }).uncheck(); await saveWork();
    await expect(work('review.issue')).toContainText('已关闭');
    expect((await policy()).review_enabled).toBe(1);
    await page.getByLabel('测试命令', { exact: true }).fill('npm test'); await saveWork();
    expect((await policy()).test_command).toBe('npm test');
    await page.getByText(/^章节与内置文本/).click();
    const pr = page.locator('[data-manager-section="review.pr"]');
    await expect(pr).toContainText('内置文本'); await expect(pr).toContainText('.bot/rules/pr-review.md');
    const prompt = page.getByLabel('Manager 提示词', { exact: true });
    await prompt.fill('## 检视 PR `review.pr`\n\nConsole PR review rule\n'); await page.getByRole('button', { name: '保存提示词', exact: true }).click();
    await page.getByText(/^章节与内置文本/).click(); await expect(pr).toContainText('项目已写');
    await page.screenshot({ path: '.tmp/task-overview/rules-desktop.png', fullPage: true });
    await page.reload();
    await expect(prompt).toHaveValue(/Console PR review rule/);
    await page.getByText(/^章节与内置文本/).click();
    await expect(page.locator('[data-manager-section="release.notes"]')).toContainText('.agents/skills/release-notes/SKILL.md');
    for (const legacy of ['review', 'development', 'rules', 'tasks', 'workflows']) {
      await page.goto(h.admin + '/#/projects/101/' + legacy);
      await expect(page).toHaveURL(/#\/projects\/101\/roles$/);
      if (legacy === 'rules') { await expect(page.getByRole('button', { name: '刷新默认分支文件', exact: true })).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0); }
    }
    await page.locator('[data-rule-file=".bot/guide.md"]').getByRole('button', { name: '展开规则', exact: true }).click();
    await expect(page.locator('[data-rule-path=".bot/guide.md"]')).toContainText('Repository behavior guide');
    await page.goto(h.admin + '/#/projects/101/model');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/projects\/101\/model$/);
    await expect(page.getByRole('table', { name: '工作流', exact: true })).toHaveCount(0);
    await expect(page.getByRole('table', { name: '工作类型模型', exact: true })).toBeVisible();
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
    await custom.getByRole('button', { name: '移除这项设置', exact: true }).click();
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
