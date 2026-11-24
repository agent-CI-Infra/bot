import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

const longOutput = 'A'.repeat(6990) + 'LONG-END';

async function fixture() {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,created_at,updated_at) VALUES('t-io','101','development.issue','failed','#1207 每一步的输入与输出',1207,'model','2026-11-24T08:00:00Z','2026-11-24T08:10:00Z')",
  );
  h.store.run(
    "INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,ended_at,status,context_snapshot,config_snapshot,role,harness) VALUES('run-io','t-io','execution',1,1,'2026-11-24T08:00:05Z','2026-11-24T08:09:00Z','succeeded','{}','{}','dev','pi')",
  );
  h.store.run(
    `INSERT INTO model_requests(id,task_id,repository_id,request_id,model_id,model_name,requested_at,finished_at,http_status,state,request_snapshot,response_snapshot)
     VALUES('mr-1','t-io','101','req-1','model-1','gpt-5.4','2026-11-24T08:01:00Z','2026-11-24T08:01:05Z',200,'received',?,?)`,
    JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'system', content: '你是开发。' }, { role: 'user', content: '请修复登录按钮。' }] }),
    JSON.stringify({ choices: [{ message: { content: '已完成修复。' } }] }),
  );
  const insHist = h.store.db.prepare('INSERT INTO task_history(task_id,type,data,created_at,run_id,actor) VALUES(?,?,?,?,?,?)');
  insHist.run('t-io', 'tool_started', JSON.stringify({ call_id: 'c1', name: 'read_file', arguments: { path: 'src/login.ts' } }), '2026-11-24T08:00:30Z', 'run-io', 'agent');
  insHist.run('t-io', 'tool_observation', JSON.stringify({ call_id: 'c1', observation: { data: { content: 'first file body' } } }), '2026-11-24T08:00:31Z', 'run-io', 'agent');
  insHist.run('t-io', 'tool_started', JSON.stringify({ call_id: 'c2', name: 'read_file', arguments: { path: 'src/login.ts' } }), '2026-11-24T08:00:40Z', 'run-io', 'agent');
  insHist.run('t-io', 'tool_observation', JSON.stringify({ call_id: 'c2', observation: { data: { content: 'second file body' } } }), '2026-11-24T08:00:41Z', 'run-io', 'agent');
  insHist.run('t-io', 'model_request', JSON.stringify({
    request_id: 'mr-1', state: 'received', http_status: 200,
    request_source: 'model_requests:mr-1:request', response_source: 'model_requests:mr-1:response',
  }), '2026-11-24T08:01:05Z', 'run-io', 'framework');
  insHist.run('t-io', 'role_run_event', JSON.stringify({ type: 'message', data: { text: longOutput } }), '2026-11-24T08:02:00Z', 'run-io', 'agent');
  return { h, password, close: async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); } };
}

async function login(page, f) {
  await page.goto(f.h.admin + '/#/projects/101/inbox');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('a task step states its own input and output, keeps the full text readable and never mixes same-named steps', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    await page.goto(f.h.admin + '/#/projects/101/inbox');
    await page.locator('[data-task-id="t-io"]').getByRole('button', { name: '查看任务', exact: true }).click();
    const detail = page.locator('#task-view');
    await expect(detail).toContainText('#1207 每一步的输入与输出');
    const runs = detail.locator('#role-runs-list > details.role-run-fold');
    await expect(runs).toHaveCount(1);
    await runs.locator('summary').first().click();
    const steps = runs.locator('details.step-fold');
    await expect(steps).toHaveCount(4);
    for (const step of await steps.all()) expect(await step.evaluate(el => el.open)).toBe(false);

    // The recorded request pair is one step whose expanded body separates the prompt from the answer.
    const request = steps.filter({ hasText: '模型请求' });
    await expect(request).toHaveCount(1);
    await expect(request).not.toContainText('请修复登录按钮。');
    await request.locator('summary').click();
    await expect(request).toContainText('这一步的输入');
    await expect(request).toContainText('这一步的输出');
    await expect(request).toContainText('请修复登录按钮。');
    await expect(request).toContainText('已完成修复。');

    // A model message without a recorded request says so instead of showing an empty output.
    const message = steps.filter({ hasText: '模型消息' });
    await message.locator('summary').click();
    await expect(message).toContainText('这一步没有留下输入记录。');
    await expect(message).toContainText('以上是留下的全文。');
    await expect(message).toContainText('LONG-END');

    // Two read_file steps with the same title keep their own bodies.
    const reads = steps.filter({ hasText: '读取文件' });
    await expect(reads).toHaveCount(2);
    await reads.nth(0).locator('summary').click();
    await expect(reads.nth(0)).toContainText('first file body');
    await expect(reads.nth(0)).not.toContainText('second file body');
    await reads.nth(1).locator('summary').click();
    await expect(reads.nth(1)).toContainText('second file body');
    await expect(reads.nth(1)).not.toContainText('first file body');

    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(detail).toBeVisible();
      expect(await detail.evaluate(node => node.scrollWidth <= node.clientWidth), String(width)).toBe(true);
      await expect(request).toContainText('这一步的输入');
      await expect(request).toContainText('这一步的输出');
    }
  } finally { await f.close(); }
});
