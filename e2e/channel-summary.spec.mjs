import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { channelFixture, boundGroup, privateChat, scriptedModel, envelope, post, finished } from '../test/channel-fixture.mjs';

async function login(page, f, chat) {
  await page.goto(f.h.admin + '/#/conversations/' + chat.id);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

// Persist the same facts the channel API projects; no simulated model or remote delivery is needed.
function turn(f, chat, { state = 'completed', start = Date.now() - 90000, end = start + 75000, reply = '已核对项目证据。', delivery = 'sent', error = null } = {}) {
  const id = randomBytes(24).toString('hex'), source = 'summary-' + id;
  const binding = f.service.serviceBindings.get(chat.id), store = f.h.store;
  store.run(`INSERT INTO channel_service_turns(id,chat_id,binding_id,binding_revision,service_role_id,source_message,fence,state,reply,error,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id, chat.id, binding.id, binding.revision, binding.service_role_id, source, f.service.serviceBindings.fence(chat.id), state,
    reply ? store.secrets.seal({ message: reply }, 'service-turn-reply:' + id) : null, error, start, end);
  store.run("INSERT INTO channel_service_events(turn_id,type,name,created_at) VALUES(?,'running','',?)", id, start);
  if (state === 'completed') store.run("INSERT INTO channel_service_events(turn_id,type,name,created_at) VALUES(?,'done','',?)", id, end);
  if (delivery) store.run(`INSERT INTO channel_outbox(id,connector_id,idempotency_key,payload,state,next_attempt,last_error,created_at)
    VALUES(?,?,?,?,?,?,?,?)`, randomBytes(24).toString('hex'), chat.connector_id, source + ':business-result', '{}', delivery, Date.now() + 86400000,
    delivery === 'failed' ? 'channel_delivery_failed' : null, end);
  return id;
}

const run = (page, id) => page.locator(`[data-timeline-key="turn:${id}"]`);

for (const width of [390, 768, 1440]) test(`channel summaries distinguish execution, delivery and unknown timing at ${width}px`, async ({ page }) => {
  const f = await channelFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const chat = await boundGroup(f);
    const completed = turn(f, chat);
    const unsent = turn(f, chat, { delivery: 'failed', start: Date.now() - 80000 });
    const running = turn(f, chat, { state: 'running', start: Date.now() - 15000, reply: '', delivery: null });
    const failed = turn(f, chat, { state: 'failed', start: Date.now() - 60000, end: Date.now() - 52000, reply: '', delivery: null, error: 'conversation_failed' });
    const interrupted = turn(f, chat, { state: 'interrupted', start: Date.now() - 40000, end: Date.now(), reply: '', delivery: null });
    const missing = turn(f, chat, { start: 0, end: 1000, delivery: 'unknown' });
    await page.setViewportSize({ width, height: 1000 });
    await login(page, f, chat);
    await expect(run(page, completed).locator('.status')).toHaveText('生成完成');
    await expect(run(page, completed).locator('.channel-run-facts')).toHaveText('助手执行 1 分 15 秒回答已发送至飞书');
    await expect(run(page, unsent).locator('.status')).toHaveText('生成完成');
    await expect(run(page, unsent)).toContainText('回答发送失败');
    await expect(run(page, unsent)).toContainText('发送原因：channel_delivery_failed');
    await expect(run(page, unsent)).not.toContainText('回答已发送至飞书');
    await run(page, unsent).getByText('本轮生成的回答', { exact: true }).click();
    await expect(run(page, unsent).getByText('已核对项目证据。', { exact: true })).toBeVisible();
    await expect(run(page, running).locator('.channel-run-facts')).toContainText('助手已执行');
    await expect(run(page, running)).toContainText('尚无最终回答发送记录');
    await expect(run(page, running).getByRole('button', { name: '停止回答' })).toBeVisible();
    await expect(run(page, failed).locator('.channel-run-facts')).toContainText('助手执行 8 秒');
    await expect(run(page, failed)).toContainText('conversation_failed');
    for (const id of [interrupted, missing]) {
      await expect(run(page, id).locator('.channel-run-facts')).toContainText('执行时长未知');
      await expect(run(page, id).locator('.channel-run-facts')).not.toContainText('0 秒');
    }
    await expect(run(page, missing)).toContainText('回答发送结果未知');
    await expect(page.getByLabel('会话派生任务')).toBeHidden();
    await expect(page.locator('.channel-console-layout')).not.toHaveClass(/channel-with-tasks/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mkdirSync('.tmp/channel-summary', { recursive: true });
    await page.screenshot({ path: `.tmp/channel-summary/states-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('refresh retains an expanded answer and steps at the reading position, but clears revoked content', async ({ page }) => {
  const f = await channelFixture();
  try {
    const chat = await boundGroup(f);
    const id = turn(f, chat, { reply: Array.from({ length: 60 }, (_, i) => `证据第 ${i + 1} 行：保留当前阅读位置。`).join('\n') });
    await page.setViewportSize({ width: 768, height: 1000 }); await login(page, f, chat);
    const row = run(page, id), history = page.getByLabel('消息与执行时间线');
    await row.getByText('查看执行过程', { exact: true }).click();
    await expect(row.locator('.channel-step')).toHaveCount(2);
    await row.getByText('本轮生成的回答', { exact: true }).click();
    const before = await row.locator('[data-detail-key=reply] p').evaluate(body => {
      const history = body.closest('.channel-messages');
      history.scrollTop += body.getBoundingClientRect().top - history.getBoundingClientRect().top + 120;
      return history.scrollTop;
    });
    turn(f, chat, { start: Date.now() - 1000, end: Date.now(), reply: '刷新期间新增的回合。' });
    await page.getByRole('button', { name: '刷新会话', exact: true }).click();
    await expect(page.locator('.channel-run')).toHaveCount(2);
    await expect(row.locator('[data-detail-key=reply]')).toHaveAttribute('open', '');
    await expect(row.locator('[data-detail-key=steps]')).toHaveAttribute('open', '');
    await expect(row.locator('.channel-step')).toHaveCount(2);
    await expect.poll(() => history.evaluate(node => node.scrollTop)).toBeCloseTo(before, 0);
    await page.route('**/timeline?*', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'channel_history_forbidden' }) }));
    await page.getByRole('button', { name: '刷新会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '会话访问已变化', exact: true })).toBeVisible();
    await expect(history).toHaveCount(0);
    await expect(page.getByText('证据第 1 行：保留当前阅读位置。', { exact: false })).toHaveCount(0);
  } finally { await f.close(); }
});

test('private management turns do not invent execution time from their queued creation time', async ({ page }) => {
  const f = await channelFixture();
  try {
    const chat = await privateChat(f); scriptedModel(f, ['私聊中的完整回答。']);
    const receipt = await post(f.h, f.id, envelope('请核对项目。', { message: { chat_id: chat.chat_id } }));
    expect((await finished(f.h, receipt.value.operation_id)).state).toBe('completed');
    await login(page, f, chat);
    await expect(page.locator('.channel-run-facts')).toContainText('执行时长未知');
    await expect(page.getByText('私聊中的完整回答。', { exact: true })).toBeVisible();
    await expect(page.locator('.channel-run .status')).toHaveText('执行完成');
  } finally { await f.close(); }
});

test('refresh re-reads loaded older turns instead of dropping the answer being read', async ({ page }) => {
  const f = await channelFixture();
  try {
    const chat = await boundGroup(f), start = Date.now() - 900000;
    let oldest;
    for (let i = 0; i < 65; i++) oldest = turn(f, chat, { start: start - i * 1000,
      reply: i === 64 ? '较早回合的完整证据。\n'.repeat(50) : '已完成的回合 ' + i });
    await page.setViewportSize({ width: 768, height: 1000 }); await login(page, f, chat);
    await expect(page.locator('.channel-run')).toHaveCount(50);
    await page.getByRole('button', { name: '更早执行回合', exact: true }).click();
    await expect(page.locator('.channel-run')).toHaveCount(65);
    const row = run(page, oldest), history = page.getByLabel('消息与执行时间线');
    await row.getByText('本轮生成的回答', { exact: true }).click();
    const before = await row.locator('[data-detail-key=reply] p').evaluate(body => {
      const history = body.closest('.channel-messages');
      history.scrollTop += body.getBoundingClientRect().top - history.getBoundingClientRect().top + 90;
      return history.scrollTop;
    });
    turn(f, chat, { start: Date.now() - 1000, end: Date.now() });
    await page.getByRole('button', { name: '刷新会话', exact: true }).click();
    await expect(page.locator('.channel-run')).toHaveCount(66);
    await expect(row.locator('[data-detail-key=reply]')).toHaveAttribute('open', '');
    await expect.poll(() => history.evaluate(node => node.scrollTop)).toBeCloseTo(before, 0);
  } finally { await f.close(); }
});

test('first opening a long step list keeps its beginning in view', async ({ page }) => {
  const f = await channelFixture();
  try {
    const chat = await boundGroup(f), id = turn(f, chat);
    for (let i = 0; i < 80; i++) f.h.store.run("INSERT INTO channel_service_events(turn_id,type,name,created_at) VALUES(?,'tool_result','list_projects',?)", id, Date.now() + i);
    await page.setViewportSize({ width: 768, height: 1000 }); await login(page, f, chat);
    const row = run(page, id), history = page.getByLabel('消息与执行时间线');
    await row.getByText('查看执行过程', { exact: true }).click();
    await expect(row.locator('.channel-step')).toHaveCount(82);
    await expect.poll(() => history.evaluate(node => node.scrollTop)).toBeLessThan(20);
    const first = await row.locator('.channel-step').first().evaluate(node => ({
      top: node.getBoundingClientRect().top, containerTop: node.closest('.channel-messages').getBoundingClientRect().top
    }));
    expect(first.top).toBeGreaterThanOrEqual(first.containerTop);
  } finally { await f.close(); }
});
