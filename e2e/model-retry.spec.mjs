import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { managementFixture } from '../test/management-fixture.mjs';
import { channelFixture, boundGroup, repositoryAssistant, inGroup, post, until } from '../test/channel-fixture.mjs';

// A model request that keeps failing is retried five times (milliseconds apart in tests); when the turn still fails, the
// console says why instead of only showing an error code.
async function login(page, f, hash) {
  await page.goto(f.h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
const unavailable = res => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'overloaded' } })); };

test('a group turn that fails through every retry shows the retries and the reason in the chat history', async ({ page }) => {
  const f = await channelFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await repositoryAssistant(f); const chat = await boundGroup(f);
    f.modelState.respond = async (_body, res) => unavailable(res);
    const receipt = await post(f.h, f.id, inGroup('汇总十个仓库的 Issue', 'ou_bob'));
    await until(() => f.h.store.get('SELECT state FROM channel_inbox WHERE id=?', receipt.value.operation_id)?.state === 'failed');
    mkdirSync('.tmp/model-retry', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, f, '#/conversations/' + chat.id);
    const reason = page.getByText(/^原因：模型 .*返回 HTTP 503：overloaded（已自动重试 5 次仍失败）$/);
    await expect(reason).toBeVisible();
    await page.screenshot({ path: '.tmp/model-retry/group-failed-1440.png', fullPage: true });
    await page.getByText('查看执行过程', { exact: true }).click();
    await expect(page.getByText(/模型请求失败，等待后重试/)).toHaveCount(5);
    await page.screenshot({ path: '.tmp/model-retry/group-steps-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(f.h.admin + '/#/conversations/' + chat.id);
    await expect(reason).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/model-retry/group-failed-390.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('a management message that fails through every retry says why, with the error code', async ({ page }) => {
  const f = await managementFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    f.modelState.failure = 503;
    await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, f, '#/management');
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await page.getByLabel('管理消息', { exact: true }).fill('看看任务进展'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(feed.locator('.management-turn-state').last()).toHaveText('处理失败');
    await expect(feed).toContainText(/这次处理未完成：模型 .*返回 HTTP 503：Fixture model failure（已自动重试 5 次仍失败）（model_http_503）/);
    mkdirSync('.tmp/model-retry', { recursive: true }); await page.screenshot({ path: '.tmp/model-retry/management-failed-1440.png' });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
