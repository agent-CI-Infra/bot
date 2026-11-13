import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup } from '../test/helpers.mjs';

// #552: login, projects and identity share one card component and a named
// button hierarchy. A page may have at most one enabled primary button.
const out = resolve('.tmp/design-buttons-552');

const paint = async (page, value, prop = 'backgroundColor') => page.evaluate(([v, p]) => {
  const el = document.createElement('div');
  el.style[p === 'backgroundColor' ? 'background' : p] = v;
  document.body.append(el);
  const resolved = getComputedStyle(el)[p];
  el.remove();
  return resolved;
}, [value, prop]);

const cardMetrics = async (locator) => locator.evaluate(el => {
  const s = getComputedStyle(el);
  return { radius: s.borderRadius, border: s.borderTopColor, padding: s.padding, bg: s.backgroundColor };
});

// Enabled, visible controls under `scope` painted with the brand fill, whatever their class.
const enabledBrandFilled = async (page, scope, brand) => page.evaluate(([sel, fill]) => {
  const root = document.querySelector(sel) || document.body;
  return [...root.querySelectorAll('button, a.button-link, a.btn-primary')].filter(el => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[hidden]')) return false;
    const box = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0' && s.backgroundColor === fill;
  }).map(el => el.textContent.trim());
}, [scope, brand]);

test('#552 登录、项目、身份页卡片同源，每页最多一个启用的主按钮，1440 与 390 可对照', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/');
    const login = page.getByRole('button', { name: '登录', exact: true });
    await expect(login).toBeVisible();

    const brand = await paint(page, 'var(--color-brand)');
    const surface = await paint(page, 'var(--color-surface)');
    const radius = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--radius-card').trim());
    expect(radius).toBe('12px');
    expect(await login.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(brand);
    expect(await login.getAttribute('class')).toContain('btn-primary');
    const toggle = page.getByRole('button', { name: '显示密码', exact: true });
    await expect(toggle).toHaveClass(/btn-text/);
    expect(await toggle.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(brand);
    const enabledPrimary = page.locator('#access button.btn-primary:not([disabled]), #access .btn-primary:not([disabled])');
    expect(await enabledPrimary.count()).toBe(1);

    const loginCard = page.locator('#access.access-layout, #access .access-panel, #access');
    // The login shell itself uses the shared radius.
    const accessBox = page.locator('#access');
    expect(await accessBox.evaluate(el => getComputedStyle(el).borderRadius)).toBe(radius);

    await page.screenshot({ path: resolve(out, 'login-after-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(login).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(out, 'login-after-390.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await login.click();
    await page.goto(h.admin + '/#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible({ timeout: 15000 });
    const refresh = page.getByRole('button', { name: '刷新', exact: true });
    const filter = page.getByTestId('project-filter-submit');
    await expect(refresh).toHaveClass(/btn-text/);
    await expect(filter).toHaveClass(/btn-secondary/);
    expect(await refresh.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(brand);
    expect(await filter.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(surface);
    // The project list has no primary CTA; refresh and filter are secondary / text. Count by the painted fill, not
    // by class: a button with no variant class still gets the brand background from shell.css and must count.
    expect(await enabledBrandFilled(page, '#main-content', brand)).toEqual([]);
    // The count must catch a button that forgot its variant class: shell.css paints it brand by default.
    await page.evaluate(() => { const probe = document.createElement('button'); probe.id = 'variantless-probe'; probe.textContent = '无类按钮'; document.querySelector('#main-content').append(probe); });
    expect(await enabledBrandFilled(page, '#main-content', brand)).toEqual(['无类按钮']);
    await page.evaluate(() => document.getElementById('variantless-probe').remove());
    const listPanel = page.locator('.card.list-panel');
    await expect(listPanel).toBeVisible();
    expect(await listPanel.evaluate(el => getComputedStyle(el).borderRadius)).toBe(radius);
    await page.screenshot({ path: resolve(out, 'projects-after-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(out, 'projects-after-390.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/identity');
    await expect(page.locator('.identity-layout, #identity-panel').first()).toBeVisible({ timeout: 15000 });
    // After #514 the first-screen primary is 连接 GitHub (disabled until GitHub login is configured).
    const connect = page.getByRole('button', { name: '连接 GitHub', exact: true });
    if (await connect.count()) {
      await expect(connect).toHaveClass(/btn-primary/);
      expect(await connect.isDisabled()).toBe(true);
    }
    const advanced = page.locator('details.identity-advanced > summary');
    if (await advanced.count()) await advanced.first().click();
    const switcher = page.getByRole('button', { name: '切换组织', exact: true });
    await expect(switcher).toHaveClass(/btn-secondary/);
    const bind = page.getByRole('button', { name: '绑定 GitHub 账号', exact: true });
    await expect(bind).toHaveClass(/btn-secondary/);
    expect(await bind.isDisabled()).toBe(true);
    // 连接 GitHub is disabled in this fixture, so no enabled control on the page may carry the brand fill.
    expect(await enabledBrandFilled(page, '.identity-layout', brand)).toEqual([]);
    const sideCard = page.locator('.identity-layout .side-card').first();
    await expect(sideCard).toBeVisible();
    const metrics = await cardMetrics(sideCard);
    expect(metrics.radius).toBe(radius);
    expect(metrics.padding).toContain('20px');
    const listMetrics = await cardMetrics(listPanel);
    expect(metrics.radius).toBe(listMetrics.radius);
    expect(metrics.border).toBe(listMetrics.border);
    await page.screenshot({ path: resolve(out, 'identity-after-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(out, 'identity-after-390.png'), fullPage: true });
  } finally { await h.stop(); }
});
