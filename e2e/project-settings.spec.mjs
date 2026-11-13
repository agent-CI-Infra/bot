import { test, expect } from '@playwright/test';
import { openProjectDanger } from './open-basic-folds.mjs';
import { mkdirSync } from 'node:fs';
import { identityFixture } from '../test/identity-fixture.mjs';
import { testPassword } from '../test/helpers.mjs';
import { consoleSave } from './console-save.mjs';

const output = '.tmp/project-settings-226';
async function login(page, f, path, username = 'administrator', password = f.password) {
  await page.goto(f.h.admin + path);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('settings preserve a draft across refresh and save errors, with separate confirmed lifecycle actions', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
    mkdirSync(output, { recursive: true });
    f.h.store.run("UPDATE installed_repositories SET private=1 WHERE repository_id='101'");
    await login(page, f, '/#/projects/101/basic');
    const branch = page.getByLabel('基准分支', { exact: true });
    await branch.fill('release/next');
    await expect(page.locator('.project-settings-layout')).toContainText('有未保存的更改');
    await page.getByRole('button', { name: '刷新项目设置', exact: true }).click();
    await expect(branch).toHaveValue('release/next');
    const group = branch.locator('xpath=ancestor::form');
    await page.route('**/api/repositories/101/policy', route => route.fulfill({ status: 503, json: { error: 'save_unavailable' } }));
    await consoleSave(page).click();
    await expect(group.getByRole('alert')).toContainText('save_unavailable'); await expect(branch).toHaveValue('release/next');
    await page.unroute('**/api/repositories/101/policy');
    await consoleSave(page).click();
    await expect(page.locator('#project-page .flash')).toHaveText('已保存');
    expect(f.h.store.get("SELECT base_branch FROM policies WHERE repository_id='101'").base_branch).toBe('release/next');
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390 || width === 1440) await page.screenshot({ path: `${output}/settings-${width}.png`, fullPage: true });
    }
    await openProjectDanger(page);
    const danger = page.locator('.project-danger');
    await danger.getByRole('button', { name: '禁用项目', exact: true }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('正在执行的任务会中止'); await expect(dialog).toContainText('公开看板');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(f.h.store.get("SELECT enabled FROM policies WHERE repository_id='101'").enabled).toBe(1);
    await page.route('**/api/installations/101/disable', route => route.fulfill({ status: 503, json: { error: 'disable_unavailable' } }));
    await danger.getByRole('button', { name: '禁用项目', exact: true }).click();
    await dialog.getByRole('button', { name: '禁用', exact: true }).click();
    await expect(danger.getByRole('alert')).toContainText('disable_unavailable');
    await expect(danger.getByRole('button', { name: '禁用项目', exact: true })).toBeEnabled();
    const publish = page.getByRole('button', { name: '开启公开看板', exact: true });
    await publish.click(); await expect(dialog).toContainText('私有仓');
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(publish).toBeVisible();
    await publish.click(); await dialog.getByRole('button', { name: '开启公开看板', exact: true }).click();
    await expect(page.getByRole('button', { name: '关闭公开看板', exact: true })).toBeVisible();
    expect(f.h.store.get("SELECT enabled FROM public_board_settings WHERE repository_id='101'").enabled).toBe(1);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('a delayed settings receipt cannot replace the next project or its unsaved draft', async ({ page }) => {
  const f = await identityFixture(); let release = () => {};
  try {
    const otherBranch = f.h.store.get("SELECT base_branch FROM policies WHERE repository_id='201'").base_branch;
    await login(page, f, '/#/projects/101/basic');
    await page.getByLabel('基准分支', { exact: true }).fill('old-project-branch');
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/repositories/101/policy', async route => { await gate; await route.continue(); });
    await consoleSave(page).click();
    await page.evaluate(() => { location.hash = '#/projects/201/basic'; });
    await expect(page.getByRole('heading', { name: 'other/project-201', exact: true })).toBeVisible();
    await page.getByLabel('基准分支', { exact: true }).fill('new-project-draft');
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page).toHaveURL(/#\/projects\/201\/basic$/);
    await expect(page.getByLabel('基准分支', { exact: true })).toHaveValue('new-project-draft');
    await expect.poll(() => f.h.store.get("SELECT base_branch FROM policies WHERE repository_id='101'").base_branch).toBe('old-project-branch');
    expect(f.h.store.get("SELECT base_branch FROM policies WHERE repository_id='201'").base_branch).toBe(otherBranch);
  } finally { release(); await f.close(); }
});

test('project members show inherited and explicit sources, and removing a local assignment preserves inheritance', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
    const password = testPassword();
    const created = await f.admin('/api/users', 'POST', { username: 'inherited-member', password, repository_ids: ['101'], organization_ids: ['10'] });
    const user = created.value.user;
    await login(page, f, '/#/projects/101/members');
    await expect(page.locator('.project-member-list')).toContainText('组织显式委派（继承）');
    await expect(page.locator('.project-member-list')).toContainText('项目显式委派');
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390 || width === 1440) await page.screenshot({ path: `${output}/members-${width}.png`, fullPage: true });
    }
    const assignment = page.locator('.history li').filter({ hasText: 'inherited-member' });
    await assignment.getByRole('button', { name: '移除', exact: true }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('组织继承');
    await dialog.getByRole('button', { name: '移除分配', exact: true }).click();
    await expect(assignment.getByRole('button', { name: '移除', exact: true })).toHaveCount(0);
    expect(f.h.store.get('SELECT 1 FROM project_admin_assignments WHERE user_id=? AND repository_id=?', user.id, '101')).toBeUndefined();
    expect(f.h.store.get('SELECT 1 FROM project_admin_organizations WHERE user_id=?', user.id)).toBeTruthy();
    await expect(page.locator('.project-member-list')).toContainText('组织显式委派（继承）');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('member read failures replace previous grants and project admins cannot transfer authority', async ({ page, browser }) => {
  const f = await identityFixture(); let blocked = false;
  try {
    const password = testPassword(); await f.admin('/api/users', 'POST', { username: 'project-member', password, repository_ids: ['101'] });
    await login(page, f, '/#/projects/101/members');
    await expect(page.locator('.project-member-list')).toContainText('project-member');
    await page.route('**/api/repositories/101/members', route => blocked ? route.fulfill({ status: 403, json: { error: 'capability_forbidden' } }) : route.continue());
    blocked = true; await page.getByRole('button', { name: '刷新成员权限', exact: true }).click();
    await expect(page.getByRole('heading', { name: '成员权限读取失败' })).toBeVisible();
    await expect(page.locator('.project-member-list')).toHaveCount(0);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), member = await context.newPage();
    try {
      await login(member, f, '/#/projects/101/members', 'project-member', password);
      await expect(member.locator('.project-nav a')).toHaveCount(12);
      await expect(member.locator('.project-nav a[href="#/projects/101/members"]')).toHaveCount(1);
      await expect(member.getByLabel('当前页面',{exact:true})).toHaveValue('#/projects/101/members');
      await expect(member.locator('.project-member-list')).toContainText('project-member');
      await expect(member.getByLabel('添加项目管理员', { exact: true })).toHaveCount(0);
      await expect(member.locator('#project-page')).toContainText('不能再转授权');
      // #553: without the super-admin-only assignment card the grants card spans the whole row instead of half of it.
      await expect(member.locator('.members-layout > [hidden]')).toHaveCount(1);
      await member.setViewportSize({ width: 1440, height: 900 });
      const widths = await member.locator('.members-layout').evaluate(grid => ({ grid: grid.getBoundingClientRect().width,
        card: [...grid.children].find(child => !child.hidden).getBoundingClientRect().width }));
      expect(Math.abs(widths.card - widths.grid)).toBeLessThanOrEqual(1);
      mkdirSync('.tmp/console-states-553', { recursive: true });
      await member.screenshot({ path: '.tmp/console-states-553/members-member-1440.png', fullPage: true });
      await member.setViewportSize({ width: 390, height: 844 });
      expect(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await member.screenshot({ path: '.tmp/console-states-553/members-member-390.png', fullPage: true });
    } finally { await context.close(); }
  } finally { await f.close(); }
});

test('a late successful member read cannot replace a newer permission error', async ({ page }) => {
  const f = await identityFixture(); let release = () => {}, count = 0;
  try {
    await login(page, f, '/#/projects/101/members');
    await expect(page.getByRole('button', { name: '刷新成员权限', exact: true })).toBeVisible();
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/repositories/101/members', async route => {
      if (++count > 1) return route.fulfill({ status: 403, json: { error: 'capability_forbidden' } });
      const response = await route.fetch(); await gate; await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '刷新成员权限', exact: true }).click();
    await expect.poll(() => count).toBe(1);
    await page.getByRole('button', { name: '刷新成员权限', exact: true }).click();
    await expect(page.getByRole('heading', { name: '成员权限读取失败' })).toBeVisible();
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByRole('heading', { name: '成员权限读取失败' })).toBeVisible();
    await expect(page.locator('.project-member-list')).toHaveCount(0);
  } finally { release(); await f.close(); }
});
