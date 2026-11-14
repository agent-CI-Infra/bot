import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

test('超级管理员按组织分组选择项目管理员的仓库，并在用户列表里看到和修改', async ({ page }) => {
  const h = await harness(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    for (const [id, name, owner, login] of [['102', 'fixture/project-102', '10', 'fixture'], ['201', 'other/app', '20', 'other']])
      h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at) VALUES(?,?,?,?,?,0,1,?)`,
        a.id, id, name, owner, login, new Date().toISOString());
    await page.goto(h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '全局设置', exact: true }).click(); await page.locator('.project-nav').getByRole('link', { name: '用户', exact: true }).click();
    await page.getByRole('button', { name: '新增用户', exact: true }).click();
    // One group per organization; its first option is the whole organization, and repositories not enabled yet are listed too.
    const editor = page.locator('#editor'), picker = editor.getByLabel('仓库权限');
    expect(await picker.evaluate(select => [...select.querySelectorAll('optgroup')].map(group => [group.label, ...[...group.children].map(option => option.textContent)]))).toEqual([
      ['fixture', '整个组织 fixture（含以后启用的仓库）', 'fixture/project-101', 'fixture/project-102（未启动）'], ['other', '整个组织 other（含以后启用的仓库）', 'other/app（未启动）']]);
    // A super administrator sees every project, so the choice is not offered.
    await editor.locator('select[name=role]').selectOption('super_admin'); await expect(picker).toBeHidden();
    await editor.locator('select[name=role]').selectOption('project_admin');
    await editor.getByLabel('用户名', { exact: true }).fill('member'); await editor.getByLabel('初始密码（至少 12 位）', { exact: true }).fill(testPassword());
    await picker.selectOption(['organization:10', 'repository:201']); await page.getByRole('button', { name: '保存', exact: true }).click();
    const row = page.locator('#settings-panel .row', { hasText: 'member' });
    await expect(row).toContainText('整个组织：fixture · 仓库：other/app（未启动）');
    // The same list edits the grants later, starting from what is held now.
    await row.getByRole('button', { name: '修改仓库权限', exact: true }).click();
    await expect(page.getByRole('heading', { name: '修改 member 的仓库权限' })).toBeVisible();
    expect(await picker.evaluate(select => [...select.selectedOptions].map(option => option.value))).toEqual(['organization:10', 'repository:201']);
    await picker.selectOption(['repository:101']); await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(row).toContainText('仓库：fixture/project-101'); await expect(row).not.toContainText('整个组织');
    const { assignments, organization_assignments } = (await admin('/api/project-admin-assignments')).value;
    expect([assignments.map(r => r.repository_id), organization_assignments]).toEqual([['101'], []]);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
