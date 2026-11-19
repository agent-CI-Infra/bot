import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

// #1064: the storage page's introduction used to be one paragraph carrying three facts: what is counted, how often
// it refreshes, and when this page last refreshed. The first screen now folds the refresh cadence away, but the
// reader still sees what is counted on the summary line and when the page last refreshed right below it. A failed
// manager read is a state, not an explanation: its sentence must stay outside the fold.
const SUMMARY = '这里统计已采集的文件与项目工作卷。';
const BODY = '后台快照每 5 分钟更新一次，目录按小时测量，工作卷每 6 小时扫描。';

const signIn = async (page, base, username, password) => {
  await page.goto(base + '/#/settings/storage');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
};

// The real /api/storage answer with the manager read marked as failed, which is what the page keeps from #793.
const withManagerError = async route => {
  const response = await route.fetch(), json = await response.json();
  json.manager_error = 'manager_unavailable';
  json.manager_read_at = '2026-11-19T08:00:00.000Z';
  await route.fulfill({ response, json });
};

const fold = page => page.locator('#settings-panel details.advanced-help').first();
const refreshLine = page => page.locator('#settings-panel p.muted').filter({ hasText: '最近刷新' }).first();

test('the storage introduction folds by default, keeps the refresh line visible, and opens from the keyboard', async ({ page }) => {
  const h = await harness(), { password, admin } = await setup(h), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await repository(admin, (await account(admin)).id, '101');
    await signIn(page, h.admin, 'administrator', password);

    const details = fold(page);
    await expect(details).toHaveCount(1);
    expect(await details.evaluate(el => el.open)).toBe(false);
    await expect(details.locator(':scope > summary')).toHaveText(SUMMARY);
    await expect(details.locator('p.muted').first()).toHaveText(BODY);
    await expect(details.locator('p.muted').first()).toBeHidden();

    const refresh = refreshLine(page);
    await expect(refresh).toContainText('最近刷新');
    await expect(refresh).toBeVisible();
    await expect(details).not.toContainText('最近刷新');

    // The summary is the control: focus it and press Enter, as a keyboard user would.
    await details.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    await expect(details).toHaveJSProperty('open', true);
    await expect(details.locator('p.muted').first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('a failed manager read keeps its sentence outside the fold', async ({ page }) => {
  const h = await harness(), { password, admin } = await setup(h), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await repository(admin, (await account(admin)).id, '101');
    await page.route(/\/api\/storage(\?|$)/, withManagerError);
    await signIn(page, h.admin, 'administrator', password);

    const details = fold(page);
    await expect(details).toHaveCount(1);
    expect(await details.evaluate(el => el.open)).toBe(false);
    const refresh = refreshLine(page);
    await expect(refresh).toContainText('manager 读取失败');
    await expect(refresh).toContainText('上次读取于');
    await expect(refresh).toBeVisible();
    await expect(details).not.toContainText('manager 读取失败');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('a project administrator sees the same fold and the same visible refresh line', async ({ page }) => {
  const h = await harness(), { password, admin } = await setup(h), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await repository(admin, (await account(admin)).id, '101');
    const memberPassword = 'member-password';
    const created = await admin('/api/users', 'POST', { username: 'member', password: memberPassword, role: 'project_admin', repository_ids: ['101'] });
    expect(created.status).toBe(201);
    await signIn(page, h.admin, 'member', memberPassword);

    const details = fold(page);
    await expect(details).toHaveCount(1);
    expect(await details.evaluate(el => el.open)).toBe(false);
    await expect(details.locator(':scope > summary')).toHaveText(SUMMARY);
    await expect(refreshLine(page)).toBeVisible();
    await expect(refreshLine(page)).toContainText('最近刷新');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
