import { test, expect } from '@playwright/test';
import { managementFixture, command } from '../test/management-fixture.mjs';

// #235: a command receipt used to live only inside the transcript card. Opening it as its own address renders the same
// command structurally — who ran it, on which project, what changed, the recorded diff and the result — from the one
// GET /api/management/commands/<id> the console already exposes. The page is read-only: it never re-runs or reconciles a
// command, so a bookmarked receipt cannot become a second execution.
async function login(page, f) {
  await page.goto(f.h.admin + '/#/management');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#tabs')).toBeVisible();
}
const open = async (page, f, id) => { await page.goto(f.h.admin + '/#/management/commands/' + id); return page.locator('#management-receipt-page'); };

test('a receipt opens as its own page with the project, the change and the recorded diff', async ({ page }) => {
  const f = await managementFixture(), errors = [], reads = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/management/commands')) return;
    (request.method() === 'GET' ? reads : writes).push(url.pathname);
  });
  try {
    const prompt = 'Inspect evidence and cite the original logs.';
    const receipt = (await command(f.admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, { prompt })).value;
    expect(receipt.state).toBe('succeeded');
    await login(page, f);
    const panel = await open(page, f, receipt.id);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: '命令回执', exact: true })).toBeVisible();
    // State, operation and the project by the name the console already loaded — not the bare id in the receipt.
    await expect(panel.locator('[data-receipt-state]')).toHaveText('已执行');
    await expect(panel).toContainText('更新工作配置');
    await expect(panel).toContainText('agent-test-zone/admin-fixture-101');
    await expect(panel).not.toContainText('项目 101');
    // The initiator of this console command is the person reading it; a receipt from someone else says so instead.
    await expect(panel.locator('[data-receipt-initiator]')).toContainText('你');
    // What the command named and what it wrote, structurally rather than as one JSON blob.
    await expect(panel.locator('[data-receipt-target]')).toContainText('review.issue');
    await expect(panel.locator('[data-receipt-arguments]')).toContainText(prompt);
    // The recorded diff is a before/after row per field, and the revision moved from the old to the new one.
    const diff = panel.locator('[data-receipt-diff] tr', { hasText: 'prompt' });
    await expect(diff).toContainText('未设置');
    await expect(diff).toContainText(prompt);
    await expect(panel).toContainText(receipt.before_revision.slice(0, 12));
    await expect(panel).toContainText(receipt.after_revision.slice(0, 12));
    // The idempotency key is what makes a repeat submission return this same receipt; the page shows it as evidence.
    await expect(panel).toContainText(receipt.idempotency_key);
    await expect(panel.getByRole('link', { name: '原始回执（JSON）', exact: true })).toHaveAttribute('href', '/api/management/commands/' + receipt.id);
    // Read-only: no approval, no retry, no reconcile on a page that only describes what already happened.
    await expect(panel.getByRole('button')).toHaveCount(0);
    await expect(panel).toContainText('这一页只读');
    expect(reads.filter(path => path === '/api/management/commands/' + receipt.id)).toHaveLength(1);
    expect(writes).toEqual([]);
    // The two tables scroll inside their own containers on a phone, never widening the page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator('#management-receipt-page')).toContainText('agent-test-zone/admin-fixture-101');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('a failed command says why it did not run instead of showing the bare server code', async ({ page }) => {
  const f = await managementFixture();
  try {
    // A delivered task cannot be paused again: the server records the refusal on the receipt.
    f.h.store.run("UPDATE tasks SET status='completed' WHERE id='blocked'");
    const receipt = (await command(f.admin, 'task.pause', { project_id: '101', task_id: 'blocked' }, {})).value;
    expect(receipt.state).toBe('failed');
    expect(receipt.result.error).toBe('task_already_delivered');
    await login(page, f);
    const panel = await open(page, f, receipt.id);
    await expect(panel.locator('[data-receipt-state]')).toHaveText('执行失败');
    await expect(panel).toContainText('命令未执行');
    // The code the server returned stays visible, with the sentence a person needs beside it.
    await expect(panel.locator('[data-receipt-result]')).toContainText('task_already_delivered');
    await expect(panel.locator('[data-receipt-result]')).toContainText('任务已经交付');
    await expect(panel.locator('[data-receipt-result]')).toContainText('409');
    // Nothing on a failed receipt offers to run it again.
    await expect(panel.getByRole('button')).toHaveCount(0);
    await expect(panel).not.toContainText('按原值回滚');
  } finally { await f.close(); }
});

test('a receipt recorded as unknown and one recorded as rejected are told apart', async ({ page }) => {
  const f = await managementFixture();
  try {
    const unknown = (await command(f.admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, { prompt: 'Later prompt.' })).value;
    // The server writes these two states itself: `unknown` when an external call may have landed, `rejected` only on
    // receipts recorded before the approval flow was retired (#312). The fixture records both as the server would.
    f.h.store.run("UPDATE management_commands SET state='unknown', result=? WHERE id=?", JSON.stringify({ error: 'external_result_unknown', reconcile_required: true }), unknown.id);
    const rejected = (await command(f.admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, { prompt: 'Refused prompt.' })).value;
    f.h.store.run("UPDATE management_commands SET state='rejected' WHERE id=?", rejected.id);
    await login(page, f);
    const unknownPanel = await open(page, f, unknown.id);
    await expect(unknownPanel.locator('[data-receipt-state]')).toHaveText('结果待确认');
    await expect(unknownPanel).toContainText('对账');
    await expect(unknownPanel).not.toContainText('已执行');
    // A rejected receipt is not an approval button waiting to be clicked: it says the command never ran.
    const rejectedPanel = await open(page, f, rejected.id);
    await expect(rejectedPanel.locator('[data-receipt-state]')).toHaveText('已拒绝');
    await expect(rejectedPanel).toContainText('没有执行');
    await expect(rejectedPanel.getByRole('button')).toHaveCount(0);
  } finally { await f.close(); }
});

test('the receipt card in the transcript links to that same receipt page', async ({ page }) => {
  const f = await managementFixture();
  try {
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await page.getByLabel('管理消息', { exact: true }).fill('更新任务默认提示词');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(feed.locator('.management-turn-state')).toHaveText('已完成');
    // The card stays a summary in the transcript; its link is the way into the record, so it has to be a real link.
    const link = feed.getByRole('link', { name: '回执详情', exact: true }).last();
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^#\/management\/commands\/[a-f0-9]+$/);
    const commandId = href.split('/').pop();
    await link.click();
    await expect(page).toHaveURL(new RegExp('#/management/commands/' + commandId + '$'));
    const panel = page.locator('#management-receipt-page');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-receipt-state]')).toHaveText('已执行');
    await expect(panel).toContainText('agent-test-zone/admin-fixture-101');
    // Opening the record is a read: the transcript that produced it is left behind, not re-run.
    const written = f.h.store.get('SELECT count(*) AS n FROM management_commands WHERE id=?', commandId).n;
    expect(written).toBe(1);
    expect(f.h.store.get('SELECT state FROM management_commands WHERE id=?', commandId).state).toBe('succeeded');
  } finally { await f.close(); }
});

test('a failed receipt read is not read again by the next automatic route', async ({ page }) => {
  const f = await managementFixture();
  try {
    const receipt = (await command(f.admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, {})).value;
    const reads = [];
    await page.route('**/api/management/commands/' + receipt.id, async route => {
      reads.push(route.request().url());
      // Only the reader's own read fails; a later read would succeed, which is exactly what must not happen by itself.
      if (reads.length === 1) return route.fulfill({ status: 503, json: { error: 'temporary_unavailable' } });
      return route.continue();
    });
    await login(page, f);
    await page.evaluate(id => { location.hash = '#/management/commands/' + id; }, receipt.id);
    const panel = page.locator('#management-receipt-page');
    await expect(panel).toContainText('读不到这条回执');
    expect(reads).toHaveLength(1);
    // #540: the console routes the same address again on its own (#382). That route must neither read the receipt a second
    // time nor replace the failure the reader is looking at with a success that was not there when they asked.
    const routed = page.waitForRequest(request => new URL(request.url()).pathname === '/api/management/commands/' + receipt.id, { timeout: 4000 })
      .then(() => true, () => false);
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    expect(await routed).toBe(false);
    await expect(panel).toContainText('读不到这条回执');
    await expect(panel.getByRole('button')).toHaveCount(0);
    expect(panel.locator('[data-receipt-state]')).toHaveCount(0);
    expect(reads).toHaveLength(1);
    // The id is only kept against the automatic route: a person who reloads the address asks again, and a read that now
    // succeeds must still replace the failure. Every read after the first one is let through to the server.
    await page.reload();
    await expect(panel.locator('[data-receipt-state]')).toHaveText('已执行');
    await expect(panel).not.toContainText('读不到这条回执');
    expect(reads).toHaveLength(2);
    await expect(panel.getByRole('button')).toHaveCount(0);
  } finally { await f.close(); }
});
