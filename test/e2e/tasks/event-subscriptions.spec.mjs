import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { authorizeKnowledgeTask } from '../../fixtures/knowledge-fixture.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { TaskCommands } from '../../../dist/tasks/commands.js';
import { executeTaskSubscriptionTool } from '../../../dist/tasks/event-subscriptions.js';


const login = async (page, url, password) => {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
};

test('task detail displays waiting event subscription state, hints, note, timeout_at and allows cancelling (#1168)', async ({ page }) => {
  const h = await harness(undefined);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');
    h.store.run("UPDATE policies SET capability_ceiling='comment' WHERE repository_id='101'");

    const operator = { id: 'administrator', role: 'super_admin', repositories: [] };
    const commands = new TaskCommands(h.store);
    const { id } = commands.api(operator, 'POST', new URL('http://local/api/tasks'), {
      repository_id: '101',
      request: '触发 nightly.yml 工作流并等待运行完成后汇总产物报告',
      contract: {
        goal: '触发 nightly.yml 工作流并等待运行完成后汇总产物报告',
        scope: ['.github/workflows/nightly.yml'],
        criteria: ['工作流完成后读取产物并给出报告'],
        endpoint: 'report',
      },
    });
    authorizeKnowledgeTask(h.store, id);

    const task = h.store.get('SELECT * FROM tasks WHERE id=?', id);
    const subRes = executeTaskSubscriptionTool(h.store, task, 'subscribe_event', {
      events: ['workflow_run', 'check_suite'],
      run_id: 94021,
      workflow: 'nightly.yml',
      head_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      branch: 'main',
      note: '等待 nightly.yml 构建与制品归档完成后继续读取报告',
      timeout_seconds: 1800,
      release_slot: false,
    });
    h.store.run(
      "UPDATE tasks SET status='waiting_event', phase='model', error_code='event_subscription_pending' WHERE id=?",
      id,
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h.admin + '/#/projects/101/overview/all', password);
    await page.locator(`[data-task-id="${id}"] a, [data-task-id="${id}"] button`).first().click();

    await expect(page.locator('#task-badges')).toContainText('等待事件');
    const topBarSub = page.getByTestId('task-subscriptions-bar');
    await expect(topBarSub).toBeVisible();
    await expect(topBarSub).toContainText('等待触发');
    await expect(topBarSub).toContainText('workflow_run/check_suite');
    await expect(topBarSub).toContainText('run_id=94021');
    await expect(topBarSub).toContainText('超时唤醒');

    // Expand folded detail archive to verify the full 事件订阅 card as well
    await page.locator('details.task-archive-fold > summary').click();
    const card = page.getByTestId('task-subscriptions-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('当前有 1 条待触发订阅');
    await expect(card).toContainText('workflow_run / check_suite');
    await expect(card).toContainText('run_id=94021');
    await expect(card).toContainText('workflow=nightly.yml');
    await expect(card).toContainText('等待 nightly.yml 构建与制品归档完成后继续读取报告');

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await topBarSub.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await card.scrollIntoViewIfNeeded();
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (shots) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await card.scrollIntoViewIfNeeded();
      }
    }

    // Verify cancel control is horizontal (not single-character vertically collapsed) and unoccluded on short mobile viewport (390x640)
    const cancelBtn = page.getByTestId('cancel-subscription-' + subRes.subscription.id);
    await page.setViewportSize({ width: 390, height: 640 });
    await cancelBtn.scrollIntoViewIfNeeded();
    const geom = await cancelBtn.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { width: rect.width, height: rect.height, unoccluded: !!hit && (hit === el || el.contains(hit)) };
    });
    expect(geom.width).toBeGreaterThan(geom.height);
    expect(geom.unoccluded).toBe(true);

    // Cancel active subscription from the UI card and verify status updates
    await page.setViewportSize({ width: 1440, height: 900 });
    await cancelBtn.click();
    await expect(card).toContainText('已取消');
    await expect(card).toContainText('人工取消订阅');
    await expect(page.locator('#task-badges')).toContainText('待执行');
    expect(errors).toEqual([]);
  } finally {
    await h.stop();
    rmSync(h.directory, { recursive: true, force: true });
  }
});
