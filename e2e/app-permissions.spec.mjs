import { consoleNavigate } from './console-navigation.mjs';
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { InstallationSync } from '../dist/app/installations.js';

test('App 定义只在机器人账号检查，各功能的安装权限和事件缺口在项目行、缺口对话框与同步结论中显示', async ({ page }) => {
  const full = { contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'write', actions: 'write', checks: 'write', metadata: 'read' };
  const events = ['issues', 'pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'];
  // Gate onboarding also needs workflows, and Actions failure analysis workflow_run.
  const everything = { ...full, workflows: 'write' }, allEvents = [...events, 'workflow_run'];
  const app = { slug: 'fixture-app', html_url: 'https://github.com/apps/fixture-app', owner: { login: 'fixture', type: 'Organization' },
    permissions: { ...full, statuses: 'read', actions: undefined }, events: ['issues', 'pull_request'] };
  const installations = [{ id: 7, account: { id: 10, login: 'fixture', type: 'Organization' }, repository_selection: 'all',
    permissions: { ...full, actions: 'read' }, events: ['issues', 'pull_request', 'issue_comment'] },
    { id: 8, account: { id: 20, login: 'paused', type: 'Organization' }, repository_selection: 'selected', suspended_at: '2026-01-01', permissions: {}, events: [] }];
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
    await consoleNavigate(page, '全局设置'); await page.locator('.project-nav').getByRole('link', { name: '机器人账号', exact: true }).click();
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
    // Gate onboarding and Actions failure analysis need more than the baseline; that is listed without failing it.
    await expect(result).toContainText('Workflows：改为「Read and write」（当前「No access」），接入门禁需要');
    await expect(result).toContainText('Subscribe to events：勾选 Workflow run，Actions 失败分析需要');
    // Workflow run sits next to the Workflows line but needs only Actions read.
    await expect(result).toContainText('这是事件订阅，不是 Workflows 权限：GitHub 只要求 App 至少有 Actions「Read-only」');
    // App completeness is independent of installations that have not yet accepted its permissions or events.
    app.permissions = full; app.events = events; await accountRow.getByRole('button', { name: '重新检查', exact: true }).click();
    await expect(result).toContainText('检视和开发所需的 App 权限和事件订阅齐全。'); await expect(result).toContainText('勾选 Workflow run');
    app.permissions = everything; app.events = allEvents; await accountRow.getByRole('button', { name: '重新检查', exact: true }).click();
    await expect(result).toContainText('App 权限和事件订阅齐全，覆盖全部功能。'); await expect(result).not.toContainText('安装'); await expect(settingsLink).toBeVisible();
    await page.setViewportSize({ width: 1365, height: 900 }); await page.goto(h.admin + '/#/settings/projects');
    await expect(page.getByRole('button', { name: '检查接入', exact: true })).toHaveCount(0);
    const row = id => page.locator(`.global-project-row[data-repository-id="${id}"]`), message = page.locator('#message'), chip = id => row(id).locator('[data-permission]');
    const sync = page.getByRole('button', { name: '同步安装列表', exact: true });
    await sync.click(); await expect(message).toContainText('权限和事件订阅并非全部正常。');
    await expect(message).toContainText('fixture（安装 7）：Actions 需要「Read and write」，现在「Read-only」（影响发版本、Actions 失败分析）');
    await expect(message).toContainText('未订阅事件 Pull request review（影响检视、开发）'); await expect(message).toContainText('未订阅事件 Workflow run（影响 Actions 失败分析）');
    await expect(message).not.toContainText('paused');
    for (const id of ['101', '202']) {
      await expect(chip(id)).toHaveText('权限不足 · 事件未订阅'); await expect(chip(id).locator('svg.status-icon')).toBeVisible();
      await expect(chip(id)).toHaveAttribute('title', /Actions 需要.*Workflows 需要.*Pull request review comment.*Workflow run/);
    }
    // Every gap opens with what is missing, how to fix it and what it stops, including features that are off.
    await chip('101').click();
    const gapsView = page.locator('dialog.access-dialog'), items = gapsView.locator('.access-gaps > li');
    await expect(gapsView.getByRole('heading', { name: '权限与事件缺口 · fixture/project-101' })).toBeVisible(); await expect(items).toHaveCount(5);
    await expect(items.nth(1)).toContainText('Workflows 需要「Read and write」，现在「No access」');
    await expect(items.nth(1)).toContainText('把 Workflows 设为「Read and write」并保存；新增权限要由安装所有者（fixture）在 GitHub 的安装设置里接受');
    await expect(items.nth(1)).toContainText('接入门禁（手动使用时）：提交不了 .github/workflows 门禁配置 PR');
    await expect(items.nth(4)).toContainText('Actions 失败分析在读取运行之前停止：不分类、不重跑、不提报 Issue。涉及：Actions 失败分析（未开启）');
    await expect(items.nth(4)).toContainText('勾选 Workflow run 并保存。这是事件订阅，不是 Workflows 权限');
    for (const [width, height] of [[1365, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: `.tmp/app-permissions/gaps-dialog-${width}.png` });
      expect(await gapsView.evaluate(view => view.scrollWidth <= view.clientWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1365, height: 900 }); await gapsView.getByRole('button', { name: '关闭', exact: true }).click(); await expect(gapsView).toBeHidden();
    app.events = ['issues', 'pull_request']; await sync.click();
    await expect(message).toContainText('App 定义仍有缺口，请到「全局设置 → 机器人账号」查看。');
    app.events = allEvents; installations[0].permissions = everything; await sync.click();
    await expect(chip('101')).toHaveText('事件未订阅');
    await row('101').getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.locator('.project-head [data-permission]')).toHaveText('事件未订阅');
    await expect(page.locator('.project-head [data-permission]')).toHaveAttribute('title', /Pull request review comment.*Workflow run/);
    await page.getByRole('link', { name: '← 全部项目', exact: true }).click(); await page.goto(h.admin + '/#/settings/projects');
    installations[0].events = allEvents; await sync.click();
    await expect(message.locator('span')).toHaveText('安装列表已同步，1 个安装的权限和事件订阅都正常。');
    await expect(message.locator('span')).toHaveClass('view-success');
    await expect(chip('101')).toBeHidden(); await expect(chip('202')).toBeHidden();
    // Without workflow_run both rows are flagged; switching the feature on only raises that row from blue to amber.
    installations[0].events = events;
    expect((await admin('/api/repositories/101/policy', 'PATCH', { actions_failures_enabled: true })).status).toBe(200);
    await sync.click(); await expect(message).toContainText('未订阅事件 Workflow run（影响 Actions 失败分析）');
    await expect(chip('101')).toHaveText('事件未订阅'); await expect(chip('101')).toHaveClass(/status-warning/);
    await expect(chip('202')).toHaveText('事件未订阅'); await expect(chip('202')).toHaveClass(/status-info/);
    await chip('101').click(); await expect(items).toHaveCount(1); await expect(items.first()).toContainText('涉及：Actions 失败分析（已开启）');
    await gapsView.getByRole('button', { name: '关闭', exact: true }).click();
    for (const [width, height] of [[1365, 900], [390, 844]]) {
      await page.setViewportSize({ width, height }); await row('101').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `.tmp/app-permissions/actions-row-${width}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1365, height: 900 });
    installations[0].events = allEvents; await sync.click();
    await expect(message.locator('span')).toHaveText('安装列表已同步，1 个安装的权限和事件订阅都正常。'); await expect(chip('101')).toBeHidden();
    // A failed account sync cannot turn cached grants into an all-normal conclusion.
    failInstallations = true; await sync.click();
    await expect(message).toContainText('部分账号同步失败：Department App（github_http_503）');
    await expect(message).toContainText('因此还不能判断全部安装的权限和事件订阅是否正常。');
    expect(errors).toEqual([]);
  } finally { await h.stop(); await new Promise(resolve => github.close(resolve)); }
});
