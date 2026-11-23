import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { managementFixture } from '../../fixtures/management-fixture.mjs';

test('conversation titles and last activity update and sort the sidebar across reloads', async ({ page }) => {
  const fixture = await managementFixture();
  try {
    fixture.modelState.titleRespond = async (body, response) => {
      const { request } = JSON.parse(body.messages[1].content);
      const title = request.includes('日志') ? '查看执行日志' : '排查等待中的任务';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: title } }] }));
    };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(fixture.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const list = page.getByRole('list', { name: '持久会话' });
    const entries = list.getByRole('button');
    const composer = page.getByLabel('管理消息', { exact: true });
    const send = page.getByRole('button', { name: '发送', exact: true });
    async function sendMessage(text) {
      await composer.fill(text);
      await send.click();
      await expect(send).toBeEnabled();
    }

    await expect(entries.first()).toContainText('新会话');
    await sendMessage('任务为什么没有继续？');
    const first = entries.filter({ hasText: '排查等待中的任务' });
    await expect(first).toBeVisible();
    const firstActivity = await first.locator('time').getAttribute('datetime');

    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    await expect(entries.first()).toContainText('新会话');
    await sendMessage('怎么查看任务的执行日志？');
    await expect(entries.first()).toContainText('查看执行日志');
    await expect(entries.nth(1)).toContainText('排查等待中的任务');

    await first.click();
    await sendMessage('再检查一次任务状态。');
    await expect(entries.first()).toContainText('排查等待中的任务');
    await expect(first.locator('time')).toHaveText(/^最后活动 \d{4}-\d{2}-\d{2} /);
    await expect(first.locator('time')).not.toHaveAttribute('datetime', firstActivity);
    expect(fixture.titleRequests).toHaveLength(2);

    await page.reload();
    await expect(entries.first()).toContainText('排查等待中的任务');
    await expect(entries.nth(1)).toContainText('查看执行日志');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '会话记录', exact: true }).click();
    await expect(entries.first()).toContainText('排查等待中的任务');
    await expect(entries.nth(1).locator('time')).toBeVisible();
  } finally {
    await fixture.close();
    rmSync(fixture.h.directory, { recursive: true, force: true });
  }
});
