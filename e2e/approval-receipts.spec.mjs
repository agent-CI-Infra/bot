import { test, expect } from '@playwright/test';
import { managementFixture } from '../test/management-fixture.mjs';

// An approval policy is tenant-wide and has no console write path yet, so the fixture seeds it where the service reads it.
const requireApproval = (h, operations) => {
  const tenant = h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
  h.store.run('INSERT INTO management_policies(tenant_id,revision,approval_operations) VALUES(?,1,?) ON CONFLICT(tenant_id) DO UPDATE SET approval_operations=excluded.approval_operations', tenant, JSON.stringify(operations));
};
const latest = h => h.store.get('SELECT * FROM management_commands ORDER BY created_at DESC, rowid DESC LIMIT 1');

test('approval and execution receipts are told apart, decided states are named, and history never executes again', async ({ page }) => {
  test.setTimeout(180000);
  const f = await managementFixture(), { h } = f, errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const feed = page.getByRole('log', { name: '管理会话记录' }), message = page.getByLabel('管理消息', { exact: true });
  const ask = async text => { await message.fill(text); await page.getByRole('button', { name: '发送', exact: true }).click(); };
  try {
    requireApproval(h, ['workflow.update']);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    await expect(page.getByRole('region', { name: '管理助手', exact: true })).toBeVisible();

    // A command the organization policy holds back is a decision to take, never a failure, and the approval is not the result.
    await ask('更新任务默认提示词');
    await expect(feed).toContainText('等待批准');
    await expect(feed).toContainText('批准只代表审批通过');
    await expect(page.getByRole('button', { name: '批准此版本' })).toHaveCount(1);
    const first = latest(h); expect(first.state).toBe('awaiting_approval');

    // A rejected approval reads as rejected, including from the receipt restored after a reload, and offers no button to execute it.
    await f.admin('/api/management/commands/' + first.id + '/approval', 'POST', { parameter_hash: first.parameter_hash, expected_revision: first.expected_revision, decision: 'reject' });
    await page.reload();
    await expect(feed).toContainText('已拒绝');
    await expect(feed).toContainText('未执行');
    await expect(page.getByRole('button', { name: '批准此版本' })).toHaveCount(0);
    expect(h.store.get('SELECT state,after_revision FROM management_commands WHERE id=?', first.id)).toMatchObject({ state: 'rejected', after_revision: null });

    // An approval that has expired says why it did not run instead of surfacing the API error, and the command stays unexecuted.
    await ask('更新任务默认提示词');
    await expect(feed).toContainText('等待批准');
    const second = latest(h); expect(second.state).toBe('awaiting_approval');
    h.store.run('UPDATE management_approvals SET expires_at=? WHERE command_id=?', 0, second.id);
    await page.getByRole('button', { name: '批准此版本' }).click();
    await expect(page.getByText(/审批已过期/)).toBeVisible();
    await expect(page.getByRole('button', { name: '批准此版本' })).toHaveCount(0);
    expect(h.store.get('SELECT state FROM management_commands WHERE id=?', second.id).state).toBe('awaiting_approval');

    // Approval runs the command once; the receipt shows the execution result and reloading the history does not run it again.
    await ask('更新任务默认提示词');
    await expect(feed).toContainText('等待批准');
    const third = latest(h), total = h.store.get('SELECT count(*) n FROM management_commands').n;
    await page.getByRole('button', { name: '批准此版本' }).click();
    await expect(feed).toContainText('已执行');
    await expect(page.getByRole('button', { name: '批准此版本' })).toHaveCount(0);
    await page.reload();
    await expect(feed).toContainText('已执行');
    await page.waitForTimeout(500);
    expect(h.store.get('SELECT count(*) n FROM management_commands').n).toBe(total);
    expect(h.store.get('SELECT state FROM management_commands WHERE id=?', third.id).state).toBe('succeeded');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
