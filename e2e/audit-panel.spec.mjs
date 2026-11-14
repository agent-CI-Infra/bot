import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

// #357 slice B: a read-only audit card on the project activity page. It renders the audit table as it is — actor, action,
// object, time — and says out loud what the table does not record (an outcome). The only links out of a row are the ones
// the row itself proves: a management receipt the audit names by id, and the two actions whose object is a task.
const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };
const login = async (page, admin, username, password) => {
  await page.goto(admin + '/#/projects/101/activity');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.project-nav [aria-current=page]')).toHaveText('运行状态');
};

test('the audit card names who did what to which object, says the table records no result and links the receipt it names', async ({ page }) => {
  const h = await harness(undefined, manager), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    for (const id of ['101', '202']) await repository(admin, a.id, id);
    // Fixture setup writes its own audit rows; clear them so the card shows exactly the rows this test seeds.
    h.store.run('DELETE FROM audit');
    const mine = h.store.get("SELECT id FROM users WHERE username='administrator'").id;
    const audit = (id, repo, action, resource, at) => h.store.run('INSERT INTO audit(id,user_id,repository_id,action,resource_id,created_at) VALUES(?,?,?,?,?,?)', id, mine, repo, action, resource, at);
    audit('a1', '101', 'repository.enabled', '101', '2026-11-10T01:00:00Z');
    // A long object id: the phone assertion below is about this row, not about short ids that always fit.
    audit('a6', '101', 'knowledge.file.saved', 'knowledge/abcdef0123456789abcdef0123456789abcdef01.md', '2026-11-10T00:30:00Z');
    audit('a2', '101', 'management.succeeded', 'command-1', '2026-11-10T02:00:00Z');
    audit('a3', '101', 'roles.apply', 'task-9', '2026-11-10T03:00:00Z');
    audit('a4', '202', 'repository.enabled', '202', '2026-11-10T04:00:00Z');
    // #698: an action the console has no name for falls back to its group, or to 其他操作, never to the raw code.
    audit('a7', '101', 'github.write.sent', 'pull/7', '2026-11-10T00:20:00Z');
    audit('a8', '101', 'unheard.of', 'x-1', '2026-11-10T00:10:00Z');
    // A second account, so the actor column is tested against a name the reader is not: the audit row keeps the account id.
    await admin('/api/users', 'POST', { username: 'auditor', password: testPassword(), repository_ids: ['101'] });
    const other = h.store.get("SELECT id FROM users WHERE username='auditor'").id;
    h.store.run('INSERT INTO audit(id,user_id,repository_id,action,resource_id,created_at) VALUES(?,?,?,?,?,?)', 'a5', other, '101', 'repository.enabled', '101', '2026-11-10T05:00:00Z');
    await login(page, h.admin, 'administrator', password);
    const card = page.locator('#project-audit');
    await expect(card.getByRole('heading', { name: '操作记录（审计）', exact: true })).toBeVisible();
    // The card states the boundary of its own data instead of leaving the reader to assume an outcome column.
    await expect(card).toContainText('它不记录结果');
    await expect(card).toContainText('最近 100 条');
    const rows = card.locator('[data-audit-row]');
    // Newest first, and only this project: the row written for repository 202 must not leak into 101.
    await expect(rows).toHaveCount(7);
    // #698: each row starts with what was done in plain words; the action code is only under 技术信息.
    const head = index => rows.nth(index).locator('.audit-row-head');
    await expect(head(0)).toHaveText('启用项目 · auditor');
    await expect(head(1)).toHaveText('按角色配置执行 · 你');
    await expect(head(2)).toHaveText('管理助手操作成功 · 你');
    await expect(head(3)).toHaveText('启用项目 · 你');
    await expect(head(4)).toHaveText('保存项目知识文件 · 你');
    await expect(head(5)).toHaveText('GitHub · 其他操作 · 你');
    await expect(head(6)).toHaveText('其他操作 · 你');
    for (const code of ['repository.enabled', 'roles.apply', 'management.succeeded', 'knowledge.file.saved', 'github.write.sent', 'unheard.of'])
      await expect(card.getByText(code, { exact: true }).filter({ visible: true })).toHaveCount(0);
    await expect(card.getByText('无法关联')).toHaveCount(0);
    const tech = rows.nth(0).locator('details.audit-tech');
    await expect(tech.locator('summary')).toHaveText('技术信息');
    await tech.locator('summary').click();
    await expect(tech.getByText('repository.enabled', { exact: true })).toBeVisible();
    await expect(tech.getByText(other, { exact: true })).toBeVisible();
    await expect(tech.getByText('101', { exact: true })).toBeVisible();
    // A super administrator gets account names; a row of their own reads 你 instead of their account id.
    await expect(rows.nth(0)).toContainText('auditor');
    await expect(rows.nth(1)).toContainText('你');
    // The object of a management action is the receipt id, so the row links to that receipt page.
    await expect(rows.nth(2).getByRole('link')).toHaveAttribute('href', '#/management/commands/command-1');
    // roles.apply names a task, so that row opens the task the audit recorded.
    await expect(rows.nth(1).getByRole('button', { name: '打开任务', exact: true })).toBeVisible();
    // An object the page cannot resolve stays a plain id instead of becoming a link to something else.
    await expect(rows.nth(3).getByRole('link')).toHaveCount(0);
    await expect(rows.nth(3).getByRole('button')).toHaveCount(0);
    // The long object id renders in full under 技术信息 and is still not linkable.
    await rows.nth(4).locator('details.audit-tech>summary').click();
    await expect(rows.nth(4).getByText('knowledge/abcdef0123456789abcdef0123456789abcdef01.md', { exact: true })).toBeVisible();
    await expect(rows.nth(4).getByRole('link')).toHaveCount(0);
    mkdirSync('.tmp/audit-readable-698', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await card.evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: '.tmp/audit-readable-698/audit-1440.png' });
    // A 40-character object id must not push the page sideways on a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: '.tmp/audit-readable-698/audit-390.png' });
    // Read-only: the card has no control that writes.
    expect(await card.locator('form, input, select, textarea').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('a project administrator reads only their own project audit and sees themself as 你', async ({ page }) => {
  const h = await harness(undefined, manager), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    for (const id of ['101', '202']) await repository(admin, a.id, id);
    const memberPassword = testPassword();
    await admin('/api/users', 'POST', { username: 'member', password: memberPassword, repository_ids: ['101'] });
    h.store.run('DELETE FROM audit');
    const member = h.store.get("SELECT id FROM users WHERE username='member'").id;
    h.store.run('INSERT INTO audit(id,user_id,repository_id,action,resource_id,created_at) VALUES(?,?,?,?,?,?)', 'm1', member, '101', 'repository.disabled', '101', '2026-11-10T05:00:00Z');
    h.store.run('INSERT INTO audit(id,user_id,repository_id,action,resource_id,created_at) VALUES(?,?,?,?,?,?)', 'x1', member, '202', 'repository.enabled', '202', '2026-11-10T06:00:00Z');
    await login(page, h.admin, 'member', memberPassword);
    const card = page.locator('#project-audit');
    const rows = card.locator('[data-audit-row]');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('.audit-row-head')).toHaveText('停用项目 · 你');
    // A project administrator cannot read account names, so the row says it is them instead of printing an opaque id.
    await expect(rows.nth(0)).toContainText('你');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('a project with no audit rows says so instead of showing an empty list', async ({ page }) => {
  const h = await harness(undefined, manager);
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    h.store.run('DELETE FROM audit');
    await login(page, h.admin, 'administrator', password);
    const card = page.locator('#project-audit');
    await expect(card).toContainText('还没有操作记录', { timeout: 10000 });
    await expect(card.locator('[data-audit-row]')).toHaveCount(0);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('a name map read as super administrator is not reused by the next signed-in account', async ({ page }) => {
  const h = await harness(undefined, manager);
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const memberPassword = testPassword();
    await admin('/api/users', 'POST', { username: 'member', password: memberPassword, repository_ids: ['101'] });
    await admin('/api/users', 'POST', { username: 'auditor', password: testPassword(), repository_ids: ['101'] });
    h.store.run('DELETE FROM audit');
    const auditor = h.store.get("SELECT id FROM users WHERE username='auditor'").id;
    h.store.run('INSERT INTO audit(id,user_id,repository_id,action,resource_id,created_at) VALUES(?,?,?,?,?,?)', 'n1', auditor, '101', 'repository.disabled', '101', '2026-11-10T07:00:00Z');
    await login(page, h.admin, 'administrator', password);
    const card = page.locator('#project-audit');
    // The platform administrator fills the cache with real account names.
    await expect(card.locator('[data-audit-row]').nth(0)).toContainText('auditor');
    // Signing out only clears the console's own state; this document keeps the project module loaded.
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('用户名', { exact: true }).fill('member');
    await page.getByLabel('密码', { exact: true }).fill(memberPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.goto(h.admin + '/#/projects/101/activity');
    const row = page.locator('#project-audit [data-audit-row]').nth(0);
    await expect(row.locator('.audit-row-head')).toHaveText('停用项目 · 其他成员');
    // A project administrator may not read account names, so the map from the previous sign-in must be gone.
    await expect(row).not.toContainText('auditor');
    // #698: the account id is not printed in the sentence; it is kept under 技术信息.
    await expect(row.getByText(auditor, { exact: true }).filter({ visible: true })).toHaveCount(0);
    await row.locator('details.audit-tech>summary').click();
    await expect(row.getByText(auditor, { exact: true })).toBeVisible();
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
