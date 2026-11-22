import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup } from '../../fixtures/helpers.mjs';
import { assistantManager } from '../../fixtures/assistant-computer-fixture.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';

test('#1214 助手电脑全局设置：默认开放外网，可切换并持久化，窄屏无溢出', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cleanups = [];
  const t = { after(fn) { cleanups.push(fn); } };
  const assistant = await assistantManager(t);
  const h = await harness(null, assistant.manager, store => ({
    engine: new TaskEngine(store, assistant.manager),
    assistantHomes: assistant.homes,
  }));
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/settings/assistant-computers');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('body.console-ready')).toHaveCount(1);

    await page.goto(h.admin + '/#/settings/assistant-computers');
    const resources = page.locator('section.side-card').filter({ has: page.getByRole('heading', { name: '每台电脑的资源', level: 2, exact: true }) });
    await expect(resources).toBeVisible();
    await expect(resources.getByText('可访问外网（独立隔离网络）')).toBeVisible();
    const egress = resources.getByRole('checkbox', { name: /允许访问外网/ });
    await expect(egress).toBeChecked();

    await egress.uncheck();
    await resources.getByRole('button', { name: '保存', exact: true }).click();
    await expect(resources.getByText('已保存：新建的电脑立即使用，已有的在下一个回合重建')).toBeVisible();
    await expect(resources.getByText('无外网', { exact: true })).toBeVisible();
    await expect(egress).not.toBeChecked();

    await egress.check();
    await resources.getByRole('button', { name: '保存', exact: true }).click();
    await expect(resources.getByText('可访问外网（独立隔离网络）')).toBeVisible();
    await expect(egress).toBeChecked();

    await page.setViewportSize({ width: 390, height: 844 });
    await resources.scrollIntoViewIfNeeded();
    await expect(resources).toBeVisible();
    await expect(egress).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await h.stop();
    rmSync(h.directory, { recursive: true, force: true });
    for (const fn of cleanups.reverse()) await fn();
  }
});
