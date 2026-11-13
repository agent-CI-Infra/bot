import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #555: projects, identity and management each show at most one enabled primary on the first screen.
const out = resolve('.tmp/one-primary-555');

async function login(page, h, password) {
  await page.goto(h.admin + '/');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
}

async function enabledPrimaries(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, a.button-link, a.btn-primary')].filter(el => {
    if (el.disabled || el.hidden) return false;
    if (el.id === 'logout' || el.id === 'management-launcher') return false;
    if (el.closest('#management-launcher, header, #console-sidebar, .console-mobile-nav, dialog:not([open])')) return false;
    const fold = el.closest('details');
    if (fold && !fold.open) return false;
    if (el.classList.contains('quiet') || el.classList.contains('btn-secondary') || el.classList.contains('btn-text') || el.classList.contains('btn-danger') || el.classList.contains('status') || el.classList.contains('management-size-handle')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || n.hidden) return false;
    }
    return true;
  }).map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()));
}

test('#555 项目、对话、身份页首屏各至多一个主按钮，次要筛选和诊断默认折叠', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
      if (width === 1440) await login(page, h, password);

      await page.goto(h.admin + '/#/projects');
      await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
      const filtersFold = page.getByTestId('project-filters-fold');
      await expect(filtersFold).toBeVisible();
      expect(await filtersFold.evaluate(el => el.open)).toBe(false);
      await expect(page.locator('#filters')).toBeHidden();
      await expect(page.getByRole('button', { name: '设置' }).first()).toBeVisible();
      expect(await enabledPrimaries(page)).toEqual([]);
      await filtersFold.locator('summary').click();
      await expect(page.getByRole('button', { name: '筛选', exact: true })).toBeVisible();
      await filtersFold.locator('summary').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: resolve(out, `projects-after-${width}.png`), fullPage: true });

      await page.goto(h.admin + '/#/identity');
      await expect(page.locator('#identity-panel')).toBeVisible();
      await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible({ timeout: 15000 });
      const advanced = page.locator('details.identity-advanced');
      await expect(advanced).toBeVisible();
      expect(await advanced.evaluate(el => el.open)).toBe(false);
      await expect(page.getByRole('button', { name: '切换组织' })).toBeHidden();
      await expect(page.getByRole('button', { name: '刷新身份与授权' })).toBeHidden();
      const feishuMore = page.getByTestId('feishu-more-actions');
      await expect(feishuMore).toBeVisible();
      expect(await feishuMore.evaluate(el => el.open)).toBe(false);
      await expect(page.getByRole('link', { name: '创建个人绑定' })).toBeHidden();
      await expect(page.getByRole('link', { name: '管理飞书绑定' })).toBeVisible();
      const identityPrimaries = await enabledPrimaries(page);
      expect(identityPrimaries.length).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: resolve(out, `identity-after-${width}.png`), fullPage: true });

      await page.goto(h.admin + '/#/management');
      await expect(page.getByRole('heading', { name: '管理助手' }).first()).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('button', { name: '全屏显示管理助手' })).toBeVisible();
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible();
      // 全屏 / 收起 / 新建会话 stay visible as quiet secondary controls so 收起 is never hidden.
      // The shell appears before its conversation has opened and enabled the composer.
      await expect.poll(() => enabledPrimaries(page)).toEqual(['发送']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: resolve(out, `management-after-${width}.png`), fullPage: true });
    }
  } finally { await h.stop(); }
});
