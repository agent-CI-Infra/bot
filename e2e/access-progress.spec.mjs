import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { identityFixture } from '../test/identity-fixture.mjs';
import { Onboarding } from '../dist/onboarding/service.js';
import { testPassword } from '../test/helpers.mjs';

const output = '.tmp/access-progress-225';
async function localLogin(page, f, path) {
  await page.goto(f.h.admin + path);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
async function readyWizard(f) {
  const wizard = new Onboarding(f.h.store);
  const model = (await f.admin('/api/models', 'POST', { repository_id: null, api_url: 'https://model.invalid/v1', model_name: 'fixture', api_key: testPassword() })).value.model;
  wizard.save('public', { origin: 'https://hooks.invalid', checked_at: new Date().toISOString() });
  wizard.save('app', { account_id: f.a.id, app_id: '123', slug: 'fixture', installations: 99, settings_url: 'https://github.com/settings/apps/fixture', install_url: 'https://github.com/apps/fixture/installations/new' });
  wizard.save('model', model.id);
  return { wizard, model };
}

test('the seven-step wizard exposes missing setup at six widths and resumes the addressed step', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    mkdirSync(output, { recursive: true });
    await localLogin(page, f, '/#/settings/onboarding/6');
    await expect(page.getByRole('heading', { name: '接入尚未完成' })).toBeVisible();
    await expect(page.getByRole('button', { name: '完成向导', exact: true })).toBeDisabled();
    await expect(page.getByRole('navigation', { name: '接入步骤' }).locator('.onboarding-step')).toHaveCount(7);
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const action = page.getByRole('button', { name: '前往第 1 步：公网 HTTPS', exact: true });
      await expect(action).toBeVisible();
      if (width === 390 || width === 1440) await page.screenshot({ path: `${output}/wizard-missing-${width}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: '前往第 1 步：公网 HTTPS', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/onboarding\/0$/);
    await page.getByLabel('公网 HTTPS 地址', { exact: true }).fill('https://draft.invalid');
    await page.route('**/api/onboarding/address', route => route.fulfill({ status: 503, json: { error: 'probe_unavailable' } }));
    await page.getByRole('button', { name: '检查并使用', exact: true }).click();
    await expect(page.getByLabel('公网 HTTPS 地址', { exact: true })).toHaveValue('https://draft.invalid');
    await expect(page.locator('#wizard-proxy [role=alert]')).toContainText('probe_unavailable');
    await page.reload(); await expect(page.getByRole('button', { name: '1. 公网 HTTPS', exact: true })).toHaveAttribute('aria-current', 'step');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('completion checks current prerequisites again and local login remains an allowed configuration', async ({ page }) => {
  const f = await identityFixture();
  try {
    const { model } = await readyWizard(f);
    await localLogin(page, f, '/#/settings/onboarding/6');
    const finish = page.getByRole('button', { name: '完成向导', exact: true });
    await expect(finish).toBeEnabled();
    await expect(page.locator('.onboarding-progress')).toContainText('1 个有效安装');
    const key = f.h.store.get('SELECT api_key FROM models WHERE id=?', model.id).api_key;
    f.h.store.run('UPDATE models SET api_key=NULL WHERE id=?', model.id);
    await finish.click(); await expect(page.locator('#onboarding-panel [role=alert]').last()).toContainText('接入配置已变化');
    await expect(finish).toBeDisabled();
    await expect(page.getByRole('button', { name: '前往第 5 步：模型', exact: true })).toBeVisible();
    await expect(page.locator('.onboarding-step').nth(4)).toHaveAttribute('data-ready', 'false');
    expect(f.h.store.get("SELECT value FROM settings WHERE key='onboarding.complete'")).toBeUndefined();
    f.h.store.run('UPDATE models SET api_key=? WHERE id=?', key, model.id);
    await page.reload(); await expect(finish).toBeEnabled(); await finish.click();
    await expect(page).toHaveURL(/#\/projects$/);
    expect(JSON.parse(f.h.store.get("SELECT value FROM settings WHERE key='onboarding.complete'").value)).toBe(true);
  } finally { await f.close(); }
});

test('the installation step uses current effective installations instead of the saved historical count', async ({ page }) => {
  const f = await identityFixture();
  try {
    await readyWizard(f); await localLogin(page, f, '/#/settings/onboarding/3');
    const count = page.locator('dt').filter({ hasText: '当前有效安装数' }).locator('xpath=following-sibling::dd[1]');
    await expect(count).toHaveText('1');
    await expect(page.locator('.onboarding-progress')).toContainText('1 个有效安装');
    mkdirSync('.tmp/onboarding-readiness-225', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: '.tmp/onboarding-readiness-225/installations-desktop.png', fullPage: true });
    f.h.store.run("UPDATE github_installations SET status='suspended'");
    await page.reload(); await expect(count).toHaveText('0');
    await expect(page.locator('.onboarding-step').nth(3)).toHaveAttribute('data-ready', 'false');
    f.h.store.run("UPDATE github_installations SET status='active',scope_pending=1");
    await page.reload(); await expect(count).toHaveText('0');
  } finally { await f.close(); }
});

test('a failed readiness reload after a completion conflict stays unknown and retries without another completion write', async ({ page }) => {
  const f = await identityFixture(); let failure = false, writes = 0;
  try {
    const { model } = await readyWizard(f); await localLogin(page, f, '/#/settings/onboarding/6');
    const finish = page.getByRole('button', { name: '完成向导', exact: true }); await expect(finish).toBeEnabled();
    await page.route('**/api/onboarding', route => failure ? route.fulfill({ status: 503, json: { error: 'status_unavailable' } }) : route.continue());
    await page.route('**/api/onboarding/complete', route => { writes++; return route.continue(); });
    f.h.store.run('UPDATE models SET api_key=NULL WHERE id=?', model.id); failure = true; await finish.click();
    await expect(page.getByRole('heading', { name: '接入状态待重新核验', exact: true })).toBeVisible();
    await expect(finish).toBeDisabled(); await expect(page.locator('.onboarding-step[data-ready=unknown]')).toHaveCount(7);
    await expect(page.locator('#onboarding-panel [role=alert]').last()).toContainText('status_unavailable');
    mkdirSync('.tmp/onboarding-readiness-225', { recursive: true });
    await page.setViewportSize({ width: 390, height: 900 }); await page.evaluate(() => scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/onboarding-readiness-225/readiness-unknown-mobile.png', fullPage: true });
    failure = false; await page.getByRole('button', { name: '重新读取接入状态', exact: true }).click();
    await expect(page.getByRole('button', { name: '前往第 5 步：模型', exact: true })).toBeVisible(); await expect(finish).toBeDisabled();
    expect(writes).toBe(1);
  } finally { await f.close(); }
});

test('a readiness response after a completion conflict cannot replace a page opened in the meantime', async ({ page }) => {
  const f = await identityFixture(); let release = () => {}, requested = false;
  try {
    const { model } = await readyWizard(f); await localLogin(page, f, '/#/settings/onboarding/6');
    const finish = page.getByRole('button', { name: '完成向导', exact: true }); await expect(finish).toBeEnabled();
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/onboarding', async route => { const response = await route.fetch(); requested = true; await gate; await route.fulfill({ response }); });
    f.h.store.run('UPDATE models SET api_key=NULL WHERE id=?', model.id); await finish.click(); await expect.poll(() => requested).toBe(true);
    await page.evaluate(() => { location.hash = '#/projects'; }); await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page).toHaveURL(/#\/projects$/); await expect(page.locator('#settings-panel')).toBeHidden();
  } finally { release(); await f.close(); }
});

test('identity and effective grants remain visible when optional provider and Feishu reads fail', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message));
  let failures = true;
  try {
    await localLogin(page, f, '/#/identity');
    await expect(page.getByRole('heading', { name: '我的身份与有效权限' })).toBeVisible();
    await page.route('**/api/auth/github/status', route => failures ? route.fulfill({ status: 503, json: { error: 'provider_unavailable' } }) : route.continue());
    await page.route('**/api/channels/bindings', route => failures ? route.fulfill({ status: 503, json: { error: 'bindings_unavailable' } }) : route.continue());
    await page.getByRole('button', { name: '刷新身份与授权' }).click();
    await expect(page.getByRole('heading', { name: 'GitHub 登录状态读取失败' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '飞书绑定读取失败' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '当前角色与授权来源' })).toBeVisible();
    await expect(page.getByLabel('有效授权', { exact: true })).toContainText('平台超级管理员');
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390 || width === 1440) await page.screenshot({ path: `${output}/identity-partial-${width}.png`, fullPage: true });
    }
    failures = false;
    await page.locator('.identity-provider').getByRole('button', { name: '重新加载', exact: true }).click();
    await page.locator('.identity-feishu').getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(page.getByRole('button', { name: '绑定 GitHub 账号', exact: true })).toBeEnabled();
    await expect(page.getByRole('heading', { name: '飞书身份绑定' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('identity read errors replace old permissions and a late response cannot repaint another page', async ({ page }) => {
  const f = await identityFixture();
  let fail = true, release = () => {};
  try {
    await localLogin(page, f, '/#/identity');
    await expect(page.getByRole('heading', { name: '我的身份与有效权限' })).toBeVisible();
    await page.route('**/api/identity', route => fail ? route.fulfill({ status: 503, json: { error: 'identity_unavailable' } }) : route.continue());
    await page.getByRole('button', { name: '刷新身份与授权' }).click();
    await expect(page.getByRole('heading', { name: '身份与权限读取失败' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '当前角色与授权来源' })).toHaveCount(0);
    fail = false; await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的身份与有效权限' })).toBeVisible();
    await page.unroute('**/api/identity');
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/identity', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
    await page.getByRole('button', { name: '刷新身份与授权' }).click();
    await expect(page.getByRole('heading', { name: '正在读取身份与权限' })).toBeVisible();
    await page.evaluate(() => { location.hash = '#/projects'; });
    await expect(page.locator('#identity-panel')).toBeHidden();
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('#identity-panel').getByRole('heading', { name: '我的身份与有效权限' })).toHaveCount(0);
    await expect(page).toHaveURL(/#\/projects$/);
  } finally { release(); await f.close(); }
});
