import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { boardFixtures } from '../test/board-fixtures.mjs';

// #672: the floating 管理助手 launcher must not sit over board filters, the search box or the statistics project
// selector on narrow screens. Below the wide layout it is a 44px round icon that keeps its accessible name; on a phone
// the bottom bar is the entry point (#481). Wide screens keep the two-line pill.

async function fixture() {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202'); boardFixtures(h.store);
  return { h, password };
}
async function login(page, h, password) {
  await page.goto(h.admin + '/#/board');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
}
async function open(page, h, hash) {
  await page.goto(h.admin + '/' + hash);
  if (hash === '#/board') await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
  else await expect(page.getByLabel('统计项目', { exact: true })).toBeVisible();
}

// Scrolls the page and every scrolling box in main to the end, then reports the launcher box and the visible part of
// each interactive control in main (clipped by the viewport and by overflow ancestors), the last one first.
async function bottomLayout(page) {
  return page.evaluate(() => {
    const scrollers = [document.scrollingElement, ...document.querySelectorAll('main *')].filter(el => el && el.scrollHeight > el.clientHeight + 1 && (el === document.scrollingElement || /auto|scroll/.test(getComputedStyle(el).overflowY)));
    for (const el of scrollers) el.scrollTop = el.scrollHeight;
    const visible = el => {
      let r = el.getBoundingClientRect(); let top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight), left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p); if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const c = p.getBoundingClientRect(); top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); left = Math.max(left, c.left); right = Math.min(right, c.right);
      }
      return bottom > top && right > left ? { top, bottom, left, right, name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40) } : null;
    };
    const controls = [...document.querySelectorAll('main :is(button, a[href], input, select, textarea, summary)')]
      .filter(el => el.checkVisibility() && !el.closest('[hidden], dialog:not([open])')).map(visible).filter(Boolean)
      .sort((a, b) => b.bottom - a.bottom);
    const launcher = document.getElementById('management-launcher'), r = launcher?.getBoundingClientRect();
    return { launcher: launcher && launcher.checkVisibility() ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height } : null, controls };
  });
}
const overlaps = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);

test('#672 窄屏下管理助手入口是仅图标的 44px 圆形按钮，滚到底后不压住最后一个可操作控件；宽屏保持原样', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h, password);
    const launcher = page.getByRole('button', { name: '打开管理助手', exact: true });
    // Wide screens keep the two-line pill.
    await expect(launcher).toBeVisible();
    await expect(launcher.locator('.management-launcher-label')).toBeVisible();
    await expect(launcher).toContainText('管理助手'); await expect(launcher).toContainText('随时唤起');
    expect((await launcher.boundingBox()).width).toBeGreaterThan(100);

    for (const width of [390, 510, 768, 900]) {
      await page.setViewportSize({ width, height: 844 });
      for (const hash of ['#/board', '#/costs']) {
        await open(page, h, hash);
        const layout = await bottomLayout(page);
        expect(layout.controls.length, `${hash} @${width}`).toBeGreaterThan(0);
        if (width <= 767) {
          // #481: the phone's bottom bar replaces the floating launcher, so nothing floats over the page at all.
          await expect(page.locator('#management-launcher')).toBeHidden();
          await expect(page.locator('#console-mobile-nav a[data-page="assistant"]')).toBeVisible();
        } else {
          // The launcher is an icon-only round button that still reads 打开管理助手.
          await expect(launcher).toBeVisible();
          await expect(launcher).toHaveAttribute('aria-label', '打开管理助手');
          await expect(launcher.locator('.management-launcher-label')).toBeHidden();
          expect(layout.launcher.width).toBe(44); expect(layout.launcher.height).toBe(44);
          expect(await launcher.evaluate(el => getComputedStyle(el).borderRadius)).toBe('50%');
        }
        // After scrolling to the end, the launcher covers neither the last interactive control nor any other one.
        const covered = layout.launcher ? layout.controls.filter(control => overlaps(layout.launcher, control)).map(control => control.name) : [];
        expect(covered, `${hash} @${width}: last control ${layout.controls[0].name}`).toEqual([]);
      }
    }

    // Keyboard focus shows the shared focus ring, and a new reply shows as a dot on the icon.
    await page.setViewportSize({ width: 768, height: 844 });
    await open(page, h, '#/board');
    await launcher.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect(launcher).toBeFocused();
    expect(await launcher.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
    expect(await launcher.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
    await launcher.evaluate(el => el.classList.add('has-update'));
    expect(await launcher.evaluate(el => { const dot = getComputedStyle(el, '::after'); return [dot.content, dot.width, dot.position]; })).toEqual(['""', '10px', 'absolute']);
    await launcher.evaluate(el => el.classList.remove('has-update'));
    // Clicking the icon still opens the chat.
    await launcher.click();
    await expect(page.getByRole('dialog', { name: '管理助手', exact: true })).toBeVisible();
  } finally { await h.stop(); }
});
