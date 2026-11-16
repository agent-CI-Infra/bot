import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { RuleService } from '../dist/rules/service.js';
import { consoleSave } from './console-save.mjs';
import { goRolePage } from './open-role-advanced.mjs';
import { managementFixture } from '../test/management-fixture.mjs';

const out = '.tmp/retired-rules-935';

// A project upgraded from a version that read the repositories' .bot/ files (#935): the files were imported once, the
// project pages say they can be deleted, the labels are settings and the Manager page lists the skills and the import.
test('an upgraded project shows its imported .bot/ files as deletable, its labels as settings and its skills on the Manager page', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    // The store as the previous version left it, then the upgrade.
    h.store.run("DELETE FROM settings WHERE key='rules.bot_imported'"); h.store.run('DELETE FROM rule_imports'); h.store.run('DELETE FROM project_labels');
    h.store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '101', 'a'.repeat(40), JSON.stringify({
      '.bot/rules/labels.md': 'review_label: team-reviewed\n\n# Labels\nUse type/* labels.\n', '.bot/rules/pr-review.md': 'Review the public API first.\n',
      '.bot/computer.yaml': 'packages: [jq]\n', '.agents/skills/ci/SKILL.md': '---\ndescription: Diagnose the CI pipeline.\n---\n# CI\nRun the checks.\n' }), new Date().toISOString());
    new RuleService(h.store);
    // No console spec was saved: the imported computer fields are the project's spec until it is first saved.
    expect((await admin('/api/repositories/101/rules')).value.rules.computer.packages).toEqual(['jq']);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/101/basic');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const notice = page.locator('[data-retired-rules]');
    await expect(notice).toContainText('仓库里的 .bot/ 文件已迁入角色配置，可以删除');
    await expect(notice).toContainText('.bot/rules/labels.md'); await expect(notice).toContainText('升级时已导入');
    await expect(page.getByLabel('检视标签', { exact: true })).toHaveValue('team-reviewed');
    await expect(page.getByLabel('开发标签', { exact: true })).toHaveValue('bot-develop');
    await page.screenshot({ path: `${out}/basic-1440.png` });
    // The labels save through the page's save bar; an empty review label means none.
    await page.getByLabel('检视标签', { exact: true }).fill('');
    await consoleSave(page).click();
    await expect.poll(async () => (await admin('/api/repositories/101/policy')).value.policy.review_label).toBe('');
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => window.scrollTo(0, 0));
    await notice.scrollIntoViewIfNeeded(); await expect(notice).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${out}/basic-390.png` });
    await page.getByLabel('检视标签', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/basic-labels-390.png` });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/101/roles');
    await goRolePage(page, { role: 'Manager' });
    const skills = page.getByRole('table', { name: '仓库 skill', exact: true });
    await expect(page.getByRole('heading', { name: '仓库 skill', exact: true })).toHaveCount(1);
    await expect(skills).toContainText('.agents/skills/ci/SKILL.md');
    await expect(page.locator('#project-page [data-retired-rules]')).toContainText('.bot/computer.yaml');
    const record = page.locator('[data-overview-anchor="rule-import"]');
    await expect(record).toContainText('.bot/ 规则文件导入记录');
    await expect(record).toContainText('.bot/rules/pr-review.md'); await expect(record).toContainText('team-reviewed'); await expect(record).toContainText('packages');
    await expect(page.getByLabel('Manager 提示词', { exact: true })).toHaveValue(/由 `\.bot\/rules\/pr-review\.md` 导入/);
    await expect(page.locator('#project-page')).not.toContainText('控制台覆盖');
    await page.locator('[data-rule-file=".agents/skills/ci/SKILL.md"]').getByRole('button', { name: '查看内容', exact: true }).click();
    await expect(page.locator('#project-detail .rule-card')).toContainText('Run the checks.');
    await expect(page.getByRole('heading', { name: 'skill ci', exact: true }).first()).toBeVisible();
    // Full viewports at the changed cards: the skills card, then the import record.
    const card = page.locator('[data-overview-anchor="rule-sources"]');
    await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await page.evaluate(() => window.scrollBy(0, -120));
    await page.screenshot({ path: `${out}/manager-skills-1440.png` });
    await record.evaluate(node => node.scrollIntoView({ block: 'center' })); await page.screenshot({ path: `${out}/manager-import-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await page.evaluate(() => window.scrollBy(0, -120));
    await page.screenshot({ path: `${out}/manager-skills-390.png` });
    await record.evaluate(node => node.scrollIntoView({ block: 'center' })); await page.screenshot({ path: `${out}/manager-import-390.png` });
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

// The management chat's Manager section form offers a configuration PR only for a section with a repository skill, and
// starts it from that skill's text; the other sections are saved in the Manager prompt.
test('the management chat offers a configuration PR only for a skill-backed section, starting from the skill', async ({ page }) => {
  const f = await managementFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    new RuleService(f.h.store).cache('101', 'a'.repeat(40), { '.agents/skills/release-notes/SKILL.md': '# Release notes\nGroup the changes by area.\n', '.bot/guide.md': '' });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    await page.getByRole('button', { name: '快捷操作', exact: true }).click();
    const workType = page.getByLabel('工作类型', { exact: true }), form = workType.locator('xpath=ancestor::form'), publish = form.getByRole('button', { name: '创建配置 PR', exact: true });
    await expect(form).toContainText('保存的是 Manager 提示词里这类工作的章节'); await expect(publish).toBeHidden();
    await workType.selectOption({ label: '发行说明 · repository' });
    await expect(page.getByLabel('默认提示词', { exact: true })).toHaveValue(/Group the changes by area/);
    await expect(form).toContainText('这类工作的文本来自仓库 skill .agents/skills/release-notes/SKILL.md'); await expect(publish).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
