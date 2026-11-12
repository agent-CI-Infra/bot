import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

async function login(page, h, password, hash = '#/projects') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.locator('#workspace')).toBeVisible();
}

test('the shared shell groups projects by organization and keeps the selected project permission state in the nav', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    // Two owners can install repositories with the same name; the picker has to show which organization a project came from.
    for (const [id, full, owner] of [['101', 'alpha/project-101', 'alpha'], ['102', 'beta/project-102', 'beta']]) {
      h.store.run('UPDATE repositories SET full_name=? WHERE id=?', full, id);
      h.store.run('UPDATE installed_repositories SET full_name=?, owner_login=? WHERE repository_id=?', full, owner, id);
    }
    // A bot account with read-only role has real access gaps, and the installation snapshot the console already reads reports them.
    h.store.run('UPDATE installed_repositories SET permissions=? WHERE repository_id=?', JSON.stringify({ pull: true }), '101');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password, '#/projects/101/overview');
    const picker = page.locator('#console-project'), location = page.locator('#console-location');
    // The picker is one group per organization instead of one flat list of repositories.
    await expect(picker.locator('optgroup')).toHaveCount(2);
    await expect(picker.locator('optgroup[label="alpha"] option')).toHaveCount(1);
    await expect(picker.locator('optgroup[label="alpha"] option')).toHaveText(['alpha/project-101']);
    await expect(picker.locator('optgroup[label="beta"] option')).toHaveText(['beta/project-102']);
    // The current scope bar names the organization and the project, and a project whose permissions are short of a feature says so there.
    await expect(page.locator('#console-context')).toContainText('alpha · project-101');
    const permission = page.locator('#console-location [data-permission]');
    await expect(permission).toBeVisible(); await expect(permission).toContainText('权限不足');
    // The badge opens the same gap dialog the project list uses, and Escape returns to it.
    await permission.click();
    await expect(page.getByRole('dialog')).toContainText('权限与事件缺口 · alpha/project-101');
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(permission).toBeFocused();
    // Switching to a project whose snapshot has not answered yet must clear the previous project's badge at once: the
    // badge names a project and opens its dialog, so keeping it would describe something other than the scope text.
    // The snapshot is delayed here, because an assertion that retries cannot tell a cleared badge from a late answer.
    await page.route('**/api/installations?repository_id=102', async route => { await new Promise(resolve => setTimeout(resolve, 2500)); await route.continue(); });
    await picker.selectOption('102');
    await expect(page.locator('#console-context')).toContainText('beta · project-102');
    expect(await page.locator('#console-location [data-permission]').count()).toBe(0);
    await page.unroute('**/api/installations?repository_id=102');
    // Re-reading the installation list drops the snapshot the navigation cached earlier, so the badge on returning to
    // the project comes from the new read instead of the page session's first answer.
    let snapshotReads = 0;
    page.on('request', request => { if (/\/api\/installations\?repository_id=101$/.test(request.url())) snapshotReads += 1; });
    // The sync answers here, so the assertion tests the order of the clear rather than the harness's missing installation
    // client: before the answer the cache still holds the old row, after it the bar reads the project again.
    await page.route('**/api/installations/sync', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) }));
    await picker.selectOption('');
    await page.goto(h.admin + '/#/settings/projects');
    const sync = page.getByRole('button', { name: '同步安装列表', exact: true });
    await expect(sync).toBeVisible(); await sync.click(); await expect(sync).toBeEnabled();
    await page.evaluate(() => { location.hash = '#/projects/101/overview'; });
    await expect(page.locator('#console-location [data-permission]')).toBeVisible();
    expect(snapshotReads).toBeGreaterThanOrEqual(1);
    // A project with nothing missing keeps the bar to the scope only.
    await page.goto(h.admin + '/#/projects/102/overview');
    await expect(page.locator('#console-context')).toContainText('beta · project-102');
    await expect(page.locator('#console-location [data-permission]')).toHaveCount(0);
    // No breakpoint gains a page-level horizontal scrollbar from the extra scope text and badge.
    for (const width of [390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(h.admin + '/#/projects/101/overview');
      await expect(page.locator('#console-location [data-permission]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width < 768) expect(await page.locator('#console-mobile-nav a').count()).toBe(4);
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('a background permission check reaches the scope bar without a fresh project read', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    h.store.run('UPDATE repositories SET full_name=? WHERE id=?', 'alpha/project-101', '101');
    h.store.run('UPDATE installed_repositories SET full_name=?, owner_login=? WHERE repository_id=?', 'alpha/project-101', 'alpha', '101');
    h.store.run('UPDATE installed_repositories SET permissions=? WHERE repository_id=?', JSON.stringify({ pull: true }), '101');
    // Grants older than the freshness window make the list run the background check by itself when it opens.
    h.store.run('UPDATE installed_repositories SET permissions_at=? WHERE repository_id=?', '2020-01-01T00:00:00.000Z', '101');
    await page.route('**/api/installations/permissions/check', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ repositories: [{ id: '101', full_name: 'alpha/project-101', owner_login: 'alpha', access_gaps: [] }] })
    }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password, '#/projects/101/overview');
    const badge = page.locator('#console-location [data-permission]');
    await expect(badge).toBeVisible();
    // Open the list so the check answers, then come back: the bar has to show what the check returned, not the row it
    // cached before that answer. A fresh project read would bring the old gap back, so no read may be needed here.
    await page.evaluate(() => { location.hash = '#/projects'; });
    await expect(page.locator('#rows .project-list-row')).toHaveCount(1);
    await page.evaluate(() => { location.hash = '#/projects/101/overview'; });
    await expect(page.locator('#console-context')).toContainText('alpha · project-101');
    await expect(badge).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('a sync that answers after a project was opened still reaches the scope bar', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    h.store.run('UPDATE repositories SET full_name=? WHERE id=?', 'alpha/project-101', '101');
    h.store.run('UPDATE installed_repositories SET full_name=?, owner_login=? WHERE repository_id=?', 'alpha/project-101', 'alpha', '101');
    h.store.run('UPDATE installed_repositories SET permissions=? WHERE repository_id=?', JSON.stringify({ pull: true }), '101');
    // The GitHub round trip is modelled here: the snapshot only loses its gap once the sync has answered.
    let synced = false;
    await page.route('**/api/installations/sync', async route => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      synced = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) });
    });
    await page.route('**/api/installations?repository_id=101', route => synced
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ repositories: [{ id: '101', full_name: 'alpha/project-101', owner_login: 'alpha', access_gaps: [] }] }) })
      : route.continue());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password, '#/projects/101/overview');
    const badge = page.locator('#console-location [data-permission]');
    await expect(badge).toBeVisible();
    // Open the list, start the sync, and open the project again while the answer is still in flight: that read caches
    // the pre-sync row, so the answer itself has to drop it after it lands, not before it starts.
    await page.goto(h.admin + '/#/settings/projects');
    await page.getByRole('button', { name: '同步安装列表', exact: true }).click();
    await page.evaluate(() => { location.hash = '#/projects/101/overview'; });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveCount(0, { timeout: 15000 });
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
