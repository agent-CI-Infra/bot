import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';
import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { managementFixture } from '../../fixtures/management-fixture.mjs';

async function fixture() {
  const f = await managementFixture(), close = f.close;
  f.close = async () => { await close(); rmSync(f.h.directory, { recursive: true, force: true }); }; return f;
}
async function login(page, f, project = '101') {
  await page.goto(f.h.admin + '/#/projects/' + project + '/new-task');
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

test('the mobile project overview keeps a compact new-task entry and carries the current project into the form', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f); await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { location.hash = '#/projects/101/overview'; });
    await expect(page.locator('.workspace-overview')).toBeVisible();
    const entry = page.locator('.workspace-overview').getByRole('link', { name: '+ 新建任务', exact: true });
    await expect(entry).toHaveAttribute('href', '#/projects/101/new-task'); await expect(entry).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await entry.click(); await expect(page.locator('#console-page h1')).toHaveText('新建任务');
    await expect(page.getByRole('button', { name: '提交任务', exact: true })).toBeEnabled();
  } finally { await f.close(); }
});

test('new task uses a real management receipt, persists the contract and opens the task with its existing retry action', async ({ page }) => {
  const f = await fixture(), errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
     await login(page, f); await fill(page);
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
    await page.goto(f.h.admin + '/#/projects/101/new-task');
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
    await page.evaluate(() => { location.hash = '#/costs'; }); await expect(page.getByRole('heading', { name: '用量与成本', exact: true })).toBeVisible();
    await page.evaluate(() => { location.hash = '#/projects/101/new-task'; });
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
    await switchConsoleProject(page, '102');
    await expect(page.getByLabel('原始需求', { exact: true })).toHaveValue('');
    await switchConsoleProject(page, '101');
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

test('a leftover approval policy does not hold task creation back', async ({ page }) => {
  const f = await fixture();
  try {
    const tenant = f.h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
    f.h.store.run("INSERT INTO management_policies(tenant_id,approval_operations) VALUES(?,?) ON CONFLICT(tenant_id) DO UPDATE SET approval_operations=excluded.approval_operations", tenant, JSON.stringify(['task.create']));
    await login(page, f); await fill(page); await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务已创建', exact: true })).toBeVisible(); expect(createCount(f)).toBe(1);
    await expect(page.getByText('等待管理审批')).toHaveCount(0);
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
    await switchConsoleProject(page, '102');
    await expect(page.getByRole('region', { name: '执行上下文', exact: true })).toContainText('admin-fixture-102');
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByRole('region', { name: '执行上下文', exact: true })).not.toContainText('admin-fixture-101');
    await expect(page.getByRole('button', { name: '提交任务', exact: true })).toBeEnabled(); expect(createCount(f)).toBe(0);
  } finally { release(); await f.close(); }
});

test('a code delivery in a project below the develop capability ceiling is refused with the level it needs (#850)', async ({ page }) => {
  const f = await fixture(), errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
    expect((await f.admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'comment' })).status).toBe(200);
    const tasks = () => f.h.store.get("SELECT count(*) n FROM tasks WHERE kind IN ('task.request','task.development')").n, before = tasks();
    await login(page, f); await fill(page);
    await page.getByLabel('交付类型', { exact: true }).selectOption('reviewable_pull_request');
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    const message = page.getByText('项目能力上限不是「可开发并开 PR」，不能交付代码；请项目管理员在「项目设置 → 监听与触发」调整。', { exact: true });
    await expect(message).toBeVisible();
    // One generic task kind since #814: a refused creation leaves no new task.
    expect(tasks()).toBe(before);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await message.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

// #1269: workflow changes no longer require a separate console confirmation checkbox on the task creation form.
test('code PR task creation has no workflow_changes checkbox and submits cleanly for both admins and members (#1269)', async ({ page }) => {
  const f = await fixture(), errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
    f.h.store.run("UPDATE policies SET capability_ceiling='develop',development_enabled=1 WHERE repository_id='101'");
    await login(page, f); await fill(page);
    await page.getByLabel('交付类型', { exact: true }).selectOption('reviewable_pull_request');
    await expect(page.locator('input[name="workflow_changes"]')).toHaveCount(0);
    await expect(page.locator('.task-create-form')).toContainText('按需申请 Workflows 权限');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务已创建', exact: true })).toBeVisible();
    const receipt = f.h.store.get("SELECT * FROM management_commands WHERE operation='task.create'"), id = JSON.parse(receipt.result).id;
    expect(JSON.parse(receipt.arguments).workflow_changes).toBeUndefined();
    expect(JSON.parse(f.h.store.get('SELECT input FROM tasks WHERE id=?', id).input).workflow_changes).toBeUndefined();
    expect(errors).toEqual([]);

    // A member with tasks.write also creates a PR task directly without any workflow_changes gate.
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
    const member = await f.member('task-writer', { repository_ids: [] });
    const principal = f.h.store.get('SELECT id FROM principals WHERE user_id=?', member.id).id, tenant = f.h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
    expect((await f.admin('/api/identity/grants', 'POST', { principal_id: principal, tenant_id: tenant, project_id: '101', capabilities: ['tasks.read', 'tasks.write'] })).status).toBe(201);
    await page.goto(f.h.admin + '/#/projects/101/new-task');
    await page.getByLabel('用户名', { exact: true }).fill('task-writer'); await page.getByLabel('密码', { exact: true }).fill(member.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '提交任务', exact: true })).toBeEnabled();
    await fill(page);
    await page.getByLabel('交付类型', { exact: true }).selectOption('reviewable_pull_request');
    await expect(page.locator('input[name="workflow_changes"]')).toHaveCount(0);
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务已创建', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

// #527 slice: the new-task page was never in the dictionary — every label, the page state and the receipt were
// hardcoded Chinese (static/task-create.js). An English console must show none of them in the page body; the console
// shell around it is a different slice, so the reading is scoped to #console-page. Three layouts are read because the
// form and the execution-context card stack differently below 1024.
test('English 界面：新建任务页整页不再出现中文，三个视口都不溢出', async ({ page }) => {
  const f = await fixture(), errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    await login(page, f);
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const body = page.locator('#console-page');
    await expect(body.getByRole('heading', { name: 'Create a task', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit task', exact: true })).toBeEnabled();

    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow at ${width}px`).toBe(true);
      const text = await body.innerText();
      expect(text.match(/[^\s]*[\u4e00-\u9fff][^\s]*/g) || [], `Chinese text left on the new-task page at ${width}px`).toEqual([]);
      expect(text, `raw dictionary key at ${width}px`).not.toContain('taskCreate.');
    }

    // The fields and the execution-context card must read in English too, not only the heading.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByLabel('Original request', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Acceptance criteria (one item per line)', { exact: true })).toBeVisible();
    await expect(page.locator('#console-page').getByRole('region', { name: 'Execution context' })).toContainText('Current identity');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
