import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup } from '../test/helpers.mjs';

test('全局设置的服务角色页查看和修改内置角色，新建、停用并删除自定义角色，陈旧版本不覆盖', async ({ page }) => {
  mkdirSync('.tmp/service-roles', { recursive: true });
  const h = await harness(), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const { admin, password } = await setup(h);
    const shared = (await admin('/api/models', 'POST', { model_name: 'Shared assistant', api_url: 'http://127.0.0.1:9/v1', api_key: 'fixture-provider-key' })).value.model;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/settings/service-roles'); await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('#settings-panel');
    await expect(page.getByRole('navigation', { name: '全局设置类别' }).getByRole('link', { name: '服务角色', exact: true })).toHaveAttribute('aria-current', 'page');
    const cardOf = name => panel.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const assistant = cardOf('管理助手'), repository = cardOf('仓库问答助手');
    await expect(assistant).toContainText('继承当前用户自己的有效权限'); await expect(assistant).toContainText('还没有模型请求');
    await expect(assistant.locator('.endpoint-warning')).toContainText('不会改用其他模型');
    await expect(repository).toContainText('GitHub 内容：只读'); await expect(repository).toContainText('其他角色的任务：禁止');
    await expect(assistant.getByRole('button', { name: '删除角色' })).toHaveCount(0);

    // The management assistant: choose the shared model and a budget.
    await assistant.locator('select[name=model_id]').selectOption(shared.id);
    await assistant.locator('input[name=budget_limit]').fill('5');
    await assistant.getByRole('button', { name: '保存', exact: true }).click();
    await expect(assistant).toContainText('已保存'); await expect(assistant).toContainText('Shared assistant · 127.0.0.1:9');
    await expect(assistant).toContainText('USD 5.00（累计）');
    expect(h.store.get("SELECT model_id,budget FROM service_roles WHERE id='management-assistant'")).toEqual({ model_id: shared.id, budget: JSON.stringify({ currency: 'USD', limit_amount: 5 }) });
    await page.screenshot({ path: '.tmp/service-roles/settings-desktop.png', fullPage: true });

    // The repository assistant: allow reading other roles' tasks. An edit saved elsewhere first is reported, not overwritten.
    await repository.getByLabel('其他角色的任务', { exact: true }).selectOption('read');
    const current = (await admin('/api/service-roles')).value.service_roles.find(r => r.id === 'repository-assistant');
    await admin('/api/service-roles/repository-assistant', 'PATCH', { expected_revision: current.revision, responsibility: '另一个窗口的修改' });
    await repository.getByRole('button', { name: '保存', exact: true }).click();
    await expect(repository.getByRole('alert')).toHaveText('这个角色已被其他操作修改，请刷新本页、核对当前配置后重新保存。');
    expect(JSON.parse(h.store.get("SELECT permissions FROM service_roles WHERE id='repository-assistant'").permissions).project_tasks).toBe('none');

    // A custom role: create, disable, then delete.
    const create = cardOf('新建服务角色');
    await create.getByLabel('名称', { exact: true }).fill('可信 committer 群'); await create.getByRole('button', { name: '新建', exact: true }).click();
    const custom = cardOf('可信 committer 群');
    await expect(custom).toContainText('自定义'); await expect(custom).toContainText('委派角色：拒绝');
    await custom.getByLabel('启用').uncheck(); await custom.getByRole('button', { name: '保存', exact: true }).click();
    await expect(custom).toContainText('已停用');
    await custom.getByRole('button', { name: '删除角色' }).click(); await page.getByRole('button', { name: '删除', exact: true }).click();
    await expect(custom).toContainText('已删除');
    expect(h.store.get("SELECT count(*) n FROM service_roles WHERE builtin=0").n).toBe(0);

    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await expect(cardOf('管理助手')).toContainText('Shared assistant');
    await page.screenshot({ path: '.tmp/service-roles/settings-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
