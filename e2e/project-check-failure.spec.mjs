import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #869: the gate/board check and the permission check both run in the background and keep the badges they read last when
// they fail. Used to swallow that failure: the reader saw an old badge with no way to tell it was old and no way to ask
// again. Now the list names the check that failed, says the badges are the previous reading, when it was taken, and
// offers exactly one manual read. Nothing is retried by itself (#43), so the count stays at the one failed request.
const checked = '2026-01-01T00:00:00.000Z';
const staleIntegration = (overrides = {}) => ({ repository_id: '101', gate_state: 'configured', gate_detail: '', dashboard_state: 'none',
  dashboard_detail: '', checked_at: checked, stale: true, ...overrides });
const retry = (line, name) => line.getByRole('button', { name, exact: true });

test('门禁检查读取失败时保留旧徽章、写明是上次结果并只提供一个重试入口', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    let checks = 0, failing = true;
    await page.route(/\/api\/integrations/, route => {
      if (new URL(route.request().url()).pathname === '/api/integrations/check') {
        checks++;
        return failing ? route.fulfill({ status: 500, json: { error: 'github_unavailable' } })
          : route.fulfill({ status: 200, json: { integrations: [staleIntegration({ gate_state: 'live', gate_detail: '最近一次 CI 通过', stale: false })] } });
      }
      return route.fulfill({ status: 200, json: { integrations: [staleIntegration()] } });
    });
    await page.goto(h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const rows = page.locator('#rows .row');
    await expect(rows).toHaveCount(1);
    const line = page.locator('#rows [data-check="integrations"]');
    await expect(line).toHaveCount(1);
    // The failure is stated in words, not in a colour: which check, that the badge is the previous reading, and when.
    await expect(line).toContainText('门禁与看板接入检查读取失败');
    await expect(line).toContainText('github_unavailable');
    await expect(line).toContainText('上次读到的结果');
    await expect(line).toContainText(/上次成功读取：2026-01-01 \d{2}:00:00/);
    // The badge itself is untouched: the check could not replace it.
    await expect(page.locator('#rows .row [data-integration]').first()).toHaveText('门禁已配置');
    // One failed read, and no second one behind the reader's back.
    expect(checks).toBe(1);
    await page.waitForTimeout(2000);
    expect(checks, 'a failed check schedules nothing by itself').toBe(1);
    await expect(retry(line, '重新检查门禁')).toBeVisible();
    // The statement is in frame at both supported widths; a long sentence must wrap, not push the page sideways.
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await line.scrollIntoViewIfNeeded();
      expect(await line.evaluate(node => { const box = node.getBoundingClientRect(); return node.scrollWidth <= node.clientWidth + 1 && box.left >= -1 && box.right <= innerWidth + 1; }), `the statement fits at ${width}`).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no sideways scroll at ${width}`).toBe(true);
    }
    // The one manual read goes through and takes the statement away with it.
    failing = false;
    await retry(line, '重新检查门禁').click();
    await expect(line).toHaveCount(0);
    await expect(page.locator('#rows .row [data-integration]').first()).toHaveText('门禁已生效');
    expect(checks, 'the retry is the next request').toBe(2);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('权限检查读取失败时保留权限徽章、写明是上次结果并只提供一个重试入口', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    let checks = 0, failing = true;
    await page.route(/\/api\/installations/, async route => {
      if (new URL(route.request().url()).pathname === '/api/installations/permissions/check') {
        checks++;
        return failing ? route.fulfill({ status: 500, json: { error: 'github_unavailable' } })
          : route.fulfill({ status: 200, json: { repositories: [{ id: '101', access_gaps: [], permissions_stale: false, permissions_checked_at: checked }] } });
      }
      // The list read is the real one; only the freshness of its permission reading is forced, which is what makes the
      // console ask for a check at all.
      const response = await route.fetch(), body = await response.json();
      body.repositories = (body.repositories || []).map(row => ({ ...row, access_gaps: [], permissions_stale: true, permissions_checked_at: checked }));
      return route.fulfill({ response, json: body });
    });
    await page.goto(h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const rows = page.locator('#rows .row');
    await expect(rows).toHaveCount(1);
    const line = page.locator('#rows [data-check="permissions"]');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText('安装权限检查读取失败');
    await expect(line).toContainText('上次读到的结果');
    await expect(line).toContainText(/上次成功读取：2026-01-01 \d{2}:00:00/);
    await expect(page.locator('#rows .row [data-permission]').first()).toHaveText('未检查');
    expect(checks).toBe(1);
    await page.waitForTimeout(2000);
    expect(checks, 'a failed check schedules nothing by itself').toBe(1);
    failing = false;
    await retry(line, '重新检查权限').click();
    await expect(line).toHaveCount(0);
    await expect(page.locator('#rows .row [data-permission]').first()).toHaveText('正常');
    expect(checks, 'the retry is the next request').toBe(2);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// The first render reads the cache; an empty cache is checked inline before any row is drawn, and that read failed
// silently too. The statement has to survive that cold start, where no earlier reading exists at all.
test('缓存为空且首次门禁检查失败时，列表也说明读取失败', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    let checks = 0;
    await page.route(/\/api\/integrations/, route => {
      if (new URL(route.request().url()).pathname === '/api/integrations/check') {
        checks++;
        return route.fulfill({ status: 500, json: { error: 'github_unavailable' } });
      }
      return route.fulfill({ status: 200, json: { integrations: [] } });
    });
    await page.goto(h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#rows .row')).toHaveCount(1);
    const line = page.locator('#rows [data-check="integrations"]');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText('门禁与看板接入检查读取失败');
    // No reading exists yet, so the time is said to be unknown rather than invented.
    await expect(line).toContainText('上次成功读取的时间未知');
    await expect(page.locator('#rows .row [data-integration]').first()).toHaveText('发布检查未完成');
    await expect(retry(line, '重新检查门禁')).toBeVisible();
    expect(checks).toBe(1);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
