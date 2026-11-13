import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { consoleSave, compareWithServer, confirmDiscard } from './console-save.mjs';

const out = resolve('.tmp/recommended-roles-564');

test('#564 未配置项目首屏一键采用推荐配置，高级项默认折叠', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');
    // A fresh project has no saved role configuration.
    h.store.run("DELETE FROM settings WHERE key='roles:101'");

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
      if (width === 1440) {
        await page.goto(h.admin + '/#/projects/101/roles');
        await page.getByLabel('用户名', { exact: true }).fill('administrator');
        await page.getByLabel('密码', { exact: true }).fill(password);
        await page.getByRole('button', { name: '登录', exact: true }).click();
      } else {
        await page.goto(h.admin + '/#/projects/101/roles');
      }
      await expect(page.getByTestId('recommended-roles-intro')).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('heading', { name: '使用推荐的角色分工' })).toBeVisible();
      await expect(page.locator('[data-role-version]').first()).toHaveText('尚未保存。可先使用推荐配置。');
      const advanced = page.getByTestId('role-advanced');
      await expect(advanced).toBeVisible();
      expect(await advanced.evaluate(el => el.open)).toBe(false);
      await expect(page.getByRole('table', { name: '角色解析结果' })).toBeHidden();
      const adopt = page.getByTestId('adopt-recommended-roles');
      await expect(adopt).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: resolve(out, `before-${width}.png`), fullPage: true });
    }

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByTestId('adopt-recommended-roles').click();
    await expect(page.locator('.flash')).toContainText('已使用推荐配置');
    await expect(page.getByTestId('recommended-roles-intro')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible();
    await expect(page.locator('[data-role-version]').first()).toHaveText('已保存');
    const after = (await admin('/api/repositories/101/roles')).value;
    expect(after.configured).toBe(true);
    expect((after.configuration.roles || after.roles || []).length).toBeGreaterThan(0);
    await expect(page.getByRole('table', { name: '角色解析结果' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: resolve(out, 'after-1440.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: resolve(out, 'after-390.png'), fullPage: true });
  } finally { await h.stop(); }
});
