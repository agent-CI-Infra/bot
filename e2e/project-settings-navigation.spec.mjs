import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

const settings = [['basic', '基本设置'], ['machine', '机器配置'], ['roles', '角色'], ['model', '模型'], ['schedules', '计划与通知'], ['external', '外部执行'], ['members', '成员']];

for (const width of [390, 768, 1440]) test(`project settings directory and deep links stay shallow at ${width}px`, async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    await page.setViewportSize({ width, height: 900 });
    await page.goto(h.admin + '/#/projects/101/settings');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const directory = page.locator('.project-settings-directory');
    await expect(directory.getByRole('heading', { name: '项目设置', exact: true })).toBeVisible();
    await expect(directory.getByRole('link')).toHaveCount(settings.length);
    const refreshNavigation = async () => {
      await page.evaluate(() => {
        syncConsoleShell(); syncConsoleShell();
        updateConsoleGaps([{ id: '101', access_gaps: [] }]);
      });
      await expect(page.locator('.project-nav a')).toHaveText(['项目总览', '管理对话', '发版本', '项目知识', '运行状态', '项目设置']);
    };
    await refreshNavigation(); // Background installation updates must retain the navigation already moved into the shell.
    // The real server assembles project.js from this worktree, not a stale built asset.
    const script = await page.request.get(h.admin + '/project.js');
    expect(script.ok()).toBe(true); expect(await script.text()).toContain('function projectSettingsDirectory()');
    for (const [key, name] of settings) {
      await directory.getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#/projects/101/${key}$`));
      await expect(page.locator('.project-setting-location')).toContainText(name);
      await expect(page.locator('#console-secondary-nav')).toBeHidden();
      await expect(page.getByLabel('当前页面', { exact: true })).toBeHidden();
      await page.getByRole('link', { name: '返回项目设置', exact: true }).click();
      await expect(directory).toBeVisible();
    }
    await page.goto(h.admin + '/#/projects/101/roles/dev');
    await expect(page.getByRole('heading', { name: 'Dev 设置', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dev 设置', exact: true })).toBeVisible();
    await expect(page.locator('#console-secondary-nav')).toBeHidden();
    await expect(page.locator('.role-nav')).toBeVisible(); // Role editing remains the existing #566 surface.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mkdirSync('.tmp/project-settings-navigation', { recursive: true });
    await page.screenshot({ path: `.tmp/project-settings-navigation/role-${width}.png`, fullPage: true });
    await page.getByRole('link', { name: '返回项目设置', exact: true }).click();
    await expect(directory).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.tmp/project-settings-navigation/directory-${width}.png`, fullPage: true });
    await page.getByRole('link', { name: '返回项目总览', exact: true }).click();
    await expect(page.locator('.workspace-overview')).toBeVisible();
    await refreshNavigation();
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
