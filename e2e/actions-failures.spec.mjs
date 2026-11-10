import { TaskEngine } from '../dist/agent/engine.js';
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

test('项目默认关闭 Actions 失败处理，保存开关并清晰显示独立配置错误', async ({ page }) => {
  const h = await harness(undefined, undefined, store=>({engine:new TaskEngine(store,{call:async()=>null})})), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync('.tmp/actions-failures', { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    await page.goto(h.admin + '/#/projects/101/roles/manager');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // Failed Actions runs are an event source, configured alongside the other Manager event filters.
    const toggle=page.getByLabel('接收默认分支的 Actions 失败事件',{exact:true}), save=page.getByRole('button',{name:'保存事件开关',exact:true});
    await expect(toggle).not.toBeChecked();
    const status = page.locator('[data-actions-status]');
    await expect(status).toHaveText('未开启。');
    await toggle.check(); await save.click();
    await expect(page.getByText('已保存事件开关', { exact: true })).toBeVisible();
    expect((await admin('/api/repositories/101')).value.policy.actions_failures_enabled).toBe(1);
    expect((await admin('/api/repositories/101')).value.policy.development_enabled).toBe(0);
    await expect(toggle).toBeChecked();
    await expect(status).toContainText('配置检查通过后');
    h.store.run("UPDATE actions_failure_scans SET error='actions_workflow_run_subscription_missing'");
    await expect(status).toContainText('此仓库使用的 App 安装未订阅 Webhook 事件「Workflow run」', { timeout: 10000 }); await expect(status).toContainText('不读取运行、不重跑、不提报');
    // The subscription needs only Actions read; the message must not send people after the Workflows permission.
    await expect(status).toContainText('不是 Workflows 权限'); await expect(status).toContainText('Actions「Read-only」');
    h.store.run("UPDATE actions_failure_scans SET error='actions_permission_missing'");
    await expect(status).toContainText('此仓库使用的 App 安装没有 Actions 权限', { timeout: 10000 }); await expect(status).toContainText('不需要 Workflows 权限');
    await status.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.tmp/actions-failures/desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await status.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/actions-failures/mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Saving the Actions switch leaves the review work types alone.
    await toggle.uncheck(); await save.click();
    await expect(page.getByText('已保存事件开关', { exact: true })).toBeVisible();
    expect((await admin('/api/repositories/101')).value.policy.actions_failures_enabled).toBe(0);
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText('此仓库使用的 App 安装没有 Actions 权限', { exact: false })).not.toBeVisible();
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
