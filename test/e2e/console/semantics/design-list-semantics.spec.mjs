import { test, expect } from '@playwright/test';
import { harness, setup, account } from '../../../fixtures/helpers.mjs';

// #883: axe reported `aria-required-parent` (critical) on the four sample rows of the design page — every
// `div.row.has-actions[role=listitem]` sat in a `.rows` container that carried only a class, no `role=list`.
//
// This repository has no axe-core dependency (see the review on #883), so the regression encodes the rule axe applied
// instead of adding one: a `listitem` needs a `list` ancestor, counted per violating node so the before/after reading is
// the same 4 → 0 the audit reported. The check walks ancestors exactly like the rule does; a native `ul`/`ol` without an
// explicit role is a list too, in case someone switches to real list markup later.
const requiredParentViolations = page => page.evaluate(() => {
  const nativeLists = new Set(['UL', 'OL', 'MENU']);
  const isList = node => node.getAttribute('role') === 'list'
    || (!node.getAttribute('role') && nativeLists.has(node.tagName));
  return [...document.querySelectorAll('#design-rows [role=listitem]')].map(row => {
    for (let node = row.parentElement; node; node = node.parentElement) if (isList(node)) return null;
    return row.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
  }).filter(Boolean);
});

test('#883 设计样页的四个样例行是合法列表：每个 listitem 都在 role=list 的容器里，1440/390 都是 0 个违规', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h);
    await account(admin);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/design');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#design-page')).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(h.admin + '/#/design');
      await expect(page.locator('#design-page')).toBeVisible();

      // The rows are still the four product-shaped rows: same count, each one a direct child of the section's list box,
      // and the actions stay reachable. Only the ARIA context is under test; the grid and spacing must not move.
      const rows = page.locator('#design-rows [role=listitem]');
      await expect(rows).toHaveCount(4);
      expect(await page.evaluate(() => {
        const box = document.querySelector('#design-rows .rows');
        return [...document.querySelectorAll('#design-rows [role=listitem]')]
          .every(row => row.parentElement === box) && box.children.length === 4;
      })).toBe(true);
      for (const button of ['查看', '详情', '处理', '日志'])
        await expect(page.locator('#design-rows').getByRole('button', { name: button, exact: true })).toBeVisible();

      // The failing reading before the fix: four lines, one per sampled row ("检视 issue #12", …).
      expect([width, await requiredParentViolations(page)]).toEqual([width, []]);
      // The container itself names the list, so a reader announces the rows as a list and not as four loose groups.
      await expect(page.locator('#design-rows .rows')).toHaveAttribute('role', 'list');
      // 390 keeps the same rows inside the viewport; adding the role must not introduce overflow.
      expect([width, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)]).toEqual([width, true]);
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
