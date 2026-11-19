import { test, expect } from '@playwright/test';
import { identityFixture } from '../../fixtures/identity-fixture.mjs';

// #527 slice: global settings → installation archive (list and detail). The page is a dictionary consumer now, so an
// English console names the archive in English. Every case reads the same route at each width and counts the CJK words
// that survive the switch: one Chinese label left behind is the defect this spec guards, and the width loop keeps a
// reading taken at the default 1280x720 from standing in for the narrow layout.
const viewports = [[1440, 900], [768, 1024], [390, 844]];
const at = '2026-11-19T09:00:00Z';
// App 999 is deliberately not a registered account, so the archive shows its own dictionary text and not a shared
// permission-check widget that belongs to another page.
const archive = {
  target: { login: 'fixture-org', id: 77, type: 'Organization' },
  installation: { github_host: 'github.com', app_id: 999, installation_id: 77 },
  permissions: { contents: 'read' },
  status: 'active', repository_selection: 'selected', completeness: 'complete', last_success_at: at,
  projection_version: 4, scope_version: 2, permissions_version: 1,
  evidence: { creation_event_id: 'ev-1', sender: { login: 'fixture-sender', id: 5 },
    requester: { login: 'fixture-requester', id: 6 }, approval: { label: 'fixture-approver' }, history_missing: false }
};
const detail = {
  target: { login: 'fixture-org' }, installation: { installation_id: 77, app_id: 999 },
  status: 'active', repository_selection: 'selected', completeness: 'complete', last_success_at: at, execution_blocked: false,
  projection_version: 4, scope_version: 2, permissions_version: 1, permissions: { contents: 'read' },
  evidence: { sender: { login: 'fixture-sender', id: 5 }, requester: { login: 'fixture-requester', id: 6 },
    approval: { label: 'fixture-approver' }, history_missing: false }
};
// The archive endpoints answer from this fixture: the list, one snapshot, its repositories and its deliveries. A sync
// request is accepted without a GitHub call, so the button's own text is what the case reads.
async function stubArchive(page) {
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
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
test('English 界面：安装档案详情不再出现中文', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await stubArchive(page);
    await signIn(page, f, '/#/settings/installations/github.com/999/77');
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
    // The control keeps working in English: the queued notice is translated too.
    await panel(page).getByRole('button', { name: 'Re-sync' }).click();
    await expect(panel(page)).toContainText('queued');
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
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/settings/installations/github.com/999/77');
    await expect(panel(page).locator('table.rule-table')).toHaveCount(2);
    for (const word of ['安装档案详情', '状态', '重新同步', '最近安装事件']) await expect(panel(page)).toContainText(word);
    expect(await panel(page).innerText()).not.toContain('settings.installations.');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
