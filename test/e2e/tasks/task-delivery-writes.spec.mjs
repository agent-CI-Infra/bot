import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { TaskCommands } from '../../../dist/tasks/commands.js';
import { grantTaskWrites } from '../../../dist/tasks/grants.js';
import { traceEvent } from '../../../dist/tasks/trace.js';

// #814: a generic task's details show what it may deliver, how its writes changed and which delivery tools each run had;
// the project's capability ceiling form carries the QA gate before a PR.
const shots = process.env.BOT_E2E_SCREENSHOTS;
const login = async (page, url, password) => {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
};

test('task details show the granted writes, their changes and each run\'s delivery tools', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    h.store.run("UPDATE policies SET capability_ceiling='develop',development_enabled=1 WHERE repository_id='101'");
    const operator = { id: 'administrator', role: 'super_admin', repositories: [] };
    const { id } = new TaskCommands(h.store).api(operator, 'POST', new URL('http://local/api/tasks'), { repository_id: '101', request: 'Find out why add(2, 3) is wrong',
      contract: { goal: 'Find out why add(2, 3) is wrong', scope: ['calc.mjs'], criteria: ['add(2, 3) returns 5'], endpoint: 'report' } });
    h.store.run("UPDATE tasks SET status='paused' WHERE id=?", id);
    traceEvent(h.store, id, 'delivery_tools', { role: 'dev', run_id: 'run-1', attempt: 1, tools: ['submit_report'] }, null, 'framework');
    grantTaskWrites(h.store, h.store.get('SELECT * FROM tasks WHERE id=?', id), { writes: ['pull_request'], reason: '报告发现 calc.mjs 需要改，在同一个任务里开 PR' }, 'role:manager', []);
    traceEvent(h.store, id, 'delivery_tools', { role: 'dev', run_id: 'run-2', attempt: 1, tools: ['submit_report', 'open_pull_request'] }, null, 'framework');
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/projects/101/inbox', password);
    await page.locator(`[data-task-id="${id}"]`).getByRole('button', { name: '查看任务', exact: true }).click();
    // The task page keeps these records in its folded archive section (#952): open it as a person would.
    await page.locator('details.task-archive-fold > summary').click();
    const card = page.locator('#task-side section').filter({ hasText: '授权写入与交付工具' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('已授予开或更新 bot PR');
    await expect(card).toContainText('交付工具交报告、开 PR');
    await expect(card).toContainText('开 PR 前需要独立 QA 通过');
    await expect(card).toContainText('授予 开或更新 bot PR · 角色 manager：报告发现 calc.mjs 需要改');
    await expect(card).toContainText('创建时授予 无（只能交报告） · 人工 administrator');
    await expect(card).toContainText('第 1 次尝试 · dev · 交报告、开 PR');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await card.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // The card scrolls nothing sideways inside the task view either (a long person id once did at 390 px).
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/task-writes-${width}.png` }); }
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('the capability ceiling form turns the QA gate before a PR off and on', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/projects/101/triggers', password);
    const gate = page.getByLabel('普通任务开 PR 前需要独立 QA 通过', { exact: true });
    await expect(gate).toBeChecked();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await gate.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (shots) await page.screenshot({ path: `${shots}/qa-gate-${width}.png` });
    }
    await gate.uncheck();
    await page.getByRole('button', { name: '保存能力上限', exact: true }).click();
    await expect.poll(async () => (await admin('/api/repositories/101')).value.policy.delivery_gates).toEqual({ pull_request_qa: false });
    // The ceiling itself is unchanged when only the gate is saved.
    expect((await admin('/api/repositories/101')).value.policy.capability_ceiling).toBe('read');
    await page.reload(); await expect(gate).not.toBeChecked();
    await gate.check(); await page.getByRole('button', { name: '保存能力上限', exact: true }).click();
    await expect.poll(async () => (await admin('/api/repositories/101')).value.policy.delivery_gates).toEqual({ pull_request_qa: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
