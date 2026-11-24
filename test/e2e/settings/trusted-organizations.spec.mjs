import { test, expect } from '@playwright/test';
import { identityFixture } from '../../fixtures/identity-fixture.mjs';

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
    await expect(member.getByRole('heading', { name: '待接入的仓库' })).toBeVisible();
    await expect(member.locator('[data-key="pending:103"]')).toContainText('启动需超级管理员同意');
    await expect(member.locator('[data-key="pending:103"]').getByRole('link', { name: '开始接入 fixture/project-103' })).toHaveAttribute('href', '#/management');

    // The super administrator trusts fixture in the settings card, with the shared model and the develop ceiling.
    await login(page, f, '/#/settings/projects');
    const card = page.locator('section.side-card', { has: page.getByRole('heading', { name: '受信任的组织' }) });
    await expect(card).toContainText('还没有受信任的组织');
    await card.getByLabel('要信任的组织', { exact: true }).selectOption('10');
    await card.getByLabel('新组织 的默认模型', { exact: true }).selectOption({ label: '共享模型 A · 127.0.0.1:9' });
    await card.getByLabel('新组织 的默认能力上限', { exact: true }).selectOption('develop');
    await card.getByRole('button', { name: '信任', exact: true }).click();
    await expect(card.locator('.trusted-organization')).toContainText('由 administrator 于');
    await expect(card.getByLabel('fixture 的默认模型', { exact: true })).toHaveValue(model.id);
    await expect(card.getByLabel('fixture 的默认能力上限', { exact: true })).toHaveValue('develop');

    // The repository administrator now starts 103 themselves, with the organization's defaults.
    await member.reload();
    const row = member.locator('[data-key="pending:103"]');
    await expect(member.getByRole('heading', { name: '待接入的仓库' })).toBeVisible();
    await expect(row).toContainText('可自行启动');
    await expect(row).toContainText('所属组织已受信任，在管理助手确认后可以直接启动');
    // #934, #1133: 开始接入 opens the management assistant with the repository onboarding prompt prefilled.
    await row.getByRole('link', { name: '开始接入 fixture/project-103' }).click();
    await expect(member).toHaveURL(/#\/management$/);
    await expect(member.getByLabel('管理消息', { exact: true })).toHaveValue(/fixture\/project-103/);
    // The start itself is #848's: the same call the wizard's start item makes for a trusted organization.
    await member.evaluate(() => api('/api/installations/103/activate', 'POST', {}));
    await member.goto(f.h.admin + '/#/projects');
    await expect(member.locator('[data-key="103"]').first()).toContainText('fixture/project-103');
    expect({ ...f.h.store.get("SELECT enabled,capability_ceiling,development_enabled,model_id FROM policies WHERE repository_id='103'") }).toEqual({ enabled: 1, capability_ceiling: 'develop', development_enabled: 1, model_id: model.id });

    // An untrusted owner's repository: the super administrator's start dialog offers to trust it.
    await page.goto(f.h.admin + '/#/projects');
    await page.locator('[data-key="105"]').first().getByRole('button', { name: '启动', exact: true }).click();
    await expect(page.locator('#activation-trust')).toContainText('信任 other-org');
    // The start chooses the project's capability ceiling; it reviews by default.
    const ceiling = page.locator('#activation-form').getByLabel(/^能力上限：/);
    await expect(ceiling).toHaveValue('comment');
    await ceiling.selectOption('read');
    await expect(page.locator('#activation-ceiling-detail')).toContainText('不在 GitHub 上写任何内容');
    await page.locator('#activation-trust').getByRole('checkbox').check();
    await page.locator('#activation-form').getByRole('button', { name: '启动', exact: true }).click();
    await expect(page.locator('#activation-view')).not.toBeVisible();
    expect({ ...f.h.store.get("SELECT owner_login,capability_ceiling FROM trusted_organizations WHERE owner_id='30'") }).toEqual({ owner_login: 'other-org', capability_ceiling: 'read' });
    expect(f.h.store.get("SELECT capability_ceiling FROM policies WHERE repository_id='105'")?.capability_ceiling).toBe('read');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
