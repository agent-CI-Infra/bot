import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { managementFixture } from '../test/management-fixture.mjs';
import { channelFixture, boundGroup, repositoryAssistant, inGroup, post, until } from '../test/channel-fixture.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// Progress messages of service roles (#435) in the console. Model and Feishu traffic go to local protocol fixtures.
const answer = (res, message) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const progress = (res, text) => answer(res, { role: 'assistant', content: null, tool_calls: [{ id: 'progress-1', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ text }) } }] });
const answered = body => body.messages.some(m => m.role === 'tool');
async function login(page, f, path) {
  await page.goto(f.h.admin + path);
  await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('a management turn shows its progress message while it runs, before the answer, and after a reload (#435)', async ({ page }) => {
  const f = await managementFixture(), errors = []; let release; const gate = new Promise(done => { release = done; });
  page.on('pageerror', error => errors.push(error.message));
  f.modelState.respond = async (body, res) => {
    if (!answered(body)) return progress(res, '**正在读取**任务列表，稍等。');
    await gate; answer(res, { role: 'assistant', content: '任务都在正常推进。' });
  };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, f, '/#/management');
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    const feed = page.getByRole('log', { name: '管理会话记录' }), message = page.getByLabel('管理消息', { exact: true });
    await message.fill('看看任务进展'); await page.getByRole('button', { name: '发送', exact: true }).click();
    const sent = feed.locator('.management-progress-message');
    await expect(sent).toContainText('进展消息 1'); await expect(sent.locator('strong')).toHaveText('正在读取');
    await expect(feed.locator('.management-turn-state')).toHaveAttribute('data-state', 'running');
    // A progress message is not an execution step.
    await expect(feed.locator('.management-progress')).toBeHidden();
    mkdirSync('.tmp/stage-messages', { recursive: true }); await page.screenshot({ path: '.tmp/stage-messages/management-running.png' });
    release();
    await expect(feed.locator('.management-turn-state')).toHaveText('已完成');
    await expect(feed.locator('.management-answer').last()).toContainText('任务都在正常推进。');
    await page.reload();
    // #480: the page-local scope lasts for one opening, so a reload returns to the shell default; reopening the project
    // scope is how the replayed conversation is read again.
    const scope = page.getByLabel('当前管理作用域', { exact: true });
    await expect(scope).toHaveValue('platform');
    await scope.selectOption('project:101');
    await expect(feed.locator('.management-progress-message')).toContainText('正在读取任务列表');
    await expect(feed.locator('.management-answer')).toHaveCount(2);
    await expect(feed.locator('.management-answer').last()).toContainText('任务都在正常推进。');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/stage-messages/management-mobile.png' });
    expect(errors).toEqual([]);
  } finally { release(); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('a running group answer shows its progress in the console, and its manager stops it there (#435)', async ({ page }) => {
  test.setTimeout(60000);
  const f = await channelFixture(undefined, store => ({ engine: new TaskEngine(store, { call: async () => ({ state: 'stopped' }) }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await repositoryAssistant(f); await boundGroup(f);
    f.modelState.respond = async (body, res) => {
      if (!answered(body)) return progress(res, '正在查阅 admin-fixture-101 的未关闭 PR。');
      await new Promise(() => {}); // Never answers: only the stop ends this turn.
    };
    await post(f.h, f.id, inGroup('帮我看看未关闭的 PR', 'ou_bob'));
    await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('正在查阅 admin-fixture-101')));
    await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, f, '/#/identity/feishu/groups');
    const binding = page.getByRole('article', { name: '群聊助手绑定' });
    await binding.getByRole('link', { name: '查看聊天记录', exact: true }).click();
    const progressMessage = page.getByRole('region', { name: '助手进展消息' });
    await expect(progressMessage).toContainText('正在查阅 admin-fixture-101 的未关闭 PR。');
    await expect(page.getByText('正在回答…', { exact: true })).toBeVisible();
    await expect(page.locator('.channel-run')).toContainText('仓库问答助手');
    mkdirSync('.tmp/stage-messages', { recursive: true }); await page.screenshot({ path: '.tmp/stage-messages/group-running.png', fullPage: true });
    await page.getByRole('button', { name: '停止回答', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '停止回答', exact: true }).click();
    await expect(page.locator('.channel-run .status')).toHaveText('已停止');
    await expect(page.getByText('已在控制台停止，不再发送最终回答；已发出的进展消息保留。', { exact: true })).toBeVisible();
    await expect(progressMessage).toContainText('正在查阅 admin-fixture-101 的未关闭 PR。');
    await expect(page.getByRole('button', { name: '停止回答', exact: true })).toHaveCount(0);
    await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('已在控制台停止')));
    await page.screenshot({ path: '.tmp/stage-messages/group-stopped.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
