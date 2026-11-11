import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { fail } from '../dist/core/security.js';
import { harness, setup, account, repository } from '../test/helpers.mjs';

async function fixture() {
  const state = { liveState: 'provisioning', offline: false };
  const manager = { async call(_method, path) {
    const id = path.split('/')[3];
    if (path.endsWith('/stats')) { if (state.offline) fail(503, 'manager_unavailable'); return { running: false, cpu_percent: 0, memory_bytes: 1048576, memory_limit_bytes: 2147483648, pids: 3, sampled_at: new Date().toISOString() }; }
    if (state.offline) throw new Error('manager_unavailable');
    return { repository_id: id, generation: 1, state: state.liveState, desired: 'ready', revision: 1,
      computer: { cpus: 2, memory_mb: 2048, pids: 512, tmp_mb: 512, defaults: { cpus: 2, memory_mb: 2048, pids: 512, tmp_mb: 512 }, inherited: ['cpus', 'memory_mb', 'pids', 'tmp_mb'],
        packages: [], env: {}, setup_script: '', network_policy: 'internal, no egress', image: 'approved/project-computer@sha256:' + 'a'.repeat(64),
        build: { state: 'ready', output: '' }, setup: { state: 'succeeded', exit_code: 0, output: '', generation: 1 } } };
  } };
  const h = await harness(undefined, manager), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  return { h, password, state, close: async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); } };
}

async function login(page, f) {
  await page.goto(f.h.admin + '/#/projects/101/machine');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#machine-status')).toContainText('运行任务记录');
}

// #231: 创建中 / 重置中 / 重置失败 are transitional states, and the page must name them. A transitional computer that
// silently reads 「就绪」 is the worst case: it tells the admin the machine is usable while it is being created or reset,
// and it hides a failed reset behind the same badge as a healthy machine.
test('creating, resetting and a failed reset are named, never folded into 就绪', async ({ page }) => {
  const f = await fixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await login(page, f);
    await page.setViewportSize({ width: 1440, height: 900 });
    const badge = page.locator('[data-project-environment-state]');
    const seen = [];
    for (const [live, label] of [['provisioning', '创建中'], ['resetting', '重置中'], ['reset_failed', '重置失败']]) {
      f.state.liveState = live;
      await page.getByRole('button', { name: '刷新电脑状态', exact: true }).click();
      await expect(badge).toHaveText(label);
      // A transitional or failed state is never presented as ready.
      await expect(badge).not.toHaveText('就绪');
      seen.push(label);
    }
    expect(seen).toEqual(['创建中', '重置中', '重置失败']);

    // Mobile: the badge stays readable and the page never scrolls sideways; every section is still reachable.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(badge).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    for (const name of ['实时资源', '机器', '运行与排队记录']) {
      await expect(page.locator('#machine-status .side-card').filter({ has: page.getByRole('heading', { name, exact: true }) })).toBeVisible();
    }

    // A manager outage is still unknown rather than the last transitional word: the fallback text is its own state.
    f.state.offline = true;
    await page.getByRole('button', { name: '刷新电脑状态', exact: true }).click();
    await expect(badge).toHaveText('电脑待核验');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
