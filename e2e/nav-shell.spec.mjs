import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #224 slice 2: the shell navigation must only offer destinations that really render, and an older project address must
// survive a refresh instead of silently landing on another section.
test('项目导航只列真实页面，管理对话的深链不丢页，移动底栏与更多页在 390 可用', async ({ page }) => {
  const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };
  const h = await harness(undefined, manager), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const login = async () => {
      await page.goto(h.admin + '/#/projects/101/overview');
      await page.getByLabel('用户名', { exact: true }).fill('administrator');
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.locator('.workspace-overview')).toBeVisible();
    };
    await login();
    const nav = page.locator('.project-nav'), current = nav.locator('[aria-current=page]');
    // Every entry named like a page must land on that page: the address it advertises keeps that section current.
    for (const caption of ['项目总览', '基本设置', '机器配置', '模型', '发版本', '项目知识', '外部执行', '成员', '运行状态']) {
      await nav.getByRole('link', { name: caption, exact: true }).click();
      await expect(current).toHaveText(caption);
      await expect(page).toHaveURL(new RegExp('#/projects/101/[a-z]+$'));
    }
    // 管理对话 is a chat, not a settings section: opening it keeps the settings page underneath.
    await nav.getByRole('link', { name: '角色', exact: true }).click();
    await nav.getByRole('link', { name: '管理对话', exact: true }).click();
    await expect(page).toHaveURL(/#\/projects\/101\/roles$/);
    // An older address for that chat must open the chat on a page that address still describes, not on 基本设置.
    await page.goto(h.admin + '/#/projects/101/management');
    await expect(page.locator('#management-chat')).toBeVisible({ timeout: 15000 });
    await expect(current).toHaveText('项目总览');
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    await page.reload();
    await expect(current).toHaveText('项目总览');
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    await expect(page.locator('.project-content')).not.toBeEmpty();
    // Nothing in the shell may scroll the page sideways at any desktop, tablet or phone width.
    for (const width of [390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    // The phone keeps four bottom entries and every destination behind 更多, grouped, with touch-sized targets.
    await page.setViewportSize({ width: 390, height: 844 });
    const bottom = page.locator('#console-mobile-nav a');
    await expect(bottom).toHaveCount(4);
    await expect(bottom).toHaveText([/总览/, /任务/, /待处理/, /更多/]);
    for (const entry of await bottom.all()) expect((await entry.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await bottom.filter({ hasText: '更多' }).click();
    const more = page.locator('#console-page');
    await expect(more.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    for (const group of ['工作区', '分析与身份', '平台管理']) await expect(more.getByRole('heading', { name: group, exact: true })).toBeVisible();
    for (const entry of ['项目总览', '基本设置', '机器配置', '模型', '发版本', '项目知识', '外部执行', '成员', '运行状态', '用量与成本', '身份与权限'])
      await expect(more.getByRole('link', { name: new RegExp('^' + entry) })).toBeVisible();
    expect(await more.locator('a').evaluateAll(ns => ns.every(n => n.getAttribute('href')?.startsWith('#')))).toBe(true);
    mkdirSync('.tmp/nav-shell', { recursive: true });
    for (const [width, name] of [[390, 'more-390'], [768, 'more-768']]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.tmp/nav-shell/${name}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
