import { test, expect } from '@playwright/test';
import { TaskEngine } from '../dist/agent/engine.js';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { RuleService } from '../dist/rules/service.js';
import { configureDispatch, ruleDecider } from '../dist/dispatch/worker.js';
import { queueWebhook } from '../dist/review/queue.js';

// The 「Manager 与角色」 page replaces the workflows page: the Manager prompt, the work types, the events and the decisions.
test('the Manager page edits the prompt, work types and events, lists decisions and opens from old workflow addresses', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({engine:new TaskEngine(store,{call:async()=>null})})), errors = [];
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
    await expect(page.locator('.project-nav').getByRole('link', { name: '角色', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.project-nav').getByRole('link', { name: '工作流', exact: true })).toHaveCount(0);
    await page.locator('.role-nav').getByRole('link',{name:'Manager',exact:true}).click();
    const prompt=page.getByLabel('Manager 提示词',{exact:true});
    await expect(prompt).toHaveValue(/Every event/);
    await expect(page.getByText(/^章节与内置文本/)).toHaveCount(0);
    await expect(page.getByText('工作类型：开关、写入与设置',{exact:true})).toHaveCount(0);
    const plain='按项目目标安排任务。\n\n## 普通标题 `custom.heading`\n遇到重复请求时续接。';
    await prompt.fill(plain);
    await page.locator('.role-nav').getByRole('link',{name:'Dev',exact:true}).click();
    await page.locator('.role-nav').getByRole('link',{name:'Manager',exact:true}).click();
    await expect(prompt).toHaveValue(plain);
    await page.getByRole('button',{name:'保存 Manager 提示词',exact:true}).click();
    await expect(prompt).toHaveValue(plain);await page.reload();await expect(prompt).toHaveValue(plain);
    expect((await admin('/api/repositories/101/manager')).value.manager.prompt.content).toBe(plain);

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
    await page.goto(h.admin + '/#/projects/101/roles/manager');
    await expect(page.getByLabel('Manager 提示词', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: '.tmp/manager-207/manager-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { configureDispatch(ruleDecider); await h.stop(); }
});
