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
    // Actions failure handling is one of the workflows: its switch, trigger and status are in its editor.
    const list = page.getByRole('complementary', { name: '工作流列表', exact: true }), item = list.locator('[data-workflow-item="actions.failures"]');
    await expect(item).toContainText('已关闭');
    await item.click();
    const detail = page.getByRole('region', { name: '工作流：Actions 失败处理', exact: true }), toggle = detail.locator('[name="enabled"]');
    await expect(toggle).not.toBeChecked(); await toggle.check(); await detail.getByRole('button', { name: '保存', exact: true }).click();
    await expect(detail.locator('.flash')).toHaveText('已保存工作流');
    expect((await admin('/api/repositories/101')).value.policy.actions_failures_enabled).toBe(1);
    expect((await admin('/api/repositories/101')).value.policy.development_enabled).toBe(0);
    await expect(toggle).toBeChecked(); await expect(item).toContainText('运行中');
    const status = detail.locator('[data-actions-status]');
    await expect(status).toContainText('配置检查通过后');
    await detail.getByRole('tab', { name: '触发源', exact: true }).click();
    await expect(detail.getByLabel('默认分支的 Actions 运行失败', { exact: true })).toBeChecked();
    await detail.getByRole('tab', { name: '概览', exact: true }).click();
    h.store.run("UPDATE actions_failure_scans SET error='actions_workflow_run_subscription_missing'");
    await expect(status).toContainText('此仓库使用的 App 安装未订阅 workflow_run', { timeout: 10000 }); await expect(status).toContainText('本功能已停止写入');
    await page.screenshot({ path: '.tmp/actions-failures/desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await status.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/actions-failures/mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Saving the Actions switch leaves the review workflows alone.
    await toggle.uncheck(); await detail.getByRole('button', { name: '保存', exact: true }).click();
    await expect(detail.locator('.flash')).toHaveText('已保存工作流');
    expect((await admin('/api/repositories/101')).value.policy.actions_failures_enabled).toBe(0);
    await expect(toggle).not.toBeChecked();
    await expect(list.locator('[data-workflow-item="review.issue"]')).toContainText('项目的检视开关已关');
    await expect(page.getByText('此仓库使用的 App 安装未订阅 workflow_run', { exact: false })).not.toBeVisible();
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
