import { test, expect } from '@playwright/test';
import { managementFixture, command } from '../../fixtures/management-fixture.mjs';

// #355 slice A: a receipt page that says what a repeat submission would do (the idempotency key), what the command
// affects, and keeps the outcome of a successful, a failed and an unconfirmed command in their own sections instead of
// one block that means all three. Read-only, like the page itself: nothing here re-runs or reconciles a command.
async function login(page, f) {
  await page.goto(f.h.admin + '/#/management');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#tabs')).toBeVisible();
}
const open = async (page, f, id) => { await page.goto(f.h.admin + '/#/management/commands/' + id); return page.locator('#management-receipt-page'); };

test('a receipt shows the idempotency key with what a repeat submission does, and the impact the server recorded', async ({ page }) => {
  const f = await managementFixture(), writes = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/management/commands') && request.method() !== 'GET') writes.push(url.pathname);
  });
  try {
    const receipt = (await command(f.admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, { prompt: 'Keep the review prompt.' })).value;
    expect(receipt.state).toBe('succeeded');
    await login(page, f);
    const panel = await open(page, f, receipt.id);
    await expect(panel).toBeVisible();
    // The key is the reason a repeat submission is safe, so the page states the key and the rule beside it.
    const idempotency = panel.locator('[data-receipt-idempotency]');
    await expect(idempotency).toContainText(receipt.idempotency_key);
    await expect(idempotency).toContainText('同一个幂等键重放不会重复执行');
    // The impact row reads the notice this receipt actually carries (#355), and only because the server recorded an
    // effect with it. The sentence comes from the receipt itself, so the assertion cannot drift from its contract.
    expect(receipt.result.effect).toBeTruthy();
    expect(typeof receipt.result.notice).toBe('string');
    const impact = panel.locator('[data-receipt-impact]');
    await expect(impact).toContainText(receipt.result.notice);
    await expect(impact).not.toContainText('服务端未提供影响描述');
    // A successful command has its own outcome section, and it is not phrased as a failure or an unknown result.
    const result = panel.locator('[data-receipt-result]');
    await expect(result).toHaveAttribute('data-receipt-result', 'succeeded');
    await expect(result).toContainText('已执行');
    await expect(result).not.toContainText('命令未执行');
    await expect(result).not.toContainText('结果待确认');
    // Still a read: opening the fields adds no request beyond the one receipt read, and no write at all.
    expect(writes).toEqual([]);
    await expect(panel.getByRole('button')).toHaveCount(0);
  } finally { await f.close(); }
});

test('a failed command keeps its refusal in the failure section, apart from the success words', async ({ page }) => {
  const f = await managementFixture();
  try {
    f.h.store.run("UPDATE tasks SET status='completed' WHERE id='blocked'");
    const receipt = (await command(f.admin, 'task.pause', { project_id: '101', task_id: 'blocked' }, {})).value;
    expect(receipt.state).toBe('failed');
    await login(page, f);
    const panel = await open(page, f, receipt.id);
    const result = panel.locator('[data-receipt-result]');
    await expect(result).toHaveAttribute('data-receipt-result', 'failed');
    await expect(result).toContainText('命令未执行');
    await expect(result).toContainText('task_already_delivered');
    await expect(result).not.toContainText('已执行。');
    // The fields that are not the outcome stay out of the outcome section, so a refusal cannot read as a result.
    await expect(panel.locator('[data-receipt-record]')).toContainText('回执 ID');
    await expect(result).not.toContainText('回执 ID');
    // A refusal records no effect, and so no impact: the row keeps its honest fallback rather than borrowing a notice.
    await expect(panel.locator('[data-receipt-impact]')).toContainText('服务端未提供影响描述');
  } finally { await f.close(); }
});

test('an unconfirmed command has its own section, and a recorded impact is shown when the server provides one', async ({ page }) => {
  const f = await managementFixture();
  try {
    const unknown = (await command(f.admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, { prompt: 'Unconfirmed prompt.' })).value;
    f.h.store.run("UPDATE management_commands SET state='unknown', result=? WHERE id=?", JSON.stringify({ error: 'external_result_unknown', effect: 'future_tasks', impact: '之后的新任务会使用这段提示词。', notice: '这条 notice 应该让位给 result.impact。' }), unknown.id);
    await login(page, f);
    const panel = await open(page, f, unknown.id);
    const result = panel.locator('[data-receipt-result]');
    await expect(result).toHaveAttribute('data-receipt-result', 'unknown');
    await expect(result).toContainText('结果待确认');
    await expect(result).toContainText('对账');
    await expect(result).not.toContainText('已执行。');
    // The server did record an impact here, so the page renders it instead of the missing-impact sentence.
    const impact = panel.locator('[data-receipt-impact]');
    await expect(impact).toContainText('之后的新任务会使用这段提示词。');
    await expect(impact).not.toContainText('服务端未提供影响描述');
    // A recorded impact outranks a notice even when an effect backs the notice, so the row names the more specific field.
    await expect(impact).not.toContainText('这条 notice 应该让位给 result.impact。');
    // #1081: the impact row took the more specific field, not the notice, so the notice is still recorded once — the
    // fix must not start dropping a notice the row never showed.
    await expect(panel.locator('[data-receipt-record]')).toContainText('这条 notice 应该让位给 result.impact。');
    // The idempotency rule holds for an unconfirmed command too: that is exactly when it matters.
    await expect(panel.locator('[data-receipt-idempotency]')).toContainText('同一个幂等键重放不会重复执行');
  } finally { await f.close(); }
});

test('a notice without an effect statement stays out of the impact row', async ({ page }) => {
  const f = await managementFixture();
  try {
    // Two shapes where the server writes a notice but no effect: a command retired by the approval-flow removal
    // (src/management/storage.ts) and a configuration PR that is still pending merge (src/management/configuration-pr.ts).
    const retiredNotice = '审批流程已取消，这条等待审批的命令没有执行；需要时请重新发起。';
    const retired = (await command(f.admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, { prompt: 'Retired prompt.' })).value;
    f.h.store.run("UPDATE management_commands SET state='failed', result=? WHERE id=?", JSON.stringify({ error: 'approval_retired', notice: retiredNotice }), retired.id);
    const pendingNotice = '待合入默认分支；当前实际行为尚未改变。';
    const pending = (await command(f.admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, { prompt: 'Pending prompt.' })).value;
    f.h.store.run("UPDATE management_commands SET state='succeeded', result=? WHERE id=?", JSON.stringify({ state: 'pending_merge', effective: false, notice: pendingNotice }), pending.id);
    await login(page, f);
    for (const [id, notice] of [[retired.id, retiredNotice], [pending.id, pendingNotice]]) {
      const panel = await open(page, f, id);
      await expect(panel).toBeVisible();
      const impact = panel.locator('[data-receipt-impact]');
      // The notice is the outcome or a caveat, not an effect on future work: the honest fallback stands, and the notice
      // stays in the record section where it belongs.
      await expect(impact).toContainText('服务端未提供影响描述');
      await expect(impact).not.toContainText(notice);
      await expect(panel.locator('[data-receipt-record]')).toContainText(notice);
    }
  } finally { await f.close(); }
});

// #1081: the same sentence twice reads as two records. A notice the impact row already shows is the effect of this
// command; the record section keeps only what the impact row does not say, so the notice is on the page exactly once.
test('a notice shown as the impact is not repeated in the record section', async ({ page }) => {
  const f = await managementFixture();
  try {
    const receipt = (await command(f.admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, { prompt: 'One notice only.' })).value;
    expect(receipt.state).toBe('succeeded');
    expect(receipt.result?.effect).toBe('future_tasks');
    const notice = receipt.result?.notice;
    expect(notice).toBeTruthy();
    await login(page, f);
    const panel = await open(page, f, receipt.id);
    await expect(panel).toBeVisible();
    // The recorded notice is what this command affects, so the impact row names it.
    await expect(panel.locator('[data-receipt-impact]')).toContainText(notice);
    // And it is on the page once: 回执记录 does not repeat the sentence the impact row already carries.
    await expect(panel.locator('[data-receipt-record]')).not.toContainText(notice);
    const occurrences = await panel.evaluate((node, text) => node.innerText.split(text).length - 1, notice);
    expect(occurrences).toBe(1);
  } finally { await f.close(); }
});
