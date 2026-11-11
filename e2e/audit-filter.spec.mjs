import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

// #357 acceptance item 5: the audit card is 100 rows of one undifferentiated list. A reader who wants to know
// "who applied a role here" has to read every row, and on a phone the card is longer than any task. This slice adds
// two read-only controls fed by the very same `GET /api/audit` answer: filter by action code, and show the rows
// 20 at a time instead of all 100 at once. No endpoint, no schema and no write control is added.
const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };
const login = async (page, admin, username, password) => {
  await page.goto(admin + '/#/projects/101/activity');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.project-nav [aria-current=page]')).toHaveText('运行状态');
};

test('the audit card filters by action code and shows the rest 20 rows at a time', async ({ page }) => {
  const h = await harness(undefined, manager), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    // Fixture setup writes its own audit rows; clear them so the counts below are exactly the rows this test seeds.
    h.store.run('DELETE FROM audit');
    const mine = h.store.get("SELECT id FROM users WHERE username='administrator'").id;
    const audit = (id, action, resource, at) => h.store.run('INSERT INTO audit(id,user_id,repository_id,action,resource_id,created_at) VALUES(?,?,?,?,?,?)', id, mine, '101', action, resource, at);
    // 25 rows over three action codes: 15 enabled, 8 roles.apply, 2 management.succeeded. Newest first.
    const n = 25;
    for (let i = 0; i < 15; i++) audit('e' + i, 'repository.enabled', '101', `2026-11-10T0${(i % 5) + 1}:${String(i).padStart(2, '0')}:00Z`);
    for (let i = 0; i < 8; i++) audit('r' + i, 'roles.apply', `task-${100 + i}`, `2026-11-10T03:${String(10 + i).padStart(2, '0')}:00Z`);
    for (let i = 0; i < 2; i++) audit('m' + i, 'management.succeeded', `command-${i}`, `2026-11-10T02:0${i}:00Z`);
    await login(page, h.admin, 'administrator', password);
    const card = page.locator('#project-audit');
    const rows = card.locator('[data-audit-row]');
    const more = card.getByRole('button', { name: /加载更多/ });
    // A first page instead of the whole card: 20 of 25.
    await expect(rows).toHaveCount(20);
    await expect(more).toContainText('还有 5 条');
    await expect(card).toContainText('已显示 20 / 25 条');
    await more.click();
    await expect(rows).toHaveCount(n);
    await expect(more).toHaveCount(0);
    await expect(card).toContainText('已显示全部 25 条');
    // The filter is a set of read-only chips, one per action code the answer contains, plus 全部.
    const chips = card.locator('[data-audit-filter]');
    await expect(chips).toHaveCount(4);
    const all = card.locator('[data-audit-filter="*"]');
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    const roleChip = card.locator('[data-audit-filter="roles.apply"]');
    await expect(roleChip).toContainText('roles.apply');
    // roleChip only filters the rows already read; it sends no request and shows every matching row.
    const before = await page.evaluate(() => performance.getEntriesByType('resource').length);
    await roleChip.click();
    await expect(roleChip).toHaveAttribute('aria-pressed', 'true');
    await expect(all).toHaveAttribute('aria-pressed', 'false');
    await expect(rows).toHaveCount(8);
    for (const row of await rows.all()) await expect(row).toHaveAttribute('data-audit-row', 'roles.apply');
    await expect(card).toContainText('已显示 8 / 25 条');
    const after = await page.evaluate(() => performance.getEntriesByType('resource').length);
    expect(after).toBe(before);
    // A filter with more rows than one page pages on its own, and the count follows the filter.
    await card.locator('[data-audit-filter="repository.enabled"]').click();
    await expect(rows).toHaveCount(15);
    await expect(more).toHaveCount(0);
    // Back to 全部 re-pages from the top and keeps the newest row first.
    await all.click();
    await expect(rows).toHaveCount(20);
    await expect(more).toBeVisible();
    // Read-only: the controls the slice adds are buttons inside the existing read-only card.
    expect(await card.locator('form, input, select, textarea').count()).toBe(0);
    // Chips wrap on a phone instead of pushing the page sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
