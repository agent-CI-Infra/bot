import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

async function fixture(page) {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,error_code,phase,input) VALUES('summary-wait','101','task.request','waiting_configuration','检查发布文档中的版本号','model_not_configured','prepare','{}')");
  h.store.run("INSERT INTO task_logs(id,task_id,content) VALUES('summary-fault','summary-wait',?)", JSON.stringify({ type: 'fault', code: 'model_not_configured', detail: '还没有选择执行模型' }));
  h.store.run("UPDATE task_metrics SET runtime_ms=0,active_since=NULL,complete=0 WHERE task_id='summary-wait'");
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,phase,input,result) VALUES('summary-done','101','task.request','completed','检查版本记录','complete','{}',?)", JSON.stringify({ summary: '已经对照仓库版本记录完成核查。' }));
  h.store.run("UPDATE task_metrics SET runtime_ms=65000,active_since=NULL,complete=1 WHERE task_id='summary-done'");
  await page.goto(h.admin + '/#/inbox/101');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  return { h, close: async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); } };
}

test('task summary puts recorded goal, outcome, faults and duration before optional execution details', async ({ page }) => {
  const f = await fixture(page), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.evaluate(() => openTask('summary-wait'));
    const side = page.locator('#task-side');
    await expect(side.locator('.task-overview')).toContainText('检查发布文档中的版本号');
    await expect(side.locator('.task-overview')).toContainText('执行耗时未记录');
    await expect(side.locator('.task-overview')).not.toContainText('0 秒');
    await expect(side.locator('.task-attention')).toContainText('还没有选择执行模型');
    await expect(side.locator('.task-outcome')).toContainText('尚未产生任务结果');
    await expect(page.locator('#task-actions').getByRole('button', { name: '打开项目模型配置', exact: true })).toBeVisible();
    await expect(side.locator('details[open]')).toHaveCount(0);
    await expect(side.locator('.task-execution')).toBeHidden();
    await side.locator('summary').filter({ hasText: /^执行者与完整委派$/ }).click();
    await expect(side.locator('.task-execution')).toBeVisible();
    await page.evaluate(() => openTask('summary-done'));
    await expect(side.locator('.task-overview')).toContainText('执行耗时1 分 5 秒');
    await expect(side.locator('.task-outcome')).toContainText('已经对照仓库版本记录完成核查');
    // A completed state alone must not fabricate a passing QA record.
    await expect(page.locator('#task-next')).toContainText('没有读取到当前候选的有效独立 QA 通过记录');
    mkdirSync('.tmp/task-summary-576', { recursive: true });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(side.locator('.task-overview')).toBeInViewport();
      await expect(side.locator('.task-outcome')).toBeInViewport();
      expect(await page.locator('#task-view').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.querySelector('#task-layout').firstElementChild.id)).toBe('task-side');
      await page.screenshot({ path: `.tmp/task-summary-576/summary-${width}.png` });
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('refresh keeps expanded task evidence, reading position and an unfinished priority edit', async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.evaluate(() => openTask('summary-wait'));
    const side = page.locator('#task-side');
    await side.locator('summary').filter({ hasText: /^完整目标、候选与验收证据$/ }).click();
    await side.locator('summary').filter({ hasText: /^原始数据$/ }).click();
    await page.getByLabel('任务优先级', { exact: true }).selectOption('P1');
    await side.locator('.task-overview').click();
    await page.evaluate(() => refreshTask());
    await expect(page.getByLabel('任务优先级', { exact: true })).toHaveValue('P1');
    await page.getByLabel('优先级调整理由', { exact: true }).fill('发布前必须确认版本号');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await side.locator('.task-facts').evaluate(node => {
        const side = document.querySelector('#task-side'), panel = getComputedStyle(side).overflowY === 'auto' ? side : side.parentElement;
        panel.scrollTop += node.getBoundingClientRect().top - panel.getBoundingClientRect().top + 70;
      });
      const before = await side.locator('.task-facts').evaluate(node => node.getBoundingClientRect().top);
      // The response actually changes content above the reader's open evidence.
      f.h.store.run("UPDATE task_logs SET content=? WHERE id='summary-fault'", JSON.stringify({ type: 'fault', code: 'model_not_configured', detail: '等待维护人选择模型。'.repeat(width === 1440 ? 10 : 20) }));
      await page.evaluate(() => refreshTask());
      await expect(side.locator('.task-facts')).toBeVisible();
      await expect(side.locator('details.raw')).toHaveAttribute('open', '');
      const after = await side.locator('.task-facts').evaluate(node => node.getBoundingClientRect().top);
      expect(Math.abs(after - before)).toBeLessThan(2);
      await expect(page.getByLabel('任务优先级', { exact: true })).toHaveValue('P1');
      await expect(page.getByLabel('优先级调整理由', { exact: true })).toHaveValue('发布前必须确认版本号');
    }
    // Opening a different task does not inherit the previous task's expansion or draft.
    await page.evaluate(() => openTask('summary-done'));
    await expect(side.locator('details[open]')).toHaveCount(0);
    await expect(page.getByLabel('优先级调整理由', { exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});
