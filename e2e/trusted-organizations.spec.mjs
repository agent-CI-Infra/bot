import { test, expect } from '@playwright/test';
import { identityFixture } from '../test/identity-fixture.mjs';

// #848: a super administrator trusts an organization in 全局设置 → 项目管理; its repository administrators then start their
// own repositories from the project list.
const installed = (f, id, owner = '10', login = 'fixture') => {
  const now = new Date().toISOString();
  f.h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?,?,'77',?,?,?,1,1,?)`, f.a.id, id, login + '/project-' + id, owner, login, now);
  if (owner === '10') f.h.store.run("INSERT OR REPLACE INTO installation_repositories VALUES('github.com/123/77',?,?,'10','fixture',1,1,?)", id, 'fixture/project-' + id, now);
};
async function login(page, f, path) {
  await page.goto(f.h.admin + path);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('a trusted organization lets its repository administrator start a repository; others still wait for a super administrator', async ({ page, browser }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    installed(f, '103'); installed(f, '105', '30', 'other-org'); f.state.accessible = ['101', '103'];
    const model = (await f.admin('/api/models', 'POST', { model_name: '共享模型 A', api_url: 'http://127.0.0.1:9/v1', api_key: 'fixture-key' })).value.model;
    // A GitHub repository admin (not an owner) sees 103 waiting for a super administrator.
    Object.assign(f.state, { id: 42, login: 'repo-admin', owner: false, permission: 'admin' });
    const member = await (await browser.newContext()).newPage();
    await member.goto(f.h.admin); await member.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(member.getByRole('button', { name: '退出登录' })).toBeVisible();
    await member.goto(f.h.admin + '/#/projects');
    await expect(member.getByRole('heading', { name: '等待超级管理员启动' })).toBeVisible();
    await expect(member.locator('[data-key="pending:103"]').getByRole('button', { name: '复制提醒' })).toBeVisible();

    // The super administrator trusts fixture in the settings card, with the shared model and development on.
    await login(page, f, '/#/settings/projects');
    const card = page.locator('section.side-card', { has: page.getByRole('heading', { name: '受信任的组织' }) });
    await expect(card).toContainText('还没有受信任的组织');
    await card.getByLabel('要信任的组织', { exact: true }).selectOption('10');
    await card.getByLabel('新组织 的默认模型', { exact: true }).selectOption({ label: '共享模型 A' });
    await card.locator('.trusted-organization-add').getByLabel('启动时同时开启自动开发').check();
    await card.getByRole('button', { name: '信任', exact: true }).click();
    await expect(card.locator('.trusted-organization')).toContainText('由 administrator 于');
    await expect(card.getByLabel('fixture 的默认模型', { exact: true })).toHaveValue(model.id);

    // The repository administrator now starts 103 themselves, with the organization's defaults.
    await member.reload();
    const row = member.locator('[data-key="pending:103"]');
    await expect(member.getByRole('heading', { name: '待启动的仓库' })).toBeVisible();
    await expect(row).toContainText('可自行启动');
    await row.getByRole('button', { name: '启动', exact: true }).click();
    await expect(member.locator('[data-key="103"]').first()).toContainText('fixture/project-103');
    expect({ ...f.h.store.get("SELECT enabled,development_enabled,model_id FROM policies WHERE repository_id='103'") }).toEqual({ enabled: 1, development_enabled: 1, model_id: model.id });

    // An untrusted owner's repository: the super administrator's start dialog offers to trust it.
    await page.goto(f.h.admin + '/#/projects');
    await page.locator('[data-key="105"]').first().getByRole('button', { name: '启动', exact: true }).click();
    await expect(page.locator('#activation-trust')).toContainText('信任 other-org');
    await page.locator('#activation-trust').getByRole('checkbox').check();
    await page.locator('#activation-form').getByRole('button', { name: '启动', exact: true }).click();
    await expect(page.locator('#activation-view')).not.toBeVisible();
    expect(f.h.store.get("SELECT owner_login FROM trusted_organizations WHERE owner_id='30'")?.owner_login).toBe('other-org');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
