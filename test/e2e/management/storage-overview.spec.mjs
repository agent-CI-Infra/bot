import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { account, harness, repository, setup } from '../../fixtures/helpers.mjs';
import { managerFixture } from '../../fixtures/project-manager-fixture.mjs';
import { storageScan } from '../../../runner/storage-scan.mjs';
import { browserEvidenceRoot } from '../../../dist/browser/evidence.js';
import { consoleNavigate } from '../helpers/console-navigation.mjs';

test('the administrator can inspect shares and reclaim expired files from storage settings', async ({ page }) => {
  const teardown = [], hooks = { after: cb => teardown.unshift(cb) }, manager = await managerFixture(hooks);
  const service = { async call(method, path, input) {
    if (path === '/v1/storage') return manager.projects.storage();
    if (path === '/v1/storage/retention') return manager.projects.setRetention(input);
    if (path === '/v1/storage/reclaim') return manager.projects.expiry.pass();
    return manager.manager.call(method, path, input);
  } };
  const h = await harness(hooks, service), { admin, password } = await setup(h), a = await account(admin);
  for (const id of ['101', '201']) await repository(admin, a.id, id);
  const knowledge = join(manager.projects.notesRoot, '101'), work = join(manager.root, 'work');
  mkdirSync(knowledge, { recursive: true }); writeFileSync(join(knowledge, 'guide.md'), Buffer.alloc(1536 * 1024, 1));
  mkdirSync(work); writeFileSync(join(work, 'artifact'), Buffer.alloc(3 * 1024 ** 2, 1));
  await manager.projects.refreshFootprint();
  manager.projects.db.prepare("INSERT OR IGNORE INTO resources VALUES('101',1,'fixture')").run();
  manager.projects.db.prepare("INSERT INTO computer_storage VALUES('101',1,?,?)").run(new Date().toISOString(), JSON.stringify(await storageScan(work)));
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  const root = browserEvidenceRoot(h.store), eligible = join(root, 'orphan-capture'), protectedDir = join(root, 'active-task');
  for (const dir of [eligible, protectedDir]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'capture.png'), Buffer.alloc(16384, 1)); }
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES('active-task','101','review.issue','running','Active work',1)");
  for (const [id, length] of [['101', 262144], ['201', 131072]]) {
    const directory = join(h.store.trajectories.root, id);
    mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'run.jsonl'), Buffer.alloc(length, 1));
  }
  try {
    // The isolated harness has no physical host provider. Supply just the machine reading for the
    // happy path; application allocations, project shares, saved policies and the cleanup are real.
    await page.route(/\/api\/storage$/, async route => {
      const response = await route.fetch(), json = await response.json();
      const owned = json.overview.total, total = 2 ** Math.ceil(Math.log2(owned * 5)), used = Math.floor(total * .62);
      json.overview.machine = { total, used, free: total - used, launchpad: owned, other: used - owned,
        filesystems: 2, measured_at: json.refreshed_at };
      await route.fulfill({ response, json });
    });
    await page.goto(h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await consoleNavigate(page, '全局设置');
    await page.locator('.project-nav').getByRole('link', { name: '存储', exact: true }).click();
    const shares = page.locator('section').filter({ has: page.getByRole('heading', { name: '项目空间占比' }) }).last();
    await expect(shares.getByRole('table')).toContainText('公共或未归属');
    await expect(page.locator('.storage-legend').last()).not.toContainText('尚未测得');
    const parent = page.locator('#settings-panel'), reclaim = parent.getByRole('button', { name: '立即回收' });
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await parent.getByRole('heading', { name: '整机磁盘' }).evaluate(el => el.scrollIntoView({ block: 'start' }));
      await page.evaluate(() => scrollBy(0, -85));
      await shares.scrollIntoViewIfNeeded();
      expect(await shares.getByRole('table').evaluate(el => el.scrollWidth <= el.parentElement.clientWidth + 1)).toBe(true);
    }
    await parent.getByText('保留天数与项目设置', { exact: true }).click();
    const override = parent.getByRole('spinbutton', { name: 'fixture/project-101 轨迹正文保留天数' });
    await override.scrollIntoViewIfNeeded();
    expect(await override.evaluate(el => {
      const table = el.closest('.storage-overrides').getBoundingClientRect(), box = el.getBoundingClientRect();
      return box.left >= table.left && box.right <= table.right;
    })).toBe(true);
    const days = parent.getByLabel('manager 重复正文保留天数');
    await days.focus(); await days.press('ControlOrMeta+a'); await days.press('Backspace'); await days.pressSequentially('14');
    await parent.getByRole('button', { name: '保存清理设置' }).click();
    await expect(parent.getByText('已保存，下一次每日清理按新设置执行。')).toBeVisible();
    await parent.getByText('保留天数与项目设置', { exact: true }).click();
    await reclaim.focus(); await reclaim.press('Enter');
    await expect(reclaim).toBeDisabled(); await expect(reclaim).toBeEnabled();
    await expect(parent.getByText(/已清理 1 项/)).toBeVisible();
    await parent.getByText('保留天数与项目设置', { exact: true }).click();
    await expect(parent.locator('.storage-settings')).toContainText('浏览器证据 1 个目录');
    await parent.getByText('保留天数与项目设置', { exact: true }).click();
    expect(existsSync(eligible)).toBe(false); expect(existsSync(protectedDir)).toBe(true);
    await reclaim.click(); await expect(parent.getByText(/没有可回收内容/)).toBeVisible();
    // Let any storage refresh finish before removing the route and reloading.
    await page.unrouteAll({ behavior: 'wait' });
    await page.reload();
    await expect(parent.getByText(/整机容量未知/)).toBeVisible();
    expect(errors).toEqual([]);
  } finally { for (const finish of teardown) await finish(); }
});
