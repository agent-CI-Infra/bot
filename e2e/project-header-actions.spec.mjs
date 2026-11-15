import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #839: the shared project header has one primary action; 设置 stays reachable on a phone (#707).
const out = resolve('.tmp/project-header-actions');
const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };

async function login(page, h, password, hash = '#/projects/101/overview') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.workspace-overview')).toBeVisible();
}

test('项目标题栏只有「管理助手」是主按钮，「设置」和「在 GitHub 打开」为次要操作（#839）', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness(undefined, manager, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await login(page, h, password);
    const chat = page.getByTestId('project-open-chat');
    const settings = page.getByTestId('project-open-settings');
    const github = page.getByRole('link', { name: '在 GitHub 打开', exact: true });
    const headerActions = page.locator('.project-head .actions');

    for (const [width, height, name] of [[1440, 900, '1440'], [1280, 900, '1280'], [390, 844, '390']]) {
      await page.setViewportSize({ width, height });
      await page.goto(h.admin + '/#/projects/101/overview');
      await expect(page.locator('.workspace-overview')).toBeVisible();
      await expect(chat).toBeVisible();
      await expect(settings).toBeVisible();
      await expect(github).toBeVisible();
      await expect(chat).toHaveClass(/btn-primary/);
      await expect(headerActions.locator('.btn-primary')).toHaveCount(1);
      await expect(settings).toHaveClass(/btn-secondary/);
      await expect(settings).not.toHaveClass(/btn-primary/);
      await expect(github).toHaveClass(/btn-secondary/);
      await expect(github).not.toHaveClass(/btn-primary/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${out}/overview-${name}.png`, fullPage: true });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects/101/overview');
    await expect(page.locator('.workspace-overview')).toBeVisible();
    await settings.click();
    await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
    await expect(page.getByRole('button', { name: '刷新项目设置', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '刷新项目设置', exact: true })).toHaveClass(/btn-secondary/);
    await expect(page.getByRole('button', { name: '刷新项目设置', exact: true })).not.toHaveClass(/btn-primary/);
    await expect(headerActions.locator('.btn-primary')).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
