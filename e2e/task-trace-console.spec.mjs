import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

async function fixture() {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  for (const id of ['trace-page', 'other-trace']) h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase) VALUES(?,'101','review.pr','failed',?,7,'model')", id, id);
  for (let i = 0; i < 215; i++) h.store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)', 'line-' + i, 'trace-page',
    JSON.stringify({ type: 'model', step: i + 1, content: 'Public output ' + i, reasoning: 'PRIVATE_REASONING_SENTINEL' }), '2026-11-11T00:00:00Z');
  h.store.run("INSERT INTO task_logs(id,task_id,content) VALUES('other-line','other-trace',?)", JSON.stringify({ type: 'model', content: 'Other task public output' }));
  return { h, password, close: async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); } };
}
async function login(page, f) {
  await page.goto(f.h.admin + '/#/inbox/101');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
const open = (page, id) => page.locator(`[data-task-id="${id}"]`).getByRole('button', { name: '查看任务', exact: true }).click();

test('task logs load a bounded recent page, load earlier evidence on demand and retain expanded output', async ({ page }) => {
  const f = await fixture(), errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
    mkdirSync('.tmp/task-trace-227', { recursive: true });
    await login(page, f); await open(page, 'trace-page');
    await expect(page.locator('#timeline .step')).toHaveCount(100);
    await expect(page.locator('#timeline')).not.toContainText('Public output 0');
    await expect(page.locator('#timeline')).toContainText('Public output 214');
    await expect(page.locator('#task-view')).not.toContainText('PRIVATE_REASONING_SENTINEL');
    await expect(page.locator('#task-log-controls')).toContainText('还有更早记录');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `.tmp/task-trace-227/paging-${width}.png` });
    }
    await page.getByRole('button', { name: '加载更早日志', exact: true }).click();
    await expect(page.locator('#timeline .step')).toHaveCount(200);
    await page.getByRole('button', { name: '加载更早日志', exact: true }).click();
    await expect(page.locator('#timeline .step')).toHaveCount(215);
    await expect(page.getByRole('button', { name: '加载更早日志', exact: true })).toBeHidden();
    f.h.store.run("INSERT INTO task_logs(id,task_id,content) VALUES('increment','trace-page',?)", JSON.stringify({ type: 'command', command: 'npm test', output: 'Incremental public result', exit_code: 0 }));
    await page.getByRole('button', { name: '刷新任务', exact: true }).click();
    const output = page.locator('#timeline details').filter({ hasText: 'Incremental public result' });
    await expect(output).toHaveAttribute('open', '');
    await page.getByRole('button', { name: '刷新任务', exact: true }).click(); await expect(output).toHaveAttribute('open', '');
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.locator('#task-view').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      if (width === 390 || width === 1440) await page.screenshot({ path: `.tmp/task-trace-227/detail-${width}.png` });
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('a log outage keeps readable evidence, while a revoked task read clears all previous private detail', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f); await open(page, 'trace-page'); await expect(page.locator('#timeline .step')).toHaveCount(100);
    await page.route('**/api/tasks/trace-page/logs?*', route => route.fulfill({ status: 503, json: { error: 'logs_unavailable' } }));
    await page.getByRole('button', { name: '刷新任务', exact: true }).click();
    await expect(page.locator('#task-log-controls [role=alert]')).toContainText('logs_unavailable');
    await expect(page.locator('#timeline .step')).toHaveCount(100);
    await page.unroute('**/api/tasks/trace-page/logs?*'); await page.getByRole('button', { name: '重新读取日志', exact: true }).click();
    await expect(page.locator('#task-log-controls [role=alert]')).toBeEmpty();
    await page.route('**/api/tasks/trace-page/retry', route => route.fulfill({ status: 409, json: { error: 'task_already_running' } }));
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    await expect(page.locator('#task-error')).toContainText('不用再次重试');
    await page.route('**/api/tasks/trace-page', route => route.fulfill({ status: 403, json: { error: 'repository_forbidden' } }));
    await page.getByRole('button', { name: '刷新任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务暂不可访问', exact: true })).toBeVisible();
    await expect(page.locator('#timeline .step')).toHaveCount(0); await expect(page.locator('#task-side')).toBeEmpty();
    await page.unroute('**/api/tasks/trace-page');
    // The same open dialog recovers on its regular poll, rebuilding logs and the complete action bar.
    await expect(page.locator('#timeline .step')).toHaveCount(100, { timeout: 10000 });
    await expect(page.getByRole('button', { name: '刷新任务', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await expect(page.locator('#task-side')).not.toBeEmpty();
    await page.keyboard.press('Escape'); await open(page, 'trace-page');
    await expect(page.locator('#timeline .step')).toHaveCount(100);
    await expect(page.getByRole('button', { name: '刷新任务', exact: true })).toBeVisible();
  } finally { await f.close(); }
});

test('a log response received after closing the dialog cannot repaint the next selected task', async ({ page }) => {
  const f = await fixture(); let release = () => {};
  try {
    await login(page, f);
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/tasks/trace-page/logs', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
    await open(page, 'trace-page'); await expect(page.locator('#task-view')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('#task-view')).toBeHidden();
    await open(page, 'other-trace'); await expect(page.locator('#timeline')).toContainText('Other task public output');
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('#timeline')).toContainText('Other task public output');
    await expect(page.locator('#timeline')).not.toContainText('Public output 214');
  } finally { release(); await f.close(); }
});
