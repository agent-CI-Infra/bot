import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { managerFixture } from '../../fixtures/project-manager-fixture.mjs';
import { RuleService } from '../../../dist/rules/service.js';
import { consoleSave, rereadMachine, openSaveAdvanced } from '../helpers/console-save.mjs';

async function fixture() {
  const cleanup = [], manager = await managerFixture({ after: action => cleanup.push(action) });
  const h = await harness(undefined, manager.manager);
  const close = async () => {
    await h.stop(); for (const action of cleanup) await action(); rmSync(h.directory, { recursive: true, force: true });
  };
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await h.projects.reconcile();
    const saved = await admin('/api/environments/101/configure', 'POST', {
      operation_id: randomBytes(24).toString('hex'), generation: 1, spec: { cpus: 3 }
    });
    expect(saved.status).toBe(201);
    // The default branch still has a .bot/computer.yaml; since #935 it is only a name and changes nothing here.
    new RuleService(h.store).cache('101', 'a'.repeat(40), { '.bot/computer.yaml': '' });
    return { h, password, manager, close };
  } catch (err) { await close(); throw err; }
}
async function login(page, f) {
  await page.goto(f.h.admin + '/#/projects/101/machine');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.machine-config-card')).toBeVisible();
}
const configField = (page, name) => page.locator('.machine-config-field').filter({ has: page.getByLabel(name, { exact: true }) });

test('each machine field names its own source and target, and the same groups remain usable at six widths', async ({ page }) => {
  const f = await fixture(), errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
    await login(page, f);
    await expect(configField(page, 'CPU（核）')).toContainText('已保存来源：项目控制台');
    await expect(configField(page, '内存（MB）')).toContainText('已保存来源：全局默认');
    await expect(configField(page, '内存（MB）')).toContainText('配置目标 4096 · 电脑报告 4096');
    await expect(configField(page, '进程数上限')).toContainText('已保存来源：全局默认');
    await expect(page.locator('.machine-config-impact')).toContainText('工作卷、笔记和代次保留');
    await expect(page.locator('.machine-config-card')).toContainText('仓库里的 .bot/computer.yaml 不再读取');
    await expect(page.locator('#project-page')).not.toContainText('仓库文件');
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const name of ['资源上限', '软件与初始化', '网络与环境变量', '保存影响']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByLabel('环境变量', { exact: true }).fill('MODE=test');
      await expect(page.locator('.machine-config-draft')).toContainText('环境变量');
    }
    await page.getByLabel('CPU（核）', { exact: true }).fill('4');
    await expect(page.locator('.machine-config-draft')).toContainText('CPU');
    await expect(configField(page, 'CPU（核）')).toContainText('配置目标 3');
    await page.getByRole('button', { name: '刷新电脑状态', exact: true }).click();
    await expect(page.getByLabel('CPU（核）', { exact: true })).toHaveValue('4');
    await expect(page.locator('.machine-config-draft')).toContainText('CPU');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('a stale generation retains the grouped draft and an explicit retry saves through the existing operation', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f); const form = page.locator('.machine-config-card');
    await page.getByLabel('CPU（核）', { exact: true }).fill('4');
    await page.route('**/api/environments/101/configure', route => route.fulfill({ status: 409, json: { error: 'stale_generation' } }));
    await consoleSave(page).click();
    await expect(form.locator('[role=alert]')).toContainText('stale_generation');
    await expect(page.getByLabel('CPU（核）', { exact: true })).toHaveValue('4');
    expect(f.manager.projects.own('101').cpus).toBe(3);
    await rereadMachine(page);
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByLabel('CPU（核）', { exact: true })).toHaveValue('4');
    await page.unroute('**/api/environments/101/configure');
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    expect(f.manager.projects.own('101').cpus).toBe(4);
    await expect(page.locator('.machine-config-draft')).toHaveText('已保存');
  } finally { await f.close(); }
});

test('an unreadable saved spec prevents saving until an explicit read succeeds', async ({ page }) => {
  const f = await fixture();
  try {
    await page.route('**/api/repositories/101/rules', route => route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } }));
    await login(page, f);
    await expect(page.locator('.machine-config-card')).toContainText('已保存的机器配置读取失败');
    await expect(page.getByLabel('CPU（核）', { exact: true })).toBeDisabled();
    // The computer spec has no save while unread; only「同时运行的任务」keeps its own (clean, so hidden) bar.
    await expect(page.locator('.machine-config-card').getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
    await expect(consoleSave(page)).toBeHidden();
    await page.unroute('**/api/repositories/101/rules');
    await rereadMachine(page);
    await expect(page.getByLabel('CPU（核）', { exact: true })).toBeEnabled();
    await expect(configField(page, '内存（MB）')).toContainText('已保存来源：全局默认');
  } finally { await f.close(); }
});

// The machine form no longer waits for the default branch (#935): nothing in the repository adds to the saved spec.
test('a default branch the bot never read leaves the machine form editable and reads nothing from it', async ({ page }) => {
  const f = await fixture();
  try {
    f.h.store.run('DELETE FROM repository_rule_sources WHERE repository_id=?', '101');
    let refreshes = 0; page.on('request', request => { if (request.url().endsWith('/api/repositories/101/rules/refresh')) refreshes++; });
    await login(page, f);
    const form = page.locator('.machine-config-card');
    await expect(page.getByLabel('CPU（核）', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('CPU（核）', { exact: true })).toHaveValue('3');
    await expect(form).not.toContainText('尚未读取默认分支');
    for (const origin of await form.locator('.machine-config-origin').allTextContents()) expect(origin).toContain('已保存来源');
    await page.getByLabel('CPU（核）', { exact: true }).fill('4');
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    expect(f.manager.projects.own('101').cpus).toBe(4); expect(refreshes).toBe(0);
  } finally { await f.close(); }
});

// A number the field cannot accept must be refused, never read as an explicit "follow the global default".
test('an unparseable number is refused with a field error instead of clearing the project override', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    let configures = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/environments/101/configure')) configures++; });
    const cpu = page.getByLabel('CPU（核）', { exact: true }), error = configField(page, 'CPU（核）').locator('.machine-config-error');
    await expect(cpu).toHaveValue('3');
    // A resource field keeps what was typed (#865): the typo is visible in the field, not silently dropped by the browser.
    await cpu.fill(''); await page.keyboard.type('abc');
    await expect(cpu).toHaveValue('abc');
    await consoleSave(page).click();
    await expect(error).toBeVisible(); await expect(error).toHaveText('这个字段只能填数字');
    await expect(cpu).toHaveAttribute('aria-invalid', 'true');
    expect(configures).toBe(0);
    expect(f.manager.projects.own('101').cpus).toBe(3);
    await cpu.fill('5');
    await expect(error).toBeHidden();
    await expect(cpu).toHaveAttribute('aria-invalid', 'false');
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    expect(f.manager.projects.own('101').cpus).toBe(5);
  } finally { await f.close(); }
});

test('an explicitly cleared resource field says it follows the global default and saves null', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    let spec = null;
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/environments/101/configure')) spec = JSON.parse(request.postData()).spec;
    });
    const cpu = page.getByLabel('CPU（核）', { exact: true }), field = configField(page, 'CPU（核）'), follow = field.locator('.machine-config-follow');
    await expect(follow).toBeHidden();
    await cpu.fill('');
    await expect(follow).toBeVisible(); await expect(follow).toHaveText('留空即跟随全局默认');
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    expect(spec).toEqual({ cpus: null });
  } finally { await f.close(); }
});

test('a rejected entry can be cleared explicitly, and that clear follows the global default', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    let spec = null;
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/environments/101/configure')) spec = JSON.parse(request.postData()).spec;
    });
    const cpu = page.getByLabel('CPU（核）', { exact: true }), field = configField(page, 'CPU（核）');
    await cpu.fill(''); await page.keyboard.type('abc');
    // The refused text stays on screen until the clear button replaces it (#865).
    await expect(cpu).toHaveValue('abc');
    await expect(field.locator('.machine-config-error')).toBeVisible();
    await expect(field.locator('.machine-config-follow')).toBeHidden();
    await field.getByRole('button', { name: '清空并跟随全局默认', exact: true }).click();
    await expect(field.locator('.machine-config-error')).toBeHidden();
    await expect(field.locator('.machine-config-follow')).toBeVisible();
    await expect(cpu).toHaveValue('');
    await expect(cpu).not.toHaveAttribute('aria-invalid', 'true');
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    expect(spec).toEqual({ cpus: null });
  } finally { await f.close(); }
});

test('a resource the default branch .bot/computer.yaml used to set is cleared like any other, to the global default', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    let spec = null;
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/environments/101/configure')) spec = JSON.parse(request.postData()).spec;
    });
    const cpu = page.getByLabel('CPU（核）', { exact: true }), field = configField(page, 'CPU（核）');
    await expect(cpu).toHaveValue('3');
    await cpu.fill('');
    await expect(field.locator('.machine-config-follow')).toHaveText('留空即跟随全局默认');
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    expect(spec).toEqual({ cpus: null });
    await cpu.fill(''); await page.keyboard.type('abc');
    await expect(field.locator('.machine-config-error')).toHaveText('这个字段只能填数字');
    await expect(field.getByRole('button', { name: '清空并跟随全局默认', exact: true })).toBeVisible();
  } finally { await f.close(); }
});

// A refusal must also survive the paths that look like an explicit clear: a paste fires `beforeinput` with the refused
// text and then `input` with an empty value, and Backspace in an already empty field fires only a delete (#903).
test('a pasted non-number is refused, sends no configure and keeps the saved spec', async ({ page, context }) => {
  const f = await fixture();
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await login(page, f);
    let configures = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/environments/101/configure')) configures++; });
    const cpu = page.getByLabel('CPU（核）', { exact: true }), field = configField(page, 'CPU（核）'), error = field.locator('.machine-config-error');
    await cpu.fill('');
    await page.evaluate(() => navigator.clipboard.writeText('abc'));
    await cpu.click(); await page.keyboard.press('Control+V');
    await expect(cpu).toHaveValue('');
    await expect(error).toBeVisible(); await expect(error).toHaveText('这个字段只能填数字');
    await expect(cpu).toHaveAttribute('aria-invalid', 'true');
    await expect(field.locator('.machine-config-follow')).toBeHidden();
    await consoleSave(page).click();
    expect(configures).toBe(0);
    expect(f.manager.projects.own('101').cpus).toBe(3);
    // A value the field accepts ends the refusal, and that value saves normally.
    await cpu.fill('6');
    await expect(error).toBeHidden();
    await expect(cpu).toHaveAttribute('aria-invalid', 'false');
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    expect(configures).toBe(1);
    expect(f.manager.projects.own('101').cpus).toBe(6);
  } finally { await f.close(); }
});

test('Backspace in a refused empty field keeps the refusal, sends no configure and keeps the saved spec', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    let configures = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/environments/101/configure')) configures++; });
    const cpu = page.getByLabel('CPU（核）', { exact: true }), field = configField(page, 'CPU（核）'), error = field.locator('.machine-config-error');
    await cpu.fill(''); await page.keyboard.type('abc');
    await expect(error).toBeVisible();
    // The field now holds the refused text, and this Backspace removes one letter of it: the refusal stays (#865).
    await page.keyboard.press('Backspace');
    await expect(error).toBeVisible(); await expect(error).toHaveText('这个字段只能填数字');
    await expect(cpu).toHaveValue('ab');
    await expect(cpu).toHaveAttribute('aria-invalid', 'true');
    await consoleSave(page).click();
    expect(configures).toBe(0);
    expect(f.manager.projects.own('101').cpus).toBe(3);
    // The explicit clear button is the way out of a refused field.
    await field.getByRole('button', { name: '清空并跟随全局默认', exact: true }).click();
    await expect(error).toBeHidden();
    await expect(field.locator('.machine-config-follow')).toHaveText('留空即跟随全局默认');
  } finally { await f.close(); }
});

// A paste over the saved value drops the selection together with the discarded text, so the field ends up empty
// although the entry was refused; that empty field must not pass for an explicit clear (#903 review B1).
test('a non-number pasted over the saved value keeps the refusal, sends no configure and keeps the saved spec', async ({ page, context }) => {
  const f = await fixture();
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await login(page, f);
    let configures = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/environments/101/configure')) configures++; });
    const cpu = page.getByLabel('CPU（核）', { exact: true }), field = configField(page, 'CPU（核）'), error = field.locator('.machine-config-error');
    await expect(cpu).toHaveValue('3');
    await page.evaluate(() => navigator.clipboard.writeText('abc'));
    await cpu.click(); await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+v');
    // The paste replaces the selection with its own text, and that text stays visible — nothing was explicitly cleared.
    await expect(cpu).toHaveValue('abc');
    await expect(error).toBeVisible(); await expect(error).toHaveText('这个字段只能填数字');
    await expect(cpu).toHaveAttribute('aria-invalid', 'true');
    await expect(field.locator('.machine-config-follow')).toBeHidden();
    await consoleSave(page).click();
    expect(configures).toBe(0);
    expect(f.manager.projects.own('101').cpus).toBe(3);
    // A value the field accepts ends the refusal, and only then does a save go out.
    await cpu.fill('4');
    await expect(error).toBeHidden();
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    expect(configures).toBe(1);
    expect(f.manager.projects.own('101').cpus).toBe(4);
  } finally { await f.close(); }
});

// #944/#865: a text field keeps the refused letter visible, so the save refuses it and the override stays as saved;
// deleting that letter returns the field to the accepted number without clearing anything.
test('a refused field refuses the save, and deleting the offending letter saves the number', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    let configures = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/environments/101/configure')) configures++; });
    const cpu = page.getByLabel('CPU（核）', { exact: true }), field = configField(page, 'CPU（核）'), error = field.locator('.machine-config-error');
    await cpu.fill('4');
    await expect(consoleSave(page)).toBeVisible();
    await cpu.focus(); await page.keyboard.press('End'); await page.keyboard.type('a');
    await expect(cpu).toHaveValue('4a');
    await expect(error).toBeVisible();
    await expect(error).toHaveText('这个字段只能填数字');
    await expect(cpu).toHaveAttribute('aria-invalid', 'true');
    await consoleSave(page).click();
    expect(configures).toBe(0);
    expect(f.manager.projects.own('101').cpus).toBe(3);
    // Deleting the refused letter leaves the accepted number, and that number then saves normally.
    await page.keyboard.press('Backspace');
    await expect(cpu).toHaveValue('4');
    await expect(error).toBeHidden();
    await consoleSave(page).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    expect(configures).toBe(1);
    expect(f.manager.projects.own('101').cpus).toBe(4);
    await expect(error).toBeHidden();
  } finally { await f.close(); }
});

test('a refused field keeps the saved number when the offending letter is deleted, without clearing the override', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    let configures = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/environments/101/configure')) configures++; });
    const cpu = page.getByLabel('CPU（核）', { exact: true }), field = configField(page, 'CPU（核）'), error = field.locator('.machine-config-error');
    await expect(cpu).toHaveValue('3');
    await cpu.focus(); await page.keyboard.press('End'); await page.keyboard.type('a');
    await expect(cpu).toHaveValue('3a');
    await expect(error).toBeVisible();
    // The refused entry is unsaved state; deleting it returns the field to the saved 3, which needs no new configure.
    await page.keyboard.press('Backspace');
    await expect(cpu).toHaveValue('3');
    await expect(error).toBeHidden();
    await expect(page.locator('.machine-config-draft')).toHaveText('已保存');
    expect(configures).toBe(0);
    expect(f.manager.projects.own('101').cpus).toBe(3);
  } finally { await f.close(); }
});
