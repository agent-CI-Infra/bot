import { test, expect } from '@playwright/test';
import { harness, setup } from '../test/helpers.mjs';

// #879: the three save forms on the settings page used one live region for both outcomes — 存储清理 and 外部执行兑换地址
// kept role=status (polite) even when the save failed, and 同时运行的任务 kept role=alert even for a success. A reader that
// depends on the role either missed the failure or heard a success announced assertively. The rule this pins: a failure is
// role=alert, a success is role=status, and the region carries the new role when the new sentence arrives.
//
// The failure text is asserted against what `readErrorText()` produces, not against the browser's own message: the
// dropped-connection case must read 网络连接失败，请稍后重试 instead of "Failed to fetch". If a form ever goes back to
// writing `err.message` straight into the region, the first assertion fails on the English text.
const regionOf = form => form.locator(':scope > p').last();
const reading = async form => ({ role: await regionOf(form).getAttribute('role'), text: (await regionOf(form).textContent()).trim() });

test('#879 设置页三张保存表单：失败用 alert 播报，成功回到 status', async ({ page }) => {
  test.setTimeout(180000);
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Each write is routed to a switch instead of a mock: the same page then saves for real once the switch is off, so the
  // success reading comes from the real handler rather than from a second stub.
  const faults = { retention: true, external: true, concurrency: true };
  await page.route(url => url.pathname === '/api/storage/retention', route => route.request().method() === 'PUT'
    ? (faults.retention ? route.abort('failed') : route.continue()) : route.continue());
  await page.route(url => url.pathname === '/api/external/settings', route => route.request().method() === 'PUT'
    ? (faults.external ? route.fulfill({ status: 500, json: { error: 'external_audience_rejected' } }) : route.continue()) : route.continue());
  await page.route(url => url.pathname === '/api/settings', route => route.request().method() === 'PATCH'
    ? (faults.concurrency ? route.fulfill({ status: 500, json: { error: 'settings_write_failed' } }) : route.continue()) : route.continue());
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/settings/storage');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('body.console-ready')).toHaveCount(1);

    // 1. 按天数清理 — the failure never reached the service, so the sentence is readErrorText's network wording.
    await page.goto(h.admin + '/#/settings/storage');
    await page.getByText('保留天数与项目设置', { exact: true }).click();
    const retention = page.locator('form').filter({ has: page.getByRole('button', { name: '保存清理设置', exact: true }) });
    await expect(retention).toBeVisible();
    await retention.getByRole('button', { name: '保存清理设置', exact: true }).click();
    await expect.poll(async () => (await reading(retention)).role).toBe('alert');
    expect((await reading(retention)).text).toBe('网络连接失败，请稍后重试');
    faults.retention = false;
    await retention.getByRole('button', { name: '保存清理设置', exact: true }).click();
    await expect.poll(async () => (await reading(retention)).role).toBe('status');
    expect((await reading(retention)).text).toBe('已保存，下一次每日清理按新设置执行。');

    // 2. 外部执行兑换地址 — a service failure keeps the service's own code, again through readErrorText.
    await page.goto(h.admin + '/#/settings/external');
    const external = page.locator('form').filter({ has: page.getByRole('button', { name: '保存兑换地址', exact: true }) });
    await expect(external).toBeVisible();
    await external.getByLabel('兑换地址').fill('https://receiver.invalid/external/token');
    await external.getByRole('button', { name: '保存兑换地址', exact: true }).click();
    await expect.poll(async () => (await reading(external)).role).toBe('alert');
    expect((await reading(external)).text).toBe('500 · external_audience_rejected');
    faults.external = false;
    await external.getByRole('button', { name: '保存兑换地址', exact: true }).click();
    await expect.poll(async () => (await reading(external)).role).toBe('status');
    expect((await reading(external)).text).toBe('兑换地址已保存。');

    // 3. 同时运行的任务 — this form was the reverse: alert for everything, including a success.
    await page.goto(h.admin + '/#/settings/work-computers');
    const concurrency = page.locator('form').filter({ has: page.getByLabel('每台电脑默认同时运行的任务数', { exact: true }) });
    const field = concurrency.getByLabel('每台电脑默认同时运行的任务数', { exact: true });
    await expect(concurrency).toBeVisible();
    const [min, max] = [Number(await field.getAttribute('min')), Number(await field.getAttribute('max'))];
    await field.fill(String(min - 1));
    await concurrency.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await reading(concurrency)).role).toBe('alert');
    expect((await reading(concurrency)).text).toBe(`需要 ${min}–${max} 之间的整数`);
    await field.fill(String(max));
    await concurrency.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await reading(concurrency)).role).toBe('alert');
    expect((await reading(concurrency)).text).toBe('500 · settings_write_failed');
    faults.concurrency = false;
    await concurrency.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await reading(concurrency)).role).toBe('status');
    expect((await reading(concurrency)).text).toBe('已保存，新任务按这个并发数排队');

    // Narrow screen: the roles are viewport-independent, but a region whose role changed must not start overflowing.
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(h.admin + '/#/settings/external');
    await expect(external).toBeVisible();
    expect((await reading(external)).role).toBe('status');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
