import { test, expect } from '@playwright/test';
import { openRoleAdvanced } from './open-role-advanced.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { externalFixture } from '../test/external-helpers.mjs';

// #561: long titles and notes ellipsize; 390 keeps 设置 visible and 退出登录 reachable in the #481 account menu; 1440 does not over-truncate medium names.
const out = resolve('.tmp/text-overflow-561');

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

const longName = 'fixture/an-extraordinarily-long-repository-name-used-to-verify-ellipsis-truncation-on-narrow-screens';

test('#561 长文本截断，窄屏不遮挡主操作，桌面不误截中等名称', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');
    const long = await repository(admin, a.id, '202');
    h.store.run('UPDATE repositories SET full_name=? WHERE id=?', longName, '202');
    h.store.run('UPDATE installed_repositories SET full_name=? WHERE repository_id=?', longName, '202');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // After #481, 390 hides the inline 退出登录 and puts it in the account menu; the control itself must stay on-screen.
    const accountBtn = page.locator('#console-account');
    await expect(accountBtn).toBeVisible();
    await accountBtn.click();
    const accountMenu = page.locator('#console-account-menu');
    await expect(accountMenu.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    await expect(accountMenu.locator('#console-account-role')).toHaveText('超级管理员');
    await page.keyboard.press('Escape');
    await expect(accountMenu).toBeHidden();
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await expect(page.locator('.project-list-row .row-title').filter({ hasText: longName })).toBeVisible();

    const header = await page.evaluate(() => {
      const account = document.getElementById('console-account');
      const ab = account.getBoundingClientRect();
      return {
        accountVisible: ab.width > 0 && ab.height >= 44 && ab.right <= 390.5 && ab.top >= 0 && ab.bottom > 0,
        overflow: document.documentElement.scrollWidth,
      };
    });
    expect(header.accountVisible).toBe(true);
    expect(header.overflow).toBe(390);

    const list = await page.evaluate((expected) => {
      const row = [...document.querySelectorAll('.project-list-row')].find(r => r.querySelector('.row-title')?.textContent === expected);
      const title = row.querySelector('.row-title');
      const actions = row.querySelector(':scope > .actions');
      const state = row.querySelector('.row-state');
      const setting = [...(actions?.querySelectorAll('button') || [])].find(b => b.textContent.trim() === '设置');
      const ts = getComputedStyle(title), ss = getComputedStyle(state);
      const ab = actions.getBoundingClientRect(), sb = state.getBoundingClientRect(), tb = title.getBoundingClientRect();
      return {
        title: title.title,
        ellipsis: ts.textOverflow,
        nowrap: ts.whiteSpace,
        truncated: title.scrollWidth > title.clientWidth + 1,
        actionsAboveChips: ab.bottom <= sb.top + 2,
        settingVisible: !!setting && setting.getBoundingClientRect().height > 0,
        stateOverflow: ss.overflow,
        stateMax: ss.maxHeight,
        titleWidth: tb.width,
        overflow: document.documentElement.scrollWidth,
      };
    }, longName);
    expect(list.title).toBe(longName);
    expect(list.ellipsis).toBe('ellipsis');
    expect(list.nowrap).toBe('nowrap');
    expect(list.truncated).toBe(true);
    expect(list.actionsAboveChips).toBe(true);
    expect(list.settingVisible).toBe(true);
    expect(list.stateOverflow).toBe('hidden');
    expect(Number.parseFloat(list.stateMax)).toBeGreaterThan(0);
    expect(list.overflow).toBe(390);
    await page.screenshot({ path: resolve(out, 'projects-390.png'), fullPage: true });

    // Folded state first: the page's primary action stays visible and no note is drawn over it (F5).
    await page.goto(h.admin + '/#/identity');
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible({ timeout: 15000 });
    const primary = page.locator('.identity-primary').first();
    await expect(primary).toBeVisible();
    const folded = await primary.evaluate(btn => {
      const bb = btn.getBoundingClientRect();
      const notes = [...document.querySelectorAll('.identity-layout .muted, .identity-overview .muted')].filter(n => n.getClientRects().length);
      return {
        width: bb.width, height: bb.height, right: bb.right,
        overlaps: notes.some(n => { const nb = n.getBoundingClientRect(); return !(nb.right <= bb.left || bb.right <= nb.left || nb.bottom <= bb.top + 1 || bb.bottom <= nb.top); }),
      };
    });
    expect(folded.overlaps).toBe(false);
    expect(folded.height).toBeGreaterThanOrEqual(44);
    expect(folded.right).toBeLessThanOrEqual(390.5);
    await readyIdentity(page, h.admin + '/#/identity');
    const identity = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '切换组织');
      const notes = [...document.querySelectorAll('.identity-layout .muted, .identity-overview .muted')];
      const bb = btn.getBoundingClientRect();
      const overlaps = notes.some(n => {
        const nb = n.getBoundingClientRect();
        return !(nb.right <= bb.left || bb.right <= nb.left || nb.bottom <= bb.top + 1 || bb.bottom <= nb.top);
      });
      const clamp = notes.map(n => getComputedStyle(n).webkitLineClamp);
      return {
        overlaps,
        clamp,
        btnVisible: bb.height > 0 && bb.width > 0,
        accountRight: document.getElementById('console-account').getBoundingClientRect().right,
        overflow: document.documentElement.scrollWidth,
      };
    });
    expect(identity.overlaps).toBe(false);
    expect(identity.btnVisible).toBe(true);
    expect(identity.accountRight).toBeLessThanOrEqual(390.5);
    expect(identity.overflow).toBe(390);
    expect(identity.clamp.some(v => v === '4')).toBeTruthy();
    await page.screenshot({ path: resolve(out, 'identity-390.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await expect(page.locator('.project-list-row .row-title').filter({ hasText: 'fixture/project-101' })).toBeVisible();
    const desktop = await page.evaluate(() => {
      const medium = [...document.querySelectorAll('.row-title')].find(el => el.textContent.trim() === 'fixture/project-101');
      const role = document.querySelector('.current-user-role');
      const ts = getComputedStyle(medium);
      return {
        shown: medium.textContent,
        truncated: medium.scrollWidth > medium.clientWidth + 1,
        ellipsis: ts.textOverflow,
        roleDisplay: role ? getComputedStyle(role).display : 'missing',
        overflow: document.documentElement.scrollWidth,
      };
    });
    expect(desktop.shown).toBe('fixture/project-101');
    expect(desktop.truncated).toBe(false);
    expect(desktop.ellipsis).toBe('ellipsis');
    expect(desktop.roleDisplay).not.toBe('none');
    expect(desktop.overflow).toBe(1440);
    // A clamped list subtitle always carries its full text in title (F4: the clamp is scoped to .row-content > p).
    const subtitles = await page.evaluate(() => [...document.querySelectorAll('.console-ready .row-content > p')].map(p => ({ clamp: getComputedStyle(p).webkitLineClamp, title: p.title, text: p.textContent })));
    expect(subtitles.length).toBeGreaterThan(0);
    for (const line of subtitles) { expect(line.clamp).toBe('2'); expect(line.title).toBe(line.text); }
    await page.screenshot({ path: resolve(out, 'projects-1440.png'), fullPage: true });

    await readyIdentity(page, h.admin + '/#/identity');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: resolve(out, 'identity-1440.png'), fullPage: true });

    await page.goto(h.admin + '/#/projects/101/roles');
    await openRoleAdvanced(page);
    await expect(page.getByRole('heading', { name: '角色概览' })).toBeVisible();
    await expect(page.locator('table[aria-label="角色解析结果"]')).toBeVisible();
    const roles = await page.evaluate(() => {
      const muted = document.querySelector('.roles-page .project-table td .muted');
      if (!muted) return { missing: true };
      const cs = getComputedStyle(muted);
      return { clamp: cs.webkitLineClamp, overflow: cs.overflow, title: muted.title, text: muted.textContent };
    });
    expect(roles.missing).toBeFalsy();
    expect(roles.clamp).toBe('2');
    // The clamped duty keeps its full text in title, with no textContent fallback in the assertion.
    expect(roles.title).toBeTruthy();
    expect(roles.title).toBe(roles.text);
    await page.screenshot({ path: resolve(out, 'roles-1440.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects/101/roles');
    await openRoleAdvanced(page);
    await expect(page.getByRole('heading', { name: '角色概览' })).toBeVisible();
    await page.screenshot({ path: resolve(out, 'roles-390.png'), fullPage: true });
  } finally {
    await h.stop();
  }
});

test('#561 外部执行页被裁成两行的副标题都在 title 里保留完整文字', async ({ page }) => {
  test.setTimeout(90000);
  const h = await externalFixture();
  try {
    const client = await h.client();
    const longUrl = 'https://receiver.invalid/hooks/' + 'a-very-long-forward-path-segment/'.repeat(6) + 'events';
    await h.admin('/api/repositories/101/external/subscriptions', 'POST', { client_id: client.client.id, name: 'Long forward', url: longUrl, filters: { events: ['issues', 'pull_request', 'issue_comment'], actions: ['opened', 'edited', 'synchronize', 'ready_for_review'], exclude_drafts: true } });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.adminBase + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(h.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#console-account')).toBeVisible();
    await page.goto(h.adminBase + '/#/projects/101/external');
    await expect(page.getByRole('heading', { name: '当前项目的外部执行', exact: true })).toBeVisible();
    await expect(page.locator('.row-content > p').filter({ hasText: 'receiver.invalid' })).toBeVisible();
    const lines = await page.evaluate(() => [...document.querySelectorAll('.console-ready .row-content > p')]
      .map(p => ({ clamp: getComputedStyle(p).webkitLineClamp, title: p.title, text: p.textContent, cut: p.scrollHeight > p.clientHeight + 1 })));
    expect(lines.length).toBeGreaterThan(1);
    // The long subscription line is actually cut at 390, and like every clamped line it keeps its full text in title.
    expect(lines.some(line => line.cut)).toBe(true);
    for (const line of lines) { expect(line.clamp).toBe('2'); expect(line.title).toBe(line.text); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  } finally {
    await h.stop();
    await new Promise(resolve => h.github.server.close(resolve));
  }
});
