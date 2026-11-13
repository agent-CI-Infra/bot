import { test, expect } from '@playwright/test';
import { managementFixture, query, command } from '../test/management-fixture.mjs';

// #355 slice C: the receipt behaviour only the server can prove is pinned here — one idempotency key means one
// execution however often the same command is submitted, a receipt read that loses its connection is retried instead of
// duplicated, switching the chat's project and back keeps the submitted receipt once, and a stale revision is refused
// rather than overwriting. Nothing here writes through the console: the receipts come from the API the fixture already
// exposes, and the two page assertions read the same GET the console already makes.

const target = { project_id: '101', workflow_id: 'review.issue' };
const prompt = value => JSON.stringify(value);

async function login(page, f) {
  await page.goto(f.h.admin + '/#/management');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#tabs')).toBeVisible();
}

test('one idempotency key returns the same receipt and executes once, and a different argument under that key is refused', async () => {
  const f = await managementFixture();
  try {
    const revision = (await query(f.admin, 'get_effective_config', { project_id: '101' })).value.revision;
    const key = 'replay-355';
    const first = await command(f.admin, 'workflow.update', target, { prompt: 'Replay prompt.' }, key, revision);
    expect(first.status).toBe(201);
    expect(first.value.state).toBe('succeeded');
    const replay = await command(f.admin, 'workflow.update', target, { prompt: 'Replay prompt.' }, key, revision);
    expect(replay.status).toBe(201);
    // The replay answers with the receipt already stored: same id, same outcome, nothing executed a second time.
    expect(replay.value.id).toBe(first.value.id);
    expect(replay.value.state).toBe('succeeded');
    expect(f.h.store.get('SELECT count(*) n FROM management_commands WHERE idempotency_key=?', key).n).toBe(1);
    expect(f.h.store.get('SELECT state FROM management_commands WHERE id=?', first.value.id).state).toBe('succeeded');
    // The configuration moved once, not twice: the replay did not save the same prompt again.
    expect((await query(f.admin, 'get_effective_config', { project_id: '101' })).value.revision).toBe(first.value.after_revision);
    // The same key with different arguments is a conflict, not a second execution hidden behind the first receipt.
    const changed = await command(f.admin, 'workflow.update', target, { prompt: 'Different prompt.' }, key, first.value.after_revision);
    expect(changed.status).toBe(409);
    expect(changed.value.error).toBe('idempotency_conflict');
    expect(f.h.store.get('SELECT count(*) n FROM management_commands WHERE idempotency_key=?', key).n).toBe(1);
  } finally { await f.close(); }
});

test('a receipt read that loses its connection is reported, and the re-read shows the same receipt without a second execution', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), writes = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/management/commands') && request.method() !== 'GET') writes.push(url.pathname);
  });
  try {
    const receipt = (await command(f.admin, 'workflow.update', target, { prompt: 'Reconnect prompt.' })).value;
    expect(receipt.state).toBe('succeeded');
    // The fixture's own setup already recorded console writes, so the comparison is a before/after snapshot.
    const recorded = () => f.h.store.get('SELECT count(*) n FROM management_commands').n;
    const commandsBefore = recorded();
    const pattern = '**/api/management/commands/' + receipt.id;
    let dropped = false;
    await page.route(pattern, route => {
      if (dropped) return route.continue();
      dropped = true; return route.abort('connectionreset');
    });
    await login(page, f);
    await page.goto(f.h.admin + '/#/management/commands/' + receipt.id);
    // The console names the failed read and does not invent a state it never received.
    await expect(page.locator('#management-receipt-page .view-error')).toContainText('读不到这条回执');
    await expect(page.locator('[data-receipt-state]')).toHaveCount(0);
    await page.unroute(pattern);
    const reread = page.waitForResponse(response => new URL(response.url()).pathname === '/api/management/commands/' + receipt.id && response.status() === 200);
    await page.reload(); await reread;
    const state = page.locator('[data-receipt-state]');
    await expect(state).toContainText('已执行');
    await expect(page.locator('[data-receipt-result]')).toContainText('已执行，服务端没有记录错误。');
    await expect(page.locator('#management-receipt-page')).toContainText(receipt.id);
    // Reading a receipt again is still a read: nothing was submitted and the stored state did not move.
    expect(writes).toEqual([]);
    expect(recorded()).toBe(commandsBefore);
    expect(f.h.store.get('SELECT state FROM management_commands WHERE id=?', receipt.id).state).toBe('succeeded');
  } finally { await page.unrouteAll({ behavior: 'wait' }); await f.close(); }
});

test('switching the chat to another project and back keeps the submitted receipt exactly once', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await login(page, f);
    const scope = page.getByLabel('当前管理作用域'), message = page.getByLabel('管理消息', { exact: true }), feed = page.getByRole('log', { name: '管理会话记录' });
    await scope.selectOption('project:101');
    await message.fill('更新任务默认提示词');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(feed.getByText('操作 更新工作配置')).toHaveCount(1);
    await expect(feed).toContainText('已执行');
    const commands = () => f.h.store.get("SELECT count(*) n FROM management_commands WHERE operation='workflow.update'").n;
    expect(commands()).toBe(1);
    // Another project has its own conversation: the receipt of 101 is not carried over.
    await scope.selectOption('project:102');
    await expect(feed.getByText('操作 更新工作配置')).toHaveCount(0);
    // Coming back re-reads the same conversation and renders the receipt once, not twice.
    await scope.selectOption('project:101');
    await expect(feed.getByText('操作 更新工作配置')).toHaveCount(1);
    await expect(feed).toContainText('已执行');
    expect(commands()).toBe(1);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('a stale revision is refused instead of overwriting, and the receipt page explains the refusal in words', async ({ page }) => {
  const f = await managementFixture();
  try {
    const revision = (await query(f.admin, 'get_effective_config', { project_id: '101' })).value.revision;
    const applied = await command(f.admin, 'workflow.update', target, { prompt: 'First prompt.' }, 'stale-355-a', revision);
    expect(applied.status).toBe(201);
    const refused = await command(f.admin, 'workflow.update', target, { prompt: 'Overwriting prompt.' }, 'stale-355-b', revision);
    expect(refused.status).toBe(409);
    expect(refused.value.error).toBe('management_revision_conflict');
    // The stale write is refused before it is recorded: no receipt, no second save, the current value still stands.
    expect(f.h.store.get('SELECT count(*) n FROM management_commands WHERE idempotency_key=?', 'stale-355-b').n).toBe(0);
    const current = (await query(f.admin, 'get_effective_config', { project_id: '101' })).value;
    expect(current.revision).toBe(applied.value.after_revision);
    expect(prompt(current)).toContain('First prompt.');
    expect(prompt(current)).not.toContain('Overwriting prompt.');
    // A revision conflict that happens while a command executes is recorded on its receipt (src/management/service.ts
    // checks the revision again at :249 and :255), and that is the shape the page has to explain in words.
    f.h.store.run('UPDATE management_commands SET state=?, result=? WHERE id=?', 'failed', JSON.stringify({ error: 'management_revision_conflict', http_status: 409 }), applied.value.id);
    await login(page, f);
    await page.goto(f.h.admin + '/#/management/commands/' + applied.value.id);
    const panel = page.locator('#management-receipt-page'), result = panel.locator('[data-receipt-result]');
    await expect(result).toHaveAttribute('data-receipt-result', 'failed');
    await expect(result).toContainText('命令未执行');
    await expect(result).toContainText('提交之后项目配置的版本变了，命令没有执行；先读回当前配置再提交。');
    // Name the whole sentence the failure section must never show: the bare `已执行。` this used to exclude is only
    // ever rendered as a page note outside this section, so the old assertion could not fail (#484).
    await expect(result).not.toContainText('已执行，服务端没有记录错误。');
    // The positive control lives in this same test: a command submitted at the current revision does succeed and its
    // receipt page renders exactly that sentence, so the negative assertion above is known to be able to bite.
    const currentRevision = (await query(f.admin, 'get_effective_config', { project_id: '101' })).value.revision;
    const succeededCommand = await command(f.admin, 'workflow.update', target, { prompt: 'Second prompt.' }, 'stale-355-c', currentRevision);
    expect(succeededCommand.status).toBe(201);
    expect(succeededCommand.value.state).toBe('succeeded');
    await page.goto(f.h.admin + '/#/management/commands/' + succeededCommand.value.id);
    const succeeded = panel.locator('[data-receipt-result]');
    await expect(succeeded).toHaveAttribute('data-receipt-result', 'succeeded');
    await expect(succeeded).toContainText('已执行，服务端没有记录错误。');
  } finally { await f.close(); }
});
