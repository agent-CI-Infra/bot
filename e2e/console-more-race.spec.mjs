import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #365: a console page must never be loaded as a generic list row source. `#/more` used to reach the list renderer,
// which turns the tab name into an endpoint (`GET /api/more`, no such endpoint): a 404 whose failure hides #workspace,
// so `syncConsoleShell()` keeps `#console-mobile-nav` hidden. The race is timing-only, so the second test widens the
// window by holding one list read open instead of hoping a local server is slow enough.
const watch = (page, more, errors) => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/more(?:[?#]|$)/.test(request.url())) more.push(`${request.method()} ${request.url()}`); });
};
async function signIn(page, h, password, hash) {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('控制台页不会按 tab 名请求列表接口，移动导航在 #/more 上可用', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(), errors = [], more = [], bad = [];
  watch(page, more, errors);
  page.on('response', response => { if (/\/api\/more(?:[?#]|$)/.test(response.url())) bad.push(`${response.status()} ${response.url()}`); });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.setViewportSize({ width: 320, height: 900 });
    await signIn(page, h, password, '#/more');
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    await expect(page.locator('#console-mobile-nav')).toBeVisible();
    await expect(page.locator('#boot-message')).toBeHidden();
    expect(more.join('\n')).toBe('');
    expect(bad.join('\n')).toBe('');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('列表读还在进行时切到控制台页，六轮都不请求 /api/more 且导航保持可见', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(), errors = [], more = [], bad = [];
  watch(page, more, errors);
  page.on('response', response => { if (/\/api\/more(?:[?#]|$)/.test(response.url())) bad.push(`${response.status()} ${response.url()}`); });
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
      await page.evaluate(() => { location.hash = '#/more'; });
      await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
      await expect(page.locator('#console-mobile-nav')).toBeVisible();
      // Let the held read finish: a request that arrives after the test ends is not evidence either way.
      await page.waitForTimeout(700);
    }
    await page.unroute('**/api/integrations');
    expect(more.join('\n')).toBe('');
    expect(bad.join('\n')).toBe('');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
