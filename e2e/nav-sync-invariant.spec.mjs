import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

async function login(page, h, password, hash = '#/projects') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.locator('#workspace')).toBeVisible();
}

test('a background snapshot answer reaches the project header, not only the shared bar', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    h.store.run('UPDATE repositories SET full_name=? WHERE id=?', 'alpha/project-101', '101');
    h.store.run('UPDATE installed_repositories SET full_name=?, owner_login=? WHERE repository_id=?', 'alpha/project-101', 'alpha', '101');
    h.store.run('UPDATE installed_repositories SET permissions=? WHERE repository_id=?', JSON.stringify({ pull: true }), '101');
    // The grants are old enough that opening the list runs the background permission check by itself.
    h.store.run('UPDATE installed_repositories SET permissions_at=? WHERE repository_id=?', '2020-01-01T00:00:00.000Z', '101');
    // The check answers after the project page has already read and drawn the old snapshot.
    await page.route('**/api/installations/permissions/check', async route => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ repositories: [{ id: '101', full_name: 'alpha/project-101', owner_login: 'alpha', access_gaps: [] }] }) });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password, '#/projects/101/overview');
    const barBadge = page.locator('#console-location [data-permission]'), headerBadge = page.locator('#project-page [data-permission]');
    await expect(barBadge).toBeVisible(); await expect(headerBadge).toBeVisible();
    // Open the list so the check starts, then open the project again while the answer is still in flight: its own read
    // draws the gap, and the check that lands afterwards must update the header as well as the bar.
    await page.evaluate(() => { location.hash = '#/projects'; });
    await expect(page.locator('#rows .project-list-row')).toHaveCount(1);
    await page.evaluate(() => { location.hash = '#/projects/101/overview'; });
    await expect(headerBadge).toBeVisible();
    await expect(barBadge).toHaveCount(0, { timeout: 15000 });
    await expect(headerBadge).toHaveCount(0, { timeout: 15000 });
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('a sync started inside the onboarding wizard makes the project bar read the snapshot again', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    h.store.run('UPDATE repositories SET full_name=? WHERE id=?', 'alpha/project-101', '101');
    h.store.run('UPDATE installed_repositories SET full_name=?, owner_login=? WHERE repository_id=?', 'alpha/project-101', 'alpha', '101');
    h.store.run('UPDATE installed_repositories SET permissions=? WHERE repository_id=?', JSON.stringify({ pull: true }), '101');
    let reads = 0;
    page.on('request', request => { if (/\/api\/installations\?repository_id=101$/.test(request.url())) reads += 1; });
    // The wizard's own sync re-reads the installation scope; the answer is not needed here, only the cache it invalidates.
    await page.route('**/api/installations/sync', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [], repositories: [] }) }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password, '#/projects/101/overview');
    const barBadge = page.locator('#console-location [data-permission]');
    await expect(barBadge).toBeVisible();
    expect(reads).toBe(1);
    // Step 6 is addressed in the URL, so the wizard opens there directly.
    await page.evaluate(() => { location.hash = '#/settings/onboarding/6'; });
    const sync = page.getByRole('button', { name: '同步已安装仓库' });
    await sync.click();
    await expect(sync).toBeEnabled();
    await page.evaluate(() => { location.hash = '#/projects/101/overview'; });
    await expect(barBadge).toBeVisible();
    // Without the invalidation the bar answers from the row cached before the sync and never reads again.
    await expect.poll(() => reads, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
