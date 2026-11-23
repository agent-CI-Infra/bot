import { test, expect } from '@playwright/test';
import { harness, setup } from '../../fixtures/helpers.mjs';

test('全局设置的管理助手页查看和修改管理助手，旧服务角色路由兼容跳转，陈旧版本不覆盖 (#1249)', async ({ page }) => {
  const h = await harness(), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const { admin, password } = await setup(h);
    const shared = (await admin('/api/models', 'POST', { model_name: 'Shared assistant', api_url: 'http://127.0.0.1:9/v1', api_key: 'fixture-provider-key' })).value.model;
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Legacy #/settings/service-roles address stays compatible and lands on 管理助手.
    await page.goto(h.admin + '/#/settings/service-roles'); await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('#settings-panel');
    await expect(page.getByRole('navigation', { name: '全局设置类别' }).getByRole('link', { name: '管理助手设置', exact: true })).toHaveAttribute('aria-current', 'page');
    const cardOf = name => panel.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const assistant = cardOf('管理助手');
    await expect(assistant).toContainText('全部能力已允许'); await expect(assistant).toContainText('还没有模型请求');
    await expect(assistant.getByLabel('使用虚拟电脑', { exact: true })).toHaveCount(0);
    await expect(assistant.getByLabel('使用任务浏览器', { exact: true })).toHaveCount(0);
    await expect(assistant.getByLabel('指派其他角色', { exact: true })).toBeDisabled();
    // Group assistant templates and creation form are retired from Global Settings (#1249).
    await expect(panel.getByRole('heading', { name: '仓库问答助手', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('heading', { name: '新建服务角色', exact: true })).toHaveCount(0);
    const backend = assistant.getByRole('combobox', { name: 'Agent 后端', exact: true });
    await expect(backend).toHaveValue('native');
    await expect(backend.locator('option[value=container_acp], option[value=icode], option[value=workswarm]')).toHaveCount(0);
    const captureBackend = async state => { for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 900 }); await expect(assistant.getByRole('combobox', { name: 'Agent 后端', exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);  } await page.setViewportSize({ width: 1440, height: 1000 }); };
    await captureBackend('before-save');
    await assistant.getByRole('combobox', { name: 'Agent 后端', exact: true }).selectOption('pi');
    await expect(assistant.locator('.endpoint-warning').filter({ hasText: '不会改用其他模型' })).toHaveCount(1);
    // This harness has no assistant computers: choosing Pi says that each of its turns would fail (#1254).
    await expect(assistant.getByRole('status').filter({ hasText: '助手电脑现在不可用' })).toContainText('Pi、Codex 和 Claude Code 的每一轮都要在助手电脑上运行');
    await expect(assistant.getByRole('button', { name: '删除角色' })).toHaveCount(0);

    // Choose the shared model and save.
    await assistant.locator('select[name=model_id]').selectOption(shared.id);
    await expect(assistant.locator('input[name=budget_limit]')).toHaveCount(0); await expect(assistant.locator('select[name=budget_currency]')).toHaveCount(0);
    await assistant.getByRole('button', { name: '保存', exact: true }).click();
    await expect(assistant).toContainText('已保存'); await expect(assistant).toContainText('Shared assistant · 127.0.0.1:9');
    await expect(assistant).not.toContainText('预算上限');
    expect(h.store.get("SELECT harness FROM service_roles WHERE id='management-assistant'").harness).toBe('pi');
    expect(h.store.get("SELECT model_id,budget FROM service_roles WHERE id='management-assistant'")).toEqual({ model_id: shared.id, budget: null });
    await page.goto(h.admin + '/#/settings/management-assistant');
    await expect(assistant.getByRole('combobox', { name: 'Agent 后端', exact: true })).toHaveValue('pi');
    await captureBackend('saved-reloaded');

    // Stale revision conflict is reported without overwriting.
    await assistant.locator('textarea[name=prompt]').fill('先给结论，再列出处。');
    const current = (await admin('/api/service-roles')).value.service_roles.find(r => r.id === 'management-assistant');
    await admin('/api/service-roles/management-assistant', 'PATCH', { expected_revision: current.revision, responsibility: '另一个窗口的修改' });
    await assistant.getByRole('button', { name: '保存', exact: true }).click();
    await expect(assistant.getByRole('alert')).toHaveText('配置已被其他操作修改，请刷新本页、核对当前配置后重新保存。');
    expect(h.store.get("SELECT prompt FROM service_roles WHERE id='management-assistant'").prompt).toBe('');

    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await expect(cardOf('管理助手')).toContainText('Shared assistant');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
