import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { openBasicAdvanced, openProjectDanger, closeBasicFolds } from '../helpers/open-basic-folds.mjs';

const out = '.tmp/basic-layering-570';

async function loginBasic(page, h, password) {
  await page.goto(h.admin + '/#/projects/101/basic');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('基准分支', { exact: true })).toBeVisible();
}

test('#570 基本设置首屏只有常用项，技术信息和危险操作默认折叠', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');

    await page.setViewportSize({ width: 1440, height: 900 });
    await loginBasic(page, h, password);
    await expect(page.getByRole('link', { name: /监听与触发设置/ })).toBeVisible();
    await expect(page.getByLabel('只读问答', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('可开发并开 PR', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('基准分支', { exact: true })).toBeVisible();
    // Technical identifiers and danger actions are in the document but not on the first screen.
    await expect(page.getByText('仓库 ID', { exact: true })).toBeHidden();
    // The labels are first-screen settings (#935); the rule file source list is gone.
    await expect(page.getByLabel('检视标签', { exact: true })).toHaveValue('bot-reviewed');
    await expect(page.getByLabel('开发标签', { exact: true })).toHaveValue('bot-develop');
    // The label an Issue carries while the bot develops it (#1047).
    await expect(page.getByLabel('开发中标签', { exact: true })).toHaveValue('bot-developing');
    await expect(page.getByRole('button', { name: '禁用项目', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '删除项目', exact: true })).toBeHidden();
    await page.screenshot({ path: `${out}/basic-1440.png`, fullPage: true });

    await openBasicAdvanced(page);
    await expect(page.getByText('仓库 ID', { exact: true })).toBeVisible();
    await expect(page.locator('#project-page')).not.toContainText('规则来源');
    await expect(page.locator('#project-page')).toContainText('处理账号');

    await openProjectDanger(page);
    await expect(page.getByRole('button', { name: '禁用项目', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '删除项目', exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/basic-advanced-1440.png`, fullPage: true });

    await closeBasicFolds(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByLabel('基准分支', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /监听与触发设置/ })).toBeVisible();
    await expect(page.getByLabel('开启 Issue 与 PR 检视', { exact: true })).toHaveCount(0);
    await expect(page.getByText('仓库 ID', { exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '禁用项目', exact: true })).toBeHidden();
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${out}/basic-390.png`, fullPage: true });

    await openBasicAdvanced(page);
    await openProjectDanger(page);
    await expect(page.getByText('仓库 ID', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '禁用项目', exact: true })).toBeVisible();
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${out}/basic-advanced-390.png`, fullPage: true });
  } finally { await h.stop(); }
});
