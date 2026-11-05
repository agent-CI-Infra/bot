import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// The assistant model: answers with a draft workflow (a prompt with its flowchart, triggers and permissions).
async function assistantModel() {
  const requests = [];
  const draft = { name: '文档链接检查', description: 'PR 改到文档时检查链接和示例命令',
    triggers: [{ id: 'pull_request.opened' }, { id: 'pull_request.synchronize' }],
    prompt: 'Check every link and example command in the changed docs.\n\n```mermaid\nflowchart LR\n  read[读改动] --> check[核对链接] --> reply[回复]\n  check -->|需要复核| read\n```\n\n1. **Read** the changed Markdown files.\n2. **Check** each link and command; start_agent may double-check a doubtful one.\n3. **Reply** with the broken ones.',
    permissions: { workspace: { read: true, write: true, notes: false, shell: true }, github: ['contents', 'pull_requests'], agents: true } };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; requests.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ reply: '已起草：读改动、核对链接，再回复；可疑的链接交给独立 agent 复核。', draft }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

test('工作流页展示内置流程图，聊天起草的新工作流保存后才生效', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(), errors = [], model = await assistantModel();
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync('.tmp/workflows', { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const writer = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Writer model', api_url: model.url, api_key: 'assistant-fixture-key' })).value.model;
    await admin('/api/repositories/101/policy', 'PATCH', { model_id: writer.id, review_enabled: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/projects/101/workflows');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const table = page.getByRole('table', { name: '工作流', exact: true }), row = id => table.locator(`tr[data-workflow="${id}"]`);
    await expect(table.locator('tr[data-workflow]')).toHaveCount(6);
    await expect(row('review.issue').locator('.flow-path')).toHaveText('检视 → 回复');
    await expect(row('review.pr').locator('.flow-path')).toHaveText('检视 → 回复');
    await expect(row('development.issue').locator('.flow-path')).toHaveText('Issue 分析 → 开发 → 检视 → 测试');
    await expect(page.locator('#project-page')).toContainText('标签规范、PR 门禁和合并队列');
    // The development editor draws the flowchart of its prompt, back edges included.
    await row('development.issue').getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.getByRole('region', { name: '编辑工作流：开发 Issue', exact: true });
    const effective = editor.locator('figure').filter({ hasText: '生效的流程图' });
    await expect(effective.locator('svg rect')).toHaveCount(4);
    await expect(effective.locator('figcaption')).toContainText('Issue 分析 → 开发 → 检视 → 测试');
    await expect(effective.locator('figcaption')).toContainText('检视 → 开发：发现问题');
    await expect(effective.locator('figcaption')).toContainText('测试 → 开发：测试失败');
    await expect(effective.locator('svg')).toHaveAttribute('aria-label', /Issue 分析 → 开发 → 检视 → 测试/);
    await expect(editor.getByText('开发标签和「Issue 没有指派人」由控制面检查', { exact: false })).toBeVisible();
    await expect(editor.getByLabel('启动独立 agent', { exact: false })).toBeChecked();
    await editor.screenshot({ path: '.tmp/workflows/development-editor.png' });
    await editor.getByRole('button', { name: '收起', exact: true }).click();
    await row('review.pr').getByRole('button', { name: '编辑', exact: true }).click();
    const review = page.getByRole('region', { name: '编辑工作流：检视 PR', exact: true });
    await expect(review.locator('figure').filter({ hasText: '生效的流程图' }).locator('figcaption')).toContainText('检视 → 回复');
    // A trigger turned off here is the project's review switch for it.
    await review.getByLabel('PR head 更新（推送新提交）', { exact: true }).uncheck();
    await review.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('region', { name: '编辑工作流：检视 PR', exact: true }).locator('.flash')).toHaveText('已保存工作流');
    expect((await admin('/api/repositories/101')).value.policy.review_pr_updates).toBe(0);
    // Untouched permissions and prompt are not written: the workflow keeps following the built-in defaults.
    expect(h.store.get("SELECT permissions,prompt FROM workflows WHERE repository_id='101' AND id='review.pr'")).toEqual({ permissions: null, prompt: null });
    expect(JSON.parse((await admin('/api/repositories/101')).value.policy.rule_overrides)).toEqual({});
    await page.getByRole('region', { name: '编辑工作流：检视 PR', exact: true }).getByRole('button', { name: '收起', exact: true }).click();
    // Chat drafts a new workflow; the draft fills the editor and takes effect only once saved.
    await page.getByRole('button', { name: '用聊天新增', exact: true }).click();
    const create = page.getByRole('region', { name: '新增工作流', exact: true }), chat = create.getByRole('complementary', { name: '用聊天编写', exact: true });
    await chat.getByLabel('告诉助手你想要的流程', { exact: true }).fill('PR 改到文档时检查链接和示例命令，回复坏掉的');
    await chat.getByRole('button', { name: '发送', exact: true }).click();
    await expect(chat.locator('.chat-assistant')).toContainText('已起草');
    const draftFigure = chat.locator('figure').filter({ hasText: '草稿流程图' });
    await expect(draftFigure.locator('figcaption')).toContainText('读改动 → 核对链接 → 回复');
    await expect(draftFigure.locator('figcaption')).toContainText('核对链接 → 读改动：需要复核');
    await expect(chat).toContainText('已收窄到允许的范围');
    expect((await admin('/api/repositories/101/workflows')).value.workflows).toHaveLength(6);
    await create.screenshot({ path: '.tmp/workflows/chat-draft.png' });
    await chat.getByRole('button', { name: '填入编辑器', exact: true }).click();
    await expect(create.getByLabel('名称', { exact: true })).toHaveValue('文档链接检查');
    await expect(create.getByLabel('提示词', { exact: true })).toHaveValue(/flowchart LR/);
    await expect(create.locator('figure').filter({ hasText: '编辑中的流程图' }).locator('figcaption')).toContainText('读改动 → 核对链接 → 回复');
    await expect(create.getByLabel('PR 打开或 Ready for review', { exact: true })).toBeChecked();
    await expect(create.getByLabel('修改工作区代码', { exact: true })).toBeDisabled();
    await expect(create.getByLabel('修改工作区代码', { exact: true })).not.toBeChecked();
    await expect(create.getByLabel('启动独立 agent', { exact: false })).toBeChecked();
    await create.getByRole('button', { name: '保存', exact: true }).click();
    const savedEditor = page.getByRole('region', { name: '编辑工作流：文档链接检查', exact: true });
    await expect(savedEditor.locator('.flash')).toHaveText('已保存工作流');
    const workflows = (await admin('/api/repositories/101/workflows')).value.workflows, saved = workflows.find(workflow => !workflow.builtin);
    expect(saved.name).toBe('文档链接检查');
    expect(saved.triggers.map(trigger => trigger.id)).toEqual(['pull_request.opened', 'pull_request.synchronize']);
    expect(saved.permissions).toEqual({ workspace: { read: true, write: false, notes: false, shell: true }, github: ['contents', 'pull_requests'], agents: true, publication: 'reply' });
    expect(saved.prompt.effective).toContain('check -->|需要复核| read');
    // The assistant was told the ceiling and the flowchart convention; the administrator is the one who saved.
    expect(model.requests[0].messages[0].content).toContain('flowchart LR');
    expect(h.store.get("SELECT user_id FROM audit WHERE action='workflow.created'").user_id).toBeTruthy();
    await expect(row(saved.id).locator('.flow-path')).toHaveText('读改动 → 核对链接 → 回复');
    await expect(row(saved.id)).toContainText('自定义');
    await page.screenshot({ path: '.tmp/workflows/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/workflows/mobile.png', fullPage: true });
    // The custom workflow's model is on the model page next to the built-in ones.
    await page.goto(h.admin + '/#/projects/101/model');
    await expect(page.getByRole('table', { name: '工作流模型', exact: true }).locator(`tr[data-task-kind="${saved.id}"]`)).toContainText('文档链接检查');
    expect(errors).toEqual([]);
  } finally { await model.close(); await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
