import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #238 webhooks slice: one delivery is three facts, not one status. Reception (did the request arrive),
// signature verification (was the sender trusted) and processing (what happened to the event) stay apart,
// and a duplicate, a disabled project, a draft or an untriggered event is an archive outcome, not a failure.
// The delivery ID and its archive reference stay visible, and a bad signature can never read as processed.
test('webhook list and detail separate reception, signature and processing outcomes', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const opened = { repository: { id: 101, full_name: 'fixture/project-101' }, action: 'opened', issue: { number: 1, title: 'Review' } };
  // One delivery creates a task, the same delivery ID again is a duplicate archive row.
  await h.hook(a.path, a.secret, 'delivery-success', opened);
  await h.hook(a.path, a.secret, 'delivery-duplicate', opened);
  // A draft pull request and a push with nothing to offer are skipped on purpose.
  await h.hook(a.path, a.secret, 'delivery-draft', { repository: { id: 101 }, action: 'opened', pull_request: { number: 2, draft: true, head: { sha: 'a'.repeat(40) } } }, { 'X-GitHub-Event': 'pull_request' });
  await h.hook(a.path, a.secret, 'delivery-not-trigger', { repository: { id: 101 }, ref: 'refs/heads/main' }, { 'X-GitHub-Event': 'push' });
  // A disabled project archives everything, and a wrong secret is refused before processing.
  await admin('/api/repositories/101/policy', 'PATCH', { enabled: false });
  await h.hook(a.path, a.secret, 'delivery-disabled', { ...opened, issue: { number: 3, title: 'Disabled' } });
  await admin('/api/repositories/101/policy', 'PATCH', { enabled: true });
  await h.hook(a.path, 'wrong-secret', 'delivery-bad-signature', opened);
  // A delivery to an endpoint this account does not have is archived before any signature check: it is unchecked, not failed.
  await h.hook('/hooks/github/' + a.id + '/' + 'f'.repeat(48), a.secret, 'delivery-unknown-endpoint', opened);

  await page.goto(h.admin);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.goto(h.admin + '/#/events');

  const row = key => page.locator(`#rows [data-delivery-key="${key}"]`), facet = (key, kind) => row(key).locator(`[data-delivery-facet="${kind}"]`);
  await expect(page.locator('#rows [data-delivery-record]')).toHaveCount(7);

  // Processed success: reception and signature are positive, processing says a task was created.
  await expect(facet('delivery-success', 'reception')).toHaveText('已接收');
  await expect(facet('delivery-success', 'signature')).toHaveText('签名有效');
  await expect(facet('delivery-success', 'processing')).toContainText('已创建');
  await expect(facet('delivery-success', 'processing')).toHaveClass(/status-success/);

  // Archive outcomes keep their own wording and never turn into a failure badge.
  for (const [key, text] of [['delivery-duplicate', '重复，不重复建任务'], ['delivery-disabled', '项目已禁用'], ['delivery-draft', '因草稿跳过'], ['delivery-not-trigger', '不是触发事件']]) {
    await expect(facet(key, 'reception')).toHaveText('已接收');
    await expect(facet(key, 'signature')).toHaveText('签名有效');
    await expect(facet(key, 'processing')).toContainText(text);
    await expect(facet(key, 'processing')).not.toHaveClass(/status-danger/);
    await expect(row(key).locator('.status-danger')).toHaveCount(0);
  }

  // A bad signature is refused by verification and must not read as a processed delivery.
  await expect(facet('delivery-bad-signature', 'signature')).toHaveText('签名无效');
  await expect(facet('delivery-bad-signature', 'signature')).toHaveClass(/status-danger/);
  await expect(facet('delivery-bad-signature', 'reception')).toHaveText(/已拒收/);
  await expect(facet('delivery-bad-signature', 'processing')).toContainText('未处理');
  await expect(facet('delivery-bad-signature', 'processing')).not.toHaveClass(/status-success/);
  await expect(row('delivery-bad-signature')).not.toContainText('已创建');

  // Every row keeps the GitHub delivery ID and the archive reference it can be looked up by.
  for (const key of ['delivery-success', 'delivery-duplicate', 'delivery-disabled', 'delivery-draft', 'delivery-not-trigger', 'delivery-bad-signature']) {
    await expect(row(key).locator('[data-delivery-id]')).toHaveText(key);
    await expect(row(key)).toHaveAttribute('data-delivery-source', /^deliveries:/);
  }

  // The detail shows the same three facts as sections, plus the Manager dispatch behind a created task.
  const dialog = page.locator('#detail');
  await row('delivery-success').getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-detail-section="reception"]')).toContainText('已接收');
  await expect(dialog.locator('[data-detail-section="signature"]')).toContainText('签名有效');
  await expect(dialog.locator('[data-detail-section="processing"]')).toContainText('已创建');
  // A created task is a handle, not a footnote: the delivery names the task it created and the name opens that task,
  // so a maintainer goes from "this webhook made a task" to the task's own page without copying an id (#357).
  const created = dialog.locator('[data-detail-section="processing"] .delivery-tasks li').first();
  await expect(created.getByRole('button', { name: /查看任务/ })).toBeVisible();
  // The status keeps its own text after the button: the row reads "… · 查看任务 · <status>", never "查看任务queued".
  const status = created.locator('span.muted');
  await expect(status).toBeVisible();
  expect(await status.innerText()).toMatch(/^ · \S+$/);
  await expect(created).toContainText('查看任务 · ');
  const openedNumber = /#(\d+)/.exec(await created.innerText())?.[1];
  await created.getByRole('button', { name: /查看任务/ }).click();
  const taskView = page.locator('#task-view');
  await expect(taskView).toBeVisible();
  await expect(page.locator('#task-title')).toContainText(`#${openedNumber}`);
  await expect(page.locator('#task-title')).not.toHaveText('正在加载…');
  await taskView.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(taskView).toBeHidden();
  await expect(dialog).toBeVisible();
  // The archived review_outcome is computed before the Manager decides, so it cannot be printed as a conclusion here:
  // a created task must not sit next to "not_trigger" or any other raw archive code.
  await expect(dialog.locator('[data-detail-section="processing"]')).not.toContainText('归档结论');
  await expect(dialog.locator('[data-detail-section="processing"]')).not.toContainText('not_trigger');
  await expect(dialog.locator('[data-detail-section="dispatch"]')).toContainText('新建任务');
  await expect(dialog.locator('[data-detail-section="dispatch"]')).toContainText(/reason|原因/);
  await expect(dialog.locator('[data-delivery-id]')).toHaveText('delivery-success');
  await expect(dialog.locator('details.raw-payload')).not.toHaveAttribute('open', '');

  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await row('delivery-duplicate').getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(dialog.locator('[data-detail-section="processing"]')).toContainText('重复，不重复建任务');
  await expect(dialog.locator('[data-detail-section="processing"]')).not.toContainText('失败');
  await expect(dialog.locator('[data-detail-section="dispatch"]')).toContainText('未交给 Manager');

  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await row('delivery-bad-signature').getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(dialog.locator('[data-detail-section="signature"]')).toContainText('签名无效');
  await expect(dialog.locator('[data-detail-section="processing"]')).toContainText('未处理');
  await expect(dialog.locator('[data-detail-section="processing"]')).not.toContainText('已创建');

  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(facet('delivery-unknown-endpoint', 'signature')).toHaveText('未验签');
  await row('delivery-unknown-endpoint').getByRole('button', { name: '查看详情', exact: true }).click();
  // Unchecked is not a failed verification: the endpoint was unknown, so the signature check never ran.
  await expect(dialog.locator('[data-detail-section="signature"]')).toContainText('验签没有执行');
  await expect(dialog.locator('[data-detail-section="signature"]')).not.toContainText('未通过验签');

  // The same facts stay readable at 390px without horizontal scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await expect(page.locator('#rows [data-delivery-record]')).toHaveCount(7);
  await expect(facet('delivery-bad-signature', 'signature')).toHaveText('签名无效');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
