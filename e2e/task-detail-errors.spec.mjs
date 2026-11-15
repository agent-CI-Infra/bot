import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #739: the detail view rescheduled refreshTask(5000) after every failed read, so a task the account can never see was
// requested forever and the error notice came back every five seconds. 404 (missing or out of scope; the service has no
// separate 403 branch) and 401 (the console-wide session banner takes the login over) are terminal: the read stops, the
// state offers one 关闭 and one explicit 重新读取, and only the reader's click requests the task again. 5xx and network
// failures stay recoverable and retry on a 2/5/15/30s backoff instead of the flat five seconds.
const TASK = 'terminal-task';
async function fixture() {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase) VALUES(?,'101','review.pr','running','terminal detail',7,'model')", TASK);
  h.store.run("INSERT INTO task_logs(id,task_id,content) VALUES('terminal-line',?,?)", TASK, JSON.stringify({ type: 'model', content: 'Public output' }));
  return { h, password, close: async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); } };
}
async function login(page, f) {
  await page.goto(f.h.admin + '/#/inbox/101');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible({ timeout: 15000 });
}
// Records every detail read the page makes, with the time it started, so a test can count requests and their gaps.
const readDetail = page => {
  const reads = [];
  page.on('request', r => { if (new RegExp('/api/tasks/' + TASK + '(\\?|$)').test(r.url())) reads.push(Date.now()); });
  return reads;
};
const openDetail = page => page.evaluate(id => openTask(id), TASK);
const timerIdle = page => page.evaluate(() => taskTimer === null);

test('404 task read is terminal: one request, terminal copy, one 关闭 and one explicit 重新读取', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    await page.route('**/api/tasks/' + TASK, route => route.fulfill({ status: 404, json: { error: 'task_not_found' } }));
    const reads = readDetail(page);
    await openDetail(page);
    await expect(page.getByRole('heading', { name: '任务不存在或已删除', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#timeline')).toContainText('读取已停止');
    // A terminal read must leave no timer behind: the next request can only come from the reader's own 重新读取.
    await expect.poll(() => timerIdle(page)).toBe(true);
    // Six seconds is more than two poll periods of the 2s rhythm this view uses; nothing may be requested in that time.
    await page.waitForTimeout(6000);
    expect(reads.length).toBe(1);
    expect(await timerIdle(page)).toBe(true);
    const actions = page.locator('#task-actions');
    await expect(actions.getByRole('button', { name: '关闭', exact: true })).toHaveCount(1);
    const retry = page.locator('#timeline').getByRole('button', { name: '重新读取', exact: true });
    await expect(retry).toHaveCount(1);
    // The explicit retry is the only way back once the account can read the task again.
    await page.unroute('**/api/tasks/' + TASK);
    await retry.click();
    await expect(page.locator('#timeline .step')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: '任务不存在或已删除', exact: true })).toBeHidden();
    expect(reads.length).toBe(2);
  } finally { await f.close(); }
});

test('a 500 task read keeps retrying, on a backoff that grows instead of the flat five seconds', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    await page.route('**/api/tasks/' + TASK, route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
    const reads = readDetail(page);
    await openDetail(page);
    await expect(page.locator('#task-error')).toBeVisible({ timeout: 15000 });
    // First retry at 2s, second at 5s: three reads inside 12s prove the recoverable path still retries at all.
    await expect.poll(() => reads.length, { timeout: 12000 }).toBeGreaterThanOrEqual(3);
    const gaps = reads.slice(1).map((at, i) => at - reads[i]);
    // The 2s then 5s waits are the #739 change; the flat 5000 ms rhythm this replaces would give two equal gaps.
    expect(gaps[1] - gaps[0]).toBeGreaterThan(1500);
    await expect(page.getByRole('heading', { name: '任务不存在或已删除', exact: true })).toBeHidden();
    await page.unroute('**/api/tasks/' + TASK);
    await expect(page.locator('#timeline .step')).toHaveCount(1, { timeout: 20000 });
  } finally { await f.close(); }
});

test('a 401 task read stops at the terminal state and lets the session banner carry the login', async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f);
    await page.route('**/api/tasks/' + TASK, route => route.fulfill({ status: 401, json: { error: 'login_required' } }));
    const reads = readDetail(page);
    await openDetail(page);
    await expect(page.locator('#session-expired-banner')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('heading', { name: '任务暂不可访问', exact: true })).toBeVisible();
    await expect.poll(() => timerIdle(page)).toBe(true);
    await page.waitForTimeout(6000);
    // An expired session is one state for the whole console: the banner says it once, and the read does not repeat.
    expect(reads.length).toBe(1);
    await expect(page.locator('#session-expired-banner')).toHaveCount(1);
  } finally { await f.close(); }
});
