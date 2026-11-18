import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { insertTaskLog } from '../dist/storage/payloads.js';
import { withRunTraceScope } from '../dist/tasks/trace.js';

async function build952Fixture() {
  const sha = 'b'.repeat(40);
  const ghState = { failSync: true };
  const ghServer = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/user') return res.end(JSON.stringify({ id: 99, login: 'bot-user' }));
    if (url.pathname === '/repositories/101') return res.end(JSON.stringify({ id: 101, full_name: 'fixture/project-101', default_branch: 'main', owner: { id: 10, login: 'fixture' }, permissions: { admin: false, push: true, pull: true } }));
    if (url.pathname === `/repos/fixture/project-101/commits/${sha}/check-runs`) {
      if (ghState.failSync) { res.statusCode = 503; return res.end(JSON.stringify({ message: 'GitHub unavailable' })); }
      return res.end(JSON.stringify({ check_runs: [{ id: 99, name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project-101/runs/99' }] }));
    }
    if (url.pathname === `/repos/fixture/project-101/commits/${sha}/status`) {
      if (ghState.failSync) { res.statusCode = 503; return res.end(JSON.stringify({ message: 'GitHub unavailable' })); }
      return res.end(JSON.stringify({ state: 'success', statuses: [] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  ghServer.listen(0, '127.0.0.1');
  await once(ghServer, 'listening');

  const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };
  const h = await harness(undefined, manager, store => ({ engine: new TaskEngine(store, manager), githubUrl: `http://127.0.0.1:${ghServer.address().port}` }));
  const { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');

  // Configure model + per-role concurrency limit on `dev` = 1 (#283)
  const model = (await admin('/api/models', 'POST', {
    repository_id: '101',
    model_name: 'gpt-5.4',
    api_url: 'http://127.0.0.1:9/v1',
    api_key: testPassword(),
  })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id, role_concurrency: { dev: 1 } });

  const records = new TaskRecords(h.store);

  // 1. Active multi-role task `t-952`: Manager -> Dev(v1) -> [Reviewer(1 finding) + Tester(pass)] -> Dev(v2 running)
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,priority,summary,object_number,phase,result,created_at,updated_at) VALUES('t-952','101','development.issue','running','P1','重构项目角色视图与任务流转详情页',952,'model',?,'2026-11-16T08:00:00Z','2026-11-16T08:12:00Z')",
    JSON.stringify({ pr_number: 958, branch: 'feat/task-view-952', sha }),
  );
  records.contract('t-952', {
    goal: '将项目总览重构为角色视图与任务视图，并将任务详情收敛为两层可独立折叠页面。',
    scope: ['static/', 'src/roles/'],
    criteria: ['已完成角色默认折叠，运行中角色默认展开', '轮询刷新不重置手动展开状态'],
    endpoint: 'pull_request',
    source: { type: 'issue', number: 952 },
  });

  h.store.run("INSERT OR REPLACE INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','issue',952,'项目角色队列视图与极简任务详情页','open',0,'2026-11-16T08:00:00Z')");
  h.store.run("INSERT OR REPLACE INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES('101','pr',958,'feat(console): role queue view and two-level task detail','open',0,'2026-11-16T08:11:00Z')");
  await h.hook(a.path, a.secret, 'e2e-chk-10', { repository: { id: 101 }, check_run: { id: 10, name: 'unit', head_sha: sha, status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project-101/runs/10' } }, { 'X-GitHub-Event': 'check_run' });
  await h.hook(a.path, a.secret, 'e2e-chk-11', { repository: { id: 101 }, check_run: { id: 11, name: 'e2e', head_sha: sha, status: 'in_progress', conclusion: null, html_url: 'https://github.com/fixture/project-101/runs/11' } }, { 'X-GitHub-Event': 'check_run' });
  await h.hook(a.path, a.secret, 'e2e-chk-12', { repository: { id: 101 }, check_run: { id: 12, name: 'build', head_sha: sha, status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project-101/runs/12' } }, { 'X-GitHub-Event': 'check_run' });

  const insRun = h.store.db.prepare("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,ended_at,status,context_snapshot,config_snapshot,role,assignment_id,harness) VALUES(?,?,?,1,1,?,?,?,'{}','{}',?,?,?)");
  insRun.run('run-mgr', 't-952', 'execution', '2026-11-16T08:00:05Z', null, 'running', 'manager', null, 'native');
  insRun.run('run-dev-1', 't-952', 'execution', '2026-11-16T08:00:30Z', '2026-11-16T08:04:10Z', 'succeeded', 'dev', 'asg-dev-1', 'pi');
  insRun.run('run-rev-1', 't-952', 'execution', '2026-11-16T08:04:15Z', '2026-11-16T08:06:00Z', 'succeeded', 'reviewer', 'asg-rev-1', 'codex');
  insRun.run('run-tst-1', 't-952', 'execution', '2026-11-16T08:04:16Z', '2026-11-16T08:06:20Z', 'succeeded', 'test', 'asg-tst-1', 'pi');
  insRun.run('run-dev-2', 't-952', 'execution', '2026-11-16T08:06:35Z', null, 'running', 'dev', 'asg-dev-2', 'pi');

  const insHist = h.store.db.prepare('INSERT INTO task_history(task_id,type,data,created_at,run_id,actor) VALUES(?,?,?,?,?,?)');
  insHist.run('t-952', 'role_handoff', JSON.stringify({ assignment_id: 'asg-dev-1', role: 'dev', purpose: '完成角色视图与流转框图初版' }), '2026-11-16T08:00:25Z', 'run-mgr', 'role:manager');
  insHist.run('t-952', 'tool_started', JSON.stringify({ call_id: 'm1', name: 'delegate_role', arguments: { role: 'dev', purpose: '完成角色视图与流转框图初版' } }), '2026-11-16T08:00:25Z', 'run-mgr', 'agent');
  insHist.run('t-952', 'role_result', JSON.stringify({ role: 'dev', assignment_id: 'asg-dev-1', result: { summary: '已完成三层视图初版代码与基础单测' } }), '2026-11-16T08:04:10Z', 'run-dev-1', 'role:dev');
  insHist.run('t-952', 'role_result', JSON.stringify({ role: 'reviewer', assignment_id: 'asg-rev-1', result: { summary: '退回 1 项问题：轮询刷新需保留内层展开态', findings: [{ description: '轮询刷新不应重置步骤折叠状态', evidence: ['static/views/timeline.js'] }], inspected_scope: ['static/'], unknowns: [] } }), '2026-11-16T08:06:00Z', 'run-rev-1', 'role:reviewer');
  insHist.run('t-952', 'role_result', JSON.stringify({ role: 'test', assignment_id: 'asg-tst-1', result: { summary: 'API 与单测集全部通过', findings: [], inspected_scope: ['test/'], unknowns: [] } }), '2026-11-16T08:06:20Z', 'run-tst-1', 'role:test');
  insHist.run('t-952', 'role_handoff', JSON.stringify({ assignment_id: 'asg-dev-2', role: 'dev', purpose: '修复轮询时内层步骤折叠态保持逻辑' }), '2026-11-16T08:06:30Z', 'run-mgr', 'role:manager');

  const taskRow = h.store.get("SELECT * FROM tasks WHERE id='t-952'");
  withRunTraceScope('t-952', 'run-dev-1', 'dev', () => {
    insertTaskLog(h.store, taskRow, JSON.stringify({ type: 'tool', name: 'write_file', arguments: { path: 'static/workspace.js', bytes: 2048 } }), '2026-11-16T08:02:00Z');
  });
  withRunTraceScope('t-952', 'run-dev-2', 'dev', () => {
    insertTaskLog(h.store, taskRow, JSON.stringify({ type: 'tool', name: 'read_file', arguments: { path: 'static/views/timeline.js' }, result: { content: 'function renderRoleRunTimeline() {}', bytes: 35 } }), '2026-11-16T08:07:00Z');
    insertTaskLog(h.store, taskRow, JSON.stringify({ type: 'command', command: 'npm run check', exit_code: 0, output: 'Runtime JavaScript syntax checks passed' }), '2026-11-16T08:08:00Z');
  });

  // 2. #283 `role_capacity` waiting task for Dev
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,error_code,priority,summary,object_number,phase,created_at,updated_at) VALUES('t-cap','101','development.issue','retry_wait','role_capacity','P1','收敛模型探活超时提示',944,'model','2026-11-16T08:05:00Z','2026-11-16T08:09:00Z')");
  h.store.run("INSERT INTO task_history(task_id,type,data,created_at) VALUES('t-cap','role_run_admission',?,'2026-11-16T08:09:00Z')", JSON.stringify({ role: 'dev', kind: 'writer' }));

  // 3. Default Manager queued task
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,priority,summary,object_number,phase,created_at,updated_at) VALUES('t-queue','101','development.issue','queued','P2','补充飞书绑定向导说明',940,'queued','2026-11-16T08:10:00Z','2026-11-16T08:10:00Z')");

  // 4. Completed task with merged PR
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,priority,summary,object_number,phase,result,created_at,updated_at) VALUES('t-merged','101','development.issue','completed','P2','修复暗色徽标对比度',912,'done',?,'2026-11-15T08:00:00Z','2026-11-15T09:00:00Z')", JSON.stringify({ pr_number: 915, merged: true }));

  // 5. Read-only viewer (`tasks.read` only) for permission-boundary UI verification
  const viewerPassword = testPassword();
  const viewerUser = (await admin('/api/users', 'POST', { username: 'ro-viewer', password: viewerPassword, repository_ids: ['101'] })).value.user;
  const viewerPrincipal = h.store.get('SELECT id FROM principals WHERE user_id=?', viewerUser.id);
  h.store.run("UPDATE scoped_grants SET role='viewer',policy='explicit',capabilities=? WHERE principal_id=?", JSON.stringify(['tasks.read']), viewerPrincipal.id);

  return { h, admin, password, viewerPassword, taskRow, ghState, close: async () => { await h.stop(); await new Promise(r => ghServer.close(r)); rmSync(h.directory, { recursive: true, force: true }); } };
}

test('role view, task flow list view, and #/tasks/:id two-level collapsible detail work end-to-end across 1440px and 390px', async ({ page }) => {
  test.setTimeout(90000);
  const f = await build952Fixture();
  const errors = [], cspViolations = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) cspViolations.push(msg.text()); });

  try {
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.goto(f.h.admin + '/#/projects/101/overview');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();

    // 1. Default Role View checks
    await expect(page.locator('[data-workbench-view="roles"]')).toHaveAttribute('aria-current', 'page');
    const roleBoard = page.getByTestId('project-role-board');
    await expect(roleBoard).toBeVisible();
    await expect(page.locator('#console-project-header .workbench-tabs')).toBeVisible();
    await expect(page.locator('.workbench-top .workbench-tabs')).toHaveCount(0);
    // No inline configuration forms mixed into Role View
    expect(await roleBoard.locator('select, textarea, input').count()).toBe(0);

    const devRow = page.locator('[data-role-row="dev"]');
    await expect(devRow).toContainText('gpt-5.4');
    await expect(devRow).toContainText('满载 1/1 · 排队 1');
    await expect(devRow).toContainText('#952');
    await expect(devRow).toContainText('#944');
    await expect(devRow).toContainText('等槽位');

    // Manager delegated active task to Dev, so Manager is not double-counted as actively executing #952, while showing queued #940
    const mgrRow = page.locator('[data-role-row="manager"]');
    await expect(mgrRow).toContainText('已委派子角色推进中');
    await expect(mgrRow).toContainText('#940');
    await expect(page.locator('.workbench-live-stats')).toContainText('排队中：1 项（另 1 项等槽位）');
    mkdirSync('.tmp/compact-project-nav', { recursive: true });
    await page.screenshot({ path: '.tmp/compact-project-nav/roles-1440.png', fullPage: true });

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // 2. Switch to Task List View & verify inline Role Flow Diagram + aligned queue pill count + Search
    await page.locator('[data-workbench-view="tasks"]').click();
    await expect(page).toHaveURL(/#\/projects\/101\/overview\/tasks$/);
    await expect(page.locator('[data-task-group="queued"] strong')).toHaveText('1');
    const taskRow952 = page.locator('.workbench-task-row[data-task-id="t-952"]');
    await expect(taskRow952).toBeVisible();
    await expect(taskRow952).toContainText('Issue #952');
    await expect(taskRow952).toContainText('PR #958');
    await expect(taskRow952).toContainText('Actions 1 运行中');
    // Inline flow diagram shows parallel Reviewer (returned) + Tester (pass) and active Dev (v2)
    await expect(taskRow952.locator('.role-flow-diagram')).toContainText('Reviewer');
    await expect(taskRow952.locator('.role-flow-diagram')).toContainText('↩ 1问题');
    await expect(taskRow952.locator('.role-flow-diagram')).toContainText('Tester');
    await expect(taskRow952.locator('.role-flow-diagram')).toContainText('返工中');
    await expect(taskRow952.locator('.role-flow-diagram')).toContainText('QA');

    // Search filters task rows cleanly
    await page.getByLabel('搜索任务', { exact: true }).fill('944');
    await expect(page.locator('.workbench-task-row')).toHaveCount(1);
    await expect(page.locator('.workbench-task-row[data-task-id="t-cap"]')).toBeVisible();
    await page.getByLabel('搜索任务', { exact: true }).fill('');
    await expect(page.locator('.workbench-task-row')).toHaveCount(4);

    // 3. Click into Standalone Task Detail Page `#/tasks/t-952`
    await taskRow952.locator('.task-row-open').click();
    await expect(page).toHaveURL(/#\/tasks\/t-952$/);
    const detail = page.locator('#task-view.task-detail-page');
    await expect(detail).toBeVisible();
    // #936: it is a normal page article, never a modal dialog
    expect(await detail.evaluate(el => el.tagName)).toBe('ARTICLE');
    expect(await page.evaluate(() => [...document.querySelectorAll('dialog')].some(d => d.open))).toBe(false);

    // Top Summary Card: Goal, External Links, Check Runs, Flow Diagram
    await expect(detail.locator('#task-goal-box')).toContainText('将项目总览重构为角色视图与任务视图');
    await expect(detail.locator('#task-external-bar')).toContainText('#952 · 项目角色队列视图与极简任务详情页');
    await expect(detail.locator('#task-external-bar')).toContainText('PR #958 (feat/task-view-952)');
    await expect(detail.locator('#task-external-bar')).toContainText('unit ✓');
    await expect(detail.locator('#task-external-bar')).toContainText('e2e ● 运行中');
    await expect(detail.locator('#task-external-bar')).toContainText('build ✓');

    // Live check sync button: surfaces error without cooldown when GitHub fails, then updates check pills on immediate retry
    await detail.getByRole('button', { name: '同步检查', exact: true }).click();
    await expect(page.locator('#task-error')).toContainText('github_');
    f.ghState.failSync = false;
    await detail.getByRole('button', { name: '同步检查', exact: true }).click();
    await expect(detail.locator('#task-external-bar')).toContainText('lint ✓');
    await expect(page.locator('#task-error')).toBeEmpty();

    // Level 1 Outer Folds: 1..3b historical roles collapsed by default; 4. Dev (v2) running role expanded by default!
    const outerFolds = detail.locator('#role-runs-list > details.role-run-fold');
    await expect(outerFolds).toHaveCount(5);
    expect(await outerFolds.nth(0).evaluate(el => el.open)).toBe(false);
    expect(await outerFolds.nth(1).evaluate(el => el.open)).toBe(false);
    expect(await outerFolds.nth(2).evaluate(el => el.open)).toBe(false);
    expect(await outerFolds.nth(3).evaluate(el => el.open)).toBe(false);
    expect(await outerFolds.nth(4).evaluate(el => el.open)).toBe(true);

    // Level 2 Inner Folds inside active 4. Dev (v2): default collapsed to 1-line summary
    const dev2Steps = outerFolds.nth(4).locator('details.step-fold');
    await expect(dev2Steps).toHaveCount(2);
    expect(await dev2Steps.nth(0).evaluate(el => el.open)).toBe(false);
    expect(await dev2Steps.nth(1).evaluate(el => el.open)).toBe(false);
    await expect(dev2Steps.nth(1).locator('summary')).toContainText('执行命令 npm run check');

    // Click flow node `3a. Reviewer` in top diagram -> scrolls to and opens `3a. Reviewer` outer block!
    await detail.locator('#task-flow-bar [data-flow-run-id="run-rev-1"]').click();
    expect(await outerFolds.nth(2).evaluate(el => el.open)).toBe(true);
    await expect(outerFolds.nth(2)).toContainText('轮询刷新不应重置步骤折叠状态');

    // Manually expand inner step 2 (`npm run check`) in `4. Dev (v2)`, then emit a new log + refresh -> verify BOTH outer & inner states survive polling!
    await dev2Steps.nth(1).locator('summary').click();
    expect(await dev2Steps.nth(1).evaluate(el => el.open)).toBe(true);
    await expect(dev2Steps.nth(1)).toContainText('Runtime JavaScript syntax checks passed');

    withRunTraceScope('t-952', 'run-dev-2', 'dev', () => {
      insertTaskLog(f.h.store, f.taskRow, JSON.stringify({ type: 'command', command: 'npm test', exit_code: 0, output: 'All tests green' }), '2026-11-16T08:09:00Z');
    });
    await detail.getByRole('button', { name: '刷新任务', exact: true }).click();
    await expect(outerFolds.nth(4).locator('details.step-fold')).toHaveCount(3);
    // Manual open states on `3a. Reviewer` (outer) and `npm run check` (inner) MUST remain open!
    expect(await outerFolds.nth(2).evaluate(el => el.open)).toBe(true);
    expect(await outerFolds.nth(4).locator('details.step-fold').nth(1).evaluate(el => el.open)).toBe(true);
    expect(await outerFolds.nth(4).locator('details.step-fold').nth(2).evaluate(el => el.open)).toBe(false);

    // Expand All / Collapse All buttons
    await page.locator('#task-expand-all').click();
    for (let i = 0; i < 5; i++) expect(await outerFolds.nth(i).evaluate(el => el.open)).toBe(true);
    await page.locator('#task-collapse-all').click();
    for (let i = 0; i < 5; i++) expect(await outerFolds.nth(i).evaluate(el => el.open)).toBe(false);

    // Operator top actions: Append Instruction -> Pause -> Retry
    await detail.getByRole('button', { name: '追加指令', exact: true }).click();
    await page.getByLabel('补充指令内容', { exact: true }).fill('请同时补充 390px 窄屏下的无横向溢出断言');
    await page.getByRole('button', { name: '发送指令', exact: true }).click();
    await expect.poll(() => f.h.store.get("SELECT COUNT(*) AS n FROM task_history WHERE task_id='t-952' AND type='supplemental_instruction'").n).toBe(1);

    await detail.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(detail.locator('#task-badges')).toContainText('已暂停');
    await detail.getByRole('button', { name: '重试', exact: true }).click();
    await expect(detail.locator('#task-badges')).toContainText('待执行');

    // Narrow 390px responsive check across Task Detail, Task View, and Role View + zero inline style CSP check
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await detail.evaluate(el => el.querySelectorAll('[style]').length)).toBe(0);

    // Return link goes back to Task View cleanly
    await detail.locator('#task-back-link').click();
    await expect(page).toHaveURL(/#\/projects\/101\/overview\/tasks$/);
    await expect(page.locator('.workbench-task-row[data-task-id="t-952"]')).toBeVisible();
    await expect(page.locator('#console-project-header [data-workbench-view="tasks"]')).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.workspace-overview').evaluate(el => el.querySelectorAll('[style]').length)).toBe(0);
    await page.screenshot({ path: '.tmp/compact-project-nav/tasks-390.png', fullPage: true });

    await page.locator('[data-workbench-view="roles"]').click();
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    await expect(page.locator('[data-role-row="dev"]')).toContainText('gpt-5.4');
    await expect(page.locator('#console-project-header [data-workbench-view="roles"]')).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/compact-project-nav/roles-390.png', fullPage: true });

    // 4. Read-only viewer perspective (`tasks.read` only): hides `+ 新建任务` and task mutation controls
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.locator('#logout').click();
    await page.getByLabel('用户名', { exact: true }).fill('ro-viewer');
    await page.getByLabel('密码', { exact: true }).fill(f.viewerPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.goto(f.h.admin + '/#/projects/101/overview');
    await expect(page.getByTestId('project-role-board')).toBeVisible();
    await expect(page.locator('.workbench-new-task')).toBeHidden();
    await page.screenshot({ path: '.tmp/compact-project-nav/viewer-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/compact-project-nav/viewer-390.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.goto(f.h.admin + '/#/tasks/t-952');
    await expect(detail.locator('#task-flow-bar')).toContainText('Reviewer');
    await expect(detail.getByRole('button', { name: '追加指令', exact: true })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: '取消任务', exact: true })).toHaveCount(0);

    expect(errors).toEqual([]);
    expect(cspViolations).toEqual([]);
  } finally {
    await f.close();
  }
});
