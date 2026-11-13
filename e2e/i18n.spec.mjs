import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup } from '../test/helpers.mjs';
import { identityFixture, openIdentityAdvanced } from '../test/identity-fixture.mjs';

test('switching language updates login copy and html lang without a reload', async ({ page }) => {
  const h = await harness();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  try {
    await setup(h);
    await page.goto(h.admin + '/');
    expect(consoleErrors.filter(text => /Refused to execute inline script|Content-Security-Policy/i.test(text))).toEqual([]);
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '中文' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'false');

    await page.evaluate(() => { window.__i18nStay = 1; });
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await page.evaluate(() => window.__i18nStay)).toBe(1);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'See progress, and take the next step.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '中文' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#locale-switch')).toHaveAttribute('aria-label', 'Language');

    await page.getByRole('button', { name: '中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    expect(await page.evaluate(() => window.__i18nStay)).toBe(1);
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('the browser language is used when there is no stored preference, with zh-CN as the fallback', async ({ browser }) => {
  const h = await harness();
  try {
    await setup(h);
    const en = await browser.newContext({ locale: 'en-US' });
    try {
      const page = await en.newPage();
      await page.goto(h.admin + '/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    } finally { await en.close(); }

    const de = await browser.newContext({ locale: 'de-DE' });
    try {
      const page = await de.newPage();
      await page.goto(h.admin + '/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
      await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '中文' })).toHaveAttribute('aria-pressed', 'true');
    } finally { await de.close(); }
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('the identity page follows the language switch, including github_connection and html lang', async ({ page }) => {
  const f = await identityFixture();
  try {
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('#page-title')).toHaveText('身份与权限');
    await expect(page.locator('#console-context')).toHaveText('身份与权限');
    await openIdentityAdvanced(page);
    await expect(page.getByRole('heading', { name: '当前角色与授权来源' })).toBeVisible();
    const connection = page.locator('.identity-connection-status');
    await expect(connection).toBeVisible();
    const chineseStatus = await connection.textContent();
    expect(chineseStatus).toBeTruthy();

    await page.evaluate(() => { window.__i18nStay = 1; });
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await page.evaluate(() => window.__i18nStay)).toBe(1);
    await expect(page.locator('#page-title')).toHaveText('Identity and access');
    await expect(page.locator('#console-context')).toHaveText('Identity and access');
    await expect(page.getByRole('heading', { name: 'My GitHub connection' })).toBeVisible();
    await openIdentityAdvanced(page);
    await expect(page.getByRole('heading', { name: 'Current role and grant sources' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Personal settings sections' }).getByRole('link', { name: 'Identity and access' })).toBeVisible();
    // Status is translated from the state code, not taken from the API's Chinese status/next_step.
    await expect(connection).toBeVisible();
    const englishStatus = await connection.textContent();
    expect(englishStatus).not.toEqual(chineseStatus);
    await expect(connection).not.toHaveText(/[\u4e00-\u9fff]/);
    const allowed = [
      'Connected to GitHub, with access to',
      'GitHub is not connected',
      'GitHub authorization has expired',
      'GitHub authorization needs verification',
      'Signed in to GitHub, with',
      'Signed in to GitHub, but no repositories are authorized yet'
    ];
    expect(allowed.some(part => englishStatus.includes(part)), englishStatus).toBe(true);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
