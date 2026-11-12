import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { parse } from 'yaml';
import { gateFixture, writes, branchOf } from '../test/gate-onboarding-fixtures.mjs';

const lanes = (values = {}) => ({ 'pr-ready': [], 'pr-merge': [], daily: [], release: [], ...values });
// Plays the project computer once the console has queued a turn: the turn's task runs and the console picks up its result.
async function runTurn(f) {
  await expect.poll(() => f.h.store.get("SELECT count(*) n FROM tasks WHERE kind='gate.onboarding' AND status='queued'").n).toBe(1);
  await f.turn();
}

async function login(page, f) {
  await page.goto(f.h.admin + '/#/settings/projects');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全局设置', exact: true })).toBeVisible();
}

test('接入门禁先介绍各 lane，再和 agent 按仓库事实定方案，确认后才开 PR；有 merge queue 时合入门禁在队列里运行', async ({ page }) => {
  mkdirSync('.tmp', { recursive: true });
  const cleanup = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const f = await gateFixture({ after: fn => cleanup.push(fn) }, { agent: ({ conversation, plan }) => conversation.length <= 1
    ? { reply: '在项目电脑里看了仓库：Python 项目，Makefile 里有 build、lint、test，三条都试跑通过，共 40 秒。建议 pr-ready 跑 make build、make lint 和 make test；默认分支启用了 merge queue，队列里会先重跑 pr-ready 再跑 pr-merge。Python 依赖在 CI 里怎么安装？',
      plan: { ...plan, toolchains: { ...plan.toolchains, python: '3.12' }, lanes: lanes({ 'pr-ready': ['make build', 'make lint', 'make test'] }) } }
    : { reply: '已按你的说法加入安装命令。', plan: { ...plan, install: ['pip install -e ".[test]"'] } } });
  try {
    f.state.repos['octo/hello'].queue = 'ruleset';
    await login(page, f);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.global-project-row[data-repository-id="101"]').getByRole('button', { name: '接入门禁', exact: true }).click();
    const dialog = page.locator('#quickstart-view');
    await expect(dialog.getByRole('heading', { name: '接入门禁 · octo/hello', exact: true })).toBeVisible();
    // The four lanes come first, fully visible, before any conversation, branch or PR exists.
    for (const lane of ['pr-ready', 'pr-merge', 'daily', 'release']) await expect(dialog.locator('#gate-onboarding-lanes dt', { hasText: new RegExp(`^${lane}$`) })).toBeVisible();
    await expect(dialog.locator('#gate-onboarding-lanes').getByText(/^合入门禁，确保多个 PR 合在一起不会互相影响：有 merge queue 时在队列里对合并结果先跑 pr-ready 再跑这一层；没有 merge queue 时在合入默认分支后/)).toBeVisible();
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
    // Each turn is a task in the project computer: the dialog says where it is and links to its process.
    await expect(dialog.locator('.gate-message-pending')).toContainText('agent 排队等待项目电脑');
    await expect(dialog.locator('#gate-onboarding-turn').getByRole('button', { name: '查看执行过程', exact: true })).toBeVisible();
    await runTurn(f);
    await expect(dialog.locator('.gate-message-agent').first()).toContainText('Makefile 里有 build、lint、test');
    await expect(dialog.locator('#gate-onboarding-turn')).toBeHidden();
    await expect(dialog.locator('.gate-message-system').first()).toContainText('merge queue：已启用');
    await expect(dialog.locator('#gate-onboarding-queue')).toContainText('队列里先跑 pr-ready 再跑 pr-merge');
    const lane = name => dialog.locator(`textarea[name="lane_${name}"]`);
    await expect(lane('build')).toHaveCount(0);
    await expect(lane('pr-ready')).toHaveValue('make build\nmake lint\nmake test');
    await expect(lane('pr-merge')).toBeEditable();
    await dialog.getByLabel('发给 agent').fill('依赖用 pip install -e ".[test]"');
    await dialog.getByRole('button', { name: '发送', exact: true }).click();
    await runTurn(f);
    await expect(dialog.locator('.gate-message-agent').nth(1)).toContainText('已按你的说法加入安装命令');
    await expect(dialog.locator('textarea[name=install]')).toHaveValue('pip install -e ".[test]"');
    await expect(dialog.locator('#gate-onboarding-plan-title')).toHaveText('门禁方案 · 第 3 版');
    // Still nothing in the repository: no branch, no file, no PR.
    expect(writes(f.state)).toEqual([]);
    await expect(dialog.locator('#gate-onboarding-preview')).toHaveAttribute('open','');
    await expect(dialog.locator('#gate-onboarding-files')).toContainText('在 pull_request、merge_group、workflow_dispatch 上运行');
    await page.screenshot({ path: '.tmp/gate-onboarding-chat-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/gate-onboarding-chat-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    await dialog.getByRole('button', { name: '确认并创建门禁 PR', exact: true }).click();
    await expect(dialog.getByRole('link', { name: '打开门禁 PR', exact: true })).toHaveAttribute('href', 'https://github.com/octo/hello/pull/1');
    const { files } = branchOf(f.state), workflow = parse(files['.github/workflows/ci.yml']);
    expect(Object.keys(workflow.on)).toEqual(['pull_request', 'merge_group', 'workflow_dispatch']);
    expect(JSON.parse(files['.github/ci-gates.json']).lanes['pr-merge']).toEqual({ commands: [] });
    expect(JSON.parse(files['.github/ci-gates.json']).events.merge_group).toEqual(['pr-ready', 'pr-merge']);
    expect(workflow.jobs.gate.steps[0].with.ref).toBe('${{ github.event.pull_request.head.sha || github.sha }}');
    await expect(dialog.getByRole('button', { name: '确认并创建门禁 PR', exact: true })).toBeHidden();
    await page.screenshot({ path: '.tmp/gate-onboarding-done-desktop.png' });
    expect(errors).toEqual([]);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});

test('没有启动的项目只能看介绍；启动、虚拟电脑就绪后才能开始，回答 merge queue 后确认', async ({ page }) => {
  const cleanup = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const f = await gateFixture({ after: fn => cleanup.push(fn) }, { ready: false });
  try {
    f.state.repos['octo/hello'].queue = 'hidden';
    await login(page, f);
    await page.locator('.global-project-row[data-repository-id="101"]').getByRole('button', { name: '接入门禁', exact: true }).click();
    let dialog = page.locator('#quickstart-view');
    await expect(dialog.locator('#gate-onboarding-lanes dt', { hasText: /^pr-ready$/ })).toBeVisible();
    await expect(dialog.locator('#gate-onboarding-ready')).toContainText('项目还没有启动');
    await expect(dialog.getByRole('button', { name: '开始适配', exact: true })).toBeDisabled();
    expect(f.h.store.get('SELECT count(*) n FROM gate_onboarding_sessions').n).toBe(0);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await f.startProject();
    await page.reload();
    await page.locator('.global-project-row[data-repository-id="101"]').getByRole('button', { name: '接入门禁', exact: true }).click();
    dialog = page.locator('#quickstart-view');
    await dialog.getByRole('button', { name: '开始适配', exact: true }).click();
    await runTurn(f);
    await expect(dialog.locator('.gate-message-agent')).toContainText('方案见右侧');
    const confirm = dialog.getByRole('button', { name: '确认并创建门禁 PR', exact: true });
    await expect(confirm).toBeDisabled();
    await expect(dialog.locator('#gate-onboarding-note')).toContainText('回答 merge queue 问题后才能确认');
    await dialog.getByLabel('没有启用：合入门禁在合入默认分支后运行').check();
    await expect(dialog.locator('.gate-message-system').last()).toContainText('你确认默认分支没有启用 merge queue');
    await expect(dialog.locator('#gate-onboarding-files')).toContainText('在 pull_request、merge_group、push、workflow_dispatch 上运行');
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

test('已有 CI 的仓库：把门禁 job 并入已有 ci.yml 前先看到改动，确认后只改门禁需要的部分', async ({ page }) => {
  const cleanup = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const f = await gateFixture({ after: fn => cleanup.push(fn) });
  try {
    f.state.repos['octo/hello'].files['.github/workflows/ci.yml'] = '# Our CI\nname: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n';
    await login(page, f);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.global-project-row[data-repository-id="101"]').getByRole('button', { name: '接入门禁', exact: true }).click();
    const dialog = page.locator('#quickstart-view');
    await dialog.getByRole('button', { name: '开始适配', exact: true }).click();
    await runTurn(f);
    const place = dialog.getByLabel('门禁 job 放在');
    await expect(place).toHaveValue('.github/workflows/ci-gates.yml');
    await place.selectOption('.github/workflows/ci.yml');
    await expect(dialog.locator('#gate-onboarding-preview')).toHaveAttribute('open','');
    const files = dialog.locator('#gate-onboarding-files');
    await expect(files).toContainText('按表单里当前的内容（含未发送的修改）将提交');
    await expect(files.getByRole('heading', { name: '.github/workflows/ci.yml（修改）' })).toBeVisible();
    await expect(files.locator('.diff-add', { hasText: /^\+  gate:$/ })).toBeVisible();
    await expect(files.locator('.diff-same', { hasText: /^ {3}test:$/ })).toBeVisible();
    expect(writes(f.state)).toEqual([]);
    await page.screenshot({ path: '.tmp/gate-onboarding-merge-diff.png' });
    await dialog.getByRole('button', { name: '确认并创建门禁 PR', exact: true }).click();
    await expect(dialog.getByRole('link', { name: '打开门禁 PR', exact: true })).toBeVisible();
    const workflow = parse(branchOf(f.state).files['.github/workflows/ci.yml']);
    expect(Object.keys(workflow.jobs)).toEqual(['test', 'gate']);
    expect(branchOf(f.state).files['.github/workflows/ci-gates.yml']).toBeUndefined();
    expect(errors).toEqual([]);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
});
