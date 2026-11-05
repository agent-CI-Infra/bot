import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

test('项目默认关闭 Actions 失败处理，保存开关并清晰显示独立配置错误', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync('.tmp/actions-failures', { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    await page.goto(h.admin + '/#/projects/101/workflows');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const table = page.getByRole('table', { name: '工作流', exact: true });
    await expect(table.locator('tr[data-workflow]')).toHaveCount(6);
    await expect(page.locator('#project-page .workflow-editor')).toHaveCount(0);
    // Actions failure handling is a control-plane module next to the workflows, not a prompt.
    const card = page.locator('[data-overview-anchor="actions-failures"]');
    const toggle = card.locator('[name="actions_failures_enabled"]'), form = toggle.locator('xpath=ancestor::form');
    await expect(toggle).not.toBeChecked(); await toggle.check(); await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await admin('/api/repositories/101')).value.policy.actions_failures_enabled).toBe(1);
    expect((await admin('/api/repositories/101')).value.policy.development_enabled).toBe(0);
    await expect(page.locator('#project-page .project-content > .flash')).toHaveText('已保存'); await expect(toggle).toBeChecked();
    const reviewRow = table.locator('tr[data-workflow="review.issue"]');
    await reviewRow.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = () => page.getByRole('region', { name: '编辑工作流：检视 Issue', exact: true });
    await editor().getByLabel('启用这条工作流', { exact: true }).check(); await editor().getByRole('button', { name: '保存', exact: true }).click();
    await expect(editor().locator(':scope > .flash')).toHaveText('已保存工作流');
    expect((await admin('/api/repositories/101')).value.policy.review_enabled).toBe(1);
    await expect(toggle).toBeChecked(); await expect(table.locator('tr[data-workflow]')).toHaveCount(6);
    await expect(form).toContainText('配置检查通过后');
    h.store.run("UPDATE actions_failure_scans SET error='actions_workflow_run_subscription_missing'");
    await expect(form).toContainText('此仓库使用的 App 安装未订阅 workflow_run', { timeout: 10000 }); await expect(form).toContainText('本功能已停止写入');
    await form.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.tmp/actions-failures/desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await form.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/actions-failures/mobile.png' });
    await toggle.uncheck(); await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await admin('/api/repositories/101')).value.policy.actions_failures_enabled).toBe(0);
    await expect(toggle).not.toBeChecked(); await expect(reviewRow).toContainText('已开启');
    await expect(page.getByText('此仓库使用的 App 安装未订阅 workflow_run', { exact: false })).not.toBeVisible();
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
