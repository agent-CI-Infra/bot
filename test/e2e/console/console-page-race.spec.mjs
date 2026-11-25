import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

// #365: a console page must never be loaded as a generic list row source. A console tab used to reach the list renderer,
// which turns the tab name into an endpoint (`GET /api/more`, no such endpoint): a 404 whose failure hides #workspace,
// so `syncConsoleShell()` keeps `#console-mobile-nav` hidden. The race is timing-only, so the second test widens the
// window by holding one list read open instead of hoping a local server is slow enough.
// #1369: the 更多功能 page itself is gone; its saved address opens the console home of the current scope.
const watch = (page, tabs, errors) => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/(?:more|inbox)(?:[?#/]|$)/.test(request.url())) tabs.push(`${request.method()} ${request.url()}`); });
};
async function signIn(page, h, password, hash) {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('#1369 旧地址 #/more 打开当前范围的控制台首页，不请求 /api/more', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(), errors = [], tabs = [];
  watch(page, tabs, errors);
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 320, height: 900 });
    // A first visit has no remembered scope: #/more starts on the project list, like a bare address.
    await signIn(page, h, password, '#/more');
    await expect(page).toHaveURL(/#\/projects$/);
    await expect(page.locator('#rows .row')).toHaveCount(1);
    await expect(page.locator('#console-mobile-nav')).toBeVisible();
    await expect(page.locator('#boot-message')).toBeHidden();
    await expect(page.locator('[data-page-not-found]')).toHaveCount(0);
    // Inside a project the same address opens that project's overview, and Back does not revisit the redirect.
    await page.evaluate(() => { location.hash = '#/projects/101/knowledge'; });
    await expect(page.locator('#console-project-header .project-head h1')).toHaveText('项目知识');
    await page.evaluate(() => { location.hash = '#/more'; });
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    await expect(page.locator('.workspace-overview')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#\/projects\/101\/knowledge$/);
    // Whatever a saved link appended to the address redirects the same way.
    for (const saved of ['#/more/', '#/more/old-entry', '#/more?from=bookmark']) {
      await page.evaluate(hash => { location.hash = hash; }, saved);
      await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
      await expect(page.locator('[data-page-not-found]')).toHaveCount(0);
    }
    // A fresh load of a saved #/more starts in the remembered scope. page.goto() to an address that differs only in its
    // fragment would stay in the same document, so a new tab of the same session (same localStorage) does the real load.
    for (const saved of ['#/more', '#/more?from=bookmark']) {
      const fresh = await page.context().newPage();
      watch(fresh, tabs, errors);
      await fresh.goto(h.admin + '/' + saved);
      await expect(fresh).toHaveURL(/#\/projects\/101\/overview$/);
      await expect(fresh.locator('.workspace-overview')).toBeVisible();
      await fresh.close();
    }
    expect(tabs.join('\n')).toBe('');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('列表读还在进行时切到控制台页，六轮都不按 tab 名请求接口且导航保持可见', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(), errors = [], tabs = [];
  watch(page, tabs, errors);
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 320, height: 900 });
    await signIn(page, h, password, '#/projects');
    await expect(page.locator('#console-mobile-nav')).toBeVisible();
    // The projects list reads gate/dashboard status before it builds its row address; holding that read open is what
    // a slow connection does on its own, and it is the window the old code fell through.
    // A held read may be abandoned by the page when the address changes; releasing it twice is not a failure of this test.
    await page.route('**/api/integrations', async route => { await new Promise(done => setTimeout(done, 400)); await route.continue().catch(() => {}); });
    for (let round = 0; round < 6; round++) {
      await page.evaluate(() => { location.hash = '#/projects'; });
      await page.waitForTimeout(60);
      await page.evaluate(() => { location.hash = '#/inbox'; });
      await expect(page.getByRole('heading', { name: '待处理', exact: true })).toBeVisible();
      await expect(page.locator('#console-mobile-nav')).toBeVisible();
      // Let the held read finish: a request that arrives after the test ends is not evidence either way.
      await page.waitForTimeout(700);
    }
    await page.unroute('**/api/integrations');
    expect(tabs.join('\n')).toBe('');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
