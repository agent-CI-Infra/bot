import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { RuleService } from '../dist/rules/service.js';
import { configureDispatch, ruleDecider } from '../dist/dispatch/worker.js';
import { queueWebhook } from '../dist/review/queue.js';

// The 「Manager 与角色」 page replaces the workflows page: the Manager prompt, the work types, the events and the decisions.
test('the Manager page edits the prompt, work types and events, lists decisions and opens from old workflow addresses', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync('.tmp/manager-207', { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
    new RuleService(h.store).cache('101', 'a'.repeat(40), { '.bot/rules/pr-review.md': 'Repository PR review rules' });
    // One decided event and one the Manager could not decide, as the dispatcher leaves them.
    configureDispatch(null);
    queueWebhook(h.store, '101', 'issues', { action: 'opened', sender: { type: 'User', login: 'alice', id: 5 }, issue: { number: 3, state: 'open', title: 'Parser drops a line', body: 'x', user: { id: 5 } } }, 'opened-3');
    queueWebhook(h.store, '101', 'issues', { action: 'opened', sender: { type: 'User', login: 'alice', id: 5 }, issue: { number: 4, state: 'open', title: 'Crash on start', body: 'y', user: { id: 5 } } }, 'opened-4');
    const [decided, failed] = h.store.all('SELECT id FROM dispatch_events ORDER BY created_at,rowid');
    h.store.run("UPDATE dispatch_events SET state='decided',decision='ignore',reason='重复的问题，已有 Issue 在处理',decided_at=? WHERE id=?", new Date().toISOString(), decided.id);
    h.store.run("UPDATE dispatch_events SET state='failed',attempts=8,error=? WHERE id=?", JSON.stringify({ code: 'model_not_configured', detail: '仓库 101 未配置可用模型' }), failed.id);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/projects/101/workflows/review.pr');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // An old workflows address opens the Manager page; the navigation has no workflows page any more.
    await expect(page).toHaveURL(/#\/projects\/101\/roles$/);
    await expect(page.locator('.project-nav').getByRole('link', { name: 'Manager 与角色', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.project-nav').getByRole('link', { name: '工作流', exact: true })).toHaveCount(0);
    const prompt = page.getByLabel('Manager 提示词', { exact: true });
    await expect(prompt).toHaveValue('');
    // A repository file replaces its section; unwritten sections show their built-in text and can be inserted.
    await page.getByText(/^章节与内置文本/).click();
    await expect(page.locator('[data-manager-section="review.pr"]')).toContainText('仓库文件');
    await page.locator('[data-manager-section="review.issue"]').getByRole('button', { name: '插入这一章开始改写', exact: true }).click();
    await expect(prompt).toHaveValue(/^## 检视 Issue `review\.issue`\n/);
    await prompt.fill('## 分派 `dispatch`\n\nPR 推送新提交时不检视。\n\n## 检视 Issue `review.issue`\n\nReview issues briefly.\n');
    await page.getByRole('button', { name: '保存提示词', exact: true }).click();
    await expect(page.getByText('已保存 Manager 提示词，之后的分派和新任务使用新版本', { exact: true })).toBeVisible();
    await page.getByText(/^章节与内置文本/).click();
    await expect(page.locator('[data-manager-section="review.issue"]')).toContainText('项目已写');
    expect(JSON.parse(h.store.get("SELECT rule_overrides FROM policies WHERE repository_id='101'").rule_overrides)['.bot/rules/issue-review.md']).toBe('Review issues briefly.');
    // An unknown section id is refused with its reason.
    await prompt.fill('## 别的 `unknown.part`\n\n内容\n');
    await page.getByRole('button', { name: '保存提示词', exact: true }).click();
    await expect(page.getByText(/章节 id 不认识/)).toBeVisible();

    // Work types: the issue review may also file Issues; the reply work type is switched on.
    const work = id => page.locator(`[data-work-type="${id}"]`);
    await expect(work('review.issue').getByLabel('回复评论（固定）', { exact: true })).toBeDisabled();
    await work('review.issue').getByLabel('提报 Issue', { exact: true }).check();
    await work('reply').getByLabel('开启', { exact: true }).check();
    await page.getByLabel('测试命令', { exact: true }).fill('npm test');
    await page.getByRole('button', { name: '保存工作类型', exact: true }).click();
    await expect(page.getByText('已保存工作类型', { exact: true })).toBeVisible();
    const view = (await admin('/api/repositories/101/manager')).value.manager;
    expect(view.work.find(w => w.id === 'review.issue').writes).toEqual(['reply', 'labels', 'issue']);
    expect(view.work.find(w => w.id === 'reply').enabled).toBe(true);
    expect((await admin('/api/repositories/101')).value.policy.test_command).toBe('npm test');

    // Events: PR pushes stop reaching the Manager; a label is dispatched.
    await page.getByLabel('PR 推送新提交', { exact: true }).uncheck();
    await page.getByLabel('有人给 Issue 加上这些标签时', { exact: true }).fill('needs-triage, docs');
    await page.getByRole('button', { name: '保存事件开关', exact: true }).click();
    await expect(page.getByText('已保存事件开关', { exact: true })).toBeVisible();
    const events = (await admin('/api/repositories/101/manager')).value.manager.events;
    expect([events['pull_request.synchronize'], events['issue.labels']]).toEqual([false, ['needs-triage', 'docs']]);

    // The decisions: the reason of an ignored event, and a failed one a person retries.
    const decisions = page.locator('.manager-dispatch');
    await expect(decisions.locator(`[data-dispatch-event="${decided.id}"]`)).toContainText('重复的问题，已有 Issue 在处理');
    const stuck = decisions.locator(`[data-dispatch-event="${failed.id}"]`);
    await expect(stuck).toContainText('分派失败'); await expect(stuck).toContainText('model_not_configured');
    await page.screenshot({ path: '.tmp/manager-207/manager-desktop.png', fullPage: true });
    await stuck.getByRole('button', { name: '重试分派', exact: true }).click();
    await expect(decisions.locator(`[data-dispatch-event="${failed.id}"]`)).toContainText('等待 Manager');
    expect(h.store.get('SELECT state FROM dispatch_events WHERE id=?', failed.id).state).toBe('pending');

    // The models page lists every work type and the Manager's own dispatch model.
    await page.locator('.project-nav').getByRole('link', { name: '模型', exact: true }).click();
    for (const kind of ['manager', 'review.issue', 'reply', 'actions.failures', 'gate.onboarding']) await expect(page.locator(`[data-task-kind="${kind}"]`)).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects/101/roles');
    await expect(page.getByLabel('Manager 提示词', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: '.tmp/manager-207/manager-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { configureDispatch(ruleDecider); await h.stop(); }
});
