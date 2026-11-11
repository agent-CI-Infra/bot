import { test, expect } from '@playwright/test';
import { managementFixture } from '../test/management-fixture.mjs';

async function login(page, f) {
  await page.goto(f.h.admin + '/#/management');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('当前管理作用域').selectOption('project:101');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
}

// #235 验收要求「消息/日志均脱敏，无 secret 和私有推理」。管理助手的脱敏只有两个实现点
// （src/management/agent.ts:198 的流式增量与 :204 的最终回复，另有 receipt 的 redactEgress），
// 此前没有任何用例钉住它：模型若原样回吐供应商 key，页面、事件表与 HTML 都可能留着明文。
test('a provider key the model echoes back never reaches the chat, the stored events or the page HTML', async ({ page }) => {
  test.setTimeout(90000);
  // managementFixture 把助手模型的 api_key 设成 fixture-provider-key，运行时会交给 Redactor。
  const secret = 'fixture-provider-key';
  const f = await managementFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    f.modelState.respond = async (_body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // The key appears once as a streamed delta and once in the final text: both paths must be redacted.
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '已读取供应商配置，凭据是 ' + secret } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '，请只在控制台使用。' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    };
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, f);
    const feed = page.getByRole('log', { name: '管理会话记录' }), message = page.getByLabel('管理消息', { exact: true });
    await message.fill('把供应商凭据念一遍');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(feed).toContainText('已读取供应商配置');
    await expect(feed).toContainText('请只在控制台使用');
    // The wording stays readable; the value itself is gone.
    const shown = await feed.innerText();
    expect(shown).toContain('[REDACTED]');
    expect(shown).not.toContain(secret);
    // Stored events (what a later re-read renders) must not keep the plaintext either.
    const events = JSON.stringify(f.h.store.all('SELECT * FROM management_events'));
    expect(events).toContain('[REDACTED]');
    expect(events).not.toContain(secret);
    // Nor the rendered page, however the browser serializes it.
    expect(await page.content()).not.toContain(secret);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
