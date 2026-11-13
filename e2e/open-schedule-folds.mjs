import { expect } from '@playwright/test';

async function openFold(page, testid) {
  const fold = page.getByTestId(testid);
  await expect(fold).toHaveCount(1);
  await fold.evaluate(el => { el.open = true; });
}

export async function openScheduleTimeRules(page) {
  await openFold(page, 'schedule-time-rules');
  await expect(page.getByLabel('Cron 表达式', { exact: true })).toBeVisible();
  await expect(page.getByLabel('计划时区', { exact: true })).toBeVisible();
}

export async function openScheduleIdentity(page) {
  await openFold(page, 'schedule-identity-fold');
  await expect(page.getByLabel('执行身份类型', { exact: true })).toBeVisible();
}

export async function openScheduleAdvanced(page) {
  await openScheduleIdentity(page);
  await openScheduleTimeRules(page);
}

export async function openSubscriptionAdvanced(page) {
  await openFold(page, 'subscription-advanced');
  await expect(page.getByLabel('订阅时区', { exact: true })).toBeVisible();
}
