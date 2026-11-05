import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// The assistant model: like an agent, it reads the workflows, proposes a draft through update_draft, then streams a short
// answer in pieces (slowly enough to watch it arrive). Its draft also names read permissions, which are dropped: reading
// is not configured; its writes are kept.
async function assistantModel() {
  const requests = [];
  const draft = { name: '文档链接检查', description: 'PR 改到文档时检查链接和示例命令',
    triggers: [{ id: 'pull_request.opened' }, { id: 'pull_request.synchronize' }],
    prompt: 'Check every link and example command in the changed docs.\n\n```mermaid\nflowchart LR\n  read[读改动] --> check[核对链接] --> reply[回复]\n  check -->|需要复核| read\n```\n\n1. **Read** the changed Markdown files.\n2. **Check** each link and command; start_agent may double-check a doubtful one.\n3. **Reply** with the broken ones.',
    writes: ['reply', 'issue'], permissions: { workspace: { read: true, write: true, notes: false, shell: true }, github: ['contents', 'pull_requests'], agents: true } };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    const called = name => body.messages.some(message => message.tool_calls?.some(call => call.function.name === name));
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const message = !called('list_workflows') ? { role: 'assistant', content: '先看看现有的工作流。', tool_calls: [call('c1', 'list_workflows', {})] }
      : !called('update_draft') ? { role: 'assistant', content: null, tool_calls: [call('c2', 'update_draft', draft)] } : null;
    if (message) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of ['已起草：读改动、核对链接，', '再回复；', '可疑的链接交给独立 agent 复核。']) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`); await new Promise(resolve => setTimeout(resolve, 150));
    }
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

test('工作流页左侧列表、右侧分页编辑：触发源在概览里改并画在流程图左侧，读取不限制，Actions 失败处理也是工作流，聊天起草保存后才生效', async ({ page }) => {
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
    const list = page.getByRole('complementary', { name: '工作流列表', exact: true }), item = id => list.locator(`[data-workflow-item="${id}"]`);
    await expect(list.locator('.workflow-list:not(.shared) a')).toHaveCount(7);
    await expect(item('review.issue')).toHaveAttribute('aria-current', 'page');
    await expect(item('review.issue').locator('.flow-path')).toHaveText('检视 → 回复');
    await expect(item('development.issue').locator('.flow-path')).toHaveText('Issue 分析 → 开发 → 检视 → 测试');
    await expect(item('actions.failures')).toContainText('Actions 失败处理');
    // The editor sits beside the list, not under it, and uses the page width.
    const detail = name => page.getByRole('region', { name: '工作流：' + name, exact: true });
    await expect(detail('检视 Issue').locator('figure').first().locator('figcaption')).toContainText('检视 → 回复');
    const listBox = await list.boundingBox(), detailBox = await detail('检视 Issue').boundingBox();
    expect(detailBox.x).toBeGreaterThan(listBox.x + listBox.width - 2); expect(Math.abs(detailBox.y - listBox.y)).toBeLessThan(4);
    expect(detailBox.width).toBeGreaterThan(800);
    await item('development.issue').click();
    await expect(page).toHaveURL(/#\/projects\/101\/workflows\/development\.issue$/);
    const development = detail('开发 Issue'), flow = development.locator('figure').first();
    await expect(flow.locator('svg rect.flow-node')).toHaveCount(4);
    await expect(flow.locator('figcaption')).toContainText('Issue 分析 → 开发 → 检视 → 测试');
    await expect(flow.locator('figcaption')).toContainText('检视 → 开发：发现问题');
    await expect(flow.locator('figcaption')).toContainText('测试 → 开发：测试失败');
    // The triggers are drawn on the left of the steps from the trigger list; the prompt's flowchart does not name them.
    await expect(flow.locator('svg text.flow-trigger-label')).toHaveText(['检视发布结论', 'Issue 加标签：bot-develop']);
    const pill = await flow.locator('svg rect.flow-trigger').first().boundingBox(), step = await flow.locator('svg rect.flow-node').first().boundingBox();
    expect(pill.x + pill.width).toBeLessThan(step.x);
    // There is no separate trigger tab: the triggers are chosen in the overview, under the chart.
    await expect(development.getByRole('tab')).toHaveText(['概览', '提示词与流程', '权限与模型']);
    await expect(development.getByLabel('检视工作流发布结论后', { exact: true })).toBeChecked();
    await expect(development.getByLabel('有人给 Issue 加上标签', { exact: true })).toBeChecked();
    await expect(development.locator('.workflow-trigger code')).toHaveText('bot-develop');
    await expect(development).toContainText('无论选哪些触发源，控制面都要求');
    await development.screenshot({ path: '.tmp/workflows/development-overview.png' });
    await development.getByRole('tab', { name: '提示词与流程', exact: true }).click();
    await expect(development.getByLabel('控制台提示词', { exact: true })).toBeVisible();
    await expect(development.locator('figure').filter({ hasText: '生效的流程图' }).locator('svg text.flow-trigger-label')).toHaveCount(2);
    // Reading is not configured: every workflow may read everything. Writes are chosen; development keeps the PR it ends with.
    await development.getByRole('tab', { name: '权限与模型', exact: true }).click();
    await expect(development).toContainText('读取工作区、运行命令、写项目笔记、启动独立 agent、读取 GitHub：所有工作流都允许，不需要配置。');
    await expect(development.locator('input[name^="permission:"], input[name^="scope:"]')).toHaveCount(0);
    for (const write of ['code', 'pull_request']) { await expect(development.locator(`[name="write:${write}"]`)).toBeChecked(); await expect(development.locator(`[name="write:${write}"]`)).toBeDisabled(); }
    await expect(development.locator('[name="write:issue"]')).not.toBeChecked(); await expect(development.locator('[name="write:reply"]')).toHaveCount(0);
    await page.screenshot({ path: '.tmp/workflows/desktop.png', fullPage: true });
    // A built-in review: change its triggers like a custom workflow's.
    await item('review.pr').click();
    const review = detail('检视 PR'), reviewTriggers = review.locator('figure').first().locator('svg text.flow-trigger-label');
    await expect(reviewTriggers).toHaveText(['PR 打开', 'PR 推送新提交', 'PR 修改或讨论', '评论提到 bot']);
    await review.getByLabel('PR head 更新（推送新提交）', { exact: true }).uncheck();
    await review.getByLabel('有人给 PR 加上标签', { exact: true }).check();
    await review.getByLabel('有人给 PR 加上标签：标签名', { exact: true }).fill('needs-review');
    // The chart follows the ticked triggers before they are saved.
    await expect(reviewTriggers).toHaveText(['PR 打开', 'PR 修改或讨论', 'PR 加标签：needs-review', '评论提到 bot']);
    await review.getByRole('button', { name: '保存', exact: true }).click();
    await expect(detail('检视 PR').locator('.flash')).toHaveText('已保存工作流');
    await expect(detail('检视 PR').getByRole('tab', { name: '概览', exact: true })).toHaveAttribute('aria-selected', 'true');
    let saved = (await admin('/api/repositories/101/workflows/review.pr')).value.workflow;
    expect(saved.triggers.map(trigger => trigger.id).sort()).toEqual(['comment.mention', 'pull_request.labeled', 'pull_request.opened', 'pull_request.updated']);
    expect(saved.triggers.find(trigger => trigger.id === 'pull_request.labeled').label).toBe('needs-review');
    expect((await admin('/api/repositories/101')).value.policy.review_pr_updates).toBe(0);
    // An untouched prompt is not written: it keeps following the built-in default. No permissions are saved at all.
    expect(h.store.get("SELECT permissions,prompt FROM workflows WHERE repository_id='101' AND id='review.pr'")).toEqual({ permissions: null, prompt: null });
    // Actions failure handling is managed here too, with its switch and its trigger.
    await item('actions.failures').click();
    const actions = detail('Actions 失败处理');
    await expect(actions.locator('figure').first().locator('figcaption')).toContainText('读取日志 → 分析原因 → 重跑一次 → 提报 Issue → 检视 Issue');
    await actions.getByLabel('启用这条工作流', { exact: false }).check();
    await actions.getByRole('button', { name: '保存', exact: true }).click();
    await expect(detail('Actions 失败处理').locator('.flash')).toHaveText('已保存工作流');
    expect((await admin('/api/repositories/101')).value.policy.actions_failures_enabled).toBe(1);
    // The model analyzes the failure: its prompt and model are edited here like any workflow's.
    await detail('Actions 失败处理').getByRole('tab', { name: '提示词与流程', exact: true }).click();
    await expect(detail('Actions 失败处理').getByLabel('控制台提示词', { exact: true })).toHaveValue(/# Actions failure analysis/);
    await detail('Actions 失败处理').getByRole('tab', { name: '权限与模型', exact: true }).click();
    await expect(detail('Actions 失败处理').locator('select[name=model_id]')).toBeVisible();
    await expect(detail('Actions 失败处理')).toContainText('启动独立 agent、读取 GitHub：所有工作流都允许');
    await expect(detail('Actions 失败处理')).toContainText('所有工作流都在项目电脑里运行');
    await expect(detail('Actions 失败处理').locator('.workflow-write').filter({ hasText: '提报 Issue' })).toContainText('report_failure');
    for (const write of ['issue', 'actions_rerun']) await expect(detail('Actions 失败处理').locator(`[name="write:${write}"]`)).toBeChecked();
    await expect(item('actions.failures')).toContainText('运行中');
    // The assistant floats over the page: it can be moved and resized and shows the agent's work as it streams.
    await list.getByRole('button', { name: '用聊天新增', exact: true }).click();
    const assistant = page.getByRole('dialog', { name: '工作流助手', exact: true });
    await expect(assistant).toBeVisible();
    expect(await assistant.evaluate(node => [getComputedStyle(node).position, getComputedStyle(node).resize])).toEqual(['fixed', 'both']);
    const before = await assistant.boundingBox(), handle = assistant.locator('.assistant-head');
    await handle.hover({ position: { x: 60, y: 12 } }); await page.mouse.down(); await page.mouse.move(before.x - 240, before.y - 120, { steps: 5 }); await page.mouse.up();
    const moved = await assistant.boundingBox(); expect(moved.x).toBeLessThan(before.x - 150); expect(moved.y).toBeLessThan(before.y - 60);
    await assistant.getByLabel('告诉助手你想要的流程', { exact: true }).fill('PR 改到文档时检查链接和示例命令，回复坏掉的');
    await assistant.getByRole('button', { name: '发送', exact: true }).click();
    await expect(assistant.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await expect(assistant.locator('.assistant-tool code')).toHaveText(['list_workflows', 'update_draft']);
    await expect(assistant.locator('.turn-assistant')).toContainText('已起草：读改动、核对链接，再回复；可疑的链接交给独立 agent 复核。');
    await expect(assistant.getByRole('button', { name: '停止', exact: true })).toBeHidden();
    const draftFigure = assistant.locator('figure').filter({ hasText: '草稿流程图' });
    await expect(draftFigure.locator('figcaption')).toContainText('读改动 → 核对链接 → 回复');
    await expect(draftFigure.locator('figcaption')).toContainText('核对链接 → 读改动：需要复核');
    await expect(draftFigure.locator('svg text.flow-trigger-label')).toHaveText(['PR 打开', 'PR 推送新提交']);
    await expect(assistant).toContainText('草稿写入：回复评论、提报 Issue');
    await assistant.locator('.assistant-tool').filter({ hasText: 'list_workflows' }).locator('summary').click();
    await expect(assistant.locator('.assistant-tool').filter({ hasText: 'list_workflows' })).toContainText('review.pr');
    expect((await admin('/api/repositories/101/workflows')).value.workflows).toHaveLength(7);
    await page.screenshot({ path: '.tmp/workflows/assistant.png' });
    // Another page keeps the window and its conversation; after a reload the conversation comes back with the window.
    await page.getByRole('link', { name: '模型', exact: true }).click();
    await expect(assistant).toBeVisible(); await expect(assistant.locator('.turn-user')).toHaveCount(1);
    await page.reload(); await expect(assistant).toBeHidden();
    await page.goto(h.admin + '/#/projects/101/workflows/new');
    await page.getByRole('region', { name: '新增工作流', exact: true }).getByRole('button', { name: '用聊天编写', exact: true }).click();
    await expect(assistant.locator('.turn-assistant')).toContainText('已起草');
    const placed = await assistant.boundingBox(); expect(Math.abs(placed.x - moved.x)).toBeLessThan(4);
    // A draft fills the editor; unsaved contents survive leaving the page and show up in the list until saved.
    await assistant.getByRole('button', { name: '填入编辑器', exact: true }).click();
    const create = page.getByRole('region', { name: '新增工作流', exact: true });
    await expect(create.getByRole('tab', { name: '提示词与流程', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(create.getByLabel('提示词', { exact: true })).toHaveValue(/flowchart LR/);
    await expect(create.locator('figure').filter({ hasText: '编辑中的流程图' }).locator('figcaption')).toContainText('读改动 → 核对链接 → 回复');
    await assistant.getByRole('button', { name: '收起', exact: true }).click(); await expect(assistant).toBeHidden();
    await page.getByRole('link', { name: '基本设置', exact: true }).click(); await page.getByRole('link', { name: '工作流', exact: true }).click();
    await expect(item('new')).toContainText('文档链接检查'); await expect(item('new')).toContainText('未保存的草稿');
    await item('new').click();
    await expect(create).toContainText('这里显示的是未保存的修改');
    await create.getByRole('tab', { name: '概览', exact: true }).click();
    await expect(create.getByLabel('名称', { exact: true })).toHaveValue('文档链接检查');
    await expect(create.getByLabel('PR 打开或 Ready for review', { exact: true })).toBeChecked();
    await create.getByRole('tab', { name: '权限与模型', exact: true }).click();
    // The draft's writes are ticked; asking for a PR ticks the code write with it.
    await expect(create.locator('[name="write:issue"]')).toBeChecked(); await expect(create.locator('[name="write:code"]')).not.toBeChecked();
    await create.getByLabel('开或更新 bot PR', { exact: true }).check(); await expect(create.locator('[name="write:code"]')).toBeChecked();
    await expect(create).toContainText('写入（按需勾选）'); await expect(create).toContainText('create_pull_request');
    await create.getByRole('button', { name: '保存', exact: true }).click();
    await expect(detail('文档链接检查').locator('.flash')).toHaveText('已保存工作流');
    await expect(item('new')).toHaveCount(0);
    const workflows = (await admin('/api/repositories/101/workflows')).value.workflows, custom = workflows.find(workflow => !workflow.builtin);
    expect(custom.triggers.map(trigger => trigger.id)).toEqual(['pull_request.opened', 'pull_request.synchronize']);
    expect(custom.permissions).toEqual({ workspace: { read: true, write: true, notes: true, shell: true }, github: ['contents', 'issues', 'pull_requests', 'actions', 'checks', 'statuses', 'metadata'], agents: true, writes: ['reply', 'code', 'pull_request', 'issue'] });
    expect(custom.prompt.effective).toContain('check -->|需要复核| read');
    expect(model.requests[0].messages[0].content).toContain('flowchart LR');
    expect(h.store.get("SELECT user_id FROM audit WHERE action='workflow.created'").user_id).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`#/projects/101/workflows/${custom.id.replace('.', '\\.')}$`));
    await expect(item(custom.id).locator('.flow-path')).toHaveText('读改动 → 核对链接 → 回复');
    // Shared rules open in the same place; the address of an item survives a reload.
    await list.locator('[data-workflow-item="rules.guide"]').click();
    await expect(page.getByRole('region', { name: '行为指南', exact: true })).toContainText('.bot/guide.md');
    await page.goto(h.admin + '/#/projects/101/workflows/review.pr'); await page.reload();
    await expect(detail('检视 PR')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/workflows/mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // The custom workflow's model is on the model page next to the built-in ones.
    await page.goto(h.admin + '/#/projects/101/model');
    await expect(page.getByRole('table', { name: '工作流模型', exact: true }).locator(`tr[data-task-kind="${custom.id}"]`)).toContainText('文档链接检查');
    expect(errors).toEqual([]);
  } finally { await model.close(); await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
