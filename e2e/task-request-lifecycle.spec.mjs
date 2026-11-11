import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { LocalManager } from '../dist/projects/local-manager.js';
import { server as github } from '../test/fixtures/agent-server.mjs';

const reportText = 'Observed repository fact: calc.mjs contains the arithmetic implementation.';
const send = (res, message) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
};
const call = (name, args, id) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'console-request-')), manager = new LocalManager('101', root);
  let h, engine, advance = false, releaseQA, startedQA;
  const qaGate = new Promise(resolve => { releaseQA = resolve; });
  const qaStarted = new Promise(resolve => { startedQA = resolve; });
  const requests = [];
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()), accepting = body.tools.some(t => t.function.name === 'submit_acceptance');
    requests.push({ accepting, body });
    const names = body.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(c => c.function.name);
    if (accepting) {
      startedQA(); await qaGate;
      if (!names.includes('read_file')) return send(res, call('read_file', { path: 'report.md' }, 'qa-read'));
      const read = body.messages.some(m => m.role === 'tool' && m.content.includes(reportText));
      return send(res, call('submit_acceptance', { outcome: read ? 'pass' : 'insufficient_evidence',
        reason: read ? 'Read the report from the fixed candidate.' : 'The report could not be inspected.',
        gaps: read ? [] : ['Read the actual report'], residuals: [], core_complete: read,
        required_evidence_complete: read, acceptable_risk: read }, 'qa-verdict'));
    }
    if (!names.includes('read_file')) return send(res, call('read_file', { path: 'calc.mjs' }, 'read-source'));
    if (!names.includes('write_file')) return send(res, call('write_file', { path: 'report.md', content: reportText }, 'write-report'));
    return send(res, call('submit_delivery', { summary: 'Observed repository report', artifacts: [{ path: 'report.md', description: 'Repository observation' }], evidence: [], unknowns: [] }, 'deliver-report'));
  });
  const closeServer = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const close = async () => {
    releaseQA(); await engine?.close(); await manager.recover(); await h?.stop();
    await closeServer(provider); await closeServer(github); rmSync(root, { recursive: true, force: true });
  };
  try {
    github.listen(0, '127.0.0.1'); await once(github, 'listening');
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const githubUrl = 'http://127.0.0.1:' + github.address().port;
    h = await harness(undefined, manager, store => {
      engine = new TaskEngine(store, manager, githubUrl + '/github');
      const tick = engine.tick.bind(engine);
      // Hold scheduling until the real pause/retry round trip has completed; never fabricate task states.
      engine.tick = () => { if (advance) tick(); };
      return { engine };
    });
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    await fetch(githubUrl + '/fixture/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_token: a.token }) });
    const model = await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Lifecycle fixture',
      api_url: 'http://127.0.0.1:' + provider.address().port + '/v1', api_key: 'fixture-model-key' });
    expect(model.status).toBe(201);
    expect((await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.value.model.id, development_enabled: true })).status).toBe(200);
    const roles = (await admin('/api/repositories/101/roles')).value;
    expect((await admin('/api/repositories/101/roles', 'PUT', { expected_revision: roles.revision, enabled: false,
      roles: [{ role_id: 'qa', harness_ref: { id: 'native' } }] })).status).toBe(200);
    return { h, admin, password, requests, qaStarted, releaseQA, close,
      run() { advance = true; engine.tick(); return Promise.all(engine.active.values()); } };
  } catch (error) { await close(); throw error; }
}

for (const width of [1440, 390]) test(`a new report survives pause/retry and shows its actual candidate, evidence and independent QA (${width}px)`, async ({ page }) => {
  test.setTimeout(60000);
  const f = await fixture(), errors = []; let running;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width, height: 900 }); await page.goto(f.h.admin + '/#/new-task/101');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('原始需求', { exact: true }).fill('Read the current repository and produce an observed report.');
    await page.getByLabel('任务目标', { exact: true }).fill('Report an inspected repository fact.');
    await page.getByLabel('工作范围（每行一项）', { exact: true }).fill('calc.mjs');
    await page.getByLabel('验收条件（每行一项）', { exact: true }).fill('The report names its source and passes independent inspection.');
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务已创建', exact: true })).toBeVisible();
    const commands = f.h.store.all("SELECT * FROM management_commands WHERE operation='task.create'"); expect(commands).toHaveLength(1);
    const id = JSON.parse(commands[0].result).id;
    await page.getByRole('button', { name: '查看已创建的任务', exact: true }).click();
    expect((await f.admin('/api/tasks/' + id + '/pause', 'POST', {})).status).toBe(201);
    await page.getByRole('button', { name: '刷新任务', exact: true }).click();
    await expect(page.locator('#task-badges')).toContainText('已暂停');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.locator('#task-badges')).toContainText('待执行');
    running = f.run(); await f.qaStarted;
    await page.getByRole('button', { name: '刷新任务', exact: true }).click();
    const dialog = page.locator('#task-view');
    await expect(dialog).toContainText('独立 QA 正在新的上下文里验收候选');
    const candidate = (await f.admin('/api/tasks/' + id)).value.task.structured.candidate;
    expect(candidate.artifacts.some(a => a.kind === 'report')).toBe(true);
    expect(candidate.evidence.some(e => e.source.startsWith('task_history:'))).toBe(true);
    f.releaseQA(); await running;
    await page.getByRole('button', { name: '刷新任务', exact: true }).click();
    await expect(page.locator('#task-badges')).toContainText('已完成');
    await expect(dialog).toContainText('独立 QA 对当前候选的验收已通过');
    await expect(dialog).toContainText('没有写到 GitHub');
    await expect(dialog.getByRole('heading', { name: '任务结果', exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: '开发结果', exact: true })).toHaveCount(0);
    await expect(dialog.locator('.task-execution')).toContainText('实际 Agent 和模型以运行记录为准');
    await expect(dialog.locator('.task-execution')).not.toContainText('Pi 进程');
    const result = (await f.admin('/api/tasks/' + id)).value.task;
    expect(result.structured.acceptance.candidate_id).toBe(candidate.id);
    expect(result.structured.acceptance.outcome).toBe('pass');
    expect(f.requests.filter(r => r.accepting).some(r => r.body.messages.some(m => m.role === 'tool' && m.content.includes(reportText)))).toBe(true);
    expect(f.h.store.get('SELECT count(*) n FROM tasks').n).toBe(1);
    expect(f.h.store.get('SELECT count(*) n FROM github_effects WHERE task_id=?', id).n).toBe(0);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    mkdirSync('.tmp/task-lifecycle-227/previews', { recursive: true });
    await dialog.locator('.task-execution').evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `.tmp/task-lifecycle-227/previews/report-${width}.png` });
    if (width === 1440) {
      // At 200% desktop zoom the same 1440 physical pixels have 720 CSS pixels and DPR 2.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 450, deviceScaleFactor: 2, mobile: false });
      expect(await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }))).toEqual({ width: 720, dpr: 2 });
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(page.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
      await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.detach();
    }
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.goto(f.h.admin + '/#/board');
    const card = page.locator('.board-card').filter({ hasText: 'Read the current repository and produce an observed report.' });
    await expect(card).toHaveCount(1); await card.locator('.board-card-title').click();
    await expect(page.locator('#task-badges')).toContainText('已完成'); expect(errors).toEqual([]);
  } finally { f.releaseQA(); await running; await f.close(); }
});
