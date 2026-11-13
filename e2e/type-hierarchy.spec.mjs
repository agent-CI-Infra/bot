import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup } from '../test/helpers.mjs';

// #558: one visible h1, titles not sharing a baseline with a long muted
// sentence, supporting text capped at ~40em, identity does not repeat its title.
const out = resolve('.tmp/type-hierarchy-558');

const loginAndOpen = async (page, h, password, hash) => {
  await page.goto(h.admin + '/');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
  await page.goto(h.admin + '/' + hash);
};

test('#558 项目、身份、统计、登录的标题层级与行长，1440 与 390 无重叠溢出', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginAndOpen(page, h, password, '#/projects');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    expect(await page.locator('h1:visible').count()).toBe(1);
    const group = page.locator('.toolbar .title-group');
    expect(await group.evaluate(el => getComputedStyle(el).flexDirection)).toBe('column');
    const count = page.locator('#count');
    const stacked = await page.evaluate(() => {
      const h1 = document.querySelector('.toolbar .title-group h1').getBoundingClientRect();
      const muted = document.querySelector('.toolbar .title-group .muted').getBoundingClientRect();
      return muted.top >= h1.bottom - 1;
    });
    expect(stacked).toBe(true);
    const measure = await count.evaluate(el => parseFloat(getComputedStyle(el).maxWidth));
    const size = await count.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(measure).toBeGreaterThan(0);
    expect(size).toBeGreaterThanOrEqual(14);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({ path: `${out}/projects-after-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/identity');
    await expect(page.getByRole('heading', { name: '身份与权限', exact: true })).toBeVisible();
    expect(await page.getByRole('heading', { name: '身份与权限', exact: true }).count()).toBe(1);
    await expect(page.locator('#console-area')).toHaveText('个人设置');
    await expect(page.locator('#console-context')).toHaveText('');
    expect(await page.locator('h1:visible').count()).toBe(1);
    await page.screenshot({ path: `${out}/identity-after-1440.png`, fullPage: true });

    await page.goto(h.admin + '/#/costs');
    await expect(page.getByRole('heading', { name: '统计', exact: true })).toBeVisible();
    const note = page.locator('.cost-note, .cost-scope').first();
    await expect(note).toBeVisible();
    const noteMeasure = await note.evaluate(el => {
      const s = getComputedStyle(el);
      return { max: s.maxWidth, lh: parseFloat(s.lineHeight), fs: parseFloat(s.fontSize) };
    });
    expect(noteMeasure.max === '40em' || parseFloat(noteMeasure.max) > 0).toBeTruthy();
    expect(noteMeasure.lh / noteMeasure.fs).toBeGreaterThanOrEqual(1.6);
    await page.screenshot({ path: `${out}/costs-after-1440.png`, fullPage: true });

    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect(await page.locator('#access h1:visible').count()).toBe(1);
    await page.screenshot({ path: `${out}/login-after-1440.png`, fullPage: true });

    for (const [hash, shot, heading] of [
      ['#/projects', 'projects-after-390.png', '项目'],
      ['#/identity', 'identity-after-390.png', '身份与权限'],
      ['#/costs', 'costs-after-390.png', '统计'],
    ]) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(h.admin + '/');
      await page.getByLabel('用户名', { exact: true }).fill('administrator');
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(h.admin + '/' + hash);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      expect(await page.locator('h1:visible').count()).toBe(1);
      const textOverlap = await page.evaluate(() => {
        const h1 = document.querySelector('.toolbar h1, .console-page-head h1, #access h1');
        if (!h1) return false;
        const next = h1.parentElement?.querySelector('.muted, p') || h1.nextElementSibling;
        if (!next || next === h1) return false;
        const a = h1.getBoundingClientRect(), b = next.getBoundingClientRect();
        return a.bottom > b.top + 1 && a.top < b.bottom && a.right > b.left + 1 && a.left < b.right;
      });
      expect(textOverlap).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: `${out}/${shot}`, fullPage: true });
      await page.getByRole('button', { name: '退出登录' }).click();
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/');
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${out}/login-after-390.png`, fullPage: true });
  } finally { await h.stop(); }
});
