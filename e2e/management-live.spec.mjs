import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { managementFixture, settled } from '../test/management-fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function login(page, f) {
  await page.goto(f.h.admin + '/#/management');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('当前管理作用域').selectOption('project:101');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
}
// #480: a scope chosen on the page lasts for one opening, so a reload returns to the shell default. Reopening the scope is
// how a test about stored messages gets back to the conversation it wrote.
async function reopenScope(page) {
  const scope = page.getByLabel('当前管理作用域', { exact: true });
  await expect(scope).toHaveValue('platform');
  await scope.selectOption('project:101');
}
const chunk = (res, delta, finish = null) => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
const complete = res => { chunk(res, {}, 'stop'); res.end('data: [DONE]\n\n'); };

test('real model streaming renders Markdown before completion, shows tool progress, preserves intermediate text and replays without writes', async ({ page, context }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), next = deferred(), final = deferred(), errors = [], requests = [];
  page.on('pageerror', err => errors.push(err.message));
  const markdown = '## 检查结果\n\n**项目电脑未启动**，任务正在等待。\n\n- 查看项目电脑\n- [执行记录](https://example.com/runs)\n\n> 状态来自已读取的任务。\n\n```js\nconst state = "waiting_environment";\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 测试项目 | 等待环境 |\n\n- [x] 已查询\n- [ ] 待恢复\n\n[危险链接](javascript:alert(1))\n\n<img src="/unexpected-image" onerror="window.markdownAttack=1"><script>window.markdownAttack=1</script><input type="text" value="injected"><svg onload="window.markdownAttack=1"></svg>';
  f.modelState.respond = async (body, res) => {
    requests.push(body); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (!body.messages.some(item => item.role === 'tool')) {
      chunk(res, { content: '### 正在检查\n\n先读取任务状态。' }); await next.promise;
      chunk(res, { tool_calls: [{ index: 0, id: 'read-task', type: 'function', function: { name: 'management_query', arguments: JSON.stringify({ operation: 'get_task', target: { project_id: '101', task_id: 'blocked' }, arguments: {} }) } }] }); complete(res);
    } else {
      chunk(res, { content: markdown.slice(0, 35) }); await final.promise;
      chunk(res, { content: markdown.slice(35) }); complete(res);
    }
  };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, f);
    const feed = page.getByRole('log', { name: '管理会话记录' }), message = page.getByLabel('管理消息', { exact: true });
    await message.fill('检查任务进展'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(feed.getByRole('heading', { name: '正在检查', exact: true })).toBeVisible();
    await expect(feed.locator('.management-turn-state')).toHaveText('正在回复');
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    expect(f.h.store.get('SELECT state FROM management_messages').state).toBe('running');
    await expect(feed.locator('.management-progress')).toBeHidden();
    await message.fill('下一条草稿'); next.resolve();
    await expect(feed.locator('.management-step-summary')).toContainText('读取任务状态');
    await expect(feed.locator('.management-step-status')).toHaveText('已完成');
    await expect(feed.getByRole('heading', { name: '检查结果', exact: true })).toBeVisible();
    await expect(message).toHaveValue('下一条草稿');
    mkdirSync('.tmp/management-live', { recursive: true }); await page.screenshot({ path: '.tmp/management-live/stream-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await feed.evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: '.tmp/management-live/stream-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    final.resolve();
    await expect(feed.locator('.management-turn-state')).toHaveText('已完成');
    await expect(feed.locator('.management-progress > summary')).toHaveText('执行进展 · 1/1 步完成');
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();
    await expect(feed.locator('.management-answer')).toHaveCount(2);
    await expect(feed.locator('pre code')).toHaveText('const state = "waiting_environment";\n');
    await expect(feed.locator('table tbody tr td').last()).toHaveText('等待环境');
    await expect(feed.locator('blockquote')).toContainText('状态来自已读取的任务');
    await expect(feed.getByRole('link', { name: '执行记录', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(await feed.locator('a').filter({ hasText: '危险链接' }).getAttribute('href')).toBeNull();
    await expect(feed.locator('script,img,svg,input:not([type=checkbox])')).toHaveCount(0);
    await expect(feed.locator('input[type=checkbox]')).toHaveCount(2);
    expect(await page.evaluate(() => window.markdownAttack)).toBeUndefined();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await feed.getByRole('button', { name: '复制回答', exact: true }).last().click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(markdown);
    await page.screenshot({ path: '.tmp/management-live/result-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(message).toBeInViewport(); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/management-live/result-mobile.png' });
    await page.reload(); await reopenScope(page);
    await expect(feed.locator('.management-turn-state')).toHaveText('已完成'); await expect(feed.locator('.management-answer')).toHaveCount(2);
    await expect(feed.getByRole('heading', { name: '检查结果', exact: true })).toBeVisible();
    expect(requests).toHaveLength(2); expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    expect(errors).toEqual([]);
  } finally { next.resolve(); final.resolve(); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('stop, model failure and restart interruption are visible and retain partial answers', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), gate = deferred(), errors = [];
  const commands = f.h.store.get('SELECT count(*) n FROM management_commands').n;
  page.on('pageerror', err => errors.push(err.message));
  f.modelState.respond = async (_body, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); chunk(res, { content: '**已读取部分信息**，继续检查中。' }); await gate.promise; complete(res); };
  try {
    await login(page, f);
    const feed = page.getByRole('log', { name: '管理会话记录' }), message = page.getByLabel('管理消息', { exact: true });
    await message.fill('检查进展'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(feed.locator('strong').filter({ hasText: '已读取部分信息' })).toBeVisible();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(feed.locator('.management-turn-state')).toHaveText('已停止'); await expect(feed).toContainText('已停止后续处理');
    await expect(feed.locator('.management-stream')).toHaveCount(0);
    gate.resolve(); f.modelState.respond = null; f.modelState.failure = 503;
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await message.fill('再检查一次'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(feed.locator('.management-turn-state').last()).toHaveText('处理失败'); await expect(feed).toContainText('model_http_503');
    const last = f.h.store.get('SELECT id FROM management_messages ORDER BY rowid DESC LIMIT 1').id;
    f.h.store.run("UPDATE management_messages SET state='interrupted' WHERE id=?", last);
    f.h.store.run("DELETE FROM management_events WHERE message_id=? AND type='error'", last);
    await page.reload(); await reopenScope(page); await expect(feed.locator('.management-turn-state').last()).toHaveText('运行中断');
    await expect(feed).toContainText('服务重启中断了这次处理');
    expect(f.h.store.get('SELECT count(*) n FROM management_commands').n).toBe(commands); expect(errors).toEqual([]);
  } finally { gate.resolve(); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('a broken event stream reconnects by reading, without resending, and preserves the draft', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), gate = deferred(); f.modelState.gate = gate.promise;
  try {
    await login(page, f);
    await page.route('**/events?stream=1&after=*', route => route.abort('failed'));
    const message = page.getByLabel('管理消息', { exact: true });
    await message.fill('检查任务进展'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.management-status')).toContainText('连接已中断');
    await message.fill('保留草稿'); gate.resolve(); f.modelState.gate = null;
    await page.unroute('**/events?stream=1&after=*'); await page.locator('.management-status-bar').getByRole('button', { name: '重新连接', exact: true }).click();
    await expect(page.getByRole('log', { name: '管理会话记录' })).toContainText('任务正在等待项目电脑');
    await expect(page.locator('.management-turn-state')).toHaveText('已完成'); await expect(message).toHaveValue('保留草稿');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
  } finally { gate.resolve(); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('streaming does not move the reader away from older content, and latest returns to the answer', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), gate = deferred(), tail = deferred();
  f.modelState.respond = async (_body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(res, { content: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 项：检查项目状态。\n\n`).join('') });
    await gate.promise; chunk(res, { content: '\n\n**最新进展：已读取任务。**' }); await tail.promise; complete(res);
  };
  try {
    await login(page, f);
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await page.getByLabel('管理消息', { exact: true }).fill('检查所有任务'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(feed).toContainText('第 60 项');
    await feed.evaluate(node => { node.scrollTop = 80; });
    await expect.poll(() => feed.evaluate(node => node.scrollTop)).toBe(80);
    // Wheel input gives the browser a scroll event before another model chunk arrives.
    await feed.hover(); await page.mouse.wheel(0, -40);
    await expect.poll(() => feed.evaluate(node => node.scrollTop)).toBeLessThan(80);
    const at = await feed.evaluate(node => node.scrollTop); gate.resolve();
    await expect(page.getByRole('button', { name: '↓ 回到最新消息', exact: true })).toBeVisible();
    expect(await feed.evaluate(node => node.scrollTop)).toBe(at);
    await page.getByRole('button', { name: '↓ 回到最新消息', exact: true }).click();
    await expect(feed.locator('strong').filter({ hasText: '最新进展' })).toBeInViewport();
    tail.resolve(); await expect(feed.locator('.management-turn-state')).toHaveText('已完成');
  } finally { gate.resolve(); tail.resolve(); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('a leftover approval policy holds nothing back: the operation executes and its receipt offers no approval', async ({ page }) => {
  const f = await managementFixture();
  f.h.store.run("INSERT INTO management_policies(tenant_id,approval_operations) VALUES('github.com:10','[\"workflow.update\"]')");
  try {
    await login(page, f);
    await page.getByLabel('管理消息', { exact: true }).fill('更新任务默认提示词');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const feed = page.getByRole('log', { name: '管理会话记录' }), step = feed.locator('.management-step').last();
    await expect(feed.locator('.management-turn-state')).toHaveText('已完成');
    await expect(feed.locator('.management-progress > summary')).toHaveText('执行进展 · 2/2 步完成');
    await expect(step.locator('.management-step-status')).toHaveText('已完成');
    await expect(feed.getByRole('button', { name: '批准此版本', exact: true })).toHaveCount(0);
    await expect(feed).not.toContainText('等待审批');
    expect(f.h.store.get("SELECT state FROM management_commands WHERE operation='workflow.update'").state).toBe('succeeded');
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('existing conversations without model-start or invocation ids still restore distinct tools and answers', async ({ page }) => {
  const f = await managementFixture();
  try {
    const conversation = (await f.admin('/api/management/conversations', 'POST', { scope: 'project:101' })).value.conversation.id;
    const sent = (await f.admin('/api/management/conversations/' + conversation + '/messages', 'POST', { source_message: 'legacy-message', content: '更新任务默认提示词' })).value;
    await settled(f.admin, conversation, sent.id);
    f.h.store.run("DELETE FROM management_events WHERE message_id=? AND type='model_start'", sent.id);
    f.h.store.run("UPDATE management_events SET data=json_remove(data,'$.call_id') WHERE message_id=?", sent.id);
    await login(page, f);
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await expect(feed.locator('.management-step')).toHaveCount(2);
    await expect(feed.locator('.management-step-status')).toHaveText(['已完成', '已完成']);
    await expect(feed.locator('.management-answer')).toHaveCount(1);
    await expect(feed.locator('.management-turn-state')).toHaveText('已完成');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
