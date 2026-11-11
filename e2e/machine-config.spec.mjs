import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { managerFixture } from '../test/project-manager-fixture.mjs';
import { RuleService } from '../dist/rules/service.js';

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
    new RuleService(h.store).cache('101', 'a'.repeat(40), { '.bot/computer.yaml': 'memory_mb: 8192\n' });
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
    await expect(configField(page, '内存（MB）')).toContainText('已保存来源：仓库文件');
    await expect(configField(page, '内存（MB）')).toContainText('配置目标 8192 · 电脑报告 4096');
    await expect(configField(page, '进程数上限')).toContainText('已保存来源：全局默认');
    await expect(page.locator('.machine-config-impact')).toContainText('工作卷、笔记和代次保留');
    await expect(page.locator('.machine-config-impact')).toContainText('仓库仅覆盖写明的字段');
    mkdirSync('.tmp/machine-config-231/previews', { recursive: true });
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const name of ['资源上限', '软件与初始化', '网络与环境变量', '保存影响']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByLabel('环境变量', { exact: true }).fill('MODE=test');
      await expect(page.locator('.machine-config-draft')).toContainText('环境变量');
      if ([390, 1440].includes(width)) await page.screenshot({ path: `.tmp/machine-config-231/previews/machine-${width}.png`, fullPage: true });
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
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form.locator('[role=alert]')).toContainText('stale_generation');
    await expect(page.getByLabel('CPU（核）', { exact: true })).toHaveValue('4');
    expect(f.manager.projects.own('101').cpus).toBe(3);
    await page.unroute('**/api/environments/101/configure');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    expect(f.manager.projects.own('101').cpus).toBe(4);
    await expect(page.locator('.machine-config-draft')).toHaveText('本组没有待保存改动。');
  } finally { await f.close(); }
});

test('an unread rule source prevents saving until an explicit read succeeds', async ({ page }) => {
  const f = await fixture();
  try {
    await page.route('**/api/repositories/101/rules', route => route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } }));
    await login(page, f);
    await expect(page.locator('.machine-config-card')).toContainText('规则来源读取失败');
    await expect(page.getByLabel('CPU（核）', { exact: true })).toBeDisabled();
    await expect(page.locator('.machine-config-card').getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
    await page.unroute('**/api/repositories/101/rules');
    await page.getByRole('button', { name: '重新读取电脑配置', exact: true }).click();
    await expect(page.getByLabel('CPU（核）', { exact: true })).toBeEnabled();
    await expect(configField(page, '内存（MB）')).toContainText('已保存来源：仓库文件');
  } finally { await f.close(); }
});
