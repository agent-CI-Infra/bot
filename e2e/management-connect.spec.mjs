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

test('#641 长视口与短视口（含 768×432 的 250% 缩放）下面板四边都在视口内且不遮顶栏与「退出登录」', async ({ page }) => {
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
      const field = box(document.querySelector('#management-chat textarea'));
      const send = box([...document.querySelectorAll('#management-chat button')].find(node => node.textContent.trim() === '发送'));
      return { viewport: { width: innerWidth, height: innerHeight }, win, header, logout, account, field, send,
        hitsHeader: overlap(win, header), hitsLogout: overlap(win, logout), hitsAccount: overlap(win, account) };
    });
    for (const [width, height] of [[1440, 900], [1024, 900], [768, 900], [510, 844], [390, 844], [768, 432], [510, 410], [390, 500]]) {
      await page.setViewportSize({ width, height });
      // The panel follows a viewport change the way a reader resizing a window would see it; measure once the box and the
      // composer have stopped moving, so a frame in the middle of that resize cannot produce a stray reading.
      await page.waitForFunction(() => document.querySelector('#management-chat')?.getBoundingClientRect().width > 0);
      let previous = null;
      await expect.poll(async () => {
        const m = await measure(), key = JSON.stringify([m.win, m.field, m.send]);
        const stable = key === previous; previous = key; return stable;
      }, { timeout: 8000 }).toBe(true);
      const m = await measure();
      await expect.poll(async () => (await measure()).win.height).toBeGreaterThan(200);
      expect(m.win.left).toBeGreaterThanOrEqual(-0.5);
      expect(m.win.right).toBeLessThanOrEqual(m.viewport.width + 0.5);
      expect(m.win.top).toBeGreaterThanOrEqual(m.header.bottom - 0.5);
      expect(m.win.bottom).toBeLessThanOrEqual(m.viewport.height + 0.5);
      expect(m.win.height).toBeLessThanOrEqual(m.viewport.height - m.header.height + 0.5);
      expect(m.hitsHeader).toBe(false);
      expect(m.hitsLogout).toBe(false);
      expect(m.hitsAccount).toBe(false);
      // A box that fits the viewport is not enough: the composer has to fit the box, or the panel edge cuts the send button.
      expect(m.field.height).toBeGreaterThanOrEqual(30);
      expect(m.field.bottom).toBeLessThanOrEqual(m.win.bottom + 0.5);
      expect(m.send.height).toBeGreaterThanOrEqual(30);
      expect(m.send.bottom).toBeLessThanOrEqual(m.win.bottom + 0.5);
    }
    // The corner glyph is the resize grip, not decoration: it keeps a stated name at every width.
    await expect(page.locator('#management-chat .management-size-handle')).toHaveAccessibleName('调整管理助手窗口大小');
  } finally { await f.close(); }
});

test('#641 手机从底栏打开管理助手：390×500 下面板与输入区都留在框内', async ({ page }) => {
  test.setTimeout(120000);
  const f = await managementFixture();
  try {
    // The bottom bar only exists on a phone, and it takes room from the panel: this is the case where the old 460px floor
    // and, after that, the touch-sized scope row pushed the send button past the panel's bottom edge.
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto(f.h.admin + '/#/projects');
    await signIn(page, f.h, f.password);
    const bar = page.locator('#console-mobile-nav a[data-page="assistant"]');
    await expect(bar).toBeVisible(); await bar.click();
    const panel = page.locator('#management-chat');
    await expect(panel.getByLabel('当前管理作用域')).toBeVisible({ timeout: 15000 });
    const measure = () => page.evaluate(() => {
      const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      const win = document.getElementById('management-chat');
      return { viewport: { width: innerWidth, height: innerHeight }, win: rect(win), header: rect(document.querySelector('body > header')),
        field: rect(win.querySelector('textarea')),
        send: rect([...win.querySelectorAll('button')].find(node => node.textContent.trim() === '发送')) };
    });
    let previous = null;
    await expect.poll(async () => {
      const m = await measure(), key = JSON.stringify([m.win, m.field, m.send]);
      const stable = key === previous; previous = key; return stable;
    }, { timeout: 8000 }).toBe(true);
    const m = await measure();
    expect(m.win.top).toBeGreaterThanOrEqual(m.header.bottom - 0.5);
    expect(m.win.bottom).toBeLessThanOrEqual(m.viewport.height + 0.5);
    expect(m.field.height).toBeGreaterThanOrEqual(30);
    expect(m.field.bottom).toBeLessThanOrEqual(m.win.bottom + 0.5);
    expect(m.send.height).toBeGreaterThanOrEqual(30);
    expect(m.send.bottom).toBeLessThanOrEqual(m.win.bottom + 0.5);
    await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    // Review fix: the send button keeps the 44px touch target even here; the conversation is what gives up room, by
    // scrolling inside its own box, and the session fold stays reachable instead of being removed at this height.
    expect(m.send.height).toBeGreaterThanOrEqual(44);
    await expect(panel.getByText('会话记录', { exact: true })).toBeVisible();
    const feed = await page.evaluate(() => {
      const node = document.querySelector('#management-chat .management-feed'), box = node.getBoundingClientRect();
      return { overflowY: getComputedStyle(node).overflowY, top: box.top, bottom: box.bottom };
    });
    expect(['auto', 'scroll']).toContain(feed.overflowY);
    expect(feed.bottom).toBeLessThanOrEqual(m.field.top + 0.5);
  } finally { await f.close(); }
});
