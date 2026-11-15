import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

// #779: deleting your own account ends the session, so it must clean up exactly like signing out: the sign-in screen
// carries the chrome name, the previous reader's page is not announced to the next one, and their address is gone.
// A project render still in flight when the session ends must not rename the sign-in screen either.
const zh = ' · launchpad 管理';

async function signIn(page, password) {
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('#779 自助删号与登出走同一套会话清理：标题回到界面名，播报与地址清掉，下一位管理员登录的第一页不播报', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    // Deleting yourself is allowed only while another active super administrator remains.
    const second = testPassword();
    expect((await admin('/api/users', 'POST', { username: 'second', password: second, role: 'super_admin' })).status).toBe(201);
    await page.goto(h.admin + '/#/settings/users');
    await signIn(page, password);
    await expect(page).toHaveTitle('全局设置' + zh);
    const row = page.locator('#settings-panel .users-table tbody tr', { hasText: 'administrator' });
    await row.getByRole('button', { name: '删除', exact: true }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: '删除你自己的账号' });
    await confirm.getByRole('button', { name: '删除', exact: true }).click();
    // The account is gone with the session: the sign-in screen is shown without a logout round trip.
    await expect(page.locator('#access')).toBeVisible();
    await expect(page).toHaveTitle('launchpad 管理');
    await expect(page).toHaveURL(h.admin + '/');
    expect(await page.evaluate(() => location.hash)).toBe('');
    // The next reader starts from no announced page at all, not from the page this one left.
    expect(await page.evaluate(() => announcedPage)).toBe(null);
    // A project render still in flight cannot rename the sign-in screen (#779 second defect).
    await page.evaluate(() => { applyDocumentTitle(false, { id: '101', section: 'overview' }); });
    await expect(page).toHaveTitle('launchpad 管理');
    // The next administrator lands on the default page, drawn and named but not announced: the first page of a sign-in
    // is not a navigation, so focus stays where the browser put it.
    await page.getByLabel('用户名', { exact: true }).fill('second');
    await page.getByLabel('密码', { exact: true }).fill(second);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveTitle('项目' + zh);
    // route() names the page before its asynchronous render; announcement records that render's completion.
    await expect.poll(() => page.evaluate(() => announcedPage)).toBe('page:projects');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#project-page, #console-page, #settings-panel'))).toBe(false);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
