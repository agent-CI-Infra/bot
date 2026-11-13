import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { openModelOverrides, openModelCatalog } from './open-model-folds.mjs';

const out = '.tmp/model-defaults-571';

async function loginModel(page, h, password) {
  await page.goto(h.admin + '/#/projects/101/model');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目默认模型', exact: true })).toBeVisible();
}

test('#571 模型页首屏只有默认模型，工作类型覆写用中文名称且默认折叠', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Project default', api_url: 'https://model.invalid/v1', api_key: testPassword() });

    await page.setViewportSize({ width: 1440, height: 900 });
    await loginModel(page, h, password);
    await expect(page.getByRole('button', { name: '保存默认模型', exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: '工作类型模型', exact: true })).toBeHidden();
    await expect(page.getByRole('heading', { name: '本项目专属模型', exact: true })).toBeHidden();
    await expect(page.getByText('review.issue', { exact: true })).toHaveCount(0);
    await expect(page.getByText('gate-onboarding', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${out}/model-1440.png`, fullPage: true });

    await openModelOverrides(page);
    await expect(page.getByRole('table', { name: '工作类型模型', exact: true }).getByRole('cell', { name: '检视 Issue', exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: '工作类型模型', exact: true }).getByRole('cell', { name: '开发 Issue', exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: '工作类型模型', exact: true }).getByRole('cell', { name: 'Manager 分派', exact: true })).toBeVisible();
    const table = page.getByRole('table', { name: '工作类型模型', exact: true });
    await expect(table.locator('code')).toHaveCount(0);
    await expect(table).not.toContainText('review.issue');
    await expect(table).not.toContainText('development_pr');
    await expect(table).not.toContainText('gate-onboarding');
    await openModelCatalog(page);
    await expect(page.getByRole('heading', { name: '本项目专属模型', exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/model-advanced-1440.png`, fullPage: true });

    await page.getByTestId('model-overrides').evaluate(el => { el.open = false; });
    await page.getByTestId('model-catalog').evaluate(el => { el.open = false; });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByRole('heading', { name: '项目默认模型', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存默认模型', exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: '工作类型模型', exact: true })).toBeHidden();
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${out}/model-390.png`, fullPage: true });
  } finally { await h.stop(); }
});

test('#571 覆写摘要显示数量和不可用项，解析错误出现在折叠外', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const modelId = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Override model', api_url: 'https://model.invalid/v1', api_key: testPassword() })).value.model.id;
    expect(modelId).toBeTruthy();
    const patched = await admin('/api/repositories/101/policy', 'PATCH', { task_models: { 'review.pr': modelId, 'development.pr': 'missing-model' } });
    if (patched.status !== 200) {
      h.store.run("UPDATE policies SET task_models=? WHERE repository_id=?", JSON.stringify({ 'review.pr': modelId, 'development.pr': 'missing-model' }), '101');
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await loginModel(page, h, password);
    const fold = page.getByTestId('model-overrides');
    await expect(fold.locator('summary')).toHaveText('按任务类型覆写（已设 2 项，1 项不可用）');
    await expect(fold).toHaveJSProperty('open', true);

    h.store.run("UPDATE policies SET task_models='not-json' WHERE repository_id=?", '101');
    await page.reload();
    await expect(page.getByRole('heading', { name: '项目默认模型', exact: true })).toBeVisible();
    await expect(page.getByTestId('task-models-error')).toBeVisible();
    await expect(page.getByTestId('model-overrides')).toHaveJSProperty('open', true);
  } finally { await h.stop(); }
});
