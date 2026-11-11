import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #231 slice 1: the machine overview states when its data was read, whether the manager answered at all, and the
// configured resource limits — so "stopped", "unreachable" and "unknown" cannot be read as each other.
const shot = process.env.SHOT || 'after';
const widths = [['mobile', 390, 844], ['tablet', 768, 1024], ['desktop', 1440, 900]];
const live = {
  repository_id: '101', full_name: 'fixture/project-101', generation: 1, state: 'ready', desired: 'ready', revision: 1,
  computer: { cpus: 2, memory_mb: 4096, pids: 1024, tmp_mb: 1024, network_policy: 'internet egress', image: 'sha256:0123456789abcdef',
    user: 'bot', root_filesystem: 'read-only', volume: 'bot-fixture-101-volume', workdir: '/workspace', container: 'bot-fixture-101',
    bounds: { cpus: [0.5, 8], memory_mb: [1024, 8192], pids: [128, 2048], tmp_mb: [128, 2048] }, defaults: { cpus: 2, memory_mb: 4096, pids: 1024, tmp_mb: 1024 } }
};
function managerStub() {
  const state = { reachable: true };
  return {
    state,
    async call(method, path, input) {
      if (!state.reachable) throw new Error('manager_unavailable');
      if (/\/v1\/projects\/[1-9]\d*$/.test(path)) {
        if (method === 'PUT') return { generation: 1, state: 'ready', desired: 'ready', revision: 1 };
        return live;
      }
      if (/\/stats$/.test(path)) return { running: false };
      return { generation: 1, state: 'ready' };
    }
  };
}
async function openMachine(page, h, password) {
  await page.goto(h.admin + '/#/projects/101/machine');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#machine-status')).toBeVisible();
}
async function shoot(page, name) {
  const directory = resolve('docs/verification/231');
  mkdirSync(directory, { recursive: true });
  for (const [label, width, height] of widths) {
    await page.setViewportSize({ width, height });
    // A longer facts row must not make the page scroll sideways at any of the three widths.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(directory, `${shot}-${name}-${label}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('机器总览写明数据时间、资源配置上限，并把管理服务不可达与已停止分开', async ({ page }) => {
  test.setTimeout(90000);
  const manager = managerStub(), h = await harness(undefined, manager), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    await h.projects.reconcile();
    await openMachine(page, h, password);
    // Captured before the assertions so the same script produces the base screenshots and the changed ones.
    await shoot(page, 'machine');
    await expect(page.locator('#machine-status')).toContainText('数据时间');
    await expect(page.locator('#machine-status')).toContainText('资源上限');
    await expect(page.locator('#machine-status')).toContainText('2 CPU · 4096 MB 内存 · 1024 进程 · /tmp 1024 MB');
    await expect(page.locator('#machine-status')).toContainText('就绪');

    // The manager cannot be reached: the same page must say so instead of repeating the last saved state as if it
    // were a live measurement, and it must not claim the computer is stopped.
    manager.state.reachable = false;
    await page.reload();
    const status = page.locator('#machine-status');
    await expect(status).toContainText('管理服务不可达');
    await expect(status).toContainText('数据时间');
    await expect(status).not.toContainText('已停止');
    await shoot(page, 'machine-unreachable');
    expect(errors).toEqual([]);
  } finally {
    await h.stop();
  }
});
