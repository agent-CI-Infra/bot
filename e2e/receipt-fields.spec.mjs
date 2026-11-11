import { test, expect } from '@playwright/test';
import { managementFixture, command } from '../test/management-fixture.mjs';

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

test('a receipt shows the idempotency key with what a repeat submission does, and names a missing impact', async ({ page }) => {
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
    // The impact of a command is not part of what the server records today: the page says that instead of leaving a gap.
    await expect(panel.locator('[data-receipt-impact]')).toContainText('服务端未提供影响描述');
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
  } finally { await f.close(); }
});

test('an unconfirmed command has its own section, and a recorded impact is shown when the server provides one', async ({ page }) => {
  const f = await managementFixture();
  try {
    const unknown = (await command(f.admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, { prompt: 'Unconfirmed prompt.' })).value;
    f.h.store.run("UPDATE management_commands SET state='unknown', result=? WHERE id=?", JSON.stringify({ error: 'external_result_unknown', impact: '之后的新任务会使用这段提示词。' }), unknown.id);
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
    // The idempotency rule holds for an unconfirmed command too: that is exactly when it matters.
    await expect(panel.locator('[data-receipt-idempotency]')).toContainText('同一个幂等键重放不会重复执行');
  } finally { await f.close(); }
});
