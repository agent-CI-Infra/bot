import { legacySkillBinding } from '../test/skill-fixtures.mjs';
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { goRolePage, openRoleFormAdvanced } from './open-role-advanced.mjs';
import { RuleService } from '../dist/rules/service.js';

async function prepared(page) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const rules = new RuleService(h.store), path = '.agents/skills/check/SKILL.md'; rules.cache('101', 'a'.repeat(40), { [path]: 'Keep the original verified instructions.' });
    const result = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: false, skills: [
      { id: 'console', source: { type: 'inline', files: [{ path: 'guide.md', content: 'Preserve observable evidence.' }] } },
      { id: 'migrated', source: { type: 'inline', files: [{ path: 'playbooks/review.md', content: 'Previously bound review instructions.' }] } },
      { id: 'repository', source: { type: 'repository', commit: 'a'.repeat(40), paths: [path] } }
    ], roles: [{ role_id: 'test', skill_bundle_ref: { id: 'repository' } }] }); expect(result.status).toBe(200);
    legacySkillBinding(h.store, '101', result.value.configuration, 'migrated');
    await page.goto(h.admin + '/#/projects/101/basic');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.project-nav').getByRole('link', { name: '角色', exact: true }).click();
    await goRolePage(page, { view: 'skills' });
    const catalogue = page.getByRole('region', { name: '技能包目录', exact: true }); await expect(catalogue.getByLabel('技能包名称', { exact: true })).toBeVisible();
    return { h, admin, catalogue, rules, path, saved: result.value.configuration };
  } catch (error) { await h.stop(); throw error; }
}
const select = (catalogue, id) => catalogue.getByRole('navigation', { name: '技能包列表', exact: true }).getByRole('button', { name: new RegExp('^' + id + ' · ') }).click();

test('skill catalogue shows actual pinned sources and files, and ordinary sources and migrated files fit six widths', async ({ page }) => {
  const { h, catalogue, saved } = await prepared(page), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    mkdirSync('.tmp/skill-catalog/previews', { recursive: true });
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 950 }); await select(catalogue, 'repository');
      await expect(catalogue.getByRole('region', { name: '已保存技能版本', exact: true })).toContainText('已固定提交：' + 'a'.repeat(40));
      await expect(catalogue.getByRole('table', { name: '已保存技能文件', exact: true })).toContainText(saved.skills.find(b => b.id === 'repository').files[0].sha256);
      await expect(catalogue.getByLabel('固定仓库提交', { exact: true })).toBeEditable();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await select(catalogue, 'migrated'); await expect(catalogue).toContainText('已迁移为控制台文件'); await expect(catalogue.getByLabel('文件内容', { exact: true })).toHaveValue('Previously bound review instructions.');
      await expect(catalogue.getByRole('combobox', { name: '技能来源', exact: true }).locator('option')).toHaveText(['仓库技能文件', '自定义文件']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if ([390, 1440].includes(width)) { await catalogue.scrollIntoViewIfNeeded(); await page.screenshot({ path: `.tmp/skill-catalog/previews/skill-catalog-${width}.png`, fullPage: true }); }
      await select(catalogue, 'console'); await expect(catalogue.getByLabel('文件内容', { exact: true })).toBeEditable();
    }
    await catalogue.getByLabel('搜索技能包', { exact: true }).fill('repository'); await expect(catalogue.getByRole('navigation', { name: '技能包列表', exact: true }).getByRole('button')).toHaveCount(1);
    await catalogue.getByLabel('搜索技能包', { exact: true }).fill('not-present'); await expect(catalogue).toContainText('当前编辑草稿仍保留'); await expect(catalogue.getByLabel('文件内容', { exact: true })).toHaveValue('Preserve observable evidence.');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('skill editing shares the role binding draft and preserves an older pinned repository bundle after the rule cache advances', async ({ page }) => {
  const { h, admin, catalogue, rules, path, saved } = await prepared(page);
  try {
    await select(catalogue, 'console'); await catalogue.getByLabel('文件内容', { exact: true }).fill('Keep this edited source and its role binding.');
    await catalogue.getByRole('group', { name: '草稿绑定角色', exact: true }).getByRole('checkbox', { name: 'Dev', exact: true }).check();
    await goRolePage(page, { role: 'Dev' }); await openRoleFormAdvanced(page);
    await expect(page.getByRole('combobox', { name: 'dev 技能包', exact: true })).toHaveValue('console');
    await goRolePage(page, { view: 'skills' }); await expect(catalogue.getByLabel('文件内容', { exact: true })).toHaveValue('Keep this edited source and its role binding.');
    rules.cache('101', 'b'.repeat(40), { [path]: 'New moving-branch text.' });
    await page.getByRole('button', { name: '保存角色配置', exact: true }).click(); await expect(page.locator('.flash')).toContainText('角色配置已保存');
    const next = (await admin('/api/repositories/101/roles')).value;
    expect(next.configuration.roles.find(r => r.role_id === 'dev').skill_bundle_ref.id).toBe('console');
    expect(next.skill_inputs.find(b => b.id === 'console').source.files[0].content).toBe('Keep this edited source and its role binding.');
    expect(next.configuration.skills.find(b => b.id === 'repository')).toEqual(saved.skills.find(b => b.id === 'repository'));
    const migrated = next.skill_inputs.find(b => b.id === 'migrated'); expect(migrated.source.type).toBe('inline'); expect(migrated.source.files[0].content).toBe('Previously bound review instructions.');
    await page.reload(); await expect(catalogue.getByLabel('技能包名称', { exact: true })).toBeVisible();
    await select(catalogue, 'repository'); await expect(catalogue).toContainText('草稿指定的提交与当前仓库缓存不同'); await expect(catalogue.getByLabel('固定仓库提交', { exact: true })).toHaveValue('a'.repeat(40));
    await expect(catalogue.getByRole('region', { name: '已保存技能版本', exact: true })).toContainText('Test');
  } finally { await h.stop(); }
});

test('a skill draft survives a version conflict, while permission loss clears private files', async ({ page }) => {
  const { h, admin, catalogue } = await prepared(page);
  try {
    await select(catalogue, 'console'); await catalogue.getByLabel('文件内容', { exact: true }).fill('Unsaved content stays here.');
    const before = (await admin('/api/repositories/101/roles')).value;
    await admin('/api/repositories/101/roles', 'PUT', { expected_revision: before.revision, enabled: false, roles: [{ role_id: 'reviewer', responsibility: 'A concurrent update.' }] });
    await page.getByRole('button', { name: '保存角色配置', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: '角色配置已被别人修改' })).toBeVisible();
    await expect(catalogue.getByLabel('文件内容', { exact: true })).toHaveValue('Unsaved content stays here.');
    await page.route('**/api/repositories/101/roles', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' }));
    await page.getByRole('button', { name: '读取最新版本并比较', exact: true }).click(); await expect(page.locator('#project-page')).toContainText('已清空本页草稿');
    await expect(page.getByLabel('文件内容', { exact: true })).toHaveCount(0); await expect(page.locator('#project-page')).not.toContainText('Unsaved content stays here.');
  } finally { await h.stop(); }
});
