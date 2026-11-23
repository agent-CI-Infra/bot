import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';

const trigger = page => page.locator('.console-scope-trigger:visible');
const options = page => page.locator('#console-scope-projects [role=option]');
async function login(page, h, password, hash = '#/projects', username = 'administrator') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#access')).toBeHidden();
  await expect(trigger(page)).toBeVisible();
}
async function fixture() {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  for (const id of ['101', '202', '303']) await repository(admin, a.id, id);
  for (const [id, name] of [['101', 'alpha/a-repository-with-a-name-longer-than-forty-characters'], ['202', 'beta/bravo'], ['303', 'alpha/charlie']]) {
    h.store.run('UPDATE repositories SET full_name=? WHERE id=?', name, id);
    h.store.run('UPDATE installed_repositories SET full_name=?, owner_login=? WHERE repository_id=?', name, name.split('/')[0], id);
  }
  await admin('/api/repositories/202/policy', 'PATCH', { enabled: false });
  return { h, admin, password };
}
const noOverflow = async page => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test('searchable scope list, long names, disabled state, keyboard and focus across desktop widths', async ({ page }) => {
  const { h, password } = await fixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password, '#/projects/101/overview');
    for (const width of [1440, 1024, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(trigger(page)).toHaveAttribute('title', 'alpha/a-repository-with-a-name-longer-than-forty-characters');
      const title = trigger(page).locator('strong'), organization = trigger(page).locator('small');
      await expect(organization).toHaveText('alpha');
      expect((await organization.boundingBox()).y).toBeGreaterThan((await title.boundingBox()).y);
      expect(await title.evaluate(node => getComputedStyle(node).whiteSpace)).toBe('nowrap');
      await noOverflow(page);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.keyboard.press('Control+k');
    const search = page.getByRole('combobox', { name: '搜索项目或组织' });
    await expect(search).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('listbox').getByRole('option').first()).toHaveText('全部项目');
    await expect(page.locator('#console-scope-org-0-label')).toHaveText('alpha · 2');
    await expect(page.locator('#console-scope-org-1-label')).toHaveText('beta · 1');
    await expect(options(page).locator('.console-scope-name')).toHaveText(['a-repository-with-a-name-longer-than-forty-characters', 'charlie', 'bravo']);
    await expect(options(page).filter({ hasText: 'bravo' })).toContainText('已禁用');
    await expect(options(page).locator('[data-permission], .console-nav-badge')).toHaveCount(0);
    await expect(page.locator('#console-scope-footer a')).toHaveText(['管理所有项目 →', '启动新仓库 →']);
    await search.fill('ALPHA/CHAR');
    await expect(options(page)).toHaveText(['charlie']);
    await expect(page.locator('#console-scope-recent')).toHaveCount(0);
    await expect(page.getByRole('listbox').getByRole('option').first()).toHaveText('全部项目');
    await search.fill('no-such-project');
    await expect(page.getByRole('status').filter({ hasText: '没有匹配的项目' })).toBeVisible();
    await expect(page.locator('#console-scope-projects [role=group]')).toHaveCount(0);
    await search.fill('BRAVO');
    await page.keyboard.press('ArrowDown');
    const active = await search.getAttribute('aria-activedescendant');
    await expect(page.locator('#' + active)).toHaveAttribute('data-project-id', '202');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/projects\/202\/overview$/);
    await trigger(page).click(); await page.keyboard.press('Escape');
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Meta+k'); await expect(search).toBeFocused();
    await page.locator('#console-project-header .project-head h1').click(); await expect(page.locator('#console-scope-picker')).not.toBeVisible();
    // Choosing the current row only closes: no re-render, navigation or extra project read.
    let reads = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/repositories/202') reads++; });
    await switchConsoleProject(page, '202'); expect(reads).toBe(0);
    await trigger(page).click(); await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#console-scope-picker')).not.toBeVisible();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'English', exact: true }).click();
    // #1060: the name is now computed from the trigger's content (org then repository, as drawn), not from an aria-label.
    await expect(trigger(page)).toHaveAccessibleName('Switch project: bravo beta');
    await trigger(page).click();
    await expect(page.locator('#console-scope-projects').getByRole('option', { name: 'Project: beta/bravo · Disabled', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('switching scope preserves each page type and keeps global and personal settings reachable', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,phase) VALUES('switch-task','101','review.issue','failed','scope task','model')");
    for (const [from, expected] of [
      ['#/projects/101/inbox', '#/projects/202/inbox'], ['#/projects/101/new-task', '#/projects/202/new-task'],
      ['#/projects/101/overview', '#/projects/202/overview'], ['#/projects/101/roles', '#/projects/202/roles'],
      ['#/projects/101/release', '#/projects/202/release'], ['#/projects/101/knowledge', '#/projects/202/knowledge'],
      ['#/projects/101/menu', '#/projects/202/overview'], ['#/tasks/switch-task', '#/projects/202/overview'],
      ['#/identity', '#/projects/202/overview'], ['#/settings/users', '#/projects/202/overview'],
      ['#/more', '#/projects/202/overview'], ['#/conversations', '#/projects/202/overview']
    ]) {
      // The unscoped destinations inherit 101, so choosing 202 really changes scope for every row in this table.
      await page.goto(h.admin + '/#/projects/101/overview');
      await expect(trigger(page)).toHaveAttribute('data-project-id', '101');
      await page.goto(h.admin + '/' + from);
      await expect(trigger(page)).toBeVisible();
      if (from.startsWith('#/tasks')) await expect(page.locator('#task-view')).toBeVisible();
      await switchConsoleProject(page, '202');
      await expect(page).toHaveURL(h.admin + '/' + expected);
      await expect(trigger(page)).toHaveAttribute('data-project-id', '202');
    }
    for (const [from, expected] of [['#/projects/202/inbox', '#/inbox'], ['#/projects/202/new-task', '#/new-task'], ['#/projects/202/roles', '#/projects']]) {
      await page.goto(h.admin + '/' + from); await switchConsoleProject(page, '');
      await expect(page).toHaveURL(h.admin + '/' + expected);
      await expect(trigger(page)).toHaveAttribute('data-project-id', '');
    }
  } finally { await h.stop(); }
});

test('recent projects survive refresh, cap at five, filter revoked grants and isolate accounts', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    const a = (await admin('/api/accounts')).value.accounts[0];
    for (const id of ['404', '505', '606']) await repository(admin, a.id, id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    for (const id of ['101', '202', '303', '404', '505', '606', '202']) {
      await page.goto(h.admin + `/#/projects/${id}/overview`);
      await expect(trigger(page)).toHaveAttribute('data-project-id', id);
    }
    await page.reload(); await trigger(page).click();
    const recent = page.locator('#console-scope-recent [role=option]');
    await expect(recent).toHaveCount(5);
    expect(await recent.evaluateAll(nodes => nodes.map(node => node.dataset.projectId))).toEqual(['202', '606', '505', '404', '303']);
    await page.keyboard.press('Escape');
    // A separate account has no recent projects until it visits one.
    const memberPassword = testPassword();
    const member = await admin('/api/users', 'POST', { username: 'scope-member', password: memberPassword, repository_ids: ['101', '202', '303'] });
    await page.locator('#logout').click();
    await login(page, h, memberPassword, '#/projects', 'scope-member'); await trigger(page).click();
    await expect(page.locator('#console-scope-recent')).toHaveCount(0);
    await expect(page.locator('#console-scope-footer a')).toHaveText(['管理所有项目 →']);
    await page.keyboard.press('Escape');
    for (const id of ['101', '202', '303']) {
      await page.goto(h.admin + `/#/projects/${id}/overview`);
      await expect(trigger(page)).toHaveAttribute('data-project-id', id);
    }
    await admin('/api/project-admin-assignments', 'PUT', { user_id: member.value.user.id, repository_ids: ['101', '303'] });
    await page.reload(); await trigger(page).click();
    expect(await recent.evaluateAll(nodes => nodes.map(node => node.dataset.projectId))).toEqual(['303', '101']);
    await expect(page.locator('#console-scope-projects [data-project-id="202"]')).toHaveCount(0);
  } finally { await h.stop(); }
});

test('mobile range bar stays visible on board, inbox and projects; drawer is searchable and touch sized', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await login(page, h, password);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const hash of ['#/projects', '#/projects/101/inbox', '#/projects/101/overview']) {
        await page.goto(h.admin + '/' + hash);
        await expect(page.locator('#console-mobile-project')).toBeVisible();
        await expect(page.locator('#console-mobile-nav')).toBeVisible();
        await noOverflow(page);
      }
      await trigger(page).click();
      const search = page.getByRole('combobox', { name: '搜索项目或组织' });
      await expect(search).toBeFocused();
      const box = await page.locator('#console-scope-picker').boundingBox();
      expect(box.x).toBe(0); expect(box.y).toBe(0); expect(box.width).toBe(width); expect(box.height).toBe(844);
      expect(await search.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
      expect(await page.getByRole('listbox').getByRole('option').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height >= 44))).toBe(true);
      await noOverflow(page);
      await search.fill('beta');
      await expect(options(page)).toHaveCount(1);
      await options(page).first().click();
      await expect(page).toHaveURL(/#\/projects\/202\/overview$/);
      await trigger(page).click(); await page.keyboard.press('Escape'); await expect(trigger(page)).toBeFocused();
    }
  } finally { await h.stop(); }
});

test('scope shortcut leaves assistant input and modal dialogs in control of their keys', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await login(page, h, password, '#/management');
    const message = page.getByRole('textbox', { name: '管理消息', exact: true });
    await message.fill('keep typing'); await page.keyboard.press('Control+k');
    await expect(page.locator('#console-scope-picker')).not.toBeVisible(); await expect(message).toBeFocused();
    await page.evaluate(() => { const modal = document.createElement('dialog'); modal.id = 'shortcut-test-modal'; modal.innerHTML = '<input aria-label="modal input">'; document.body.append(modal); modal.showModal(); });
    await page.keyboard.press('Control+k');
    await expect(page.locator('#console-scope-picker')).not.toBeVisible();
    await expect(page.locator('#shortcut-test-modal')).toBeVisible();
  } finally { await h.stop(); }
});
