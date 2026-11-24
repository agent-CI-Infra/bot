import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';
import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { managementFixture } from '../../fixtures/management-fixture.mjs';

const chunk = (res, text) => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n');

async function start(page, fixture) {
  await page.goto(fixture.h.admin + '/#/management');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await switchConsoleProject(page, '101');
  const send = page.getByRole('button', { name: '发送', exact: true });
  await expect(send).toBeEnabled();
  const message = page.getByLabel('管理消息', { exact: true });
  await message.fill('读取项目进展');
  await send.click();
  const feed = page.getByRole('log', { name: '管理会话记录' });
  await expect(feed).toContainText('第 60 项');
  await expect.poll(() => feed.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3);
  return { feed, message, send, latest: page.getByRole('button', { name: '↓ 回到最新消息', exact: true }) };
}

function respond(fixture, finishedOutput) {
  fixture.modelState.respond = async (_body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(res, Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 项：已读取项目事实。\n\n`).join(''));
    await finishedOutput;
    chunk(res, '\n\n' + Array.from({ length: 30 }, (_, i) => `新增记录 ${i + 1}：保持正在阅读的位置。\n\n`).join('') + '**最后一条新进展**');
    res.end('data: [DONE]\n\n');
  };
}

async function holdCompletedHistory(page, release) {
  // The stream can show the completed turn before the final history read restores the recommendation bar.
  await page.route(/\/api\/management\/conversations\/[^/]+\/events\?after=[1-9]\d*$/, async route => {
    const response = await route.fetch();
    if (response.ok()) {
      const history = await response.json();
      if (!history.has_more && !history.messages.some(message => ['pending', 'running'].includes(message.state))) await release;
    }
    await route.fulfill({ response });
  });
}

test('drafting a follow-up pauses automatic scrolling and only new output shows the latest action', async ({ page }) => {
  test.setTimeout(60000);
  const fixture = await managementFixture();
  const output = Promise.withResolvers(), history = Promise.withResolvers();
  respond(fixture, output.promise);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { feed, latest, message, send } = await start(page, fixture);
    const last = feed.getByText('最后一条新进展', { exact: true });
    const draft = '下一条尚未发送的草稿';
    await message.fill(draft);
    await expect(latest).toBeHidden();
    const at = await feed.evaluate(node => node.scrollTop);

    await holdCompletedHistory(page, history.promise);
    output.resolve();
    await expect(feed.locator('.management-turn-state')).toHaveText('已完成');
    await expect(feed).toContainText('最后一条新进展');
    await expect(latest).toBeVisible();
    expect(await feed.evaluate(node => node.scrollTop)).toBe(at);
    await expect(message).toHaveValue(draft);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(message).toBeInViewport();
    await expect(latest).toBeVisible();
    await latest.click();
    await expect(last).toBeInViewport();

    history.resolve();
    await expect(send).toBeEnabled();
    await expect(last).toBeInViewport();
    await expect(latest).toBeHidden();
    await expect(message).toHaveValue(draft);
    expect(fixture.h.store.get('select count(*) n from management_messages').n).toBe(1);
  } finally {
    output.resolve();
    history.resolve();
    await fixture.close();
    rmSync(fixture.h.directory, { recursive: true, force: true });
  }
});

test('streaming keeps selected answer text intact until the reader releases it and explicitly returns to latest', async ({ page }) => {
  test.setTimeout(60000);
  const fixture = await managementFixture();
  const output = Promise.withResolvers(), history = Promise.withResolvers();
  respond(fixture, output.promise);
  try {
    const { feed, latest, send } = await start(page, fixture);
    const last = feed.getByText('最后一条新进展', { exact: true });
    const selected = await feed.evaluate(node => {
      const paragraphs = node.querySelectorAll('.management-markdown p');
      const range = document.createRange();
      range.selectNodeContents(paragraphs[paragraphs.length - 1]);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    expect(selected).toContain('第 60 项');
    const at = await feed.evaluate(node => node.scrollTop);

    await holdCompletedHistory(page, history.promise);
    output.resolve();
    await expect(feed.locator('.management-turn-state')).toHaveText('已完成');
    await expect(latest).toBeVisible();
    expect(await page.evaluate(() => window.getSelection().toString())).toBe(selected);
    expect(await feed.evaluate(node => node.scrollTop)).toBe(at);
    await expect(feed).not.toContainText('最后一条新进展');

    await page.evaluate(() => window.getSelection().removeAllRanges());
    await expect(feed).toContainText('最后一条新进展');
    expect(await feed.evaluate(node => node.scrollTop)).toBe(at);
    await latest.focus();
    await page.keyboard.press('Enter');
    await expect(last).toBeInViewport();

    history.resolve();
    await expect(send).toBeEnabled();
    await expect(last).toBeInViewport();
    await expect(latest).toBeHidden();
    expect(fixture.h.store.get('select count(*) n from management_messages').n).toBe(1);
  } finally {
    output.resolve();
    history.resolve();
    await fixture.close();
    rmSync(fixture.h.directory, { recursive: true, force: true });
  }
});
