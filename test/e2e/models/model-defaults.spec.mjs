import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { openModelCatalog } from '../helpers/open-model-folds.mjs';
import { consoleSave } from '../helpers/console-save.mjs';

const out = '.tmp/model-defaults-1122';

async function loginModel(page, h, password) {
  await page.goto(h.admin + '/#/projects/101/model');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目默认模型', exact: true })).toBeVisible();
}

test('#1122 模型页移除按任务类型覆写，只保留项目默认模型与角色页引导，1440 与 390 布局正常', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Project default', api_url: 'https://model.invalid/v1', api_key: testPassword() });

    await page.setViewportSize({ width: 1440, height: 900 });
    await loginModel(page, h, password);
    await expect(page.getByTestId('console-save-bar')).toBeVisible();
    await expect(consoleSave(page)).toBeHidden();
    await expect(page.getByTestId('model-overrides')).toHaveCount(0);
    await expect(page.getByRole('table', { name: '工作类型模型', exact: true })).toHaveCount(0);
    await expect(page.getByText('按任务类型覆写')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /按角色配置模型/ })).toHaveAttribute('href', '#/projects/101/roles');
    await expect(page.getByRole('heading', { name: '本项目专属模型', exact: true })).toBeHidden();
    await page.screenshot({ path: `${out}/model-1440.png`, fullPage: true });

    await openModelCatalog(page);
    await expect(page.getByRole('heading', { name: '本项目专属模型', exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/model-catalog-1440.png`, fullPage: true });

    await page.getByTestId('model-catalog').evaluate(el => { el.open = false; });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByRole('heading', { name: '项目默认模型', exact: true })).toBeVisible();
    await expect(page.getByTestId('console-save-bar')).toBeVisible();
    await expect(consoleSave(page)).toBeHidden();
    await expect(page.getByTestId('model-overrides')).toHaveCount(0);
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${out}/model-390.png`, fullPage: true });
  } finally { await h.stop(); }
});
