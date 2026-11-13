import { test, expect } from '@playwright/test';
import { openModelCatalog } from './open-model-folds.mjs';
import { strict as assert } from 'node:assert';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

// #230 slice: a model row names the work types that explicitly pick it. The count alone hid the inheritance path — two
// models each used by one type both read "1 个工作类型显式使用", which tells nobody which setting to change. A kind
// this page has no name for is printed as its id instead of being guessed, and a model nobody picks says so — but only
// on a page that holds the project's policy: the shared model list in global settings has none in hand.
test('模型行写明哪些工作类型显式指定它', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    // One provider, five models: a second provider on the same URL is a different thing and not what this asserts.
    const models = (await admin('/api/models/provider', 'POST', { repository_id: '101', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword(), model_names: ['project-default', 'review-model', 'dev-model', 'reply-model', 'manager-model'] })).value.models;
    const model = name => models.find(row => row.model_name === name);
    const projectModel = model('project-default'), reviewModel = model('review-model'), devModel = model('dev-model'), replyModel = model('reply-model'), managerModel = model('manager-model');
    // The engine resolves a work type's model by work type id (src/work/catalog.ts), so every key here is one id.
    // `workflow.pr` is lazy configuration kept for old repositories and still gets the console's own label for it.
    assert.equal((await admin('/api/repositories/101/policy', 'PATCH', { model_id: projectModel.id, task_models: { 'review.pr': reviewModel.id, 'development.pr': devModel.id, 'custom.science': reviewModel.id, 'reply': replyModel.id, 'manager': managerModel.id, 'workflow.pr': devModel.id } })).status, 200);
    // A deployment-shared model: no project policy decides it, so its row must not claim that no work type picks it.
    const shared = (await admin('/api/models/provider', 'POST', { api_url: 'http://127.0.0.1:8/v1', api_key: testPassword(), model_names: ['shared-model'] })).value.models.find(row => row.model_name === 'shared-model');
    assert.ok(shared);

    await page.goto(h.admin + '/#/projects/101/model');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await openModelCatalog(page);
    const own = page.locator('.side-card').filter({ has: page.getByRole('heading', { name: '本项目专属模型', exact: true }) });
    await expect(own.getByRole('heading', { name: '本项目专属模型', exact: true })).toBeVisible();
    const facts = name => own.locator('li.model-entry').filter({ hasText: name }).locator('.model-connection-facts');

    await expect(facts('review-model')).toContainText('检视 PR');
    // A kind without a console name keeps its id, so the row never claims a work type it cannot name.
    await expect(facts('review-model')).toContainText('custom.science');
    await expect(facts('review-model')).not.toContainText('开发 Issue');
    await expect(facts('dev-model')).toContainText('跟进 bot PR');
    // The same names this page already uses for the same kinds: the work-type table before the shared labels, so a
    // built-in kind is never printed as its raw id (`reply`, `manager` are not in kindLabels).
    await expect(facts('reply-model')).toContainText('工作类型显式使用：通用回复（不继承项目默认）');
    await expect(facts('manager-model')).toContainText('Manager 分派');
    // `workflow.*` is not a kind the engine resolves; it takes the console's label for it instead of 通用回复's.
    await expect(facts('dev-model')).toContainText('通用回复 PR');
    await expect(facts('dev-model')).not.toContainText('通用回复（');
    await expect(facts('project-default')).toContainText('没有被工作类型显式指定');
    // The default is still named as such; the two facts answer different questions.
    await expect(facts('project-default')).toContainText('项目默认');

    // The shared list has no project policy: the absence sentence is not printed there, while the facts that do not
    // depend on a project (badge, price, where it is used) still are.
    await page.goto(h.admin + '/#/settings/models');
    const sharedCard = page.locator('.side-card').filter({ has: page.getByRole('heading', { name: '部署共享模型', exact: true }) });
    const sharedRow = sharedCard.locator('li.model-entry').filter({ hasText: 'shared-model' });
    await expect(sharedRow).toContainText('部署共享');
    await expect(sharedRow).toContainText('无项目默认或工作类型引用');
    await expect(sharedRow.locator('.model-connection-facts')).not.toContainText('没有被工作类型显式指定');
    await expect(sharedRow.locator('.model-connection-facts')).not.toContainText('工作类型显式使用');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
