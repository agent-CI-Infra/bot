import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { identityFixture, waitForIdentityPage } from '../test/identity-fixture.mjs';
import { managementFixture } from '../test/management-fixture.mjs';

// #551: login, projects, identity and management must resolve the same body / muted / heading tokens.
// Screenshots are the after-evidence for the PR (1440×900 and 390×844 CSS px).
const out = resolve('.tmp/design-tokens-551');
const tokenProbe = () => {
  const root = getComputedStyle(document.documentElement);
  const read = name => root.getPropertyValue(name).trim();
  const paint = value => {
    const probe = document.createElement('div');
    probe.style.color = value;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb;
  };
  return {
    text: read('--color-text'),
    muted: read('--color-text-muted'),
    bg: read('--color-bg'),
    brand: read('--color-brand'),
    h1: read('--font-size-5'),
    body: read('--font-size-2'),
    textRgb: paint('var(--color-text)'),
    mutedRgb: paint('var(--color-text-muted)'),
    bgRgb: paint('var(--color-bg)'),
  };
};
const brandBackground = () => {
  const p = document.createElement('div');
  p.style.background = 'var(--color-brand)';
  document.body.append(p);
  const v = getComputedStyle(p).backgroundColor;
  p.remove();
  return v;
};
async function capture(page, name) {
  await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
}

test('#551 登录、项目页共用正文/辅助色和标题字号，项目列表有仓库行，1440 与 390 不横向溢出', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
  try {
    const { password, admin } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/');
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();

    const tokens = await page.evaluate(tokenProbe);
    expect(tokens).toMatchObject({
      text: '#17243b', muted: '#607087', bg: '#f5f7fb', brand: '#245de0',
      h1: '30px', body: '14px',
    });

    const bodyColor = await page.evaluate(() => getComputedStyle(document.body).color);
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bodyColor).toBe(tokens.textRgb);
    expect(bodyBg).toBe(tokens.bgRgb);

    const loginTitle = page.getByRole('heading', { name: '登录', exact: true });
    await expect(loginTitle).toBeVisible();
    expect(await loginTitle.evaluate(el => getComputedStyle(el).fontSize)).toBe(tokens.h1);
    const loginMuted = page.locator('#access-description').first();
    await expect(loginMuted).toBeVisible();
    expect(await loginMuted.evaluate(el => getComputedStyle(el).color)).toBe(tokens.mutedRgb);
    const loginButton = page.getByRole('button', { name: '登录', exact: true });
    expect(await loginButton.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(
      await page.evaluate(brandBackground),
    );

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await capture(page, 'login-after-1440');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(loginTitle).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await capture(page, 'login-after-390');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await loginButton.click();
    await page.goto(h.admin + '/#/projects');
    const projectsTitle = page.getByRole('heading', { name: '项目', exact: true });
    await expect(projectsTitle).toBeVisible({ timeout: 15000 });
    const projectRow = page.locator('#rows [data-repository-id="101"]');
    await expect(projectRow).toBeVisible();
    await expect(projectRow.getByText('fixture/project-101')).toBeVisible();
    expect(await projectsTitle.evaluate(el => getComputedStyle(el).fontSize)).toBe(tokens.h1);
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(tokens.textRgb);
    const projectsMuted = page.locator('.toolbar .muted, .title-group .muted').first();
    await expect(projectsMuted).toBeVisible();
    expect(await projectsMuted.evaluate(el => getComputedStyle(el).color)).toBe(tokens.mutedRgb);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await capture(page, 'projects-after-1440');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#rows [data-repository-id="101"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await capture(page, 'projects-after-390');
  } finally { await h.stop(); }
});

test('#551 身份页共用正文/辅助色，概览为「我的 GitHub 连接」，1440 与 390 不横向溢出', async ({ page }) => {
  test.setTimeout(60000);
  const f = await identityFixture();
  mkdirSync(out, { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await waitForIdentityPage(page);
    const tokens = await page.evaluate(tokenProbe);
    expect(tokens).toMatchObject({
      text: '#17243b', muted: '#607087', bg: '#f5f7fb', brand: '#245de0',
      h1: '30px', body: '14px',
    });
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(tokens.textRgb);
    const identityMuted = page.locator('.identity-layout .muted, #identity-panel .muted, .identity-overview .muted').first();
    await expect(identityMuted).toBeVisible();
    expect(await identityMuted.evaluate(el => getComputedStyle(el).color)).toBe(tokens.mutedRgb);
    const status = page.locator('.identity-overview .identity-connection-status').first();
    await expect(status).toBeVisible();
    expect(await status.evaluate(el => getComputedStyle(el).fontSize)).toBe('18px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await capture(page, 'identity-after-1440');

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForIdentityPage(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await capture(page, 'identity-after-390');
  } finally { await f.close(); }
});

test('#551 对话页共用正文/辅助色和标题字号，1440 与 390 不横向溢出', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture();
  mkdirSync(out, { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('region', { name: '管理助手', exact: true })).toBeVisible({ timeout: 15000 });
    const tokens = await page.evaluate(tokenProbe);
    expect(tokens).toMatchObject({
      text: '#17243b', muted: '#607087', bg: '#f5f7fb', brand: '#245de0',
      h1: '30px', body: '14px',
    });
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(tokens.textRgb);
    const title = page.locator('#management-chat-title');
    await expect(title).toBeVisible();
    expect(await title.evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
    const muted = page.locator('.management-window-title p, .management-welcome > .muted, .management-scope-note').first();
    await expect(muted).toBeVisible();
    expect(await muted.evaluate(el => getComputedStyle(el).color)).toBe(tokens.mutedRgb);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await capture(page, 'management-after-1440');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(title).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await capture(page, 'management-after-390');
  } finally { await f.close(); }
});
