import { test, expect } from '@playwright/test';
import { identityFixture } from '../test/identity-fixture.mjs';

// #237 T2-A: one registered account at its own address, with what the API already offers — read-only facts, a rename,
// a credential rotation and the removal — and nothing that only looks like a change. The list keeps making no request of
// its own; every fetch lives on this page. Also covers the two non-blocking findings of the #344 review: a failed
// re-sync must not wear the success tone, and at 320px the tables scroll inside their container instead of the page.
async function login(page, f, hash) {
  await page.goto(f.h.admin + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('an account detail page shows the account, its projects and the changes it really makes', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await login(page, f, '/#/settings/accounts');
    const panel = page.locator('#settings-panel'), row = panel.locator('[role=listitem]', { hasText: 'Test account' });
    // The list keeps its own request count and gains one link per row: the way into the detail page has to be reachable
    // from the list, not only by typing the address (a duplicate helper would otherwise hide it silently).
    await expect(row.getByText('凭据来源：')).toBeVisible();
    const detail = row.getByRole('link', { name: '详情', exact: true });
    await expect(detail).toHaveAttribute('href', '#/settings/accounts/' + encodeURIComponent(f.a.id));
    await detail.click();
    // The address reaches one account, not the list, with a way back.
    await expect(page).toHaveURL(new RegExp('#/settings/accounts/' + encodeURIComponent(f.a.id) + '$'));
    await expect(panel).toContainText('账号详情');
    await expect(page.getByRole('link', { name: '返回机器人账号' })).toBeVisible();
    await expect(panel).toContainText('Test account');
    await expect(panel).toContainText('GitHub App · App ID 123');
    await expect(panel).toContainText('凭据已配置');
    // Every registered project of this account is counted and named, without a new request on the list page.
    await expect(panel).toContainText('使用项目（2）');
    await expect(panel).toContainText('fixture/project-101');
    await expect(panel).toContainText('other/project-201');
    // Its webhook entry is shown with the path GitHub posts to.
    await expect(panel).toContainText('/hooks/github/' + f.a.id);

    // A rename is written through to the account, and the page says so only after the server agreed.
    await panel.getByLabel('账号名称').fill('Renamed account');
    await panel.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(panel).toContainText('名称已保存');
    expect(f.h.store.get('SELECT name FROM accounts WHERE id=?', f.a.id).name).toBe('Renamed account');

    // An empty field never reaches the server: the API ignores an empty credential and answers 200 with the account
    // unchanged, so letting it through would report a rotation that did not happen.
    const writes = []; page.on('request', request => { if (request.method() === 'PATCH' && request.url().includes('/api/accounts/' + f.a.id)) writes.push(request.url()); });
    await panel.getByRole('button', { name: '保存凭据', exact: true }).click();
    await expect(panel.locator('p.view-error')).toContainText('留空不会替换');
    expect(writes).toEqual([]);

    // A refused credential is explained in words, not as a bare server code, and the old credential stays configured.
    await panel.getByLabel('新私钥（PEM）').fill('not a private key');
    await panel.getByRole('button', { name: '保存凭据', exact: true }).click();
    await expect(panel.locator('p.view-error')).toContainText('私钥');
    await expect(panel).toContainText('凭据已配置');

    // Removing the account is refused while its project is still registered: the dialog keeps the server's reason.
    await panel.getByRole('button', { name: '删除账号', exact: true }).click();
    const dialog = page.locator('dialog.confirm-dialog');
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    await expect(dialog.locator('.confirm-status')).toContainText('项目');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(f.h.store.get('SELECT count(*) AS c FROM accounts WHERE id=?', f.a.id).c).toBe(1);

    // #344 non-blocking: the re-sync failure is reported in the error tone, not the success tone.
    await page.route('**/api/installations/archive/**/sync', route => route.fulfill({ status: 503, json: { error: 'sync_unavailable' } }));
    await page.goto(f.h.admin + '/#/settings/installations/github.com/123/77');
    await panel.getByRole('button', { name: '重新同步', exact: true }).click();
    await expect(panel.locator('p.view-error', { hasText: '重新同步失败' })).toHaveCount(1);
    await expect(panel.locator('p.view-success', { hasText: '重新同步失败' })).toHaveCount(0);

    // #344 non-blocking: at 320px the tables scroll inside their container, and the page itself does not.
    await page.goto(f.h.admin + '/#/settings/installations/github.com/123/77');
    await page.setViewportSize({ width: 320, height: 800 });
    await panel.getByRole('heading', { name: /最近安装事件/ }).waitFor();
    const wrap = panel.locator('.rule-table-wrap').first();
    expect(await wrap.evaluate(node => getComputedStyle(node).overflowX)).toBe('auto');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // The account page is readable at the same width.
    await page.goto(f.h.admin + '/#/settings/accounts/' + encodeURIComponent(f.a.id));
    await expect(panel).toContainText('账号详情');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
