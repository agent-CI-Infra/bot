import { test, expect } from '@playwright/test';
import { identityFixture } from '../../fixtures/identity-fixture.mjs';

// #527 slice: global settings → installation archive (list and detail), together with the App permission check those
// pages draw once the App that owns an installation is registered with credentials. The archive and the widget both read
// static/i18n.js now, so an English console names them in English. Every case reads the same route at each width and
// counts the CJK words that survive the switch: one Chinese label left behind is the defect this spec guards, and the
// width loop keeps a reading taken at the default 1280x720 from standing in for the narrow layout.
const viewports = [[1440, 900], [768, 1024], [390, 844]];
const at = '2026-11-19T09:00:00Z';
// App 123 is the account identityFixture registers with a private key, so the archive draws the shared App permission
// check widget (static/onboarding/permissions.js) on the list card and in the detail's App section. The widget is part of
// this slice: its button, its report and the feature names inside it are the words an English console must not leave in
// Chinese.
const archive = {
  target: { login: 'fixture-org', id: 77, type: 'Organization' },
  installation: { github_host: 'github.com', app_id: 123, installation_id: 77 },
  permissions: { contents: 'read' },
  status: 'active', repository_selection: 'selected', completeness: 'complete', last_success_at: at,
  projection_version: 4, scope_version: 2, permissions_version: 1,
  evidence: { creation_event_id: 'ev-1', sender: { login: 'fixture-sender', id: 5 },
    requester: { login: 'fixture-requester', id: 6 }, approval: { label: 'fixture-approver' }, history_missing: false }
};
const detail = {
  target: { login: 'fixture-org' }, installation: { installation_id: 77, app_id: 123 },
  status: 'active', repository_selection: 'selected', completeness: 'complete', last_success_at: at, execution_blocked: false,
  projection_version: 4, scope_version: 2, permissions_version: 1, permissions: { contents: 'read' },
  evidence: { sender: { login: 'fixture-sender', id: 5 }, requester: { login: 'fixture-requester', id: 6 },
    approval: { label: 'fixture-approver' }, history_missing: false }
};
// The App check reads the App definition from GitHub, so the fixture answers with a report that exercises every branch:
// two missing baseline permissions, two missing events, one permission and one event that only some features need.
const report = {
  ok: false,
  app: {
    slug: 'fixture-app', owner: 'fixture',
    missing: [{ permission: 'actions', required: 'write', current: null }, { permission: 'statuses', required: 'write', current: 'read' }],
    missing_events: ['issue_comment', 'pull_request_review'],
    feature_gaps: [{ kind: 'permission', name: 'workflows', required: 'write', current: null, features: ['ci_changes'] },
      { kind: 'event', name: 'workflow_run', features: ['actions_failures'] }],
    settings_url: 'https://github.com/organizations/fixture/settings/apps/fixture-app/permissions'
  }
};
// The archive endpoints answer from this fixture: the list, one snapshot, its repositories and its deliveries. A sync
// request is accepted without a GitHub call, so the button's own text is what the case reads. The permission check is
// answered by `report` for the same reason: the widget's words, not GitHub's, are under test.
async function stubArchive(page) {
  await page.route('**/api/accounts/*/permissions', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report) }));
  await page.route('**/api/installations/archive**', route => {
    const url = new URL(route.request().url()), path = url.pathname, send = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (route.request().method() === 'POST') return send({ ok: true });
    if (path === '/api/installations/archive') return send({ installations: [archive] });
    if (path.endsWith('/repositories')) return send({ repositories: [{ full_name: 'fixture/project-101', private: true, last_success_at: at }] });
    if (path.endsWith('/events')) return send({ events: [{ received_at: at, event: 'installation_repositories', action: 'added', sender: { login: 'fixture-sender', id: 5 }, requester: null, evidence_type: 'signed', signature_verified: true }] });
    return send({ installation: detail });
  });
}
async function signIn(page, f, hash) {
  await page.goto(f.h.admin + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
const panel = page => page.locator('#settings-panel');
const cjkWords = text => text.match(/[^\s]*[\u4e00-\u9fff][^\s]*/g) || [];
// The switch redraws the whole card from the archive read, so wait for the English card rather than the pointer: the
// marker word only exists once the redraw has landed, and the shell's own loading placeholder is gone by then.
async function switchToEnglish(page, marker) {
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(panel(page)).toContainText(marker);
  await expect(panel(page).getByText('正在加载…')).toHaveCount(0);
}
test('English 界面：安装档案列表不再出现中文', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await stubArchive(page);
    await signIn(page, f, '/#/settings/installations');
    await expect(panel(page).locator('.side-card').first()).toBeVisible();
    await switchToEnglish(page, 'Status');
    await expect(panel(page).locator('.side-card').first()).toBeVisible();
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expect(panel(page).getByText('正在加载…')).toHaveCount(0);
      const left = cjkWords(await panel(page).innerText());
      expect(left, `Chinese text left in the installation archive at ${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow at ${width}px`).toBe(true);
      // The list names each fact in English, and the rows keep saying what they are.
      for (const word of ['Status', 'Scope', 'Completeness', 'Last successful sync', 'View installation details']) {
        await expect(panel(page)).toContainText(word);
      }
    }
    // The settings nav lives in the shell's secondary nav once the page is drawn, not in the panel, so the rename has to
    // hold there as well: the archive entry and the group holding it, with the Chinese caption gone.
    await page.setViewportSize({ width: 1440, height: 900 });
    const secondary = page.locator('#console-secondary-nav');
    await expect(secondary.locator('.project-nav')).toBeVisible();
    await expect(secondary).toContainText('Installations');
    await expect(secondary).toContainText('Connections and channels');
    await expect(secondary).not.toContainText('安装档案');
    // The App permission check drawn on the card is the same widget the account page uses: its button and the report it
    // opens are English, including the permission, event and feature names GitHub does not translate itself.
    const widget = panel(page).locator('.permission-check').first();
    await widget.getByRole('button', { name: 'Check permissions and events', exact: true }).click();
    const result = widget.locator('.permission-result');
    await expect(result).toContainText('Actions: set to "Read and write" (currently "No access")');
    await expect(result).toContainText('Subscribe to events: tick Issue comment, Pull request review (without them, comments, reviews and review replies do not trigger a review)');
    // A feature gap usually names one feature, so the sentence has to read as well for one as for many.
    await expect(result).toContainText('Workflows: set to "Read and write" (currently "No access"); needed for CI workflow changes');
    await expect(result).toContainText('Subscribe to events: tick Workflow run; needed for Actions failure analysis. This is an event subscription, not the Workflows permission');
    await expect(result).toContainText("Open the App's Permissions & events");
    expect(cjkWords(await result.innerText()), 'Chinese text left in the English permission report').toEqual([]);
    // The report is the widest thing the card draws (a permission line, its value and the features it serves), so the
    // widths have to be measured with it open, not with the card folded as it was on arrival.
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expect(result).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow with the report open at ${width}px`).toBe(true);
      expect(cjkWords(await panel(page).innerText()), `Chinese text left with the report open at ${width}px`).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
test('English 界面：安装档案详情不再出现中文', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await stubArchive(page);
    await signIn(page, f, '/#/settings/installations/github.com/123/77');
    await expect(panel(page).locator('table.rule-table')).toHaveCount(2);
    await switchToEnglish(page, 'Installation archive detail');
    await expect(panel(page).locator('table.rule-table')).toHaveCount(2);
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expect(panel(page).getByText('正在加载…')).toHaveCount(0);
      const left = cjkWords(await panel(page).innerText());
      expect(left, `Chinese text left in the installation detail at ${width}px`).toEqual([]);
    }
    // The facts, the repository table's headers and the sync control are the same English words the console uses.
    for (const word of ['Status', 'Scope', 'Completeness', 'Last successful sync', 'Execution', 'Repository', 'Private', 'Re-sync']) {
      await expect(panel(page)).toContainText(word);
    }
    // The App section's check opens an English report here too, and the control that queues a re-sync still works.
    const widget = panel(page).locator('.permission-check').first();
    await widget.getByRole('button', { name: 'Check permissions and events', exact: true }).click();
    await expect(widget.locator('.permission-result')).toContainText('Actions: set to "Read and write" (currently "No access")');
    expect(cjkWords(await widget.locator('.permission-result').innerText()), 'Chinese text left in the English detail report').toEqual([]);
    await panel(page).getByRole('button', { name: 'Re-sync' }).click();
    await expect(panel(page)).toContainText('queued');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
// The widget is drawn on four surfaces; this slice changed its words on all of them, so the account row is judged here
// as well: same component, narrower column, its own status and action columns beside it.
test('English 界面：账号行的权限检查报告不再出现中文', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await stubArchive(page);
    await signIn(page, f, '/#/settings/accounts');
    const row = page.locator('#settings-panel .row').filter({ has: page.locator('.permission-check') }).first();
    await expect(row).toBeVisible();
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(row.locator('.permission-check').getByRole('button', { name: 'Check permissions and events', exact: true })).toBeVisible();
    await row.locator('.permission-check button').first().click();
    const result = row.locator('.permission-result');
    await expect(result).toContainText('Actions: set to "Read and write" (currently "No access")');
    await expect(result).toContainText('Subscribe to events: tick Issue comment, Pull request review (without them, comments, reviews and review replies do not trigger a review)');
    await expect(result).toContainText('needed for CI workflow changes');
    await expect(result).toContainText('needed for Actions failure analysis');
    await expect(result).toContainText("Open the App's Permissions & events");
    expect(cjkWords(await result.innerText()), 'Chinese text left in the English account-row report').toEqual([]);
    // The page around the row is another slice of #527 and is still Chinese; what is judged here is the report and the
    // layout it has to fit in, with the report open at both widths.
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await expect(result).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow on the account row at ${width}px`).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
test('中文界面：安装档案的原文与今天逐字相同', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await stubArchive(page);
    await signIn(page, f, '/#/settings/installations');
    await expect(panel(page).locator('.side-card').first()).toBeVisible();
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      for (const word of ['GitHub App 安装档案', '所属账号', '状态', '最近成功同步', '查看安装详情']) {
        await expect(panel(page)).toContainText(word);
      }
      expect(await panel(page).innerText(), `a raw dictionary key is visible at ${width}px`).not.toContain('settings.installations.');
    }
    // The Chinese widget keeps its own words, byte for byte, including the punctuation of the report.
    await page.setViewportSize({ width: 1440, height: 900 });
    const widget = panel(page).locator('.permission-check').first();
    await widget.getByRole('button', { name: '检查权限和事件订阅', exact: true }).click();
    const result = widget.locator('.permission-result');
    await expect(result).toContainText('Actions：改为「Read and write」（当前「No access」）');
    await expect(result).toContainText('Subscribe to events：勾选 Issue comment、Pull request review（缺少时评论、检视或检视回复不会触发检视）');
    await expect(result).toContainText('App 所有者打开 Permissions & events，把下列各项改好，然后点一次「Save changes」。');
    await expect(result).toContainText('Workflows：改为「Read and write」（当前「No access」），CI 工作流改动需要');
    await expect(result).toContainText('Subscribe to events：勾选 Workflow run，Actions 失败分析需要。这是事件订阅，不是 Workflows 权限');
    await expect(result).toContainText('打开 App 的 Permissions & events');
    await expect(result).toContainText('改完后点「重新检查」。');
    await page.goto(f.h.admin + '/#/settings/installations/github.com/123/77');
    await expect(panel(page).locator('table.rule-table')).toHaveCount(2);
    for (const word of ['安装档案详情', '状态', '重新同步', '最近安装事件']) await expect(panel(page)).toContainText(word);
    await expect(panel(page).getByRole('button', { name: '检查权限和事件订阅', exact: true })).toBeVisible();
    expect(await panel(page).innerText()).not.toContain('settings.installations.');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('English 界面：安装详情读取与重新同步失败在浏览器中保持纯英文且不溢出', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    let failSync = true;
    await page.route('**/api/installations/archive/github.com/123/77**', route => {
      const path = new URL(route.request().url()).pathname;
      const send = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (route.request().method() === 'POST' && failSync) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' });
      }
      if (path.endsWith('/repositories')) return send({ repositories: [] });
      if (path.endsWith('/events')) return send({ events: [] });
      return send({ installation: detail });
    });
    await page.addInitScript(() => localStorage.setItem('launchpad.locale', 'en'));
    await page.goto(f.h.admin + '/#/settings/installations/github.com/123/77');
    await page.fill('input[name=username]', 'administrator');
    await page.fill('input[name=password]', f.password);
    await page.click('#access-submit');
    await expect(page.locator('body.console-ready')).toHaveCount(1);
    const resync = panel(page).getByRole('button', { name: 'Re-sync' });
    await expect(resync).toBeEnabled();
    await resync.click();
    const syncErr = panel(page).locator('section.side-card').first().locator('p.view-error');
    await expect(syncErr).toContainText('Re-sync failed: the service answered 500 · internal');
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expect(syncErr).toBeVisible();
      expect(cjkWords(await syncErr.innerText()), `Chinese leaked in re-sync error at ${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `overflow at ${width}px`).toBe(true);
    }
    // Aborted detail read exercises the real browser network TypeError path end-to-end.
    failSync = false;
    await page.unroute('**/api/installations/archive/github.com/123/77**');
    await page.route('**/api/installations/archive/github.com/123/77', route => route.abort('connectionrefused'));
    await page.reload();
    const readErr = panel(page).locator('section.side-card').first().locator('p.muted');
    await expect(readErr).toContainText('Cannot read this installation: the network request failed, try again shortly');
    expect(cjkWords(await readErr.innerText())).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
