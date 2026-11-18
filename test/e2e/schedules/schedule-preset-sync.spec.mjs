import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';
import { test, expect } from '@playwright/test';
import { openScheduleTimeRules } from '../helpers/open-schedule-folds.mjs';
import { channelFixture, privateChat, registerDestination } from '../../fixtures/channel-fixture.mjs';

async function environment() {
  let now = Date.now(), worker;
  const f = await channelFixture(undefined, { schedules: { automatic: false, clock: () => now }, onSchedules: s => { worker = s; } });
  now = Date.now(); f.worker = worker; f.advance = ms => { now += ms; };
  f.destination = await registerDestination(f.admin, await privateChat(f));
  await f.service.tick(); return f;
}
async function login(page, f) {
  await page.goto(f.h.admin + '/#/management');
  await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await switchConsoleProject(page, '101');
  await page.getByRole('button', { name: '快捷操作', exact: true }).click();
  await expect(page.getByRole('button', { name: '预览触发时间', exact: true })).toBeVisible();
}

test('#744: a hand-edited Cron or a 重复方式 switch keeps 常用触发时间 and the advanced fold in step', async ({ page }) => {
  test.setTimeout(90000);
  const f = await environment();
  try {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await login(page, f);
    const preset = page.getByLabel('常用触发时间', { exact: true });
    const fold = page.getByTestId('schedule-time-rules');
    const cron = page.getByLabel('Cron 表达式', { exact: true });
    const recurrence = page.getByLabel('重复方式', { exact: true });
    await expect(preset).toHaveValue('0 9 * * *');
    await expect(fold).not.toHaveAttribute('open', '');

    await openScheduleTimeRules(page);
    // A Cron the presets do not know must stop claiming a preset.
    await cron.fill('30 10 * * *');
    await expect(preset).toHaveValue('custom');
    await expect(fold).toHaveAttribute('open', '');

    // A hand-typed Cron that does match a preset must show that preset.
    await cron.fill('0 18 * * *');
    await expect(preset).toHaveValue('0 18 * * *');

    // Leaving Cron and coming back recomputes from the Cron still in the form.
    await recurrence.selectOption('interval');
    await expect(preset).toHaveValue('custom');
    await recurrence.selectOption('cron');
    await expect(preset).toHaveValue('0 18 * * *');

    // Picking a preset collapses the advanced fold, and an edit that no longer
    // matches re-expands it: the fold never disagrees with the summary.
    await preset.selectOption('0 9 * * *');
    await expect(cron).toHaveValue('0 9 * * *');
    await expect(fold).not.toHaveAttribute('open', '');
    await openScheduleTimeRules(page);
    await cron.fill('15 6 * * *');
    await expect(preset).toHaveValue('custom');
    await expect(fold).toHaveAttribute('open', '');

    // The payload is unchanged: what the operator sees saved is the Cron shown.
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1);
    const plan = (await f.admin('/api/management/query', 'POST', { operation: 'list_schedules', target: { project_id: '101' }, arguments: {} })).value.schedules[0];
    expect(plan.spec.cron).toBe('15 6 * * *');
    expect(plan.spec.interval_ms).toBeUndefined();

    // Loading the saved plan keeps the summary and the fold consistent: custom
    // Cron opens the advanced rules and shows 自定义.
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id);
    await expect(preset).toHaveValue('custom');
    await expect(fold).toHaveAttribute('open', '');
    await expect(cron).toHaveValue('15 6 * * *');
  } finally { await f.close(); }
});
