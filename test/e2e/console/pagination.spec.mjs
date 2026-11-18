// #747: the pager used to read a full page of 50 as "there is another one", so a list whose total is a multiple of 50
// offered 下一页 and drew an empty page. These cases pin the three totals the issue names: 50 (no next page), 51 (one
// next page holding a single row), and none (both directions disabled, empty state untouched).
import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account } from '../../fixtures/helpers.mjs';

const login = async (page, h, password) => {
  await page.goto(h.admin + '/#/projects');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
};

function installation(h, a, id) {
  h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,installed,synced_at)
    VALUES(?,?,?,?,?,1,?)`, a.id, String(id), `fixture/project-${id}`, '10', 'fixture', new Date().toISOString());
}
async function installations(h, a, total, from = 3000) {
  for (let index = 0; index < total; index++) installation(h, a, from + index);
}

test('exactly 50 repositories is the last page: 下一页 is disabled and no empty page can be reached', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  try {
    await installations(h, a, 50);
    await login(page, h, password);
    await expect(page.locator('#rows .row')).toHaveCount(50);
    await expect(page.locator('#page-number')).toHaveText('第 1 页');
    await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    // What the issue reports: pressing it anyway must leave the page where it is, with its 50 rows.
    await page.getByRole('button', { name: '下一页', exact: true }).click({ force: true }).catch(() => {});
    await expect(page.locator('#rows .row')).toHaveCount(50);
    await expect(page.locator('#page-number')).toHaveText('第 1 页');
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('51 repositories give a second page of one row and nothing after it', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  try {
    await installations(h, a, 51);
    await login(page, h, password);
    await expect(page.locator('#rows .row')).toHaveCount(50);
    const next = page.getByRole('button', { name: '下一页', exact: true });
    await expect(next).toBeEnabled();
    const second = page.waitForResponse(response => response.url().includes('/api/installations?offset=50&'));
    await next.click(); await second;
    await expect(page.locator('#rows .row')).toHaveCount(1);
    await expect(page.locator('#page-number')).toHaveText('第 2 页');
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await expect(page.locator('#rows .row')).toHaveCount(50);
    await expect(page.locator('#page-number')).toHaveText('第 1 页');
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('an empty project list keeps both directions disabled and the empty state', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h);
  try {
    await login(page, h, password);
    await expect(page.locator('#rows .row')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await expect(page.locator('#count')).toContainText('0 个仓库');
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('the global project batch list has no next page at exactly 50', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  try {
    await installations(h, a, 50);
    await page.goto(h.admin + '/#/settings/projects/list.0');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.global-project-row')).toHaveCount(50);
    await expect(page.getByRole('link', { name: '下一页', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '上一页', exact: true })).toHaveCount(0);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('the global project batch list reaches its last page of one row', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  try {
    await installations(h, a, 51);
    await page.goto(h.admin + '/#/settings/projects/list.0');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.global-project-row')).toHaveCount(50);
    await page.getByRole('link', { name: '下一页', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/projects\/list\.50$/);
    await expect(page.locator('.global-project-row')).toHaveCount(1);
    await expect(page.getByRole('link', { name: '下一页', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '上一页', exact: true })).toBeVisible();
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
