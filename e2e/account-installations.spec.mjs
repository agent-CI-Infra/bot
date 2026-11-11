import { test, expect } from '@playwright/test';
import { identityFixture } from '../test/identity-fixture.mjs';

// #356 片 A: the account detail page names the installations this credential actually reaches and what each one is short
// of. Everything comes from the account view the page already reads (no extra request); an installation GitHub removed
// stays as history, an unread grant is stated as unread instead of "no gaps", and a bot account says it has none at all.
async function login(page, f, hash) {
  await page.goto(f.h.admin + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
// Installation sync records which installation listed each repository; the console-side fixture starts without that.
const bound = (f, installed = 1) => f.h.store.run("UPDATE installed_repositories SET installation_id='77', installed=? WHERE account_id=? AND repository_id='101'", installed, f.a.id);

test('an account detail page names its installation and reaches the archive without a new request', async ({ page }) => {
  const f = await identityFixture(), errors = [], reads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) reads.push(url.pathname); });
  try {
    bound(f);
    await login(page, f, '/#/settings/accounts/' + encodeURIComponent(f.a.id));
    const panel = page.locator('#settings-panel');
    // The project count is the server's own count, and the installation is named with the account it was installed on.
    await expect(panel).toContainText('使用项目（2）');
    await expect(panel).toContainText('关联安装（1）');
    const row = panel.locator('tr', { has: page.getByRole('link', { name: '安装 77', exact: true }) });
    await expect(row).toContainText('fixture');
    await expect(row).toContainText('仍在安装里');
    await expect(row).toContainText('1 个');
    // A grant that was never read is not the same as a clean one: the cell says so instead of "no gaps".
    await expect(row).toContainText('授权未读取，缺什么无法判断');
    await expect(row).toContainText('不知道');
    await expect(panel).toContainText('还没有读到授权');
    // The way from the account to that installation's archive is a link, not an address to type.
    await expect(row.getByRole('link', { name: '安装 77', exact: true })).toHaveAttribute('href', '#/settings/installations/github.com/123/77');
    // Everything on this page comes from the requests it already made: no archive read, no second account read.
    expect(reads.filter(path => path === '/api/accounts/' + f.a.id)).toHaveLength(1);
    expect(reads.filter(path => path.startsWith('/api/installations/archive'))).toEqual([]);
    // The table scrolls inside its own container on a phone: the page itself never grows wider than the screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(panel.locator('tr', { has: page.getByRole('link', { name: '安装 77', exact: true }) })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('an installation GitHub no longer lists stays on the account as history', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    bound(f, 0);
    await login(page, f, '/#/settings/accounts/' + encodeURIComponent(f.a.id));
    const panel = page.locator('#settings-panel');
    const row = panel.locator('tr', { has: page.getByRole('link', { name: '安装 77', exact: true }) });
    await expect(panel).toContainText('关联安装（1）');
    await expect(row).toContainText('GitHub 已移除，保留为历史');
    await expect(row).toContainText('0 个');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('a user token account states that it has no installation at all', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const created = await f.admin('/api/accounts', 'POST', { name: 'Token account', type: 'bot_account', token: 'fixture-token-value', webhook_secret: 'fixture-secret-value' });
    expect(created.status).toBe(201);
    const bot = created.value.account;
    await login(page, f, '/#/settings/accounts/' + encodeURIComponent(bot.id));
    const panel = page.locator('#settings-panel');
    // An empty list is drawn, not omitted: "no data" must not read as "nothing to see here".
    await expect(panel).toContainText('关联安装（0）');
    await expect(panel).toContainText('用户 Token 账号按 Token 所属用户的仓库权限访问，没有 GitHub 安装');
    await expect(panel).toContainText('使用项目（0）');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('a grant read without the event table says which half of the gap is missing', async ({ page }) => {
  const f = await identityFixture();
  try {
    bound(f);
    // The sync recorded the grant but never read the event table: the gap cannot be judged yet, and the page says which
    // half is missing instead of calling a grant it did read "unread".
    f.h.store.run("UPDATE installed_repositories SET permissions=?, permissions_at=? WHERE account_id=? AND repository_id='101'",
      JSON.stringify({ metadata: 'read', contents: 'read' }), new Date().toISOString(), f.a.id);
    await login(page, f, '/#/settings/accounts/' + encodeURIComponent(f.a.id));
    const panel = page.locator('#settings-panel');
    const row = panel.locator('tr', { has: page.getByRole('link', { name: '安装 77', exact: true }) });
    await expect(row).toContainText('授权已读，事件表还没读，缺什么无法判断');
    await expect(row).not.toContainText('授权未读取');
    await expect(panel).toContainText('那一次没有读到事件表');
    await expect(panel).not.toContainText('之后可能在 GitHub 上改过');
  } finally { await f.close(); }
});
