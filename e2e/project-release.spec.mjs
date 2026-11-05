import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { releaseFixture, run, target, previous, other, writes } from '../test/release-fixtures.mjs';
import { releaseWorkflowFile, emptyPlan } from '../dist/projects/gate-plan.js';
import { testPassword } from '../test/helpers.mjs';

async function login(page, address, username, password) {
  await page.goto(address); await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
}
test('项目页完整 beta 发版：确认 SHA、Release lane、草稿编辑和人工正式发布', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    // Exercise the onboarding release-lane template against fake GitHub; no live repository writes.
    f.state.files['.github/workflows/release.yml'] = releaseWorkflowFile({ ...emptyPlan(), install: ['npm ci'] },
      { defaultBranch: 'main', mergeQueue: 'disabled', workflowPath: '.github/workflows/ci.yml', releaseWorkflow: true, npmLock: true });
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
test('填写的版本不高于上一枚版本标签时提示更高版本并禁用确认', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
  try {
    f.state.tags['v1.2.2'] = { type: 'commit', sha: previous };
    await page.route('**/api/repositories/*/rules', route => route.fulfill({ json: { rules: { files: [], computer: {} } } }));
    await login(page, f.h.admin, 'administrator', f.password); await page.goto(f.h.admin + '/#/projects/101/release');
    const panel = page.locator('#project-page'), version = page.getByLabel('版本号', { exact: true }), confirm = page.getByRole('button', { name: '确认打标签', exact: true });
    const hint = panel.getByText('版本号需要高于上一枚版本标签 v1.2.2，例如 v1.2.3 或 v1.3.0', { exact: true });
    await expect(hint).toBeVisible(); await expect(hint).not.toHaveClass(/release-check-failed/);
    await version.fill('v1.2.1'); await page.getByRole('button', { name: '检查候选提交' }).click();
    const refused = panel.getByText('版本 v1.2.1 不高于上一枚版本标签 v1.2.2，不能发布。请填写更高的版本，例如 v1.2.3 或 v1.3.0。', { exact: true });
    await expect(refused).toHaveClass(/release-check-failed/); await expect(confirm).toBeDisabled();
    mkdirSync('.tmp/project-release-version-order', { recursive: true });
    await page.screenshot({ path: '.tmp/project-release-version-order/not-higher.png', fullPage: true });
    await version.fill('v1.2.3'); await page.getByRole('button', { name: '检查候选提交' }).click();
    await expect(panel).toContainText('版本 v1.2.3 高于上一枚版本标签 v1.2.2'); await expect(confirm).toBeEnabled();
    expect(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n).toBe(0); expect(writes(f.state)).toHaveLength(0);
  } finally { for (const close of cleanup.reverse()) await close(); }
});
test('已有草稿后跳过同提交的新版本，有新提交时确认并展示第二份草稿', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
  try {
    f.state.runs = [run()];
    f.state.jobs = [{ id: 1, run_id: 800, run_attempt: 1, name: 'release', status: 'completed', conclusion: 'success' }];
    const created = await f.create(), first = created.value.release;
    for (let i = 0; i < 4; i++) await f.service.worker.process(first.id);
    const firstDraft = structuredClone(f.state.releases[0]); expect(firstDraft.draft).toBe(true);
    await page.route('**/api/repositories/*/rules', route => route.fulfill({ json: { rules: { files: [], computer: {} } } }));
    await login(page, f.h.admin, 'administrator', f.password); await page.goto(f.h.admin + '/#/projects/101/release');
    const version = page.getByLabel('版本号', { exact: true }), confirm = page.getByRole('button', { name: '确认打标签', exact: true });
    await version.fill('v1.2.4'); await page.getByRole('button', { name: '检查候选提交' }).click();
    await expect(page.locator('#project-page')).toContainText('没有新变更，跳过本次发布'); await expect(confirm).toBeDisabled();
    await expect(page.locator('.release-record').getByRole('heading', { name: first.version, exact: true })).toBeVisible();
    mkdirSync('.tmp/project-release-active-draft', { recursive: true });
    await page.screenshot({ path: '.tmp/project-release-active-draft/no-changes.png', fullPage: true });
    f.state.histories[target] = structuredClone(f.state.commits); f.state.head = other;
    f.state.commits.unshift({ sha: other, commit: { message: 'Add another change' }, html_url: 'https://github.com/fixture/project-101/commit/' + other });
    await page.getByRole('button', { name: '检查候选提交' }).click(); await expect(confirm).toBeEnabled();
    await confirm.click(); const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('v1.2.4'); await expect(dialog).toContainText(other);
    const response = page.waitForResponse(result => result.url() === f.h.admin + f.endpoint && result.request().method() === 'POST');
    await dialog.getByRole('button', { name: '确认打标签', exact: true }).click();
    const confirmed = await response, second = (await confirmed.json()).release;
    expect(confirmed.status()).toBe(201); expect(second.version).toBe('v1.2.4'); expect(second.target_sha).toBe(other); expect(second.id).not.toBe(first.id);
    f.state.runs = [run({ id: 801, head_branch: second.version, head_sha: other })]; f.state.jobs[0].run_id = 801;
    for (let i = 0; i < 4; i++) await f.service.worker.process(second.id);
    await page.reload(); await expect(page.locator('.release-record')).toHaveCount(2);
    for (const name of [first.version, second.version]) {
      const record = page.locator('.release-record').filter({ has: page.getByRole('heading', { name, exact: true }) });
      await expect(record).toContainText('草稿待发布'); await expect(record.getByLabel('发行说明草稿')).toBeVisible();
    }
    expect(f.state.releases).toHaveLength(2); expect(f.state.releases.every(release => release.draft === true)).toBe(true);
    expect(f.state.releases[0]).toEqual(firstDraft); expect(f.h.store.all('SELECT active FROM project_releases').every(row => row.active === 0)).toBe(true);
    expect(writes(f.state).some(request => request.body?.draft === false || request.method === 'DELETE')).toBe(false);
    await page.screenshot({ path: '.tmp/project-release-active-draft/two-drafts.png', fullPage: true });
  } finally { for (const close of cleanup.reverse()) await close(); }
});
test('运行分析从失败探索代码、其他Issue与PR，并展示脱敏日志证据', async ({ page }) => {
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
    f.state.custom = async ({ path, body, send, res }) => {
      if(path.endsWith('/actions/jobs/2')){send({id:2,run_id:801,run_attempt:2,name:'related build',html_url:'https://github.com/fixture/project-101/actions/runs/801/job/2'});return true;}
      if(path.endsWith('/actions/jobs/2/logs')){res.writeHead(200,{'Content-Type':'text/plain'});res.end('Earlier dependency failure');return true;}
      if (path.endsWith('/contents/package.json')) { send({ encoding: 'base64', content: Buffer.from('{"dependencies":{}}').toString('base64') }); return true; }
      if (path.endsWith('/issues/42/comments')) { send([{body:'Dependency removed in PR #9.'}]); return true; }
      if (path.endsWith('/pulls/9/files')) { send([{filename:'package.json',patch:'- missing-package'}]); return true; }
      if (path !== '/v1/chat/completions') return false;
      const index = turn++; if (!index) await held;
      const replies = [tool('token', 'github_read_token'), tool('code', 'github_read', {path:'/contents/package.json'}), tool('issue', 'github_read', {path:'/issues/42/comments'}), tool('pr', 'github_read', {path:'/pulls/9/files'}), tool('log', 'read_job_log', {job_id:1}), tool('related', 'read_job_log', {job_id:2}), {content:JSON.stringify({job_ids:[1],advice:'日志第 1 行显示 package missing；package.json、Issue #42 和 PR #9 表明依赖被移除。'})}];
      if(index===6){const evidence=JSON.stringify(body.messages);expect(evidence).toContain('dependencies');expect(evidence).toContain('Dependency removed');expect(evidence).toContain('missing-package');}
      send({ choices: [{ message: replies[index] }] }); return true;
    };
    await page.route('**/api/repositories/*/rules', route => route.fulfill({ json: { rules: { files: [], computer: {} } } }));
    await login(page, f.h.admin, 'administrator', f.password); await page.goto(f.h.admin + '/#/projects/101/release');
    const analyze = page.getByRole('button', { name: /让智能体看这次运行/ }); await analyze.click(); await expect(analyze).toBeDisabled();
    await page.waitForTimeout(5200); await expect(analyze).toBeDisabled(); release();
    await expect(page.locator('#project-page')).toContainText('日志第 1 行显示 package missing');
    await page.getByText('release 日志 · 第 1–2 行', { exact: true }).click();
    const primaryLog=page.locator('#project-page details').filter({has:page.getByText('release 日志 · 第 1–2 行',{exact:true})}).locator('pre');
    await expect(primaryLog).toContainText('Error: package missing'); await expect(primaryLog).toContainText('[REDACTED]');
    await expect(page.locator('#project-page')).not.toContainText('observation-ui-secret'); expect(f.state.releases).toHaveLength(0);
    const grant = f.state.tokens.at(-1); expect(grant.repository_ids).toEqual([101]); expect(grant.permissions.contents).toBe('read'); expect(grant.permissions.issues).toBe('read'); expect(grant.permissions.pull_requests).toBe('read'); expect(Object.values(grant.permissions).every(value=>value==='read')).toBe(true);
    await expect(page.locator('#project-page')).toContainText('Issue #42 和 PR #9');
    await expect(page.locator('#project-page')).toContainText('related build 日志 · run 801 / attempt 2');
    mkdirSync('.tmp/release-observation', { recursive: true }); await page.screenshot({ path: '.tmp/release-observation/log-evidence.png', fullPage: true });
  } finally { release?.(); for (const close of cleanup.reverse()) await close(); }
});
