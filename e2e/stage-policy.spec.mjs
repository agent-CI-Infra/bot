import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { goRolePage } from './open-role-advanced.mjs';

const stage = (stage_id, depends_on = [], writer = false) => ({ stage_id, depends_on, delivery_types: ['code', 'artifact', 'no_changes'],
  role_constraints: { kinds: [writer ? 'writer' : 'observer'], role_ids: [writer ? 'dev' : 'reviewer'], independent: !writer,
    capabilities: writer ? ['raw_evidence', 'version_binding', 'output_validation'] : ['fresh_context', 'fixed_candidate_read', 'raw_evidence'] },
  required: true, completion: { evidence_types: ['role_result'], min_evidence: 1, no_findings: !writer }, retry: { max_attempts: 3 }, budget: {} });
async function prepared(page, stages = [stage('build', [], true), stage('review', ['build']), stage('test', ['build']), stage('final', ['review', 'test'])]) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: false,
      roles: ['dev', 'reviewer', 'test'].map(role_id => ({ role_id, enabled: true, harness_ref: { id: 'native' } })), required_stages: stages });
    expect(saved.status, JSON.stringify(saved.value)).toBe(200);
    await page.goto(h.admin + '/#/projects/101/roles?view=stages');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('阶段依赖预览', { exact: true })).toBeVisible();
    return { h, admin, revision: saved.value.configuration.revision };
  } catch (error) { await h.stop(); throw error; }
}
const exactGroup = (page, id) => page.locator('.role-stage').filter({ has: page.locator('legend').filter({ hasText: new RegExp('^' + id + '$') }) });
const save = page => page.getByRole('button', { name: '保存角色配置', exact: true });
const dependencies = row => row.locator('.role-choices').filter({ has: row.page().locator('legend').filter({ hasText: /^依赖阶段$/ }) });

test('the same stage fields, dependency levels and reachable editor work at six widths', async ({ page }) => {
  const { h, admin } = await prepared(page), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const preview = page.getByLabel('阶段依赖预览', { exact: true });
    await expect(preview.locator('.stage-graph-level')).toHaveCount(3);
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 }); await preview.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(width)).toBe(true);
      await preview.getByRole('button', { name: '编辑阶段 final', exact: true }).click();
      const target = exactGroup(page, 'final'); await expect(target).toBeFocused();
      expect(await target.evaluate(el => el.getBoundingClientRect().top >= document.querySelector('.role-save').getBoundingClientRect().bottom - 1)).toBe(true);
      await expect(save(page)).toBeInViewport();
      for (const caption of ['阶段标识', '执行角色类型', '最少证据数', '最多尝试次数', '阶段最多工具调用', '阶段最多秒数']) await expect(target.getByLabel(caption, { exact: true })).toHaveCount(1);
    }
    const target = exactGroup(page, 'final'); await target.getByLabel('最多尝试次数', { exact: true }).fill('5'); await target.getByLabel('阶段最多工具调用', { exact: true }).fill('40');
    await target.getByLabel('阶段最多秒数', { exact: true }).fill('600');
    await goRolePage(page, { role: 'Dev' });
    await goRolePage(page, { view: 'stages' });
    await expect(exactGroup(page, 'final').getByLabel('最多尝试次数', { exact: true })).toHaveValue('5');
    mkdirSync('.tmp/stage-policy-229/previews', { recursive: true });
    for (const [name, width] of [['desktop', 1440], ['mobile', 390]]) {
      await page.setViewportSize({ width, height: 1000 });
      await preview.evaluate(el => { el.style.scrollMarginTop = `${document.querySelector('.role-save').getBoundingClientRect().height + 16}px`; el.scrollIntoView({ block: 'start' }); });
      await page.screenshot({ path: `.tmp/stage-policy-229/previews/stage-policy-${name}.png` });
    }
    await save(page).click(); await expect(page.locator('.flash')).toBeVisible();
    const saved = (await admin('/api/repositories/101/roles')).value.configuration.required_stages.find(row => row.stage_id === 'final');
    expect(saved.retry.max_attempts).toBe(5); expect(saved.budget).toEqual({ max_tool_calls: 40, max_wall_seconds: 600 });
    expect(h.store.get('SELECT COUNT(*) AS n FROM tasks').n).toBe(0); expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
test('renaming through a sibling id retains focus and updates only the intended dependency', async ({ page }) => {
  const { h, admin } = await prepared(page, [stage('build', [], true), stage('b'), stage('child', ['build']), stage('other', ['b'])]);
  try {
    const name = page.locator('.role-stage').first().getByLabel('阶段标识', { exact: true }); await name.fill('b'); await expect(name).toBeFocused();
    await expect(page.locator('.stage-policy-issues')).toContainText('重复'); await name.fill('build_new'); await expect(name).toBeFocused();
    await expect(dependencies(exactGroup(page, 'child')).getByRole('checkbox', { name: 'build_new', exact: true })).toBeChecked();
    await expect(dependencies(exactGroup(page, 'other')).getByRole('checkbox', { name: 'b', exact: true })).toBeChecked();
    await save(page).click(); await expect(page.locator('.flash')).toBeVisible();
    const stages = (await admin('/api/repositories/101/roles')).value.configuration.required_stages;
    expect(stages.find(row => row.stage_id === 'child').depends_on).toEqual(['build_new']); expect(stages.find(row => row.stage_id === 'other').depends_on).toEqual(['b']);
    await dependencies(exactGroup(page, 'child')).getByRole('checkbox', { name: 'build_new', exact: true }).uncheck();
    await save(page).click(); await expect(exactGroup(page, 'child').getByLabel('阶段标识', { exact: true })).toBeVisible();
    expect((await admin('/api/repositories/101/roles')).value.configuration.required_stages.find(row => row.stage_id === 'child').depends_on).toEqual([]);
  } finally { await h.stop(); }
});
test('a cycle reports the actual server field, retains the draft and focuses the affected mobile stage', async ({ page }) => {
  const { h, admin, revision } = await prepared(page); await page.setViewportSize({ width: 390, height: 844 });
  try {
    await dependencies(exactGroup(page, 'review')).getByRole('checkbox', { name: 'final', exact: true }).check();
    await expect(page.locator('.stage-policy-issues')).toContainText('循环');
    await save(page).click(); const target = exactGroup(page, 'review');
    await expect(target).toHaveAttribute('aria-invalid', 'true'); await expect(target).toBeFocused();
    await expect(target.locator('.stage-policy-error')).toContainText('循环');
    await expect(page.getByRole('alert').filter({ hasText: 'required_stages.review.cycle' })).toBeVisible();
    expect((await admin('/api/repositories/101/roles')).value.revision).toBe(revision);
    await dependencies(target).getByRole('checkbox', { name: 'final', exact: true }).uncheck();
    await expect(target).not.toHaveAttribute('aria-invalid', 'true'); await expect(page.locator('.stage-graph-level')).toHaveCount(3);
    await target.getByLabel('最多尝试次数', { exact: true }).fill('4'); await save(page).click(); await expect(page.locator('.flash')).toBeVisible();
    expect((await admin('/api/repositories/101/roles')).value.configuration.required_stages.find(row => row.stage_id === 'review').retry.max_attempts).toBe(4);
  } finally { await h.stop(); }
});
test('version conflicts preserve the stage draft and merge independent remote changes before a deliberate save', async ({ page }) => {
  const { h, admin, revision } = await prepared(page);
  try {
    await exactGroup(page, 'final').getByLabel('最多尝试次数', { exact: true }).fill('6');
    expect((await admin('/api/repositories/101/roles', 'PUT', { expected_revision: revision, enabled: false, roles: [{ role_id: 'dev', name: 'Remote Dev' }] })).status).toBe(200);
    await save(page).click(); await expect(page.getByRole('alert').filter({ hasText: '角色配置已被别人修改' })).toBeVisible();
    await expect(exactGroup(page, 'final').getByLabel('最多尝试次数', { exact: true })).toHaveValue('6');
    await page.getByRole('button', { name: '读取最新版本并比较', exact: true }).click();
    await page.getByRole('button', { name: '将修改应用到最新版本草稿', exact: true }).click();
    await save(page).click(); await expect(page.locator('.flash')).toBeVisible();
    const config = (await admin('/api/repositories/101/roles')).value.configuration;
    expect(config.required_stages.find(row => row.stage_id === 'final').retry.max_attempts).toBe(6); expect(config.roles.find(row => row.role_id === 'dev').name).toBe('Remote Dev');
  } finally { await h.stop(); }
});
test('removing a temporarily duplicated stage does not remove the other stages prerequisite', async ({ page }) => {
  const { h, admin } = await prepared(page, [stage('build', [], true), stage('b'), stage('child', ['build']), stage('other', ['b'])]);
  try {
    await page.locator('.role-stage').first().getByLabel('阶段标识', { exact: true }).fill('b');
    await page.locator('.role-stage').first().getByRole('button', { name: '移除阶段', exact: true }).click();
    await expect(dependencies(exactGroup(page, 'other')).getByRole('checkbox', { name: 'b', exact: true })).toBeChecked();
    await save(page).click(); await expect(page.locator('.flash')).toBeVisible();
    const stages = (await admin('/api/repositories/101/roles')).value.configuration.required_stages;
    expect(stages.find(row => row.stage_id === 'child').depends_on).toEqual([]); expect(stages.find(row => row.stage_id === 'other').depends_on).toEqual(['b']);
  } finally { await h.stop(); }
});
test('an empty extra policy keeps the independent acceptance explanation and can be edited', async ({ page }) => {
  const { h } = await prepared(page, []);
  try {
    await expect(page.getByLabel('阶段依赖预览', { exact: true })).toContainText('原有交付与独立验收规则继续生效');
    await expect(page.locator('.stage-graph-level')).toHaveCount(0);
    await page.getByRole('button', { name: '添加阶段', exact: true }).click();
    await expect(page.locator('.role-stage')).toHaveCount(1); await expect(page.locator('.stage-graph-level')).toHaveCount(1);
    await expect(page.locator('.role-stage').getByLabel('执行角色类型', { exact: true })).toHaveValue('observer');
  } finally { await h.stop(); }
});
test('unreachable roles, optional prerequisites and invalid evidence locate their real server fields', async ({ page }) => {
  const { h, admin, revision } = await prepared(page);
  try {
    await goRolePage(page, { role: 'Reviewer' });
    await page.getByLabel('启用角色', { exact: true }).uncheck();
    await goRolePage(page, { view: 'stages' });
    await save(page).click();
    await expect(exactGroup(page, 'review')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'required_stages.review.unreachable_role' })).toBeVisible();
    await goRolePage(page, { role: 'Reviewer' }); await page.getByLabel('启用角色', { exact: true }).check();
    await goRolePage(page, { view: 'stages' });
    await exactGroup(page, 'review').getByLabel('必须完成', { exact: true }).uncheck();
    await expect(page.locator('.stage-policy-issues')).toContainText('可选阶段 review'); await save(page).click();
    await expect(exactGroup(page, 'final')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'required_stages.final.unreachable_dependency' })).toBeVisible();
    await exactGroup(page, 'review').getByLabel('必须完成', { exact: true }).check();
    await exactGroup(page, 'build').getByLabel('必须没有待处理发现', { exact: true }).check(); await save(page).click();
    await expect(exactGroup(page, 'build')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'required_stages.build.completion' })).toBeVisible();
    expect((await admin('/api/repositories/101/roles')).value.revision).toBe(revision);
    await exactGroup(page, 'build').getByLabel('必须没有待处理发现', { exact: true }).uncheck();
    await save(page).click(); await expect(page.locator('.flash')).toBeVisible();
  } finally { await h.stop(); }
});
