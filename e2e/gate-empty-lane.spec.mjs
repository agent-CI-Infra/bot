import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { gateFixture, writes } from '../test/gate-onboarding-fixtures.mjs';

const laneOf = (page, list, name) => list.locator('li', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });

// Plays the project computer once the console has queued a turn: the turn's task runs and the console picks up its result.
async function runTurn(f) {
  await expect.poll(() => f.h.store.get("SELECT count(*) n FROM tasks WHERE kind='gate.onboarding' AND status='queued'").n).toBe(1);
  await f.turn();
}

async function login(page, f) {
  await page.goto(f.h.admin);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
}

// #233: a lane with no configured check is a gap in the gate, not a passing check. The plan preview has to say so in words,
// because a row that only printed "0 条检查命令" or a tick next to an empty lane would tell a reviewer the gate is green.
test('an empty lane is shown as not configured, never as a check that passed', async ({ page }) => {
  const dir = '.tmp/gate-empty-lane';
  mkdirSync(dir, { recursive: true });
  const cleanup = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const f = await gateFixture({ after: fn => cleanup.push(fn) }, { agent: ({ conversation, plan }) => conversation.length <= 1
    ? { reply: '仓库是 Python 项目，Makefile 里有 build、lint、test，三条都试跑通过。建议 pr-ready 跑这三条；pr-merge、daily、release 目前没有可跑的命令。',
      plan: { ...plan, lanes: { ...plan.lanes, 'pr-ready': ['make build', 'make lint', 'make test'] } } }
    : { reply: '方案不变。', plan } });
  try {
    await login(page, f);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#rows [data-repository-id="101"]').getByRole('button', { name: '接入门禁', exact: true }).click();
    const dialog = page.locator('#quickstart-view');
    await expect(dialog.getByRole('heading', { name: '接入门禁 · octo/hello', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '开始适配', exact: true }).click();
    await runTurn(f);

    const evidence = dialog.locator('#gate-onboarding-evidence');
    // The pane's own disclaimer: the listed commands are the plan, not a CI or trial-run result.
    await expect(evidence).toContainText('不代表 CI 或试跑通过');
    const list = evidence.locator('ul.gate-validation-lanes');
    await expect(list.locator('li')).toHaveCount(4);

    // A lane with commands says how many it will run and that the trial-run conclusion is not structured.
    await expect(laneOf(page, list, 'pr-ready')).toContainText('3 条检查命令 · 试跑结论未结构化提供');
    // A lane without commands is named as 未配置 · 不适用, and it must not be worded as a check list at all.
    for (const lane of ['pr-merge', 'daily', 'release']) {
      await expect(laneOf(page, list, lane)).toContainText('未配置 · 不适用，不表示检查通过');
      await expect(laneOf(page, list, lane)).not.toContainText('条检查命令');
    }
    // Nothing has been written to the repository: this is still a plan.
    expect(writes(f.state)).toEqual([]);
    await page.screenshot({ path: `${dir}/empty-lane-1440.png`, fullPage: true });

    // 390: the same four rows stay readable, nothing is clipped or scrolled sideways. On a phone the panes are paginated,
    // so the 验证 step has to be reached through its tab — the same rows, in the same order.
    await page.setViewportSize({ width: 390, height: 844 });
    const verifyTab = dialog.getByRole('tab', { name: '验证', exact: true });
    await expect(verifyTab).toBeVisible();
    await verifyTab.click();
    const horizontal = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(horizontal).toBe(0);
    const clipped = await list.evaluate(node => [node, ...node.querySelectorAll('*')]
      .filter(item => item.scrollWidth > item.clientWidth + 1 || getComputedStyle(item).textOverflow === 'ellipsis').length);
    expect(clipped).toBe(0);
    await expect(laneOf(page, list, 'release')).toContainText('未配置 · 不适用，不表示检查通过');
    await page.screenshot({ path: `${dir}/empty-lane-390.png`, fullPage: true });
  } finally {
    for (const fn of cleanup) await fn();
    expect(errors).toEqual([]);
  }
});
