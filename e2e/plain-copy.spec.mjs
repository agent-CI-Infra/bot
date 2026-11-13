import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #556: first-screen copy uses everyday words; jargon lives in closed 高级说明.
const out = resolve('.tmp/plain-copy-556');

/** After #514 the org-scope card lives inside a closed 高级／诊断 fold. Open it when present. */
async function readyIdentity(page, url) {
  if (url) await page.goto(url);
  await expect(page.locator('#identity-panel')).toBeVisible();
  const org = page.getByRole('heading', { name: '当前组织与项目范围' });
  const github = page.getByRole('heading', { name: '我的 GitHub 连接' });
  const legacy = page.getByRole('heading', { name: '我的身份与有效权限' });
  await expect(github.or(org).or(legacy).first()).toBeVisible({ timeout: 15000 });
  if (await org.isVisible()) return;
  const summary = page.locator('details.identity-advanced > summary');
  if (await summary.count()) {
    await summary.first().click();
    await expect(org).toBeVisible({ timeout: 10000 });
  }
  const switcher = page.getByRole('button', { name: '切换组织' });
  if (await switcher.count()) await switcher.first().scrollIntoViewIfNeeded();
}

const terms = ['授权版本', '显式委派', '仓库 ID', '超级管理员', 'token', 'Token'];

async function visibleTerms(page) {
  return page.evaluate((terms) => {
    const found = {};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el) continue;
      if (el.closest('details:not([open])')) continue;
      if (el.closest('[hidden], script, style, noscript')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const text = walker.currentNode.textContent || '';
      for (const term of terms) {
        if (text.includes(term)) (found[term] ||= []).push(text.trim().replace(/\s+/g, ' ').slice(0, 100));
      }
    }
    return found;
  }, terms);
}

async function login(page, h, password) {
  await page.goto(h.admin + '/');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
}

test('#556 登录、项目、身份、统计、成员首屏不再出现术语，登录页重复句合并为一句', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(h.admin + '/');
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const loginCopy = await page.evaluate(() => ({
      description: document.getElementById('access-description')?.textContent || '',
      provider: document.getElementById('access-provider-note')?.textContent || '',
      recovery: document.querySelector('.access-recovery-note')?.textContent || '',
    }));
    expect(loginCopy.description).toBe('登录后进入你有权管理的项目。');
    expect(loginCopy.provider).toBe('');
    expect(loginCopy.description).not.toMatch(/使用本系统账号进入你有权访问的仓库/);
    expect(loginCopy.recovery).not.toMatch(/超级管理员/);
    expect(await visibleTerms(page)).toEqual({});
    await page.screenshot({ path: resolve(out, 'login-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(out, 'login-390.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1100 });
    await login(page, h, password);

    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await expect(page.locator('.project-list-row, .row').first()).toBeVisible();
    const projects = await visibleTerms(page);
    expect(projects).toEqual({});
    await expect(page.locator('#count')).not.toContainText('看板公开可访问');
    await expect(page.locator('#count')).not.toContainText('仓库 ID');
    // The repository number left the first screen but stays on hover, even for a row without a detail line.
    await expect(page.locator('#rows .row-content[title="编号 101"]')).toHaveCount(1);
    await page.screenshot({ path: resolve(out, 'projects-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await visibleTerms(page)).toEqual({});
    // On a phone the account menu is the only place that names the signed-in role (F4).
    await page.locator('#console-account').click();
    await expect(page.locator('#console-account-role')).toHaveText('管理员');
    await page.screenshot({ path: resolve(out, 'account-menu-390.png'), fullPage: false });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: resolve(out, 'projects-390.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1100 });
    await readyIdentity(page, h.admin + '/#/identity');
    expect(await visibleTerms(page)).toEqual({});
    const advanced = page.getByTestId('advanced-help').filter({ hasText: '高级说明' }).first();
    await expect(advanced).toBeVisible();
    await expect(advanced).not.toHaveAttribute('open', /.*/);
    await advanced.locator('summary').click();
    await expect(advanced).toContainText('权限记录版本');
    await advanced.locator('summary').click();
    await page.screenshot({ path: resolve(out, 'identity-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await visibleTerms(page)).toEqual({});
    await page.screenshot({ path: resolve(out, 'identity-390.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(h.admin + '/#/costs');
    await expect(page.getByRole('heading', { name: '统计', exact: true })).toBeVisible();
    // trigger load
    const view = page.getByRole('button', { name: '查看统计', exact: true });
    if (await view.isVisible()) await view.click();
    await expect(page.locator('#cost-body, #costs-panel, #count')).not.toHaveCount(0);
    expect(await visibleTerms(page)).toEqual({});
    const costHelp = page.getByTestId('advanced-help').filter({ hasText: '统计说明' });
    if (await costHelp.count()) {
      await expect(costHelp.first()).toBeVisible();
      await costHelp.first().locator('summary').click();
      await expect(costHelp.first()).toContainText('通过本系统发出的模型请求');
      await costHelp.first().locator('summary').click();
    }
    await page.screenshot({ path: resolve(out, 'costs-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await visibleTerms(page)).toEqual({});
    await page.screenshot({ path: resolve(out, 'costs-390.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(h.admin + '/#/projects/101/members');
    await expect(page.getByRole('heading', { name: '项目成员与授权来源' })).toBeVisible();
    expect(await visibleTerms(page)).toEqual({});
    await page.screenshot({ path: resolve(out, 'members-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await visibleTerms(page)).toEqual({});
    await page.screenshot({ path: resolve(out, 'members-390.png'), fullPage: true });
  } finally {
    await h.stop();
  }
});
