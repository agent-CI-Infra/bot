import { test, expect } from '@playwright/test';
import { identityFixture } from '../../fixtures/identity-fixture.mjs';

// #527 slice: the installation archive's two failure paths are sentences the dictionary owns. Both used to interpolate
// readErrorText(), which answers in the console's own prose (Chinese), so an English console read "Cannot read this
// installation: 网络连接失败，请稍后重试" — one English sentence with a Chinese clause inside it. This spec makes the
// archive read and the re-sync fail in every way the console can observe (no network, a gateway page on a 500, an
// unparseable body on a 200, a permission change, an error code the page does not know) and counts the CJK words left in
// the strip. The width loop keeps a reading taken at the default 1280x720 from standing in for the narrow layout the
// same sentence has to wrap in.
const viewports = [[1440, 900], [768, 1024], [390, 844]];
const cjkWords = text => text.match(/[^\s]*[\u4e00-\u9fff][^\s]*/g) || [];
const at = '2026-11-19T09:00:00Z';
const detail = {
  target: { login: 'fixture-org' }, installation: { installation_id: 77, app_id: 123 },
  status: 'active', repository_selection: 'selected', completeness: 'complete', last_success_at: at, execution_blocked: false,
  projection_version: 4, scope_version: 2, permissions_version: 1, permissions: { contents: 'read' },
  evidence: { sender: { login: 'fixture-sender', id: 5 }, requester: { login: 'fixture-requester', id: 6 },
    approval: { label: 'fixture-approver' }, history_missing: false }
};
const archive = '/api/installations/archive/github.com/123/77';
async function signIn(page, f, locale) {
  if (locale) await page.addInitScript(value => localStorage.setItem('launchpad.locale', value), locale);
  await page.goto(f.h.admin + '/#/settings/installations/github.com/123/77');
  await page.fill('input[name=username]', 'administrator');
  await page.fill('input[name=password]', f.password);
  await page.click('#access-submit');
  await expect(page.locator('body.console-ready')).toHaveCount(1);
  return page.locator('#settings-panel');
}
// A failed read never reaches the page body, so the card holds the error strip and nothing else: that strip is what the
// case reads, at each width, after the layout has had to wrap it.
async function readFailure(page, f, fulfill, locale) {
  await page.route('**' + archive, fulfill);
  const panel = await signIn(page, f, locale);
  return panel.locator('section.side-card').first().locator('p.muted');
}
// The detail page loads, then the re-sync is the request that fails: the notice it draws carries the tone of its own
// outcome, and its words are the same dictionary sentence the read failure uses.
async function resyncFailure(page, f, fulfill, locale) {
  // Every request the card makes is answered here: the snapshot, its two tables, and the sync POST the case fails. A
  // wider pattern answers the tables as well, so the sync request must be routed before they are.
  await page.route('**' + archive + '**', route => {
    const send = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') return fulfill(route);
    if (path.endsWith('/repositories')) return send({ repositories: [] });
    if (path.endsWith('/events')) return send({ events: [] });
    return send({ installation: detail });
  });
  const panel = await signIn(page, f, locale);
  await expect(panel.getByRole('button', { name: locale === 'en' ? 'Re-sync' : '重新同步' })).toBeEnabled();
  await panel.getByRole('button', { name: locale === 'en' ? 'Re-sync' : '重新同步' }).click();
  return panel.locator('section.side-card').first().locator('p.view-error');
}
const englishFailures = [
  // A read that never reached the service is the case the reported strip showed: the console's own network sentence.
  { name: 'network', fulfill: route => route.abort('connectionrefused'),
    wording: 'the network request failed, try again shortly' },
  // A proxy in front of the console answers with its own page: status 500, no JSON, so there is no service code to name —
  // the status stays in the sentence because it is the only diagnostic the reader gets for such a page.
  { name: 'gateway page on a 500', fulfill: route => route.fulfill({ status: 500, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }),
    wording: 'the gateway answered 500 · an error page with no reason' },
  // The same unparseable body on a 2xx is a different failure: the service claimed success, so the page says the content
  // could not be read rather than blaming a gateway.
  { name: 'unreadable body on a 200', fulfill: route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>maintenance</body></html>' }),
    wording: 'the service answered 200 · content the console could not read' },
  // A code the console knows is named by the dictionary rather than by the Chinese sentence api() happens to carry.
  { name: 'permission change', fulfill: route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"authorization_changed"}' }),
    wording: 'your permissions changed; refresh the page and retry with your current permissions' },
  // A code the page does not know keeps the status and the service's own ASCII code, and never its untranslated prose.
  { name: 'unknown code', fulfill: route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' }),
    wording: 'the service answered 500 · internal' }
];
for (const failure of englishFailures) {
  test(`English 界面：安装详情读取失败（${failure.name}）的文案不含中文`, async ({ page }) => {
    const f = await identityFixture(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const strip = await readFailure(page, f, failure.fulfill, 'en');
      await expect(strip).toContainText('Cannot read this installation:');
      await expect(strip).toContainText(failure.wording);
      for (const [width, height] of viewports) {
        await page.setViewportSize({ width, height });
        await expect(strip).toBeVisible();
        expect(cjkWords(await strip.innerText()), `Chinese text left in the English read failure at ${width}px`).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow at ${width}px`).toBe(true);
      }
      expect(errors).toEqual([]);
    } finally { await f.close(); }
  });
}
test('English 界面：重新同步失败的文案不含中文', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const strip = await resyncFailure(page, f, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' }), 'en');
    await expect(strip).toContainText('Re-sync failed:');
    await expect(strip).toContainText('the service answered 500 · internal');
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expect(strip).toBeVisible();
      expect(cjkWords(await strip.innerText()), `Chinese text left in the English re-sync failure at ${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow at ${width}px`).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
// The Chinese console keeps today's wording byte for byte: this slice changes which dictionary answers, not what a
// Chinese reader already sees. The two paths are read in two cases because each one's route has to be set up alone.
test('中文界面：读取失败的原文与今天逐字相同', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const strip = await readFailure(page, f, route => route.abort('connectionrefused'), 'zh-CN');
    await expect(strip).toHaveText('读不到这条安装：网络连接失败，请稍后重试');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
// api() writes the status in front of a non-JSON body, so the two branches that read such a body keep it: dropping the
// status would take away the only diagnostic a Chinese reader has for a gateway page.
test('中文界面：网关页的原文与今天逐字相同', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const strip = await readFailure(page, f, route => route.fulfill({ status: 500, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }), 'zh-CN');
    await expect(strip).toHaveText('读不到这条安装：500 · 入口网关返回了错误页面，没有带回具体原因。请稍后重试；持续出现时请管理员查看服务日志。');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
test('中文界面：不可解析内容的原文与今天逐字相同', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const strip = await readFailure(page, f, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>maintenance</body></html>' }), 'zh-CN');
    await expect(strip).toHaveText('读不到这条安装：200 · 服务返回了无法识别的内容，请刷新页面后重试。');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
test('中文界面：重新同步失败的原文与今天逐字相同', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const strip = await resyncFailure(page, f, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' }), 'zh-CN');
    await expect(strip).toHaveText('重新同步失败：500 · internal');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
