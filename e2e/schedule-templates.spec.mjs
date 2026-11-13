import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { channelFixture, privateChat, registerDestination } from '../test/channel-fixture.mjs';
import { openScheduleTimeRules, openScheduleIdentity, openSubscriptionAdvanced } from './open-schedule-folds.mjs';

async function environment() {
  let now = Date.now();
  const f = await channelFixture(undefined, { schedules: { automatic: false, clock: () => now } });
  f.destination = await registerDestination(f.admin, await privateChat(f));
  await f.service.tick();
  return f;
}

async function login(page, f) {
  await page.goto(f.h.admin + '/#/projects/101/schedules');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByTestId('schedule-templates')).toBeVisible();
}

const out = '.tmp/schedule-templates-572';

test('#572 可用模板创建每日摘要和失败时通知，高级字段默认折叠', async ({ page }) => {
  test.setTimeout(90000);
  const f = await environment();
  mkdirSync(out, { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await login(page, f);
    await expect(page.getByRole('button', { name: '使用每日摘要模板', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '使用失败时通知模板', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存计划', exact: true })).toBeVisible();
    await expect(page.getByLabel('Cron 表达式', { exact: true })).toBeHidden();
    await expect(page.getByLabel('计划时区', { exact: true })).toBeHidden();
    await expect(page.getByLabel('执行身份类型', { exact: true })).toBeHidden();
    await expect(page.getByLabel('有效期开始', { exact: true })).toBeHidden();
    await expect(page.getByLabel('聚合窗口分钟', { exact: true })).toBeHidden();
    await expect(page.getByLabel('订阅时区', { exact: true })).toBeHidden();
    await expect(page.getByLabel('静默开始', { exact: true })).toBeHidden();
    await page.screenshot({ path: `${out}/schedules-1440.png`, fullPage: true });

    await page.getByRole('button', { name: '使用每日摘要模板', exact: true }).click();
    await expect(page.getByLabel('计划名称', { exact: true })).toHaveValue('每日摘要');
    await expect(page.getByRole('combobox', { name: '执行内容', exact: true })).toHaveValue('report.daily');
    await expect(page.getByLabel('常用触发时间', { exact: true })).toHaveValue('0 9 * * *');
    await page.getByLabel('常用触发时间', { exact: true }).selectOption('0 18 * * *');
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1);
    const plan = f.h.store.get('SELECT id, state, spec FROM schedules');
    const spec = typeof plan.spec === 'string' ? JSON.parse(plan.spec) : plan.spec;
    expect(spec.name).toBe('每日摘要');
    expect(spec.workflow).toBe('report.daily');
    expect(spec.cron).toBe('0 18 * * *');

    await page.getByRole('button', { name: '使用失败时通知模板', exact: true }).click();
    await expect(page.getByLabel('订阅名称', { exact: true })).toHaveValue('失败时通知');
    await expect(page.getByRole('checkbox', { name: '任务失败', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'CI 失败', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'CI 恢复', exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: '保存事件订阅', exact: true }).click();
    await expect(page.getByText('事件订阅已保存', { exact: true })).toBeVisible();
    const sub = f.h.store.get('SELECT spec FROM notification_subscriptions');
    const subSpec = typeof sub.spec === 'string' ? JSON.parse(sub.spec) : sub.spec;
    expect(subSpec.name).toBe('失败时通知');
    expect(subSpec.events).toEqual(expect.arrayContaining(['task.failed', 'ci.failed']));
    expect(subSpec.events).not.toContain('ci.recovered');

    await openScheduleTimeRules(page);
    await openScheduleIdentity(page);
    await openSubscriptionAdvanced(page);
    await expect(page.getByLabel('Cron 表达式', { exact: true })).toBeVisible();
    await expect(page.getByLabel('执行身份类型', { exact: true })).toBeVisible();
    await expect(page.getByLabel('订阅时区', { exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/schedules-advanced-1440.png`, fullPage: true });

    await page.getByTestId('schedule-time-rules').evaluate(el => { el.open = false; });
    await page.getByTestId('schedule-identity-fold').evaluate(el => { el.open = false; });
    await page.getByTestId('subscription-advanced').evaluate(el => { el.open = false; });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByTestId('schedule-templates')).toBeVisible();
    await expect(page.getByRole('button', { name: '使用每日摘要模板', exact: true })).toBeVisible();
    await expect(page.getByLabel('Cron 表达式', { exact: true })).toBeHidden();
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${out}/schedules-390.png`, fullPage: true });
  } finally { await f.close(); }
});
