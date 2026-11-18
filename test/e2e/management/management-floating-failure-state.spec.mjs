import { test, expect } from '@playwright/test';
import { managementFixture } from '../../fixtures/management-fixture.mjs';
import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';

// #616 acceptance 3: the floating panel states a failed open exactly as the page view does. #1038 covered only the
// page view, so the same state is checked here where the box is a fixed, short panel: on a phone it is only ~300px
// tall and sits above the bottom bar, so every recovery control has to be reachable through the panel's own scroll
// container, never through the page's.
async function openFloatingAssistant(page, width) {
  const chat = page.locator('#management-chat');
  // Each viewport gets a fresh open: the box is sized when it opens, and a box left open from the previous size would
  // measure the previous viewport instead of this one.
  if (await chat.isVisible()) {
    await chat.getByRole('button', { name: '收起管理助手', exact: true }).click();
    await expect(chat).toBeHidden();
  }
  if (width <= 760) { await page.locator('#console-mobile-nav a[data-page="assistant"]').click(); }
  else { await page.locator('#management-launcher').click(); }
  await expect(chat).toBeVisible({ timeout: 10_000 });
}

const boxOf = (locator) => locator.evaluate(el => {
  const rect = el.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
});

test('a failed open inside the floating panel keeps the reason once, every recovery control reachable, and nothing able to send', async ({ page }) => {
  test.setTimeout(180_000);
  const f = await managementFixture(), empty = await f.member('no-project', {});
  try {
    await page.setViewportSize({ width: 390, height: 640 });
    await page.goto(f.h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('no-project');
    await page.getByLabel('密码', { exact: true }).fill(empty.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    for (const [width, height] of [[390, 640], [390, 568], [320, 568], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await openFloatingAssistant(page, width);
      const chat = page.locator('#management-chat'), panel = chat.locator('.management-panel');
      await expect(panel.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible({ timeout: 10_000 });
      const size = `${width}x${height}`;
      // The panel itself is on screen and clear of the phone's bottom bar.
      const box = await chat.evaluate(el => { const r = el.getBoundingClientRect(); const bar = document.querySelector('#console-mobile-nav'); const shown = bar && getComputedStyle(bar).display !== 'none'; return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, barTop: shown ? bar.getBoundingClientRect().top : null }; });
      expect(box.left, size).toBeGreaterThanOrEqual(0);
      expect(box.right, size).toBeLessThanOrEqual(width);
      expect(box.top, size).toBeGreaterThanOrEqual(0);
      expect(box.bottom, size).toBeLessThanOrEqual(height);
      if (box.barTop !== null) expect(box.bottom, size).toBeLessThanOrEqual(box.barTop);
      // One statement of the failure, in the card, not repeated on the status line.
      const sentence = (await panel.locator('.console-state p').first().textContent()).trim();
      expect(sentence.length, size).toBeGreaterThan(10);
      await expect(panel.locator('p').filter({ hasText: sentence }), size).toHaveCount(1);
      await expect(panel.locator('.management-status'), size).toHaveText('');
      // Every recovery control is reachable inside the panel: scrolling happens in the card's own slot, and the page
      // behind never moves.
      for (const name of ['重试', '查看项目列表', '查看身份与权限']) {
        const control = name === '重试' ? panel.getByRole('button', { name, exact: true }) : panel.getByRole('link', { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        // The control has to be inside the card's own visible area (the slot clips it) and has to be the element a tap
        // lands on — a rectangle that is merely "near" the viewport is not reachable.
        const reach = await control.evaluate(el => {
          const r = el.getBoundingClientRect(), slot = el.closest('.management-access-state').getBoundingClientRect();
          const inside = r.top >= slot.top - 1 && r.bottom <= Math.min(slot.bottom, innerHeight) + 1 && r.left >= slot.left - 1 && r.right <= slot.right + 1;
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { inside, hit: !!hit && el.contains(hit) };
        });
        expect(reach.inside, `${size} ${name} inside the card`).toBe(true);
        expect(reach.hit, `${size} ${name} hit by a tap`).toBe(true);
      }
      expect(await page.evaluate(() => document.scrollingElement.scrollTop), size).toBe(0);
      // Nothing that looks able to send, and the two header controls carry the reason.
      await expect(panel.getByLabel('管理消息'), size).toBeHidden();
      await expect(page.getByRole('button', { name: '发送', exact: true }), size).toBeHidden();
      const fresh = panel.getByRole('button', { name: '新建会话', exact: true }), tools = panel.getByRole('button', { name: '快捷操作', exact: true });
      await expect(fresh, size).toBeDisabled(); await expect(tools, size).toBeDisabled();
      await expect(fresh, size).toHaveAttribute('aria-describedby', 'management-access-reason'); await expect(tools, size).toHaveAttribute('aria-describedby', 'management-access-reason');
      // A tall enough box needs no inner scroll at all; a short phone panel may scroll its own card, never the page.
      if (height >= 844) expect(await panel.locator('.management-access-state').evaluate(el => el.scrollHeight <= el.clientHeight + 1), size).toBe(true);
      await expect(page.locator('.management-window')).not.toHaveClass(/management-page/);
    }
  } finally { await f.close(); }
});

// #616: a failing 新建会话 inside the floating panel must also take away what the previous scope left behind — the
// open shortcut drawer and the composer — instead of leaving them under the card.
test('a failed 新建会话 inside the floating panel closes the shortcut drawer and disables both header controls', async ({ page }) => {
  test.setTimeout(120_000);
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click(); await switchConsoleProject(page, '101');
    await openFloatingAssistant(page, 1440);
    const panel = page.locator('#management-chat .management-panel');
    const fresh = panel.getByRole('button', { name: '新建会话', exact: true }), tools = panel.getByRole('button', { name: '快捷操作', exact: true });
    await expect(panel.getByLabel('管理消息', { exact: true })).toBeVisible({ timeout: 10_000 });
    await tools.click(); await expect(page.locator('#management-tools')).toBeVisible();
    await page.route('**/api/management/conversations', route => route.request().method() === 'GET' ? route.fulfill({ status: 403, json: { error: 'scope_forbidden' } }) : route.continue());
    await fresh.click();
    await expect(panel.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#management-tools')).toBeHidden();
    await expect(panel.getByLabel('管理消息', { exact: true })).toBeHidden();
    await expect(fresh).toBeDisabled(); await expect(tools).toBeDisabled();
  } finally { await f.close(); }
});

// #616 acceptance 3, measured rather than assumed: the floating panel may never demand more scrolling than the page
// view does at the same viewport. Where the page fits its card the panel must fit it too, and wherever the panel needs
// its own scroll the page needs at least as much.
test('the floating panel never needs more room than the page view at the same phone viewport', async ({ page }) => {
  test.setTimeout(180_000);
  const f = await managementFixture(), empty = await f.member('no-project', {});
  try {
    const fits = async root => root.locator('.management-access-state').evaluate(el => ({ fits: el.scrollHeight <= el.clientHeight + 1, need: el.scrollHeight - el.clientHeight }));
    await page.setViewportSize({ width: 390, height: 640 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('no-project');
    await page.getByLabel('密码', { exact: true }).fill(empty.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const chat = page.locator('#management-chat');
    await expect(chat.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible({ timeout: 10_000 });
    await page.goto(f.h.admin + '/#/projects');
    await expect(page.locator('#console-mobile-nav')).toBeVisible({ timeout: 10_000 });
    for (const [width, height] of [[390, 640], [390, 568], [320, 568]]) {
      await page.setViewportSize({ width, height });
      await page.goto(f.h.admin + '/#/management');
      await expect(chat.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible({ timeout: 10_000 });
      await expect(chat).toHaveClass(/management-page/);
      const pageForm = await fits(chat);
      await page.goto(f.h.admin + '/#/projects');
      await openFloatingAssistant(page, width);
      await expect(chat.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible({ timeout: 10_000 });
      await expect(chat).not.toHaveClass(/management-page/);
      const panelForm = await fits(chat);
      const size = `${width}x${height}`;
      if (pageForm.fits) expect(panelForm.fits, `${size} panel fits where the page fits`).toBe(true);
      expect(panelForm.need, `${size} panel scroll need`).toBeLessThanOrEqual(pageForm.need);
    }
  } finally { await f.close(); }
});
