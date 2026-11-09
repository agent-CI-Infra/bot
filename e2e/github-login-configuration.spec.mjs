import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { identityFixture } from '../test/identity-fixture.mjs';
import { harness, setup, testPassword } from '../test/helpers.mjs';
import { Onboarding } from '../dist/onboarding/service.js';

async function localLogin(page, origin, password) {
  await page.goto(origin); await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#identity')).toBeVisible();
}

test('停用登录时填错域名，原浏览器会话可改回，退出后仍可在部署地址登录', async ({ page }) => {
  const h = await harness(), { password } = await setup(h);
  try {
    await localLogin(page, h.admin, password); await page.goto(h.admin + '/#/settings/onboarding/2');
    const address = () => page.getByLabel('控制台访问地址', { exact: true });
    const save = async value => {
      await address().fill(value);
      const response = page.waitForResponse(r => r.url().endsWith('/api/onboarding/github-login') && r.request().method() === 'PUT');
      await page.getByRole('button', { name: '保存登录配置', exact: true }).click(); expect((await response).status()).toBe(200);
      await expect(page.locator('#message')).toContainText('当前使用本地账号登录');
      await expect(address()).toHaveValue(value);
      await expect(page.getByRole('button', { name: '保存登录配置', exact: true })).toBeEnabled();
    };
    await save('https://typo.invalid'); await save(h.admin);
    await save(h.admin.replace('http:', 'https:')); await page.locator('#logout').click();
    await localLogin(page, h.admin, password); await page.goto(h.admin + '/#/settings/onboarding/2');
    await expect(address()).toHaveValue(h.admin.replace('http:', 'https:')); await save(h.admin);
    mkdirSync('.tmp/onboarding-settings-fix', { recursive: true });
    await page.screenshot({ path: '.tmp/onboarding-settings-fix/origin-recovery.png', fullPage: true });
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

for (const returned of [true, false]) test(`已有登录配置后新建 App，${returned ? '带出新凭据' : '明确要求新凭据'}并在保存后切换`, async ({ page }) => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  let onboarding;
  const h = await harness(undefined, undefined, store => ({ onboarding: onboarding = new Onboarding(store, { fetcher: async () => new Response(JSON.stringify({
    id: 123, slug: 'new-app', pem, webhook_secret: testPassword(), ...(returned ? { client_id: 'Iv1.new-app', client_secret: testPassword() } : {}),
  })) }) }));
  try {
    const { admin, password } = await setup(h); onboarding.save('public', { origin: 'https://hooks.invalid' });
    await admin('/api/onboarding/github-login', 'PUT', { enabled: true, client_id: 'Iv1.old-app', client_secret: testPassword(), admin_origin: h.admin });
    const manifest = await admin('/api/onboarding/manifest', 'POST', { organization: 'fixture', name: 'new-app' });
    await localLogin(page, h.admin, password);
    await page.goto(h.admin + '/onboarding/github/callback?code=manifest-code&state=' + new URL(manifest.value.create_url).searchParams.get('state'));
    await expect(page.locator('#onboarding-panel')).toContainText('所选 App：new-app');
    await expect(page.locator('#onboarding-panel')).toContainText('保存并启用后才会切换');
    const client = page.getByLabel('Client ID', { exact: true }), enabled = page.getByLabel('启用 GitHub 账号登录', { exact: true });
    await expect(client).toHaveValue(returned ? 'Iv1.new-app' : ''); await expect(enabled).not.toBeChecked();
    await expect(page.getByLabel('Client secret（只保存，不回读）', { exact: true })).toHaveValue('');
    const activeClient = async () => new URL((await fetch(h.admin + '/auth/github/start', { redirect: 'manual' })).headers.get('location')).searchParams.get('client_id');
    expect(await activeClient()).toBe('Iv1.old-app'); await enabled.check();
    if (!returned) {
      await expect(page.locator('#onboarding-panel')).toContainText('不能沿用旧 App 的值');
      expect(await client.evaluate(el => el.validity.valueMissing)).toBe(true);
      await client.fill('Iv1.new-app'); await page.getByLabel('Client secret（只保存，不回读）', { exact: true }).fill(testPassword());
    }
    mkdirSync('.tmp/onboarding-settings-fix', { recursive: true });
    await page.screenshot({ path: `.tmp/onboarding-settings-fix/new-app-${returned ? 'saved' : 'manual'}.png`, fullPage: true });
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('GitHub 登录已启用'); expect(await activeClient()).toBe('Iv1.new-app');
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('系统超级管理员在全局设置向导启用 GitHub 登录，密钥不回显，普通用户不能进入配置', async ({ page, browser }) => {
  const f = await identityFixture(undefined, { wizardOnly: true }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const password = f.password;
    expect((await f.admin('/api/auth/github/status')).value.enabled).toBe(false);
    await page.goto(f.h.admin); await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#tabs').getByRole('button', { name: '接入向导', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '全局设置', exact: true }).click();
    await page.locator('.project-nav').getByRole('link', { name: '接入向导', exact: true }).click();
    await page.getByRole('button', { name: '3. GitHub 登录', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/onboarding\/2$/);
    await expect(page.locator('.project-nav [aria-current=page]')).toHaveText('接入向导');
    await page.getByLabel('启用 GitHub 账号登录', { exact: true }).check();
    await page.getByLabel('Client ID', { exact: true }).fill('fixture-client');
    await page.getByLabel('Client secret（只保存，不回读）', { exact: true }).fill('fixture-secret');
    await page.getByLabel('控制台访问地址', { exact: true }).fill(f.h.admin);
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('GitHub 登录已启用');
    await expect(page.getByLabel('Client secret（只保存，不回读）', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('启用 GitHub 账号登录', { exact: true })).toBeChecked();
    mkdirSync('.tmp/onboarding-settings', { recursive: true });
    await page.screenshot({ path: '.tmp/onboarding-settings/github-login-desktop.png', fullPage: true });
    await page.reload(); await expect(page.getByLabel('Client ID', { exact: true })).toHaveValue('fixture-client');
    await expect(page.getByLabel('Client secret（只保存，不回读）', { exact: true })).toHaveValue('');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.github-login-callback').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/onboarding-settings/github-login-mobile.png', fullPage: true });
    await page.getByLabel('启用 GitHub 账号登录', { exact: true }).uncheck();
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('当前使用本地账号登录');
    expect((await f.admin('/api/auth/github/status')).value.enabled).toBe(false);
    await page.getByLabel('启用 GitHub 账号登录', { exact: true }).check();
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('GitHub 登录已启用');
    await page.locator('#logout').click(); await page.getByRole('link', { name: '使用 GitHub 登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '当前角色与授权来源', exact: true })).toBeVisible();
    await expect(page.locator('#tabs').getByRole('button', { name: '全局设置', exact: true })).toBeHidden();
    await page.goto(f.h.admin + '/#/settings/onboarding/2');
    await expect(page.locator('#settings-panel')).toBeHidden();
    expect(await page.evaluate(async () => (await fetch('/api/onboarding')).status)).toBe(403);
    // A separately delegated local project/organization administrator is equally unable to configure OAuth.
    const memberPassword = testPassword(); await f.admin('/api/users', 'POST', { username: 'scoped-admin', password: memberPassword, organization_ids: ['10'] });
    const context = await browser.newContext(), member = await context.newPage();
    await member.goto(f.h.admin + '/#/settings/onboarding/2'); await member.getByLabel('用户名', { exact: true }).fill('scoped-admin');
    await member.getByLabel('密码', { exact: true }).fill(memberPassword); await member.getByRole('button', { name: '登录', exact: true }).click();
    await expect(member.locator('#settings-panel')).toBeHidden(); await context.close();
    await page.locator('#logout').click(); await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.goto(f.h.admin + '/#/settings/onboarding/2');
    await page.getByLabel('清除已保存的 Client secret，并停用 GitHub 登录', { exact: true }).check();
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('当前使用本地账号登录');
    expect((await f.admin('/api/onboarding')).value.github_login.secret_configured).toBe(false);
    await page.locator('#logout').click(); await expect(page.getByRole('link', { name: '使用 GitHub 登录', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
