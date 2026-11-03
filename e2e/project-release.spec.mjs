import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { releaseFixture, run, target, writes } from '../test/release-fixtures.mjs';
import { workflowSet } from '../dist/projects/gate-templates.js';
import { testPassword } from '../test/helpers.mjs';

async function login(page, address, username, password) {
  await page.goto(address); await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
}
test('项目页完整 beta 发版：确认 SHA、Release lane、草稿编辑和人工正式发布', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    // Exercise the existing onboarding release-lane template against fake GitHub; no live repository writes.
    f.state.files['.github/workflows/release.yml'] = workflowSet({ build: 'npm run build' })['.github/workflows/release.yml'];
    await page.route('**/api/repositories/*/rules', route => route.fulfill({ json: { rules: { files: [], computer: {} } } }));
    await login(page, f.h.admin, 'administrator', f.password);
    await page.goto(f.h.admin + '/#/projects/101/release');
    await expect(page.getByRole('heading', { name: '发版本', exact: true })).toBeVisible();
    const version = page.getByLabel('版本号', { exact: true }), confirm = page.getByRole('button', { name: '确认打标签', exact: true });
    await version.fill('v01.2.3'); await page.getByRole('button', { name: '检查候选提交' }).click(); await expect(confirm).toBeDisabled();
    await version.fill('v1.2.3-beta.1'); await page.getByRole('button', { name: '检查候选提交' }).click(); await expect(confirm).toBeEnabled();
    await expect(page.locator('#project-page')).toContainText(target);
    await confirm.click(); const dialog = page.getByRole('dialog'); await expect(dialog).toContainText(target);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); expect(writes(f.state)).toHaveLength(0);
    await confirm.click(); await dialog.getByRole('button', { name: '确认打标签', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT COUNT(*) n FROM project_releases').n).toBe(1);
    const record = f.h.store.get('SELECT id FROM project_releases');
    await f.service.worker.process(record.id);
    f.state.runs = [run({ head_branch: 'v1.2.3-beta.1' })];
    f.state.jobs = [{ id: 1, run_id: 800, run_attempt: 1, name: 'release', status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project-101/actions/runs/800/job/1' }];
    for (let i = 0; i < 3; i++) await f.service.worker.process(record.id);
    const editor = page.getByLabel('发行说明草稿'); await expect(editor).toBeVisible({ timeout: 10000 });
    expect(f.state.releases[0].draft).toBe(true); expect(writes(f.state).some(r => r.body?.draft === false)).toBe(false);
    await editor.fill('Maintainer reviewed beta notes'); await page.getByRole('button', { name: '保存草稿正文', exact: true }).click();
    await expect.poll(() => f.state.releases[0].body).toBe('Maintainer reviewed beta notes');
    await editor.fill('Unsaved local text'); await page.waitForTimeout(5200); await expect(editor).toHaveValue('Unsaved local text');
    await page.getByRole('button', { name: '正式发布', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible();
    expect(f.state.releases[0].draft).toBe(true);
    await page.getByRole('button', { name: '丢弃本地编辑并刷新正文' }).click();
    await page.setViewportSize({ width: 1440, height: 1000 }); mkdirSync('.tmp/project-release', { recursive: true });
    await page.screenshot({ path: '.tmp/project-release/draft-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/project-release/draft-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '正式发布', exact: true }).click(); await expect(dialog).toContainText('发布后仍为预发布版本');
    await dialog.getByRole('button', { name: '正式发布', exact: true }).click();
    await expect.poll(() => f.state.releases[0].draft).toBe(false); expect(f.state.releases[0].prerelease).toBe(true);
    await expect(page.locator('#project-page')).toContainText('已人工发布');
    await page.screenshot({ path: '.tmp/project-release/published-mobile.png', fullPage: true }); expect(errors).toEqual([]);
  } finally { for (const close of cleanup.reverse()) await close(); }
});
test('其他项目管理员看不到发版入口，直接请求本项目发布接口返回 403', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
  try {
    const password = testPassword(); await f.admin('/api/users', 'POST', { username: 'other-project-admin', password, repository_ids: ['202'] });
    await login(page, f.h.admin, 'other-project-admin', password); await page.goto(f.h.admin + '/#/projects/101/release');
    await expect(page.locator('#project-page')).toContainText('403 · repository_forbidden');
    await expect(page.locator('#project-page').getByRole('link', { name: '发版本', exact: true })).toHaveCount(0);
    const code = await page.evaluate(async () => (await fetch('/api/repositories/101/releases/preflight?version=v1.2.3')).status); expect(code).toBe(403);
    expect(writes(f.state)).toHaveLength(0);
  } finally { for (const close of cleanup.reverse()) await close(); }
});
test('候选提交已被上一版本包含时说明跳过并禁用确认，已有发布记录仍可查看', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
  try {
    const existing = await f.create('v1.2.1');
    f.state.tags['v1.2.2'] = { type: 'commit', sha: target };
    await page.route('**/api/repositories/*/rules', route => route.fulfill({ json: { rules: { files: [], computer: {} } } }));
    await login(page, f.h.admin, 'administrator', f.password); await page.goto(f.h.admin + '/#/projects/101/release');
    await page.getByLabel('版本号', { exact: true }).fill('v1.2.3'); await page.getByRole('button', { name: '检查候选提交' }).click();
    await expect(page.locator('#project-page')).toContainText('没有新变更，跳过本次发布');
    await expect(page.getByRole('button', { name: '确认打标签', exact: true })).toBeDisabled();
    await expect(page.locator('#project-page')).toContainText(existing.value.release.version);
    expect(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n).toBe(1); expect(writes(f.state)).toHaveLength(0);
  } finally { for (const close of cleanup.reverse()) await close(); }
});
test('运行分析按需申请只读令牌并在页面展示脱敏日志证据', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) }); let release;
  try {
    f.state.runs = [run({ conclusion: 'failure' })];
    f.state.jobs = [{ id: 1, run_id: 800, run_attempt: 1, name: 'release', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/project-101/actions/runs/800/job/1' }];
    f.state.logs[1] = 'Error: package missing\nobservation-ui-secret';
    const created = await f.create(); for (let i = 0; i < 2; i++) await f.service.worker.process(created.value.release.id);
    const model = await f.admin('/api/models', 'POST', { repository_id: '101', api_url: f.apiUrl + '/v1', api_key: 'observation-ui-secret', model_name: 'fixture' });
    await f.admin('/api/repositories/101/policy', 'PATCH', { model_id: model.value.model.id });
    const held = new Promise(resolve => { release = resolve; }); let turn = 0;
    const tool = (id, name, args = {}) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    f.state.custom = async ({ path, send }) => {
      if (path !== '/v1/chat/completions') return false;
      const index = turn++; if (!index) await held;
      send({ choices: [{ message: [tool('token', 'github_read_token'), tool('log', 'read_job_log', { job_id: 1 }), { content: '{"job_ids":[1],"advice":"日志第 1 行显示 package missing，请检查构建依赖。"}' }][index] }] }); return true;
    };
    await page.route('**/api/repositories/*/rules', route => route.fulfill({ json: { rules: { files: [], computer: {} } } }));
    await login(page, f.h.admin, 'administrator', f.password); await page.goto(f.h.admin + '/#/projects/101/release');
    const analyze = page.getByRole('button', { name: /让智能体看这次运行/ }); await analyze.click(); await expect(analyze).toBeDisabled();
    await page.waitForTimeout(5200); await expect(analyze).toBeDisabled(); release();
    await expect(page.locator('#project-page')).toContainText('日志第 1 行显示 package missing');
    await page.getByText('release 日志 · 第 1–2 行', { exact: true }).click();
    await expect(page.locator('#project-page pre')).toContainText('Error: package missing'); await expect(page.locator('#project-page pre')).toContainText('[REDACTED]');
    await expect(page.locator('#project-page')).not.toContainText('observation-ui-secret'); expect(f.state.releases).toHaveLength(0);
    const grant = f.state.tokens.find(t => t.permissions.metadata === 'read' && !t.permissions.contents); expect(grant.permissions).toEqual({ actions: 'read', metadata: 'read' });
    mkdirSync('.tmp/release-observation', { recursive: true }); await page.screenshot({ path: '.tmp/release-observation/log-evidence.png', fullPage: true });
  } finally { release?.(); for (const close of cleanup.reverse()) await close(); }
});
