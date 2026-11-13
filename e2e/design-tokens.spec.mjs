import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup } from '../test/helpers.mjs';

// #551: login, projects and identity must resolve the same body / muted / heading tokens,
// so the leftover teal theme in style.css cannot drift back in. Screenshots are the
// after-evidence for the PR (1440 and 390).
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

test('#551 登录、项目、身份页共用正文/辅助色和标题字号，1440 与 390 不横向溢出', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
  try {
    const { password } = await setup(h);

    await page.setViewportSize({ width: 1440, height: 1000 });
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
    if (await loginMuted.count()) {
      expect(await loginMuted.evaluate(el => getComputedStyle(el).color)).toBe(tokens.mutedRgb);
    }
    const loginButton = page.getByRole('button', { name: '登录', exact: true });
    expect(await loginButton.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(
      await page.evaluate(() => {
        const p = document.createElement('div');
        p.style.background = 'var(--color-brand)';
        document.body.append(p);
        const v = getComputedStyle(p).backgroundColor;
        p.remove();
        return v;
      }),
    );

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(out, 'login-after-1440.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(loginTitle).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(out, 'login-after-390.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await loginButton.click();
    await page.goto(h.admin + '/#/projects');
    const projectsTitle = page.getByRole('heading', { name: '项目', exact: true });
    await expect(projectsTitle).toBeVisible({ timeout: 15000 });
    expect(await projectsTitle.evaluate(el => getComputedStyle(el).fontSize)).toBe(tokens.h1);
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(tokens.textRgb);
    const projectsMuted = page.locator('.toolbar .muted, .title-group .muted').first();
    if (await projectsMuted.count()) {
      expect(await projectsMuted.evaluate(el => getComputedStyle(el).color)).toBe(tokens.mutedRgb);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(out, 'projects-after-1440.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(out, 'projects-after-390.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/identity');
    await expect(page.locator('#identity-panel, .identity-layout, #main-content').first()).toBeVisible({ timeout: 15000 });
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(tokens.textRgb);
    const identityMuted = page.locator('.identity-layout .muted, #identity-panel .muted, .identity-overview .muted').first();
    if (await identityMuted.count()) {
      expect(await identityMuted.evaluate(el => getComputedStyle(el).color)).toBe(tokens.mutedRgb);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(out, 'identity-after-1440.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(out, 'identity-after-390.png'), fullPage: true });
  } finally { await h.stop(); }
});
