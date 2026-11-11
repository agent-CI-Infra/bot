import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { managementFixture } from '../test/management-fixture.mjs';

async function fixture() {
  const f = await managementFixture(), close = f.close;
  f.close = async () => { await close(); rmSync(f.h.directory, { recursive: true, force: true }); }; return f;
}
async function login(page, f, project = '101') {
  await page.goto(f.h.admin + '/#/new-task/' + project);
  await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '提交任务', exact: true })).toBeEnabled();
}
async function fill(page) {
  await page.getByLabel('原始需求', { exact: true }).fill('请检查项目当前运行情况，并给出可追溯报告。');
  await page.getByLabel('任务目标', { exact: true }).fill('说明当前受阻原因和可执行的下一步。');
  await page.getByLabel('工作范围（每行一项）', { exact: true }).fill('当前项目的任务记录\n公开运行日志');
  await page.getByLabel('验收条件（每行一项）', { exact: true }).fill('每个结论引用原始记录\n未知信息明确标为未知');
}
const createCount = f => f.h.store.get("SELECT count(*) n FROM management_commands WHERE operation='task.create'").n;

test('new task uses a real management receipt, persists the contract and opens the task with its existing retry action', async ({ page }) => {
  const f = await fixture(), errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
    mkdirSync('.tmp/task-create-227', { recursive: true }); await login(page, f); await fill(page);
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if ([390, 1440].includes(width)) await page.screenshot({ path: `.tmp/task-create-227/form-${width}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务已创建', exact: true })).toBeVisible(); expect(createCount(f)).toBe(1);
    const receipt = f.h.store.get("SELECT * FROM management_commands WHERE operation='task.create'"), id = JSON.parse(receipt.result).id;
    const task = (await f.admin('/api/tasks/' + id)).value.task;
    expect(task.kind).toBe('task.request'); expect(JSON.parse(receipt.arguments).request).toContain('可追溯报告');
    expect(task.structured.contract.criteria).toEqual(['每个结论引用原始记录', '未知信息明确标为未知']);
    expect(task.structured.contract.endpoint).toBe('report'); expect(receipt.source_conversation).toBe('console:new-task');
    await page.getByRole('button', { name: '查看已创建的任务', exact: true }).click();
    await expect(page.locator('#task-view')).toBeVisible();
    // Pause through the same real management API used by the existing management-chat action.
    expect((await f.admin('/api/tasks/' + id + '/pause', 'POST', {})).status).toBe(201);
    await expect.poll(() => f.h.store.get('SELECT status FROM tasks WHERE id=?', id).status).toBe('paused');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT status FROM tasks WHERE id=?', id).status).toBe('queued');
    expect(createCount(f)).toBe(1); expect(errors).toEqual([]);
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: '再建一个任务', exact: true }).click();
    await expect(page.getByLabel('原始需求', { exact: true })).toHaveValue('');
  } finally { await f.close(); }
});

test('a read-only project grant cannot submit and logout clears drafts before the same user returns', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f); await fill(page);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
    await login(page, f); await expect(page.getByLabel('原始需求', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
    const reader = await f.member('task-reader', { repository_ids: ['101'] });
    f.h.store.run("UPDATE scoped_grants SET capabilities='[\"tasks.read\"]' WHERE principal_id=?", reader.id);
    await page.goto(f.h.admin + '/#/new-task/101');
    await page.getByLabel('用户名', { exact: true }).fill('task-reader'); await page.getByLabel('密码', { exact: true }).fill(reader.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('region', { name: '执行上下文', exact: true })).toContainText('没有创建此项目任务的权限');
    await expect(page.getByRole('button', { name: '提交任务', exact: true })).toBeDisabled(); expect(createCount(f)).toBe(0);
  } finally { await f.close(); }
});

test('a lost create response is reconciled with the original key across page navigation without another task', async ({ page }) => {
  const f = await fixture(); let lost = false; const keys = [];
  try {
    await login(page, f); await fill(page);
    await page.route('**/api/management/commands', async route => {
      keys.push(route.request().postDataJSON().idempotency_key);
      if (!lost) { lost = true; await route.fetch(); await route.abort('failed'); } else await route.continue();
    });
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '提交结果待核实', exact: true })).toBeVisible();
    await expect(page.getByLabel('原始需求', { exact: true })).toBeDisabled();
    await page.evaluate(() => { location.hash = '#/more'; }); await expect(page.getByRole('heading', { name: '更多功能' })).toBeVisible();
    await page.evaluate(() => { location.hash = '#/new-task/101'; });
    await page.getByRole('button', { name: '核对同一次提交', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务已创建', exact: true })).toBeVisible();
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(createCount(f)).toBe(1);
    expect(f.h.store.get('SELECT count(*) n FROM tasks').n).toBe(3);
  } finally { await f.close(); }
});

test('returning to a still-pending submission receives its original receipt without repainting a different project', async ({ page }) => {
  const f = await fixture(); let release = () => {};
  try {
    await login(page, f); await fill(page); const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/management/commands', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect.poll(() => createCount(f)).toBe(1);
    await page.getByLabel('任务项目', { exact: true }).selectOption('102');
    await expect(page.getByLabel('原始需求', { exact: true })).toHaveValue('');
    await page.getByLabel('任务项目', { exact: true }).selectOption('101');
    await expect(page.getByLabel('原始需求', { exact: true })).toBeDisabled();
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByRole('heading', { name: '任务已创建', exact: true })).toBeVisible(); expect(createCount(f)).toBe(1);
  } finally { release(); await f.close(); }
});

test('a configuration conflict preserves inputs and the next submit uses refreshed execution context', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f); await fill(page);
    f.h.store.run("UPDATE policies SET base_branch='changed-main' WHERE repository_id='101'");
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(page.locator('.task-create-feedback')).toContainText('management_revision_conflict');
    await expect(page.getByLabel('原始需求', { exact: true })).toHaveValue('请检查项目当前运行情况，并给出可追溯报告。');
    await expect(page.getByRole('button', { name: '提交任务', exact: true })).toBeEnabled(); expect(createCount(f)).toBe(0);
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务已创建', exact: true })).toBeVisible(); expect(createCount(f)).toBe(1);
  } finally { await f.close(); }
});

test('a pending approval is displayed without inventing a task and refresh reads the eventual receipt', async ({ page }) => {
  const f = await fixture();
  try {
    const tenant = f.h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
    f.h.store.run("INSERT INTO management_policies(tenant_id,approval_operations) VALUES(?,?) ON CONFLICT(tenant_id) DO UPDATE SET approval_operations=excluded.approval_operations", tenant, JSON.stringify(['task.create']));
    await login(page, f); await fill(page); await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '等待管理审批', exact: true })).toBeVisible();
    expect(f.h.store.get('SELECT count(*) n FROM tasks').n).toBe(2);
    await expect(page.getByRole('button', { name: '查看已创建的任务', exact: true })).toHaveCount(0);
    const receipt = f.h.store.get("SELECT * FROM management_commands WHERE operation='task.create'");
    const approved = await f.admin('/api/management/commands/' + receipt.id + '/approval', 'POST', { parameter_hash: receipt.parameter_hash, expected_revision: receipt.expected_revision, decision: 'approve' });
    expect(approved.value.state).toBe('succeeded');
    await page.getByRole('button', { name: '刷新创建回执', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务已创建', exact: true })).toBeVisible(); expect(createCount(f)).toBe(1);
  } finally { await f.close(); }
});

test('a forbidden software delivery does not create a task; read errors and revoked permissions clear stale content', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f); await fill(page); await page.getByLabel('交付类型', { exact: true }).selectOption('reviewable_pull_request');
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '创建未成功', exact: true })).toBeVisible();
    expect(f.h.store.get('SELECT count(*) n FROM tasks').n).toBe(2);
    await page.getByRole('button', { name: '返回草稿并重新核验', exact: true }).click();
    await page.route('**/api/management/query', route => route.fulfill({ status: 503, json: { error: 'context_unavailable' } }));
    await page.getByRole('button', { name: '重新读取执行上下文', exact: true }).click();
    await expect(page.getByRole('heading', { name: '执行上下文未能读取', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '提交任务', exact: true })).toBeDisabled();
    await page.unroute('**/api/management/query');
    await page.route('**/api/management/query', route => route.fulfill({ status: 403, json: { error: 'capability_forbidden' } }));
    await page.getByRole('button', { name: '重新读取执行上下文', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务创建权限已变化', exact: true })).toBeVisible();
    await expect(page.getByLabel('原始需求', { exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test('server preflight blocks a disabled project and a late context response cannot overwrite another project', async ({ page }) => {
  const f = await fixture(); let release = () => {};
  try {
    await login(page, f); f.h.store.run("UPDATE policies SET enabled=0 WHERE repository_id='101'");
    await page.getByRole('button', { name: '重新读取执行上下文', exact: true }).click();
    await expect(page.getByRole('region', { name: '执行上下文', exact: true })).toContainText('项目已禁用');
    await expect(page.getByRole('button', { name: '提交任务', exact: true })).toBeDisabled();
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/management/query', async route => {
      if (route.request().postDataJSON().target.project_id !== '101') return route.continue();
      const response = await route.fetch(); await gate; await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '重新读取执行上下文', exact: true }).click();
    await page.getByLabel('任务项目', { exact: true }).selectOption('102');
    await expect(page.getByRole('region', { name: '执行上下文', exact: true })).toContainText('admin-fixture-102');
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByRole('region', { name: '执行上下文', exact: true })).not.toContainText('admin-fixture-101');
    await expect(page.getByRole('button', { name: '提交任务', exact: true })).toBeEnabled(); expect(createCount(f)).toBe(0);
  } finally { release(); await f.close(); }
});
