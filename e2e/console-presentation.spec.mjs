import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// A model the role previews can resolve; nothing here asks it anything.
async function modelEndpoint() {
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
const contract = { goal: 'Keep the query string on the login redirect', scope: ['src/auth'], criteria: ['The redirect keeps ?next=', 'The project tests pass'], endpoint: 'bot PR', source: { kind: 'development.issue' } };
const candidate = { id: 'cand1234567890abcdef', revision: 1, created_at: '2026-11-09T01:00:00Z', claims: {}, artifacts: [{ kind: 'code', reference: 'task:coordinated:candidate', version: 'tree9876543210fedcba' }],
  evidence: [{ source: 'policy_validation', version: 'tree9876543210fedcba', verified: true, result: { command: 'npm test', exit_code: 0 } }] };

test('控制台按 Manager、角色、任务三层展示：没开协调时走原执行器，旧主控标成沿用，任务写清目标、候选、证据、验收、发布和谁在做什么', async ({ page }) => {
  test.setTimeout(90000);
  // The role and task routes belong to the task engine; it is never started, so the seeded tasks stay as written.
  const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };
  const h = await harness(undefined, manager, store => ({ engine: new TaskEngine(store, manager) })), errors = [], model = await modelEndpoint(), out = '.tmp/console-presentation';
  page.on('pageerror', error => errors.push(error.message)); mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const fixture = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'fixture-model', api_url: model.url, api_key: 'fixture-key' })).value.model;
    await admin('/api/repositories/101/policy', 'PATCH', { model_id: fixture.id, review_enabled: true, development_enabled: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const cardOf = title => page.locator('.side-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(cardOf('角色概览')).toBeVisible();
    const managerPicker=page.getByRole('combobox',{name:'manager Agent 后端',exact:true});
    await expect(managerPicker).toHaveValue('pi');
    h.store.run("INSERT INTO settings(key,value) VALUES('roles:101',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify({enabled:true,harnesses:{}}));
    await page.reload();await expect(managerPicker).toHaveValue('native');
    await managerPicker.selectOption('pi');
    await page.getByRole('button',{name:'保存角色配置',exact:true}).click();
    await expect(page.locator('.flash')).toHaveText('角色配置已保存，新任务使用新配置；收回权限会阻止后续调用');
    await expect(managerPicker).toHaveValue('pi');
    await expect(page.locator('[data-work-type]')).toHaveCount(0);
    await expect(page.locator('textarea[name=role_configuration]')).toHaveCount(0);

    // 5. Tasks: one without the controller (the original executor, QA accepting now) and one under it (a Reviewer at work).
    const now = '2026-11-09T01:00:00Z', task = (id, kind, number, phase) => h.store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,attempt,created_at,updated_at)
      VALUES(?,?,?,'running',?,?,?,1,?,?)`, id, '101', kind, contract.goal, number, phase, now, now);
    const record = (id, values) => h.store.run('UPDATE task_records SET contract=?,candidate=?,acceptance=?,next_action=? WHERE task_id=?', JSON.stringify(contract), JSON.stringify(values.candidate ?? null), values.acceptance ? JSON.stringify(values.acceptance) : null, values.next ?? null, id);
    // Runs as /roles returns them: a QA run is kind acceptance; a delegated run names its assignment and actual harness.
    const run = (id, task, role, status, harness = role === 'manager' ? 'pi' : 'native', assignment = null) => h.store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role,harness,assignment_id) VALUES(?,?,?,1,1,?,?,'{}','{}',?,?,?)",
      id, task, role === 'qa' ? 'acceptance' : 'role', now, status, role, harness, assignment);
    const instance = (id, task, role, harness, snapshot = null) => h.store.run('INSERT INTO role_instances(id,task_id,role,definition,harness,updated_at,snapshot_id,config_revision,role_revision) VALUES(?,?,?,?,?,?,?,1,1)', id, task, role, '{}', harness, now, snapshot);
    task('plain', 'review.issue', 11, 'model'); record('plain', { candidate: { ...candidate, artifacts: [{ kind: 'report', reference: 'task:plain:candidate', version: 'report123456789' }] } });
    instance('plain-qa', 'plain', 'qa', 'native'); run('plain-qa-run', 'plain', 'qa', 'running');
    task('coordinated', 'development.issue', 12, 'model');
    record('coordinated', { candidate, next: 'Ask Reviewer to check the redirect', acceptance: { outcome: 'return', reason: 'The redirect drops the fragment', gaps: ['Keep #fragment as well'], residuals: [], candidate_id: candidate.id, revision: 1 } });
    h.store.run("INSERT INTO role_snapshots VALUES('s-manager','101','manager',1,1,?,?)", JSON.stringify({ legacy: false, harness: { id: 'pi', source: 'role' } }), now);
    instance('c-manager', 'coordinated', 'manager', 'pi', 's-manager'); instance('c-dev', 'coordinated', 'dev', 'native'); instance('c-reviewer', 'coordinated', 'reviewer', 'acp'); instance('c-qa', 'coordinated', 'qa', 'native');
    for (const [id, owner, status, version] of [['a-dev', 'c-dev', 'completed', null], ['a-reviewer', 'c-reviewer', 'running', candidate.artifacts[0].version]])
      h.store.run('INSERT INTO role_assignments VALUES(?,?,?,1,?,?,?,NULL)', id, 'coordinated', owner, version, status, 'input-' + id);
    for (const [assignment, role, purpose] of [['a-dev', 'dev', 'Implement the redirect fix'], ['a-reviewer', 'reviewer', 'Check the redirect against both criteria']])
      h.store.run("INSERT INTO task_history(task_id,type,data,created_at,actor) VALUES('coordinated','role_handoff',?,?,'role:manager')", JSON.stringify({ assignment_id: assignment, role, purpose, refs: [], revision: 1 }), now);
    run('c-manager-run', 'coordinated', 'manager', 'running'); run('c-qa-run', 'coordinated', 'qa', 'succeeded');
    run('c-dev-run', 'coordinated', 'dev', 'succeeded', 'native', 'a-dev'); run('c-reviewer-run', 'coordinated', 'reviewer', 'running', 'acp', 'a-reviewer');

    const side = page.locator('#task-side'), fact = name => side.locator(`.task-fact[data-fact="${name}"]`);
    await page.evaluate(() => openTask('plain'));
    const next = page.locator('#task-next-text');
    await expect(next).toHaveText('独立 QA 正在新的上下文里验收候选 cand12345678。');
    await expect(side.locator('.task-fact')).toHaveCount(5);
    await expect(side.locator('.task-fact h4')).toHaveText(['目标', '候选', '证据', '验收', '发布']);
    await expect(side.locator('.task-execution')).toContainText('原来的执行器：这个任务没有经过主控，由项目电脑里的 Pi 进程直接执行。');
    await expect(side.locator('.task-execution')).not.toContainText('委派记录');
    await page.screenshot({ path: `${out}/task-original-executor.png` });
    // The dialog's close event arrives after the click; open the next task once it has.
    await page.locator('#task-actions').getByRole('button', { name: '关闭', exact: true }).click(); await page.waitForFunction(() => openTaskId === null);

    await page.evaluate(() => openTask('coordinated'));
    await expect(next).toHaveText('Reviewer（ACP）正在做主控交给它的工作：Check the redirect against both criteria');
    await expect(fact('目标')).toContainText('The redirect keeps ?next='); await expect(fact('候选')).toContainText('cand12345678');
    await expect(fact('证据')).toContainText('项目测试命令'); await expect(fact('证据')).toContainText('1/1 已核验');
    await expect(fact('验收')).toContainText('退回修改'); await expect(fact('验收')).toContainText('Keep #fragment as well');
    await expect(fact('发布')).toContainText('验收通过后，由控制面按工作类型允许的写入发布到 GitHub。');
    const execution = side.locator('.task-execution');
    await expect(execution).toContainText('角色协调：主控 Manager（Pi）按需委派工作'); await expect(execution).toContainText('运行过 1 次，每次都是新的上下文');
    await expect(execution.locator('.role-work > li')).toHaveCount(2);
    await expect(execution.locator('.role-work > li').nth(1)).toContainText('Check the redirect against both criteria');
    await expect(execution).toContainText('这不是预设流程，也不授予权限');
    // Wide screens keep two columns under the next step: the timeline beside the side panel.
    const [timelineBox, sideBox, nextBox] = await Promise.all([page.locator('.timeline-panel').boundingBox(), side.boundingBox(), page.locator('#task-next').boundingBox()]);
    expect(sideBox.x).toBeGreaterThan(timelineBox.x + timelineBox.width - 2); expect(Math.abs(sideBox.y - timelineBox.y)).toBeLessThan(2); expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(timelineBox.y + 1);
    await page.screenshot({ path: `${out}/task-coordinated.png` });
    await side.screenshot({ path: `${out}/task-coordinated-side.png` });
    await page.locator('#task-actions').getByRole('button', { name: '关闭', exact: true }).click(); await page.waitForFunction(() => openTaskId === null);

    // 6. Narrow screens stack the delegation lanes.
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(h.admin + '/#/projects/101/roles');
    await expect(cardOf('角色概览')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({ path: `${out}/roles-narrow.png`, fullPage: true });

    // 7. At 390px a task with a long timeline still opens with its next step in view, without horizontal overflow.
    task('logged', 'review.issue', 13, 'model'); record('logged', { next: 'Compare the redirect handler with the issue and reply' });
    for (let n = 1; n <= 30; n++) h.store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)', 'log-' + n, 'logged',
      JSON.stringify({ type: 'model', step: n, content: `Step ${n}: read the redirect handler and the tests around it before deciding what to report.` }), now);
    await page.evaluate(() => openTask('logged'));
    await expect(page.locator('#timeline .step-model')).toHaveCount(30);
    await expect(next).toHaveText('执行器（项目电脑里的 Pi 进程）正在处理：Compare the redirect handler with the issue and reply');
    const banner = await page.locator('#task-next').boundingBox();
    expect(banner.y).toBeGreaterThanOrEqual(0); expect(banner.y + banner.height).toBeLessThanOrEqual(900);
    expect(await page.evaluate(() => [document.documentElement.scrollWidth, document.getElementById('task-next').scrollWidth <= document.getElementById('task-next').clientWidth])).toEqual([390, true]);
    await page.screenshot({ path: `${out}/task-narrow-with-logs.png` });
    expect(errors).toEqual([]);
  } finally { await model.close(); await h.stop(); }
});
