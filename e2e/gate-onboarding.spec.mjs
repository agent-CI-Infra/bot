import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { parse } from 'yaml';
import { gateFixture, answer, writes, branchOf } from '../test/gate-onboarding-fixtures.mjs';

async function login(page, f) {
  await page.goto(f.h.admin);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
}

test('接入门禁先介绍五层，再和 agent 按仓库事实定方案，确认后才开 PR；有 merge queue 时不提交合并后的门禁', async ({ page }) => {
  mkdirSync('.tmp', { recursive: true });
  const cleanup = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const f = await gateFixture({ after: fn => cleanup.push(fn) }, { model: async input => input.conversation.length <= 1
    ? answer('仓库是 Python 项目，Makefile 里有 build、lint、test。建议 build 跑 make build，pr-ready 跑 make lint 和 make test。默认分支启用了 merge queue，所以 pr-merge 留空。Python 依赖在 CI 里怎么安装？',
      { toolchains: { python: '3.12' }, lanes: { build: ['make build'], 'pr-ready': ['make lint', 'make test'] } })
    : answer('已按你的说法加入安装命令。', { toolchains: { python: '3.12' }, install: ['pip install -e ".[test]"'], lanes: { build: ['make build'], 'pr-ready': ['make lint', 'make test'] } }) });
  try {
    f.state.repos['octo/hello'].queue = 'ruleset';
    await login(page, f);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#rows [data-repository-id="101"]').getByRole('button', { name: '接入门禁', exact: true }).click();
    const dialog = page.locator('#quickstart-view');
    await expect(dialog.getByRole('heading', { name: '接入门禁 · octo/hello', exact: true })).toBeVisible();
    // The five lanes come first, fully visible, before any conversation, branch or PR exists.
    for (const lane of ['build', 'pr-ready', 'pr-merge', 'daily', 'release']) await expect(dialog.locator('#gate-onboarding-lanes dt', { hasText: new RegExp(`^${lane}$`) })).toBeVisible();
    await expect(dialog.locator('#gate-onboarding-lanes').getByText('PR 进入 merge queue 后，对排队中的合并结果跑；仓库没有 merge queue 时不会触发。')).toBeVisible();
    await expect(dialog.getByText(/你确认之前，不会创建分支或 PR/)).toBeVisible();
    // Nothing in the introduction is cut off: no element is wider than its box and none uses an ellipsis.
    const clipped = await dialog.locator('#gate-onboarding-intro').evaluate(node => [node, ...node.querySelectorAll('*')]
      .filter(item => item.scrollWidth > item.clientWidth + 1 || getComputedStyle(item).textOverflow === 'ellipsis').map(item => item.tagName));
    expect(clipped).toEqual([]);
    expect(f.h.store.get('SELECT count(*) n FROM gate_onboarding_sessions').n).toBe(0);
    expect(writes(f.state)).toEqual([]);
    await page.screenshot({ path: '.tmp/gate-onboarding-intro-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog.getByRole('button', { name: '开始适配', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/gate-onboarding-intro-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    await dialog.getByRole('button', { name: '开始适配', exact: true }).click();
    await expect(dialog.locator('.gate-message-agent').first()).toContainText('Makefile 里有 build、lint、test');
    await expect(dialog.locator('.gate-message-system').first()).toContainText('merge queue：已启用');
    await expect(dialog.locator('#gate-onboarding-queue')).toContainText('只提交进入队列之前的门禁');
    const lane = name => dialog.locator(`textarea[name="lane_${name}"]`);
    await expect(lane('build')).toHaveValue('make build');
    await expect(lane('pr-ready')).toHaveValue('make lint\nmake test');
    await expect(lane('pr-merge')).toBeDisabled();
    await dialog.getByLabel('发给 agent').fill('依赖用 pip install -e ".[test]"');
    await dialog.getByRole('button', { name: '发送', exact: true }).click();
    await expect(dialog.locator('.gate-message-agent').nth(1)).toContainText('已按你的说法加入安装命令');
    await expect(dialog.locator('textarea[name=install]')).toHaveValue('pip install -e ".[test]"');
    await expect(dialog.locator('#gate-onboarding-plan-title')).toHaveText('门禁方案 · 第 2 版');
    // Still nothing in the repository: no branch, no file, no PR.
    expect(writes(f.state)).toEqual([]);
    await dialog.locator('#gate-onboarding-preview summary').click();
    await expect(dialog.locator('#gate-onboarding-files')).toContainText('触发事件 pull_request、workflow_dispatch');
    await page.screenshot({ path: '.tmp/gate-onboarding-chat-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/gate-onboarding-chat-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    await dialog.getByRole('button', { name: '确认并创建门禁 PR', exact: true }).click();
    await expect(dialog.getByRole('link', { name: '打开门禁 PR', exact: true })).toHaveAttribute('href', 'https://github.com/octo/hello/pull/1');
    const { files } = branchOf(f.state), workflow = parse(files['.github/workflows/ci.yml']);
    expect(Object.keys(workflow.on)).toEqual(['pull_request', 'workflow_dispatch']);
    expect(JSON.parse(files['.github/ci-gates.json']).lanes['pr-merge']).toEqual({ commands: [] });
    await expect(dialog.getByRole('button', { name: '确认并创建门禁 PR', exact: true })).toBeHidden();
    await page.screenshot({ path: '.tmp/gate-onboarding-done-desktop.png' });
    expect(errors).toEqual([]);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});

test('没有模型的仓库也能看到按事实整理的方案，回答 merge queue 后直接确认', async ({ page }) => {
  const cleanup = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const f = await gateFixture({ after: fn => cleanup.push(fn) });
  try {
    f.state.repos['octo/hello'].queue = 'hidden';
    await login(page, f);
    await page.locator('#rows [data-repository-id="101"]').getByRole('button', { name: '接入门禁', exact: true }).click();
    const dialog = page.locator('#quickstart-view');
    await dialog.getByRole('button', { name: '开始适配', exact: true }).click();
    await expect(dialog.locator('.gate-message-system').nth(1)).toContainText('还没有启动，没有可用的模型');
    await expect(dialog.locator('#gate-onboarding-compose')).toBeHidden();
    const confirm = dialog.getByRole('button', { name: '确认并创建门禁 PR', exact: true });
    await expect(confirm).toBeDisabled();
    await expect(dialog.locator('#gate-onboarding-note')).toContainText('回答 merge queue 问题后才能确认');
    await dialog.getByLabel('没有启用：保留完整的五层事件').check();
    await expect(dialog.locator('.gate-message-system').last()).toContainText('你确认默认分支没有启用 merge queue');
    await expect(dialog.locator('#gate-onboarding-files')).toContainText('触发事件 pull_request、merge_group、push、workflow_dispatch');
    await expect(confirm).toBeEnabled();
    await dialog.locator('textarea[name=install]').fill('pip install -e .');
    await confirm.click();
    await expect(dialog.getByRole('link', { name: '打开门禁 PR', exact: true })).toBeVisible();
    const { files } = branchOf(f.state);
    expect(Object.keys(parse(files['.github/workflows/ci.yml']).on)).toEqual(['pull_request', 'merge_group', 'push', 'workflow_dispatch']);
    expect(parse(files['.github/workflows/ci.yml']).jobs.gate.steps.find(step => step.name === 'Install dependencies').run).toBe('pip install -e .');
    expect(errors).toEqual([]);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});
