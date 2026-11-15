import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, testPassword } from '../test/helpers.mjs';

// #547: one platform user per row, with the login methods and the GitHub binding the server reports. A phone keeps the
// table readable: the wrapper scrolls on its own, the page does not, and every row's entries stay reachable.
// Playwright results and screenshots live under .tmp/ (docs/development.md); nothing here writes into the tracked tree.
const output = resolve('.tmp/users-table-547');
const identity = (h, principal, login, status) => h.store.run(`INSERT INTO external_identities(id,principal_id,provider,host,
  connector,external_tenant,external_actor,display_name,status,verified_at) VALUES(?,?,'github','github.com','','',?,?,?,?)`,
  'ext-' + principal, principal, 'gh-' + principal, login, status, Date.now());
const widths = view => view.evaluate(() => {
  const wrap = document.querySelector('#settings-panel .rule-table-wrap');
  return wrap ? { scroll: wrap.scrollWidth, client: wrap.clientWidth } : null;
});
const create = async (admin, username) => {
  const created = await admin('/api/users', 'POST', { username, password: testPassword() });
  expect(created.status).toBe(201);
  return created.value.user;
};

test('the user list is one table: local, GitHub and both, with the binding state the server reports', async ({ page }) => {
  const h = await harness(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h);
    const local = await create(admin, 'mike');
    const both = await create(admin, 'bob'); identity(h, both.id, 'bob-dev', 'active');
    const pending = await create(admin, 'carol'); identity(h, pending.id, 'carol-gh', 'pending_verification');
    const unbind = await create(admin, 'dave'); identity(h, unbind.id, 'dave-old', 'revoked');
    h.store.run("INSERT INTO users(id,username,password_hash,role) VALUES('gh-zen','github:9002:ef567890','!external-only','project_admin')");
    identity(h, 'gh-zen', 'octozen', 'active');
    // Neither way in is left: no local password and the GitHub binding was revoked.
    h.store.run("INSERT INTO users(id,username,password_hash,role) VALUES('gh-lost','github:9003:deadbeef','!external-only','project_admin')");
    identity(h, 'gh-lost', 'lost-gh', 'revoked');
    expect(local.id).toBeTruthy(); expect(pending.id).toBeTruthy();

    await page.goto(h.admin + '/#/settings/users');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('#settings-panel'), table = panel.getByRole('table');
    await expect(table).toBeVisible();
    for (const caption of ['用户', '登录方式', '本地账号', 'GitHub 账号', '绑定关系', '角色', '状态', '操作'])
      await expect(table.getByRole('columnheader', { name: caption, exact: true })).toBeVisible();

    const row = name => table.getByRole('row').filter({ hasText: name });
    await expect(row('mike')).toContainText('本地');
    await expect(row('mike')).toContainText('未绑定 GitHub');
    await expect(row('@bob-dev')).toContainText('本地 + GitHub');
    await expect(row('@bob-dev')).toContainText('bob');
    await expect(row('@bob-dev')).toContainText('同一用户，已绑定');
    await expect(row('@carol-gh')).toContainText('待验证');
    await expect(row('dave')).toContainText('已解绑');
    await expect(row('dave')).not.toContainText('dave-old');
    // A GitHub-only account: no local login, and the placeholder name is not shown as one.
    await expect(row('@octozen')).toContainText('仅 GitHub');
    await expect(row('@octozen')).toContainText('无本地登录');
    // Unbound on both sides: the account is named after its GitHub id, never after the opaque placeholder, and the two
    // columns that describe the binding both say 已解绑 instead of calling it a local login.
    const lost = row('账号 #9003');
    await expect(lost).toContainText('无可用登录');
    await expect(lost).toContainText('无本地登录');
    expect(((await lost.textContent()) || '').match(/已解绑/g) || []).toHaveLength(2);
    await expect(lost).not.toContainText('github:9003');
    // The row still carries the entries the list had: detail, grants where they apply, and removal.
    await expect(row('mike').getByRole('link', { name: '详情', exact: true })).toBeVisible();
    await expect(row('mike').getByRole('button', { name: '删除', exact: true })).toBeVisible();

    // The desktop reading and its screenshot are both taken at 1440, the width the file is named after.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(row('mike')).toBeVisible();
    const desktop = await widths(page);
    expect(desktop, 'desktop keeps the table in a wrapper').not.toBeNull();
    expect(desktop.scroll, 'the desktop table fits its card').toBeLessThanOrEqual(desktop.client + 1);
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: resolve(output, 'after-1440.png'), fullPage: true });
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      // The table scrolls inside its wrapper; the page itself must not, and the actions stay reachable.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const scrolls = await widths(page);
      expect(scrolls, `${width}px keeps the table in a wrapper`).not.toBeNull();
      if (width >= 760) {
        // 768 still draws the table, wider than its card: the wrapper is the element that scrolls, and its last cell
        // (the actions column with 删除) can be brought into view without moving the page sideways.
        expect(scrolls.scroll, 'the 768 table overflows its card').toBeGreaterThan(scrolls.client);
        const moved = await page.evaluate(() => {
          const wrap = document.querySelector('#settings-panel .rule-table-wrap');
          wrap.scrollLeft = wrap.scrollWidth;
          return { wrap: wrap.scrollLeft, page: document.documentElement.scrollLeft };
        });
        expect(moved.wrap, 'the wrapper scrolls sideways').toBeGreaterThan(0);
        expect(moved.page, 'the page itself does not').toBe(0);
        await expect(table.getByRole('row').filter({ hasText: 'mike' }).getByRole('button', { name: '删除', exact: true })).toBeVisible();
      } else {
        // Below 760 the rows are cards: nothing overflows, so there is nothing to scroll inside the wrapper.
        expect(scrolls.scroll, `${width}px cards fit their card`).toBeLessThanOrEqual(scrolls.client + 1);
        expect(await panel.getByRole('link', { name: '详情', exact: true }).first().isVisible()).toBe(true);
      }
      await page.screenshot({ path: resolve(output, `after-${width}.png`), fullPage: true });
    }
    // 200% zoom of a 1440px window is a 720 CSS px viewport: the card layout, with 详情 still reachable.
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(panel.getByRole('link', { name: '详情', exact: true }).first()).toBeVisible();
    await page.screenshot({ path: resolve(output, 'after-zoom200.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
