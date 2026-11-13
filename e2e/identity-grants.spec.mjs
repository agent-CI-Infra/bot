import { test, expect } from '@playwright/test';
import { identityFixture, openIdentityAdvanced } from '../test/identity-fixture.mjs';

// #237: the tenant member list carried principal, source, project and state only, while the same page already asked
// "最近核验 / 授权有效期" for the person's own grants and the API had always returned grantor_id, expires_at and
// verified_at. The organization block must answer the same questions: who granted it, when it was verified, when it
// expires. A raw row keeps the fixture to one organization member with one explicit delegation.
async function delegatedMember(f) {
  const grantor = f.h.store.get("SELECT id FROM users WHERE username='administrator'").id;
  f.h.store.run("INSERT INTO users(id,username,password_hash,role) VALUES('member-237','team-member','x','project_admin')");
  // The user insert trigger creates the principal; only its tenant still has to be recorded.
  f.h.store.run("UPDATE principals SET tenant_id='github.com:10' WHERE id='member-237'");
  f.h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at,expires_at)
    VALUES('grant-237','member-237','github.com:10','tenant','delegated',?,'explicit_delegation',?,'independent','console delegation',?,?)`,
    JSON.stringify(['tasks.read']), grantor, Date.now() - 86_400_000, Date.now() + 7 * 86_400_000);
  return grantor;
}

test('授权列表把授权者 id 解析成可读名字，未记录授权者时明确说明', async () => {
  const f = await identityFixture();
  try {
    const grantor = await delegatedMember(f);
    const listing = await f.admin('/api/identity/grants?tenant_id=' + encodeURIComponent('github.com:10'));
    expect(listing.status).toBe(200);
    const granted = listing.value.grants.find(g => g.id === 'grant-237');
    expect(granted.grantor_id).toBe(grantor);
    // The wire carries the human's name, so the console never prints an internal id or guesses at one.
    expect(granted.grantor_name).toBe('administrator');
    // A grant with no recorded grantor stays null instead of borrowing the holder's name.
    for (const g of listing.value.grants) if (g.grantor_id == null) expect(g.grantor_name).toBeNull();
  } finally { await f.close(); }
});

test('组织成员授权展示授权者、最近核验与授权有效期', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await delegatedMember(f);
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await openIdentityAdvanced(page);
    await expect(page.getByRole('heading', { name: '当前角色与授权来源' })).toBeVisible();
    await page.getByLabel('当前租户').selectOption('github.com:10');
    await page.getByRole('button', { name: '切换组织' }).click();
    await expect(page.getByLabel('当前租户')).toHaveValue('github.com:10');
    await page.goto(f.h.admin + '/#/identity');
    await openIdentityAdvanced(page);
    await expect(page.getByRole('heading', { name: '组织成员授权' })).toBeVisible();
    const row = page.locator('#identity-panel .row').filter({ hasText: 'team-member' });
    await expect(row).toContainText('授权者');
    await expect(row).toContainText('administrator');
    await expect(row).toContainText('最近核验');
    await expect(row).toContainText('授权有效期');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('身份页按浏览器时区显示时间，有效期写成还剩多少分钟', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await openIdentityAdvanced(page);
    const panel = page.locator('#identity-panel');
    await expect(panel).toContainText(/UTC[+-]\d/);
    await expect(panel).toContainText(/还剩 \d+ 分钟/);
    await expect(panel.getByText('本页读取时间', { exact: true })).toBeVisible();
    const body = await panel.innerText();
    expect(body).toMatch(/还剩 \d+ 分钟（\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC[+-]\d/);
    const { mkdirSync } = await import('node:fs');
    mkdirSync('.tmp/ui-518', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: '.tmp/ui-518/remaining-1440.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/ui-518/remaining-390.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

