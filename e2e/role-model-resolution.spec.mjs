import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { goRolePage, openRoleFormAdvanced } from './open-role-advanced.mjs';

async function prepared(page) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    const models = [];
    for (const model_name of ['Project base', 'Work review', 'Role fixed']) {
      const saved = await admin('/api/models', 'POST', { repository_id: '101', model_name, api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() }); expect(saved.status).toBe(201); models.push(saved.value.model);
    }
    expect((await admin('/api/repositories/101/policy', 'PATCH', { model_id: models[0].id, task_models: { 'review.pr': models[1].id, 'custom.example': models[1].id } })).status).toBe(200);
    const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: false, roles: [
      { role_id: 'dev', enabled: true, harness_ref: { id: 'native' } },
      { role_id: 'reviewer', enabled: true, harness_ref: { id: 'native' }, model_profile_ref: { model_id: models[2].id, api: 'openai-chat-completions', tool_calls: true, structured_output: 'tool_call' } }
    ] }); expect(saved.status, JSON.stringify(saved.value)).toBe(200);
    await page.goto(h.admin + '/#/projects/101/roles/dev');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await openRoleFormAdvanced(page);
    await expect(panel(page)).toBeVisible(); return { h, admin, models, revision: saved.value.configuration.revision };
  } catch (error) { await h.stop(); throw error; }
}
const panel = page => page.getByLabel('按工作类型检查已保存模型', { exact: true });
const read = page => panel(page).getByRole('button', { name: '读取已保存模型解析', exact: true });
const choose = (page, kind) => panel(page).getByLabel('解析工作类型', { exact: true }).selectOption(kind);
const fact = (page, caption) => panel(page).locator('dt').filter({ hasText: new RegExp('^' + caption + '$') }).locator('xpath=following-sibling::dd[1]');

test('work type inheritance and explicit roles use saved configuration without saving drafts or snapshots', async ({ page }) => {
  const { h, admin, models, revision } = await prepared(page), errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
    const before = h.store.get('SELECT COUNT(*) AS n FROM role_snapshots').n;
    await read(page).click(); await expect(fact(page, '模型来源')).toHaveText('项目默认'); await expect(fact(page, '模型名称')).toHaveText('Project base');
    await choose(page, 'review.pr'); await expect(panel(page).locator('dd')).toHaveCount(0); await read(page).click();
    await expect(fact(page, '模型来源')).toHaveText('工作类型'); await expect(fact(page, '模型名称')).toHaveText('Work review');
    await page.getByLabel('角色提示词', { exact: true }).fill('Retain the local unsaved prompt.');
    await page.getByLabel('dev 模型', { exact: true }).selectOption(models[2].id);
    await read(page).click(); await expect(fact(page, '模型名称')).toHaveText('Work review');
    await expect(page.getByLabel('角色提示词', { exact: true })).toHaveValue('Retain the local unsaved prompt.');
    await choose(page, 'custom.example'); await read(page).click(); await expect(fact(page, '工作类型')).toHaveText('custom.example');
    await expect(fact(page, '模型名称')).toHaveText('Work review');
    mkdirSync('.tmp/model-resolution-230/previews', { recursive: true });
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 }); await panel(page).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(width)).toBe(true);
      if ([390, 1440].includes(width)) await page.screenshot({ path: `.tmp/model-resolution-230/previews/model-resolution-${width === 390 ? 'mobile' : 'desktop'}.png` });
    }
    await goRolePage(page, { role: 'Reviewer' }); await openRoleFormAdvanced(page); await choose(page, 'review.pr'); await read(page).click();
    await expect(fact(page, '模型来源')).toHaveText('角色'); await expect(fact(page, '模型名称')).toHaveText('Role fixed');
    expect((await admin('/api/repositories/101/roles')).value.revision).toBe(revision);
    expect(h.store.get('SELECT COUNT(*) AS n FROM role_snapshots').n).toBe(before); expect(h.store.get('SELECT COUNT(*) AS n FROM tasks').n).toBe(0); expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
test('withdrawn work type models and changed configuration do not show a substitute or stale success', async ({ page }) => {
  const { h, admin, models, revision } = await prepared(page);
  try {
    await choose(page, 'review.pr'); await read(page).click(); await expect(fact(page, '模型名称')).toHaveText('Work review');
    h.store.run('UPDATE models SET api_key=NULL WHERE id=?', models[1].id);
    await read(page).click(); await expect(panel(page).getByRole('status')).toContainText('解析失败，当前结果未知'); await expect(panel(page).locator('dd')).toHaveCount(0);
    await choose(page, 'development.issue'); await read(page).click(); await expect(fact(page, '模型名称')).toHaveText('Project base');
    await page.getByLabel('角色提示词', { exact: true }).fill('Still my draft');
    expect((await admin('/api/repositories/101/roles', 'PUT', { expected_revision: revision, enabled: false, roles: [{ role_id: 'dev', name: 'New saved name' }] })).status).toBe(200);
    await read(page).click(); await expect(panel(page).getByRole('status')).toContainText('配置版本已变化'); await expect(panel(page).locator('dd')).toHaveCount(0);
    await expect(page.getByLabel('角色提示词', { exact: true })).toHaveValue('Still my draft');
  } finally { await h.stop(); }
});
test('an external backend reports its own model instead of fabricating a project model version', async ({ page }) => {
  const { h, admin, revision } = await prepared(page);
  try {
    expect((await admin('/api/repositories/101/roles', 'PUT', { expected_revision: revision, enabled: false, roles: [{ role_id: 'dev', harness_ref: { id: 'codex' }, model_profile_ref: null }] })).status).toBe(200);
    await page.reload(); await openRoleFormAdvanced(page); await expect(panel(page)).toBeVisible(); await read(page).click();
    await expect(fact(page, '模型来源')).toHaveText('执行器自带模型'); await expect(fact(page, '模型记录版本')).toHaveText('不适用');
    await expect(fact(page, '模型名称')).toHaveText('由执行器管理，不使用项目模型');
  } finally { await h.stop(); }
});
test('late resolutions cannot replace another project and a forbidden preview clears the shared draft', async ({ page }) => {
  const { h } = await prepared(page); let release;
  try {
    let entered; const seen = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/repositories/101/roles/resolve', async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); });
    await read(page).click(); await seen; await page.goto(h.admin + '/#/projects/102/roles/dev'); await openRoleFormAdvanced(page); await expect(panel(page)).toBeVisible(); release();
    await expect(panel(page).locator('dd')).toHaveCount(0); await expect(panel(page).getByRole('status')).toContainText('尚未读取');
    await page.unroute('**/api/repositories/101/roles/resolve'); await page.goto(h.admin + '/#/projects/101/roles/dev');
    await page.getByLabel('角色提示词', { exact: true }).fill('Private local draft');
    await openRoleFormAdvanced(page);
    await page.route('**/api/repositories/101/roles/resolve', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"repository_forbidden"}' }));
    await read(page).click(); await expect(page.getByText('当前身份无权读取或修改角色配置，已清空本页草稿。', { exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0); await expect(page.getByLabel('角色提示词', { exact: true })).toHaveCount(0);
  } finally { release?.(); await h.stop(); }
});
test('a late result for the previous work type cannot overwrite the new selection', async ({ page }) => {
  const { h } = await prepared(page); let release;
  try {
    let entered, count = 0; const seen = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/repositories/101/roles/resolve', async route => {
      if (++count > 1) return route.continue();
      const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
    });
    await read(page).click(); await seen;
    await choose(page, 'review.pr'); await read(page).click(); await expect(fact(page, '模型名称')).toHaveText('Work review');
    release(); await expect(fact(page, '工作类型')).toHaveText('检视 PR'); await expect(fact(page, '模型名称')).toHaveText('Work review');
  } finally { release?.(); await h.stop(); }
});
