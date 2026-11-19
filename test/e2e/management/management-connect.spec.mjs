import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { managementFixture } from '../../fixtures/management-fixture.mjs';

const out = '.tmp/ui-874';

// #641: a connect that never returns must end in a stated failure with a working retry, and the page must stay
// inside the available viewport at every width without covering the shell header or mobile navigation.
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
    await page.locator('#tabs').getByRole('link', { name: '管理助手', exact: true }).click();
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
    await expect(page.locator('#management-chat .management-scope-name')).toBeVisible({ timeout: 15000 });
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
    await page.locator('#tabs').getByRole('link', { name: '管理助手', exact: true }).click();
    await expect(page.locator('#management-chat .management-scope-name')).toBeVisible();
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
    // 320×568, 390×600, 360×640 are the band where the viewport is taller than 560px but the clamped panel is not: the
    // compact layout used to hang on the viewport height alone, so the composer overflowed the box and the send button
    // ended up outside both the panel and the screen (#641 review).
    for (const [width, height] of [[1440, 900], [1024, 900], [768, 900], [510, 844], [390, 844], [768, 432], [510, 410], [390, 500], [320, 568], [390, 600], [360, 640]]) {
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
      // The box can be the right size while the composer is not reachable: a control under the fixed bottom bar or the
      // status bar still fails the reader. Its own centre must hit the button.
      const hit = await page.evaluate(() => {
        const win = document.getElementById('management-chat');
        const send = [...win.querySelectorAll('button')].find(node => node.textContent.trim() === '发送');
        const r = send.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { tag: at ? at.tagName : null, inside: !!(at && send.contains(at)) };
      });
      expect(hit.inside).toBe(true);
    }
  } finally { await f.close(); }
});

test('#641 手机从底栏打开管理助手：390×500 下页面与输入区都留在可用区域内', async ({ page }) => {
  test.setTimeout(120000);
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto(f.h.admin + '/#/projects');
    await signIn(page, f.h, f.password);
    const bar = page.locator('#console-mobile-nav a[data-page="assistant"]');
    await expect(bar).toBeVisible(); await bar.click();
    const panel = page.locator('#management-chat');
    await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeEnabled({ timeout: 15000 });
    const measure = () => page.evaluate(() => {
      const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      const win = document.getElementById('management-chat');
      return { viewport: { width: innerWidth, height: innerHeight }, win: rect(win), header: rect(document.querySelector('body > header')), scope: rect(document.getElementById('console-mobile-scope')), nav: rect(document.getElementById('console-mobile-nav')),
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
    expect(m.win.top).toBeGreaterThanOrEqual(m.scope.bottom);
    expect(m.win.bottom).toBeLessThanOrEqual(m.nav.top + 0.5);
    expect(m.field.height).toBeGreaterThanOrEqual(30);
    expect(m.field.bottom).toBeLessThanOrEqual(m.win.bottom + 0.5);
    expect(m.send.height).toBeGreaterThanOrEqual(44);
    expect(m.send.bottom).toBeLessThanOrEqual(m.win.bottom + 0.5);
    await expect(bar).toBeVisible();
    await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '会话记录', exact: true })).toBeVisible();
    const feed = await page.evaluate(() => {
      const node = document.querySelector('#management-chat .management-feed'), box = node.getBoundingClientRect();
      return { overflowY: getComputedStyle(node).overflowY, top: box.top, bottom: box.bottom };
    });
    expect(['auto', 'scroll']).toContain(feed.overflowY);
    expect(feed.bottom).toBeLessThanOrEqual(m.field.top + 0.5);
  } finally { await f.close(); }
});

test('#641 短手机（390×500）连接后状态栏可见且是单行（有文字）', async ({ page }) => {
  test.setTimeout(90000);
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto(f.h.admin + '/#/projects');
    await signIn(page, f.h, f.password);
    const navBar = page.locator('#console-mobile-nav a[data-page="assistant"]');
    await expect(navBar).toBeVisible(); await navBar.click();
    const panel = page.locator('#management-chat');
    await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeEnabled({ timeout: 15000 });
    // The bar is not only the failure exit: it carries the normal progress text too (正在读取会话… / 就绪 / 处理中),
    // so at this height it has to stay on screen as one compact line rather than be removed (#641 review).
    const status = panel.locator('.management-status');
    await expect(status).toBeVisible();
    await expect(status).not.toBeEmpty();
    const box = await page.evaluate(() => {
      const bar = document.querySelector('#management-chat .management-status-bar');
      const text = bar.querySelector('.management-status');
      const style = getComputedStyle(text), r = bar.getBoundingClientRect();
      return { height: r.height, whiteSpace: style.whiteSpace, overflowY: style.overflowY, textHeight: text.clientHeight };
    });
    expect(box.whiteSpace).toBe('nowrap');
    // The bar stays one line and may grow to hold a 44px recovery control (#641 accessibility).
    expect(box.height).toBeLessThanOrEqual(46);
    expect(box.textHeight).toBeLessThanOrEqual(24);
  } finally { await f.close(); }
});

test('#641 短手机（390×500）断流后错误文案与「重新连接」可见且可点', async ({ page }) => {
  test.setTimeout(90000);
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto(f.h.admin + '/#/projects');
    await signIn(page, f.h, f.password);
    // #641 review: the stream only opens while a turn is in flight. With the fixture model free to answer, the first
    // read can already see the turn finished — no stream request is made at all, this route has nothing to abort, and the
    // bar legitimately says 「就绪」 (the merge-queue run failed exactly here). Holding the model keeps the turn pending,
    // so the read opens the stream and the abort always hits it.
    f.modelState.gate = new Promise(() => {});
    await page.route('**/events?stream=1&after=*', route => route.abort('failed'));
    const navBar = page.locator('#console-mobile-nav a[data-page="assistant"]');
    await expect(navBar).toBeVisible(); await navBar.click();
    const panel = page.locator('#management-chat');
    await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeEnabled({ timeout: 15000 });
    const message = page.getByLabel('管理消息', { exact: true });
    await message.fill('检查任务进展'); await panel.getByRole('button', { name: '发送', exact: true }).click();
    const statusBar = panel.locator('.management-status-bar'), status = statusBar.locator('.management-status');
    await expect(status).toBeVisible({ timeout: 15000 });
    await expect(status).toContainText('连接已中断');
    // The text may shrink to an ellipsis; the button must never be squeezed with it.
    const reconnect = statusBar.getByRole('button', { name: '重新连接', exact: true });
    await expect(reconnect).toBeVisible();
    await expect(reconnect).toBeEnabled();
    // #641 accessibility: the only recovery control on a phone keeps the console's 44px touch target.
    const reconnectBox = await reconnect.boundingBox();
    expect(reconnectBox.height).toBeGreaterThanOrEqual(44);
    await page.unroute('**/events?stream=1&after=*');
    await reconnect.click();
    await expect(status).toBeVisible();
    const m = await page.evaluate(() => {
      const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      const win = document.getElementById('management-chat');
      const send = [...win.querySelectorAll('button')].find(node => node.textContent.trim() === '发送');
      return { win: rect(win), header: rect(document.querySelector('body > header')),
        status: rect(win.querySelector('.management-status-bar')), send: rect(send) };
    });
    expect(m.status.top).toBeGreaterThanOrEqual(m.header.bottom - 0.5);
    expect(m.status.bottom).toBeLessThanOrEqual(m.win.bottom + 0.5);
    expect(m.send.height).toBeGreaterThanOrEqual(44);
    expect(m.send.bottom).toBeLessThanOrEqual(m.win.bottom + 0.5);
  } finally { await f.close(); }
});

test('the desktop assistant keeps only the shell header and has no compact tag at 1440×900', async ({ page }) => {
  test.setTimeout(90000);
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('region', { name: '管理助手', exact: true })).toBeVisible({ timeout: 15000 });
    const panel = page.locator('#management-chat');
    expect(await panel.evaluate(node => node.hasAttribute('data-compact'))).toBe(false);
    await expect(panel.locator('.management-window-head')).toHaveCount(0);
    await expect(panel.getByText('从了解情况，到推进下一步', { exact: true })).toHaveCount(0);
    await expect(page.locator('body > header')).toBeVisible(); await expect(panel.locator('.management-sidebar')).toBeVisible();
  } finally { await f.close(); }
});

test('the 1440×600 assistant page keeps its normal composer without a secondary header', async ({ page }) => {
  test.setTimeout(90000);
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('region', { name: '管理助手', exact: true })).toBeVisible({ timeout: 20000 });
    const panel = page.locator('#management-chat');
    expect(await panel.evaluate(node => node.hasAttribute('data-compact'))).toBe(false);
    await expect(panel.locator('.management-window-head')).toHaveCount(0);
    expect(await panel.locator('textarea').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(60);
  } finally { await f.close(); }
});

test('#641 768×432 直接打开对话页：页面视图按自身盒高进紧凑布局，发送键留在框内', async ({ page }) => {
  test.setTimeout(90000);
  const f = await managementFixture();
  try {
    // 250% zoom on a laptop: the page view's own box is 368px tall, so the compact rules have to follow the box, not the mode.
    await page.setViewportSize({ width: 768, height: 432 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('region', { name: '管理助手', exact: true })).toBeVisible({ timeout: 20000 });
    const panel = page.locator('#management-chat');
    expect(await panel.evaluate(node => node.hasAttribute('data-compact'))).toBe(true);
    const m = await panel.evaluate(node => {
      const send = [...node.querySelectorAll('button')].find(b => b.textContent.trim() === '发送');
      const box = node.getBoundingClientRect(), s = send.getBoundingClientRect();
      const at = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
      return { winBottom: box.bottom, winHeight: box.height, sendBottom: s.bottom, sendHeight: s.height,
        inside: !!(at && send.contains(at)), hit: at ? at.tagName : null };
    });
    expect(m.sendBottom).toBeLessThanOrEqual(m.winBottom + 0.5);
    expect(m.sendHeight).toBeGreaterThanOrEqual(30);
    expect(m.inside).toBe(true);
  } finally { await f.close(); }
});

// #874: a broken stream left the status line assertive for good — every ordinary progress it wrote afterwards ("正在读取
// 会话…", "就绪") was announced as an alert and interrupted the reader. The error itself must still interrupt while it
// stands; once the read recovers, the same line carries ordinary progress and must hand the role back.
test('#874 断流错误后重连成功，状态栏从 alert 回到 status，普通进度不再打断读屏', async ({ page }) => {
  test.setTimeout(90000);
  const f = await managementFixture();
  let release; const held = new Promise(resolve => { release = resolve; });
  f.modelState.gate = held;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await switchConsoleProject(page, '101');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    // The stream breaks while a turn is in flight: the read says the connection is interrupted.
    await page.route('**/events?stream=1&after=*', route => route.abort('failed'));
    const message = page.getByLabel('管理消息', { exact: true });
    await message.fill('检查任务进展'); await page.getByRole('button', { name: '发送', exact: true }).click();
    const statusBar = page.locator('#management-chat .management-status-bar'), status = statusBar.locator('.management-status');
    await expect(status).toContainText('连接已中断');
    await expect(status).toHaveAttribute('role', 'alert');
    // The connection recovers through the bar's own button: what the line says now is ordinary progress, not an alarm.
    release(); f.modelState.gate = null;
    await page.unroute('**/events?stream=1&after=*');
    await statusBar.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect(status).toContainText('就绪');
    await expect(status).toHaveAttribute('role', 'status');
    // The line that now carries ordinary progress, at each width.
    mkdirSync(out, { recursive: true });
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      await page.screenshot({ path: `${out}/status-recovered-${width}.png`, fullPage: true });
    }
  } finally { release(); await f.close(); }
});
