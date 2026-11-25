import { legacySkillBinding } from '../../fixtures/skill-fixtures.mjs';
import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { goRolePage, openRoleFormAdvanced } from '../helpers/open-role-advanced.mjs';
import { consoleSave, compareWithServer } from '../helpers/console-save.mjs';
import { RuleService } from '../../../dist/rules/service.js';
import { syncBuiltinSkills } from '../../../dist/roles/skill-library.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function prepared(page) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const rules = new RuleService(h.store), path = '.agents/skills/check/SKILL.md'; rules.cache('101', 'a'.repeat(40), { [path]: '---\nname: check\ndescription: Keep the original verified instructions.\n---\nKeep the original verified instructions.' });
    const result = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: false, skills: [
      { id: 'console', source: { type: 'inline', files: [{ path: 'guide.md', content: 'Preserve observable evidence.' }] } },
      { id: 'migrated', source: { type: 'inline', files: [{ path: 'playbooks/review.md', content: 'Previously bound review instructions.' }] } },
      { id: 'repository', source: { type: 'repository', commit: 'a'.repeat(40), paths: [path] } }
    ], roles: [{ role_id: 'test', skill_bundle_ref: { id: 'repository' } }] }); expect(result.status).toBe(200);
    legacySkillBinding(h.store, '101', result.value.configuration, 'migrated');
    await page.goto(h.admin + '/#/projects/101/basic');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.evaluate(() => { location.hash = '#/projects/101/roles'; });
    await goRolePage(page, { view: 'skills' });
    const catalogue = page.getByRole('region', { name: '技能包目录', exact: true }); await expect(catalogue.getByLabel('技能包名称', { exact: true })).toBeVisible();
    return { h, admin, catalogue, rules, path, saved: result.value.configuration };
  } catch (error) { await h.stop(); throw error; }
}
const select = (catalogue, id) => catalogue.getByRole('navigation', { name: '技能包列表', exact: true }).getByRole('button', { name: new RegExp('^' + id + ' · ') }).click();

test('skill catalogue shows actual pinned sources and files, and ordinary sources and migrated files fit six widths', async ({ page }) => {
  const { h, catalogue, saved } = await prepared(page), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 950 }); await select(catalogue, 'repository');
      await expect(catalogue.getByRole('region', { name: '已保存技能版本', exact: true })).toContainText('已固定提交：' + 'a'.repeat(40));
      await expect(catalogue.getByRole('table', { name: '已保存技能文件', exact: true })).toContainText(saved.skills.find(b => b.id === 'repository').files[0].sha256);
      await expect(catalogue.getByLabel('固定仓库提交', { exact: true })).toBeEditable();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await select(catalogue, 'migrated'); await expect(catalogue).toContainText('已迁移为控制台文件'); await expect(catalogue.getByLabel('文件内容', { exact: true })).toHaveValue('Previously bound review instructions.');
      await expect(catalogue.getByRole('combobox', { name: '技能来源', exact: true }).locator('option')).toHaveText(['技能库', '仓库技能文件', '自定义文件']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await select(catalogue, 'console'); await expect(catalogue.getByLabel('文件内容', { exact: true })).toBeEditable();
    }
    await catalogue.getByLabel('搜索技能包', { exact: true }).fill('repository'); await expect(catalogue.getByRole('navigation', { name: '技能包列表', exact: true }).getByRole('button')).toHaveCount(1);
    await catalogue.getByLabel('搜索技能包', { exact: true }).fill('not-present'); await expect(catalogue).toContainText('当前编辑草稿仍保留'); await expect(catalogue.getByLabel('文件内容', { exact: true })).toHaveValue('Preserve observable evidence.');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('skill editing shares the multi-bundle role draft and preserves an older pinned repository bundle after the rule cache advances', async ({ page }) => {
  const { h, admin, catalogue, rules, path, saved } = await prepared(page);
  try {
    await select(catalogue, 'console'); await catalogue.getByLabel('文件内容', { exact: true }).fill('Keep this edited source and its role binding.');
    await catalogue.getByRole('group', { name: '草稿绑定角色', exact: true }).getByRole('checkbox', { name: 'Developer', exact: true }).check();
    await goRolePage(page, { role: 'Dev' }); await openRoleFormAdvanced(page);
    await expect(page.getByTestId('role-skill-bundles').locator('input[data-bundle-id="console"]')).toBeChecked();
    await goRolePage(page, { view: 'skills' }); await expect(catalogue.getByLabel('文件内容', { exact: true })).toHaveValue('Keep this edited source and its role binding.');
    rules.cache('101', 'b'.repeat(40), { [path]: 'New moving-branch text.' });
    await consoleSave(page).click(); await expect(page.locator('.flash')).toContainText('角色配置已保存');
    const next = (await admin('/api/repositories/101/roles')).value;
    expect(next.configuration.roles.find(r => r.role_id === 'dev').skill_bundle_refs.map(ref => ref.id)).toContain('console');
    expect(next.skill_inputs.find(b => b.id === 'console').source.files[0].content).toBe('Keep this edited source and its role binding.');
    expect(next.configuration.skills.find(b => b.id === 'repository')).toEqual(saved.skills.find(b => b.id === 'repository'));
    const migrated = next.skill_inputs.find(b => b.id === 'migrated'); expect(migrated.source.type).toBe('inline'); expect(migrated.source.files[0].content).toBe('Previously bound review instructions.');
    await page.reload(); await expect(catalogue.getByLabel('技能包名称', { exact: true })).toBeVisible();
    await select(catalogue, 'repository'); await expect(catalogue).toContainText('草稿指定的提交与当前仓库缓存不同'); await expect(catalogue.getByLabel('固定仓库提交', { exact: true })).toHaveValue('a'.repeat(40));
    await expect(catalogue.getByRole('region', { name: '已保存技能版本', exact: true })).toContainText('Tester');
  } finally { await h.stop(); }
});

test('a skill draft survives a version conflict, while permission loss clears private files', async ({ page }) => {
  const { h, admin, catalogue } = await prepared(page);
  try {
    await select(catalogue, 'console'); await catalogue.getByLabel('文件内容', { exact: true }).fill('Unsaved content stays here.');
    const before = (await admin('/api/repositories/101/roles')).value;
    await admin('/api/repositories/101/roles', 'PUT', { expected_revision: before.revision, enabled: false, roles: [{ role_id: 'reviewer', responsibility: 'A concurrent update.' }] });
    await consoleSave(page).click(); await expect(page.getByRole('alert').filter({ hasText: '角色配置已被别人修改' })).toBeVisible();
    await expect(catalogue.getByLabel('文件内容', { exact: true })).toHaveValue('Unsaved content stays here.');
    await page.route('**/api/repositories/101/roles', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' }));
    await compareWithServer(page); await expect(page.locator('#project-page')).toContainText('已清空本页草稿');
    await expect(page.getByLabel('文件内容', { exact: true })).toHaveCount(0); await expect(page.locator('#project-page')).not.toContainText('Unsaved content stays here.');
  } finally { await h.stop(); }
});

test('Skill Library CRUD/import, built-in bundle upgrades, multi-bundle role preview, and management assistant skills work end-to-end (#1359)', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const upgradeDir = await mkdtemp(join(tmpdir(), 'e2e-skill-upgrade-'));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const rules = new RuleService(h.store);
    rules.cache('101', 'c'.repeat(40), {
      '.agents/skills/repo-ops/SKILL.md': '---\nname: repo-ops\ndescription: Repository operations checklist.\n---\n# Repo Ops\nRun smoke checks.',
      '.agents/skills/repo-ops/references/runbook.md': 'Verify healthz endpoint.',
    });

    // Save a custom role config first so built-in bundles are pinned at v1.
    const seeded = await admin('/api/repositories/101/roles', 'PUT', {
      expected_revision: 0,
      roles: [{ role_id: 'dev', responsibility: 'Custom dev note.' }],
    });
    expect(seeded.status).toBe(200);

    // Mint v2 of built-in `test-driven-development` so upgrade notice triggers on `dev-practices`.
    await mkdir(join(upgradeDir, 'test-driven-development'), { recursive: true });
    await writeFile(
      join(upgradeDir, 'test-driven-development', 'SKILL.md'),
      '---\nname: test-driven-development\ndescription: Upgraded TDD workflow v2.\n---\n# TDD v2\nWrite failing test first.\n',
      'utf8',
    );
    syncBuiltinSkills(h.store, { root: upgradeDir, imageTag: 'v2.0.0' });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();

    // 1. Roles Overview: no duplicate embedded skill editor; shows upgrade notice + nav links to 技能库 and 技能包目录.
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.role-skill')).toHaveCount(0);
    await expect(page.getByTestId('overview-bundle-upgrades')).toContainText('dev-practices');
    await expect(page.getByTestId('role-skill-library-link')).toBeVisible();
    await expect(page.getByTestId('role-skills-link')).toBeVisible();

    // 2. Skill Library (?view=library): inspect built-in, create console skill v1, edit to v2, switch back to v1, import from repo cache.
    await page.getByTestId('role-skill-library-link').click();
    const lib = page.getByTestId('skill-library-workspace');
    await expect(lib).toBeVisible({ timeout: 15000 });
    await expect(lib).toContainText('test-driven-development');
    await expect(lib).toContainText('roadmap-decomposition');

    // Create console Skill v1
    await page.getByTestId('create-console-skill-btn').click();
    await lib.getByLabel('Skill slug', { exact: true }).fill('release-notes');
    await lib.getByLabel('文件内容 1', { exact: true }).fill('---\nname: release-notes\ndescription: Release notes checklist.\n---\n# Release Notes v1\nList breaking changes.');
    await page.getByTestId('submit-create-skill').click();
    await expect(lib).toContainText('已创建控制台 Skill「release-notes」（v1）');

    // Edit console Skill -> v2, then view v1 in version history
    await page.getByTestId('edit-console-skill-btn').click();
    await lib.getByLabel('编辑文件内容 1', { exact: true }).fill('---\nname: release-notes\ndescription: Release notes checklist v2.\n---\n# Release Notes v2\nInclude migration guide.');
    await page.getByTestId('save-console-skill-edit').click();
    await expect(lib).toContainText('已发布 release-notes v2');
    await expect(lib.locator('.skill-file-preview')).toContainText('Release Notes v2');
    await lib.getByLabel('查看技能版本', { exact: true }).selectOption('1');
    await expect(lib.locator('.skill-file-preview')).toContainText('Release Notes v1');

    // Import whole directory from trusted repo cache
    await page.getByTestId('import-repo-skill-btn').click();
    await page.getByTestId('import-all-cached-skills').click();
    await expect(lib).toContainText('已扫描 1 个仓库 Skill');
    await expect(lib).toContainText('repo-ops');

    // 3. Skill Bundles Catalog (?view=skills): see upgrade notice on dev-practices, one-click upgrade, add a library bundle, bind to Dev.
    await page.getByTestId('role-skills-link').click();
    const catalogue = page.getByRole('region', { name: '技能包目录', exact: true });
    await expect(catalogue).toBeVisible();
    await select(catalogue, 'dev-practices');
    await expect(page.getByTestId('bundle-upgrade-banner')).toContainText('v1 → v2');
    await page.getByTestId('upgrade-bundle-skills').click();
    await expect(page.getByTestId('bundle-upgrade-banner')).toHaveCount(0);

    // Add a new library bundle referencing our console skill `release-notes` and bind to Dev alongside existing bundles
    await catalogue.getByRole('button', { name: '添加技能包', exact: true }).click();
    const skillId = 'console:101:release-notes';
    await page.getByTestId('bundle-add-skill-select').selectOption(skillId);
    await page.getByTestId('bundle-add-skill-btn').click();
    await catalogue.getByRole('group', { name: '草稿绑定角色', exact: true }).getByRole('checkbox', { name: 'Developer', exact: true }).check();

    // 4. Role Editor (/roles/dev): multi-bundle checkboxes + effective skills preview + responsive check at 390px
    await goRolePage(page, { role: 'Dev' });
    await openRoleFormAdvanced(page);
    await expect(page.getByTestId('role-skill-bundles').locator('input[data-bundle-id="dev-practices"]')).toBeChecked();
    await expect(page.getByTestId('role-skill-bundles').locator('input[data-bundle-id="ci-gates"]')).toBeChecked();
    await expect(page.getByTestId('role-skill-bundles').locator('input[data-bundle-id="skills_1"]')).toBeChecked();
    await expect(page.getByTestId('role-effective-skills')).toContainText('release-notes');
    await expect(page.getByTestId('role-effective-skills')).toContainText('.agents/skills/repo-ops');

    await consoleSave(page).click();
    await expect(page.locator('.flash')).toContainText('角色配置已保存');
    const afterSave = (await admin('/api/repositories/101/roles')).value;
    expect(afterSave.bundle_upgrades).toEqual([]);
    expect(afterSave.configuration.roles.find(r => r.role_id === 'dev').skill_bundle_refs.map(ref => ref.id)).toEqual(['ci-gates', 'dev-practices', 'skills_1']);

    // Deletion protection on in-use console skill
    await goRolePage(page, { view: 'library' });
    await lib.locator('button[data-skill-id="console:101:release-notes"]').click();
    await page.getByTestId('delete-project-skill-btn').click();
    await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(lib.getByRole('alert')).toContainText('仍被当前角色配置的技能包引用');

    // Mobile 390px viewport overflow check across library & skills views
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await goRolePage(page, { view: 'skills' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // 5. Global Management Assistant settings: edit skill bundles and save
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { location.hash = '#/settings/management-assistant'; });
    const mgmtBundles = page.getByTestId('service-role-skill-bundles');
    await expect(mgmtBundles).toBeVisible({ timeout: 15000 });
    await expect(mgmtBundles.locator('input[data-bundle-id="ci-gates"]')).toBeChecked();
    await expect(mgmtBundles.locator('input[data-bundle-id="feishu-cards"]')).toBeChecked();
    await mgmtBundles.locator('input[data-bundle-id="feishu-cards"]').uncheck();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('main')).toContainText('已保存');
    const srAfter = (await admin('/api/service-roles')).value;
    expect(srAfter.service_roles[0].skill_bundle_ids).toEqual(['ci-gates']);

    expect(errors).toEqual([]);
  } finally {
    await rm(upgradeDir, { recursive: true, force: true });
    await h.stop();
  }
});
