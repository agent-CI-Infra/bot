import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { openRoleAdvanced, goRolePage } from '../helpers/open-role-advanced.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { registerRoleHarness, harnesses } from '../../../dist/roles/harness.js';

// #1192 review F1/F4: a driver registered by the product that ships it (environment `workspace` with task tools) must
// read as a product-managed backend on a real page, at phone and desktop widths, and its role box must not offer the
// tool-volume path — that volume installs Claude Code and Codex, not an ACP product.
test('a product-declared backend reads as product-managed at 390 and 1440', async ({ page }) => {
  registerRoleHarness({
    id: 'declared_page_fixture', version: '1', session: 'external_session', events: 'acp_session_events',
    kinds: ['writer', 'observer', 'evaluator'], model_api: ['openai-chat-completions'], environment: 'workspace',
    runtime: { package: 'fixture-product', version: '1' },
    capabilities: { raw_evidence: 'task_tools', cancel: 'protocol_then_kill', isolation: 'none', version_binding: true,
      output_validation: true, fresh_context: true, recovery: ['rebuilt_from_task_records'] },
  }, () => async () => ({ summary: 'declared fixture, not a real driver' }));
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }), maxBodyBytes: 1024 * 1024 }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await openRoleAdvanced(page);
    const card = page.getByTestId('backend-availability-card');
    await expect(card).toBeVisible();
    const row = card.locator('tr[data-backend=declared_page_fixture]');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(row).toContainText('由产品声明管理');
      await expect(row).toContainText('控制台尚未检查');
      await expect(row.locator('.status')).toHaveText('由产品管理');
      await expect(row).not.toContainText('未就绪');
      await expect(row).not.toContainText('请平台管理员');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    // The role form states the same declaration and offers no tool-volume action.
    await goRolePage(page, { role: 'dev' });
    await page.getByTestId('role-form').getByRole('combobox', { name: 'dev Agent 后端', exact: true }).selectOption('declared_page_fixture');
    const box = page.getByTestId('backend-runtime-status');
    await expect(box).toBeVisible();
    await expect(box).toContainText('由产品管理');
    await expect(box).toContainText('由产品自身管理');
    await expect(box).toContainText('控制台尚未检查');
    // #1192 review F6: this fixture has no `externalModel`, so it resolves the project's model through the relay.
    await expect(box).toContainText('平台网关（按角色配置解析）');
    await expect(box).not.toContainText('工具卷');
    await expect(box.getByRole('link', { name: '打开工具卷设置' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    // The registry is process-wide: drop the fixture so a following spec file in the same worker still sees exactly the
    // built-in backends. The adapter entry is unused once the metadata is gone and no role selects this id.
    const registered = harnesses.findIndex(entry => entry.id === 'declared_page_fixture');
    if (registered >= 0) harnesses.splice(registered, 1);
    await h.stop();
  }
});
