import { test, expect } from '@playwright/test';
import { identityFixture } from '../test/identity-fixture.mjs';

// #871: the settings data tables must be readable cell by cell. A table without a caption has no accessible name, and a
// header cell without scope="col" does not tie its column to the cells under it, so a screen reader reads the values of a
// seven-column table as isolated strings. The narrow layout keeps printing the column name from data-label; that is not a
// substitute for the header, so this spec asserts both: the header semantics exist and data-label still matches it.
async function login(page, f, hash) {
  await page.goto(f.h.admin + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
// The table that belongs to the section whose own heading starts with the given text. The heading is the section's direct
// child, so its parent is that section and not the card above it, which also contains the heading.
function tableIn(panel, heading) {
  return panel.getByRole('heading', { name: heading }).locator('..').locator('table.rule-table');
}
// One delivery: the widest of the three tables, and only rendered when a delivery was recorded.
function recordDelivery(f) {
  f.h.store.run(`INSERT INTO installation_events(id,installation_ref,account_id,endpoint_id,delivery_id,event,action,
    signature_verified,received_at,payload_hash,payload,sender,requester,evidence_type,result,revision)
    VALUES('ev-a11y','github.com/123/77',?,?,'d-a11y','installation_repositories','added',1,?,'hash-a11y','{}',NULL,NULL,'signed','accepted',1)`,
    f.a.id, f.a.endpoints[0].id, new Date().toISOString());
}
// The three tables this change covers, with the column names their headers already carry.
const tables = [
  { heading: /^仓库（/, columns: ['仓库', '私有', '最近成功同步'] },
  { heading: /^最近安装事件（/, columns: ['时间', '事件', '动作', '发送者', '申请者', '证据类型', '签名'] },
  { heading: /^关联安装（/, columns: ['安装', '目标', '状态', '仓库', '缺什么', '会挡住什么'] },
];
// The installation sync records which installation listed each repository; the console-side fixture starts without it, and
// the account page's installation table only lists rows the sync bound to an installation.
const bound = f => f.h.store.run("UPDATE installed_repositories SET installation_id='77', installed=1 WHERE account_id=? AND repository_id='101'", f.a.id);
// The installation page carries the first two tables, the account page the third. The session survives navigation, so only
// the first page of a test logs in.
const hashes = f => ['/#/settings/installations/github.com/123/77', '/#/settings/installations/github.com/123/77', '/#/settings/accounts/' + encodeURIComponent(f.a.id)];
async function openTable(page, f, index) {
  await page.goto(f.h.admin + hashes(f)[index]);
  return page.locator('#settings-panel');
}

test('every settings data table carries a caption that names it', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    recordDelivery(f); bound(f);
    const seen = [];
    await login(page, f, hashes(f)[0]);
    for (const [index, table] of tables.entries()) {
      const panel = await openTable(page, f, index);
      const node = tableIn(panel, table.heading);
      await expect(node).toHaveCount(1);
      // A caption, exactly one, and it says something: an empty one is no accessible name at all.
      await expect(node.locator('caption')).toHaveCount(1);
      const caption = (await node.locator('caption').innerText()).trim();
      expect(caption.length).toBeGreaterThan(0);
      // The caption is a name for the table, not a second copy of one of its headers.
      for (const column of table.columns) expect(caption).not.toBe(column);
      seen.push(caption);
    }
    // Three different tables say three different things.
    expect(new Set(seen).size).toBe(3);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('every settings data table scopes its headers and keeps the narrow data-label in step', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    recordDelivery(f); bound(f);
    await login(page, f, hashes(f)[0]);
    for (const [index, table] of tables.entries()) {
      const panel = await openTable(page, f, index);
      const node = tableIn(panel, table.heading);
      await expect(node).toHaveCount(1);
      const heads = node.locator('thead th');
      await expect(heads).toHaveCount(table.columns.length);
      for (const [column, label] of table.columns.entries()) {
        // The header names the column and is scoped to it.
        await expect(heads.nth(column)).toHaveText(label);
        await expect(heads.nth(column)).toHaveAttribute('scope', 'col');
      }
      // Every body cell repeats its column's name for the narrow layout, so the header and the label cannot drift apart.
      const firstRow = node.locator('tbody tr').first();
      await expect(firstRow.locator('td')).toHaveCount(table.columns.length);
      for (const [column, label] of table.columns.entries()) await expect(firstRow.locator('td').nth(column)).toHaveAttribute('data-label', label);
    }

    // At 390 the header row is hidden and each cell prints its data-label instead; that layout is untouched by this change.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [index, table] of tables.entries()) {
      const panel = await openTable(page, f, index);
      const node = tableIn(panel, table.heading);
      await expect(node.locator('thead')).toBeHidden();
      const firstRow = node.locator('tbody tr').first();
      for (const [column, label] of table.columns.entries()) {
        if (column === table.columns.length - 1) continue; // the last column prints its value without a label (rule-table rule)
        const cell = firstRow.locator('td').nth(column);
        await expect(cell).toHaveAttribute('data-label', label);
        const printed = await cell.evaluate(cellNode => getComputedStyle(cellNode, '::before').content);
        expect(printed).toContain(label);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
