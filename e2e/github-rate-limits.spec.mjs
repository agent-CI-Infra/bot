import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { harness, setup, account } from '../test/helpers.mjs';
import { InstallationSync } from '../dist/app/installations.js';
import { appBucket, installationBucket, observe, refused } from '../dist/github/rate-limits.js';

test('全局设置按账号、App 和组织显示 GitHub 请求额度的窗口和用量，「探测」立即读取', async ({ page }) => {
  const reset = Date.now() + 30 * 60_000, seconds = ms => String(Math.floor(ms / 1000));
  // GitHub answers the bot account's GET /rate_limit; nothing else is needed for a probe.
  const github = createServer((req, res) => {
    res.writeHead(req.url === '/rate_limit' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/rate_limit' ? { resources: { core: { limit: 5000, remaining: 4321, used: 679, reset: Number(seconds(reset)) }, graphql: { limit: 5000, remaining: 5000, used: 0, reset: Number(seconds(reset)) } } } : {}));
  });
  github.listen(0, '127.0.0.1'); await once(github, 'listening');
  const h = await harness(undefined, undefined, store => ({ installations: new InstallationSync(store, 'http://127.0.0.1:' + github.address().port) })), errors = [];
  page.on('pageerror', e => errors.push(e.message)); mkdirSync('.tmp/github-rate-limits', { recursive: true });
  try {
    const { admin, password } = await setup(h), bot = await account(admin, { name: '部门机器人' });
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const app = await account(admin, { name: 'agent-ci-infra-bot', type: 'github_app', app_id: '123', private_key: privateKey, token: undefined });
    const headers = remaining => new Headers({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-used': String(5000 - remaining), 'x-ratelimit-reset': seconds(reset), 'x-ratelimit-resource': 'core' });
    observe(h.store, appBucket(app.id), headers(4990));
    observe(h.store, installationBucket(app.id, '175700149', 'openJiuwen-ai'), headers(300));
    refused(h.store, installationBucket(app.id, '175700150', 'agent-test-zone'), headers(0));
    await page.goto(h.admin + '/#/settings/accounts'); await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    const card = page.locator('.side-card').filter({ has: page.getByRole('heading', { name: 'GitHub 请求额度' }) });
    const rows = card.locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('App 自身（JWT） · REST'); await expect(rows.nth(0)).toContainText('正常');
    // Installations follow the App's own window, by organization name.
    await expect(rows.nth(1)).toContainText('agent-test-zone（安装 175700150）'); await expect(rows.nth(1)).toContainText(/流控中，\d\d:\d\d:\d\d 后继续/);
    await expect(rows.nth(2)).toContainText('openJiuwen-ai（安装 175700149） · REST'); await expect(rows.nth(2)).toContainText('将用完');
    await expect(card).toContainText('部门机器人（机器人账号）'); await expect(card).toContainText('还没有记录，点「探测」读取。');
    // Probing the bot account reads its windows now.
    const section = card.locator('.settings-list-head').filter({ hasText: '部门机器人' });
    await section.getByRole('button', { name: '探测', exact: true }).click();
    await expect(card).toContainText('已读取 部门机器人 的请求额度');
    await expect(rows).toHaveCount(5); await expect(card).toContainText('机器人账号 · REST'); await expect(card).toContainText('4321');
    expect(h.store.get("SELECT remaining FROM github_rate_limits WHERE bucket=?", 'user:' + bot.id).remaining).toBe(4321);
    await page.screenshot({ path: '.tmp/github-rate-limits/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await expect(rows).toHaveCount(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/github-rate-limits/mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); await new Promise(resolve => github.close(resolve)); }
});
