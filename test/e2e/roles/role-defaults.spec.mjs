import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { consoleSave, consoleSaveStatus } from '../helpers/console-save.mjs';

const following = '正在使用默认配置，内置默认更新时自动跟随。';

// #1068: without a configuration of its own a project shows the defaults in force; saving a change makes it the
// project's own; restoring the defaults returns to them. Each screen at 1440 and 390.
test('#1068 未配置时直接展示生效的默认配置，保存后为自定义，可恢复默认', async ({ page }) => {
  test.setTimeout(150000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  const shoot = async name => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
  };
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const status = page.locator('[data-role-version]').first(), table = page.getByRole('table', { name: '角色解析结果' });

    // 1. The first screen: the role list of the defaults in force, which the API reports too.
    const fresh = (await admin('/api/repositories/101/roles')).value;
    expect([fresh.configured, fresh.configuration.follows_default]).toEqual([false, true]);
    expect(fresh.configuration.roles.map(role => role.harness_ref.id)).toEqual(fresh.configuration.roles.map(() => fresh.recommended_backend));
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(status).toHaveText(following, { timeout: 15000 });
    await expect(consoleSaveStatus(page)).toHaveText(following);
    await expect(consoleSave(page)).toBeHidden();
    await expect(table).toBeVisible();
    await expect(table.locator('tr[data-role]')).toHaveCount(fresh.configuration.roles.length);
    for (const role of fresh.configuration.roles) await expect(table.locator(`tr[data-role=${role.role_id}]`)).toContainText('默认配置');
    // No intro, fold or empty bar in front of it, and no way back to defaults it already follows.
    await expect(page.getByRole('button', { name: '使用推荐配置', exact: true })).toHaveCount(0);
    await expect(page.locator('details.role-advanced')).toHaveCount(0);
    await expect(page.locator('.roles-page > .actions.role-save')).toHaveCount(1);
    await expect(page.locator('.roles-page > .actions.role-save')).toHaveAttribute('data-testid', 'console-save-bar');
    await expect(page.getByTestId('restore-default-roles')).toHaveCount(0);
    // A role page shows the same backend the server runs; its fold draws a marker.
    await page.getByTestId('role-list-manager').click();
    await expect(page.getByLabel('manager Agent 后端', { exact: true })).toHaveValue(fresh.recommended_backend);
    await expect(page.getByTestId('role-form').getByText(/^默认配置 · /)).toBeVisible();
    const marker = await page.getByTestId('role-form-advanced').locator(':scope > summary').evaluate(el => getComputedStyle(el, '::before').content);
    expect(marker).toBe('"▸"');
    await page.getByTestId('role-list-link').click();
    await expect(status).toHaveText(following);
    await shoot('defaults');

    // 2. A change to save says it leaves the defaults; afterwards the configuration is the project's own.
    await table.locator('tr[data-role=ux]').getByRole('checkbox').uncheck();
    await expect(consoleSaveStatus(page)).toHaveText('有未保存的更改。保存后成为自定义配置，不再跟随内置默认；正在运行的任务不受影响。');
    await consoleSave(page).click();
    await expect(page.locator('.flash')).toHaveText('角色配置已保存为自定义配置，不再跟随内置默认。新任务使用新配置；收回权限会阻止后续调用');
    await expect(status).toHaveText('已保存');
    await expect(table.locator('tr[data-role=ux]')).toContainText('已关闭 · 已保存');
    await expect(page.getByTestId('role-config-source')).toContainText('这是项目自己的配置，内置默认更新时不会改变。');
    const custom = (await admin('/api/repositories/101/roles')).value;
    expect([custom.configured, custom.configuration.follows_default, custom.revision]).toEqual([true, undefined, 1]);
    expect(custom.configuration.roles.find(role => role.role_id === 'ux').enabled).toBe(false);
    await shoot('custom');

    // 3. Restoring the defaults asks first; cancelling keeps the custom configuration.
    await page.getByTestId('restore-default-roles').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('恢复默认配置？');
    await expect(dialog).toContainText('当前配置保留在修订历史里；正在运行的任务继续使用开始时的配置。');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(status).toHaveText('已保存');
    expect((await admin('/api/repositories/101/roles')).value.revision).toBe(1);
    await page.getByTestId('restore-default-roles').click();
    await page.getByRole('dialog').getByRole('button', { name: '恢复默认', exact: true }).click();
    await expect(page.locator('.flash')).toHaveText('已恢复默认配置。新任务按内置默认运行，内置默认更新时自动跟随');
    await expect(status).toHaveText(following);
    await expect(table.locator('tr[data-role=ux]')).toContainText('已启用 · 默认配置');
    await expect(page.getByTestId('restore-default-roles')).toHaveCount(0);
    const restored = (await admin('/api/repositories/101/roles')).value;
    expect([restored.configured, restored.configuration.follows_default, restored.revision]).toEqual([false, true, 2]);
    expect(restored.revisions.map(row => row.revision)).toEqual([2, 1]);
    await shoot('restored');
  } finally { await h.stop(); }
});
