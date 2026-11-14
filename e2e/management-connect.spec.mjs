import { test, expect } from '@playwright/test';
import { managementFixture } from '../test/management-fixture.mjs';

// #641: a connect that never returns must end in a stated failure with a working retry, and the floating panel must stay
// inside the viewport at every width without covering the top bar. #616 covers what happens after a failure exists.
async function signIn(page, h, password) {
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
}

test('#641 连接请求一直没有返回时 10 秒内进入失败态，「重试」重新发起并连上', async ({ page }) => {
  test.setTimeout(90000);
  const f = await managementFixture(), held = [];
  let hanging = true, attempts = 0, errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(f.h.admin + '/#/projects');
    await signIn(page, f.h, f.password);
    await page.route('**/api/management/query**', async route => {
      let operation = null;
      try { operation = route.request().postDataJSON()?.operation ?? null; } catch { /* not our body */ }
      if (operation === 'list_projects') {
        attempts++;
        // The first connect never answers: the panel has to give up on its own instead of waiting forever.
        if (hanging) { held.push(route); return; }
      }
      await route.continue();
    });
    await page.locator('#management-launcher').click();
    const panel = page.locator('#management-chat .management-panel');
    await expect(panel.getByText('正在连接管理助手…')).toBeVisible();
    // After three seconds the loading state says it is still connecting and offers a way out.
    await expect(panel.getByText('仍在连接，网络较慢时可能需要多等一会儿')).toBeVisible({ timeout: 8000 });
    await expect(panel.getByRole('button', { name: '取消', exact: true })).toBeVisible();
    // Ten seconds in, the wait is over: a stated failure with a retry, not an endless spinner.
    const failure = page.locator('#management-chat [data-testid="console-state-error"]');
    await expect(failure).toBeVisible({ timeout: 14000 });
    await expect(failure).toContainText('管理助手暂时连不上');
    await expect(failure).toContainText('可以稍后重试，或先去项目列表查看进展');
    const retry = failure.getByRole('button', { name: '重试', exact: true });
    await expect(retry).toBeVisible();
    await expect(failure.getByRole('link', { name: '查看项目列表' })).toBeVisible();
    expect(hanging).toBe(true);
    // Retrying really reconnects: the second request is allowed through and the scope control appears.
    hanging = false;
    await retry.click();
    await expect(page.locator('#management-chat').getByLabel('当前管理作用域')).toBeVisible({ timeout: 15000 });
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
  } finally {
    for (const route of held) await route.abort().catch(() => {});
    await f.close();
  }
});

test('#641 390 / 510 / 768 / 1024 / 1440 下面板四边都在视口内且不遮顶栏与「退出登录」', async ({ page }) => {
  test.setTimeout(120000);
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(f.h.admin + '/#/projects');
    await signIn(page, f.h, f.password);
    await page.locator('#management-launcher').click();
    await expect(page.locator('#management-chat').getByLabel('当前管理作用域')).toBeVisible();
    const measure = () => page.evaluate(() => {
      const box = node => {
        if (!node || !node.getClientRects().length || getComputedStyle(node).display === 'none') return null;
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const overlap = (a, b) => !!a && !!b && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      const win = box(document.getElementById('management-chat'));
      const header = box(document.querySelector('body > header'));
      const logout = box(document.getElementById('logout'));
      const account = box(document.getElementById('console-account'));
      return { viewport: { width: innerWidth, height: innerHeight }, win, header, logout, account,
        hitsHeader: overlap(win, header), hitsLogout: overlap(win, logout), hitsAccount: overlap(win, account) };
    });
    for (const [width, height] of [[1440, 900], [1024, 900], [768, 900], [510, 844], [390, 844]]) {
      await page.setViewportSize({ width, height });
      // The panel follows a viewport change the way a reader resizing a window would see it.
      await page.waitForFunction(() => document.querySelector('#management-chat')?.getBoundingClientRect().width > 0);
      await expect.poll(async () => (await measure()).win.height).toBeGreaterThan(200);
      const m = await measure();
      expect(m.win.left).toBeGreaterThanOrEqual(-0.5);
      expect(m.win.right).toBeLessThanOrEqual(m.viewport.width + 0.5);
      expect(m.win.top).toBeGreaterThanOrEqual(m.header.bottom - 0.5);
      expect(m.win.bottom).toBeLessThanOrEqual(m.viewport.height + 0.5);
      expect(m.win.height).toBeLessThanOrEqual(m.viewport.height - m.header.height + 0.5);
      expect(m.hitsHeader).toBe(false);
      expect(m.hitsLogout).toBe(false);
      expect(m.hitsAccount).toBe(false);
    }
    // The corner glyph is the resize grip, not decoration: it keeps a stated name at every width.
    await expect(page.locator('#management-chat .management-size-handle')).toHaveAccessibleName('调整管理助手窗口大小');
  } finally { await f.close(); }
});
