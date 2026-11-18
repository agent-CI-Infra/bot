import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

// #1060: the console project switcher carried an `aria-label` ("切换项目：全部项目") while its visible text also holds
// the mark (⊞ / A), the project or "3 个项目", and the arrow (⌄) — axe `label-content-name-mismatch` (serious,
// WCAG 2.5.3) on `#console-project` (1440) and `#console-mobile-project` (390), one violation per page.
//
// This repository has no axe-core dependency (same constraint #883 worked under), so the regression encodes the rule
// instead of adding one: with a non-empty `aria-label` the accessible name must contain the element's visible text.
// The decorative spans keep `aria-hidden="true"` in the product, but axe counts their glyphs as visible text, so the
// check keeps them too — that is exactly why the label has to go instead of growing longer.
const nameMismatch = selector => page => page.evaluate((selector) => {
  const el = document.querySelector(selector);
  if (!el) return { selector, present: false };
  const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
  const label = (el.getAttribute('aria-label') || '').trim();
  const visible = normalize(el.innerText);
  return {
    selector,
    present: true,
    label,
    visible,
    violations: label && !normalize(label).toLowerCase().includes(visible.toLowerCase()) ? 1 : 0,
  };
}, selector);

const triggers = { 390: '#console-mobile-project', 1440: '#console-project' };
const routes = ['#/settings/storage', '#/board'];

test('#1060 项目切换器的可访问名包含可见文字：1440/390 的 storage 与 board 上 label-content-name-mismatch 为 0', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h);
    const owner = await account(admin);
    for (const id of ['101', '202', '303']) await repository(admin, owner.id, id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/board');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#access')).toBeHidden();

    // One reading per viewport and route: the failing lines name the aria-label axe compared the visible text against.
    const readings = [];
    for (const [width, selector] of Object.entries(triggers)) {
      for (const route of routes) {
        await page.setViewportSize({ width: Number(width), height: 900 });
        await page.goto(h.admin + '/' + route);
        await expect(page.locator(selector)).toBeVisible();
        const reading = await nameMismatch(selector)(page);
        readings.push({ width, route, present: reading.present, label: reading.label, visible: reading.visible, violations: reading.violations });
      }
    }
    expect(readings.map(({ width, route, present, label, violations }) => ({ width, route, present, label, violations }))).toEqual([
      { width: '390', route: '#/settings/storage', present: true, label: '', violations: 0 },
      { width: '390', route: '#/board', present: true, label: '', violations: 0 },
      { width: '1440', route: '#/settings/storage', present: true, label: '', violations: 0 },
      { width: '1440', route: '#/board', present: true, label: '', violations: 0 },
    ]);

    for (const [width, selector] of Object.entries(triggers)) {
      for (const route of routes) {
        await page.setViewportSize({ width: Number(width), height: 900 });
        await page.goto(h.admin + '/' + route);
        const trigger = page.locator(selector);
        await expect(trigger).toBeVisible();

        // Content naming starts with the visible label and still contains what the user reads.
        await expect(trigger).toHaveAccessibleName(/切换项目：/);
        await expect(trigger).toHaveAccessibleName(/全部项目/);
        await expect(trigger).toHaveAccessibleName(/3 个项目/);
        // The "切换项目：" word is for screen readers only; sighted users keep the same two-line trigger.
        const prefix = trigger.locator('.sr-only');
        await expect(prefix).toHaveCount(1);
        await expect(prefix).toHaveText('切换项目：');
        expect(await prefix.evaluate(node => [getComputedStyle(node).width, getComputedStyle(node).height, getComputedStyle(node).overflow])).toEqual(['1px', '1px', 'hidden']);
        // No layout movement: the page stays inside the viewport at both widths.
        expect([width, route, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)]).toEqual([width, route, true]);
      }
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
