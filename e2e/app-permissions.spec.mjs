import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { InstallationSync } from '../dist/app/installations.js';

test('App 定义只在机器人账号检查，安装权限和事件缺口在项目行与同步结论中显示', async ({ page }) => {
  const full = { contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'write', actions: 'write', checks: 'write', metadata: 'read' };
  const events = ['issues', 'pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'];
  const app = { slug: 'fixture-app', html_url: 'https://github.com/apps/fixture-app', owner: { login: 'fixture', type: 'Organization' },
    permissions: { ...full, statuses: 'read', actions: undefined }, events: ['issues', 'pull_request'] };
  const installations = [{ id: 7, account: { login: 'fixture' }, permissions: { ...full, actions: 'read' }, events: ['issues', 'pull_request', 'issue_comment'] },
    { id: 8, account: { login: 'paused' }, suspended_at: '2026-01-01', permissions: {}, events: [] }];
  let failInstallations = false;
  const github = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake'); res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/app') return res.end(JSON.stringify(app));
    if (url.pathname === '/app/installations') {
      if (failInstallations) { res.statusCode = 503; return res.end('{}'); }
      return res.end(JSON.stringify(url.searchParams.get('page') === '1' ? installations : []));
    }
    if (url.pathname === '/app/installations/7/access_tokens') return res.end(JSON.stringify({ token: 'installation-fixture' }));
    if (url.pathname === '/installation/repositories') return res.end(JSON.stringify({ repositories: [101, 202].map(id => ({ id, full_name: `fixture/project-${id}`, private: true, owner: { id: 10, login: 'fixture' } })) }));
    res.statusCode = 404; res.end('{}');
  });
  github.listen(0, '127.0.0.1'); await once(github, 'listening');
  const h = await harness(undefined, undefined, store => ({ installations: new InstallationSync(store, `http://127.0.0.1:${github.address().port}`) }));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const a = await account(admin, { name: 'Department App', type: 'github_app', app_id: '123', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), token: undefined });
    await admin('/api/installations/sync', 'POST', {}); await repository(admin, a.id, '101');
    await page.goto(h.admin); await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '全局设置', exact: true }).click(); await page.locator('.project-nav').getByRole('link', { name: '机器人账号', exact: true }).click();
    const accountRow = page.locator('.row', { hasText: 'Department App' }); await accountRow.getByRole('button', { name: '检查权限和事件订阅', exact: true }).click();
    const result = accountRow.locator('.permission-result');
    await expect(result).toContainText('Actions：改为「Read and write」（当前「No access」）');
    await expect(result).toContainText('Commit statuses：改为「Read and write」（当前「Read-only」）');
    await expect(result).toContainText('Subscribe to events：勾选 Issue comment、Pull request review、Pull request review comment');
    await expect(result).not.toContainText('第 2 步'); await expect(result).not.toContainText('fixture：');
    await expect(result.getByRole('link', { name: '前往接受' })).toHaveCount(0);
    const settingsLink = result.getByRole('link', { name: '打开 App 的 Permissions & events' });
    await expect(settingsLink).toHaveAttribute('href', 'https://github.com/organizations/fixture/settings/apps/fixture-app/permissions');
    mkdirSync('.tmp/app-permissions', { recursive: true });
    for (const [width, height] of [[1365, 900], [390, 844]]) {
      await page.setViewportSize({ width, height }); await result.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `.tmp/app-permissions/missing-${width}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    // App completeness is independent of installations that have not yet accepted its permissions or events.
    app.permissions = full; app.events = events; await accountRow.getByRole('button', { name: '重新检查', exact: true }).click();
    await expect(result).toContainText('App 权限和事件订阅齐全。'); await expect(result).not.toContainText('安装'); await expect(settingsLink).toBeVisible();
    await page.setViewportSize({ width: 1365, height: 900 }); await page.getByRole('button', { name: '项目', exact: true }).click();
    await expect(page.getByRole('button', { name: '检查接入', exact: true })).toHaveCount(0);
    const row = id => page.locator(`#rows [data-repository-id="${id}"]`), message = page.locator('#message');
    const sync = page.getByRole('button', { name: '同步安装列表', exact: true });
    await sync.click(); await expect(message).toContainText('权限和事件订阅并非全部正常。');
    await expect(message).toContainText('fixture（安装 7）：权限不足：Actions'); await expect(message).toContainText('事件未订阅：Pull request review、Pull request review comment');
    await expect(message).not.toContainText('paused');
    for (const id of ['101', '202']) {
      await expect(row(id).locator('[data-permission]')).toHaveText('权限不足 · 事件未订阅');
      await expect(row(id).locator('[data-permission]')).toHaveAttribute('title', /Actions.*Pull request review、Pull request review comment/);
    }
    app.events = ['issues', 'pull_request']; await sync.click();
    await expect(message).toContainText('App 定义仍有缺口，请到「全局设置 → 机器人账号」查看。');
    app.events = events; installations[0].permissions = full; await sync.click();
    await expect(row('101').locator('[data-permission]')).toHaveText('事件未订阅');
    await row('101').getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.locator('.project-head [data-permission]')).toHaveText('事件未订阅');
    await expect(page.locator('.project-head [data-permission]')).toHaveAttribute('title', /Pull request review、Pull request review comment/);
    await page.getByRole('link', { name: '← 全部项目', exact: true }).click();
    installations[0].events = events; await sync.click();
    await expect(message.locator('span')).toHaveText('安装列表已同步，1 个安装的权限和事件订阅都正常。');
    await expect(message.locator('span')).toHaveClass('view-success');
    await expect(row('101').locator('[data-permission]')).toBeHidden(); await expect(row('202').locator('[data-permission]')).toBeHidden();
    // A failed account sync cannot turn cached grants into an all-normal conclusion.
    failInstallations = true; await sync.click();
    await expect(message).toContainText('部分账号同步失败：Department App（github_http_503）');
    await expect(message).toContainText('因此还不能判断全部安装的权限和事件订阅是否正常。');
    expect(errors).toEqual([]);
  } finally { await h.stop(); await new Promise(resolve => github.close(resolve)); }
});
