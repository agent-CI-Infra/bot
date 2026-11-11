import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, testPassword } from '../test/helpers.mjs';

// 公网接入页：公网地址、它的检查结果、Tunnel 状态和 GitHub 登录配置要能同屏读完。登录配置在这里只读，
// 编辑仍然只在接入向导第 3 步，所以这一页不新增请求，也不出现能改配置的控件。
async function localLogin(page, origin, password) {
  await page.goto(origin);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#identity')).toBeVisible();
}
const cards = page => page.locator('#settings-panel h3').allInnerTexts();
const loginCard = page => page.locator('#settings-panel .side-card').filter({ has: page.getByRole('heading', { name: 'GitHub 登录（只读）', exact: true }) });

test('公网接入同屏显示地址、验证结果、Tunnel 与只读的 GitHub 登录配置，且不新增请求', async ({ page }) => {
  const h = await harness(), errors = [], reads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) reads.push(url.pathname); });
  try {
    const { password } = await setup(h);
    await localLogin(page, h.admin, password);
    await page.waitForLoadState('networkidle'); reads.length = 0;
    await page.locator('.project-nav').getByRole('link', { name: '公网接入', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/access$/);
    // 四件事同屏：当前地址、验证结果（没有地址时直说没有）、Tunnel 状态、登录配置与变更影响。
    await expect.poll(() => cards(page)).toEqual(['公网 HTTPS 地址', 'Cloudflare Tunnel', 'GitHub 登录（只读）']);
    const card = loginCard(page);
    await expect(card).toContainText('未启用：只能用本地账号登录');
    // 没保存过配置就不点名任何 App：这里说「未配置」，与下一行的「Client ID 未填写」一致。
    await expect(card).toContainText(/OAuth App\s*未配置/);
    await expect(card).not.toContainText('独立 OAuth App（只用于登录）');
    await expect(card).toContainText('未填写');
    await expect(card).toContainText('未保存');
    await expect(card).toContainText(h.admin + '/auth/github/callback');
    // 只读：没有输入框、选择框或按钮，只有一条去向导第 3 步的链接。
    await expect(card.locator('input, select, textarea, button')).toHaveCount(0);
    await expect(card.getByRole('link', { name: '接入向导第 3 步（GitHub 登录）', exact: true })).toHaveAttribute('href', '#/settings/onboarding/2');
    await expect(card).toContainText('换 OAuth App 或 Client ID 后，现有 GitHub 会话失效');
    await expect(page.locator('#settings-panel')).toContainText('还没有验证过的公网地址');
    // 这一页沿用打开控制台时已经发出的请求：只读登录配置不再多读一次接口。
    expect(reads.filter(path => path === '/api/onboarding')).toHaveLength(1);
    expect(reads.filter(path => path.includes('github-login'))).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('已启用独立 OAuth App 时只读页显示生效值，且不回显 Client secret', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), secret = testPassword();
    const saved = await admin('/api/onboarding/github-login', 'PUT', { enabled: true, client_id: 'Ov23.login', client_secret: secret });
    expect(saved.status).toBe(200);
    await localLogin(page, h.admin, password);
    await page.goto(h.admin + '/#/settings/access');
    const card = loginCard(page);
    await expect(card).toContainText('已启用：用户可以用 GitHub 账号登录');
    await expect(card).toContainText('Client ID');
    await expect(card).toContainText('Ov23.login');
    await expect(card).toContainText('已保存（接口不回读）');
    await expect(card).toContainText('控制台向导保存');
    await expect(card).toContainText(h.admin + '/auth/github/callback');
    await expect(card).not.toContainText('仍复用仓库 GitHub App');
    // secret 不回读：整页文本里不能出现刚保存的那个值。
    expect(await page.locator('#settings-panel').innerText()).not.toContain(secret);
    // 390px 下同屏可读，没有横向滚动。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(loginCard(page)).toContainText('Ov23.login');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('登录仍复用仓库 GitHub App 时只读页点名迁移，并保留旧回调地址的提醒', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { password } = await setup(h);
    // 入口改成新地址，登录配置却还是旧地址保存的：回调留在旧域名上。
    h.store.run("INSERT INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://bot.example.com', checked_at: new Date().toISOString() }));
    h.store.run("INSERT INTO settings VALUES('identity.github_login',?)", h.store.secrets.seal({ enabled: true, client_id: 'Iv1.legacy', client_secret: testPassword(), admin_origin: 'https://old.example.com', account_id: 'repository-app' }, 'identity.github_login'));
    await localLogin(page, h.admin, password);
    await page.goto(h.admin + '/#/settings/access');
    const card = loginCard(page);
    await expect(card).toContainText('仍复用仓库 GitHub App（登录与仓库连接没有分开）');
    await expect(card).toContainText('登录仍复用仓库 GitHub App：切换成独立 OAuth App 后');
    await expect(card).toContainText('登录 Callback URL');
    await expect(card).toContainText('https://bot.example.com/auth/github/callback');
    await expect(card).toContainText('https://old.example.com/auth/github/callback');
    await expect(card).toContainText('请在该 OAuth App 里把 Authorization callback URL 改成上面的登录 Callback URL');
    // 已验证的公网地址与登录回调同屏，读的人能直接对照。
    await expect(page.locator('#settings-panel')).toContainText('https://bot.example.com');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
