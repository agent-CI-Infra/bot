import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { consoleSave } from '../helpers/console-save.mjs';

const output = '.tmp/project-triggers';
async function screenshots(page, role, name, target) {
  mkdirSync(output, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await target.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `${output}/${name}-${role}-${width}.png`, fullPage: name === 'events' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
for (const role of ['super_admin', 'project_admin']) test(`${role} configures project-wide listeners outside Manager and preserves other settings`, async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [], roleReads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/repositories\/101\/roles(?:\?|$)/.test(request.url())) roleReads.push(request.url()); });
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const memberPassword = testPassword();
    await admin('/api/users', 'POST', { username: 'project-manager', password: memberPassword, repository_ids: ['101'] });
    const { configuration } = (await admin('/api/repositories/101/roles')).value;
    h.store.run("INSERT INTO settings VALUES('roles:101',?)", JSON.stringify({ ...configuration, enabled: false, controller: { role: 'manager', entries: { development: false, request: false, review: false, actions: false } } }));
    await page.goto(h.admin + '/#/projects/101/basic');
    await page.getByLabel('用户名', { exact: true }).fill(role === 'super_admin' ? 'administrator' : 'project-manager');
    await page.getByLabel('密码', { exact: true }).fill(role === 'super_admin' ? password : memberPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const entry = page.getByRole('link', { name: /监听与触发设置/ });
    await expect(entry).toBeVisible(); await expect(page.getByLabel('可开发并开 PR', { exact: true })).toHaveCount(0);
    await screenshots(page, role, 'basic', entry);
    await entry.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/triggers$/);
    await expect(page.getByRole('navigation', { name: '项目设置类别' }).getByRole('link', { name: '监听与触发', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: '监听的事件来源', exact: true })).toBeVisible();
    expect(roleReads).toEqual([]); // Project listeners do not need to load any role definition.
    await expect(page.getByLabel('Manager 提示词', { exact: true })).toHaveCount(0);
    // The capability ceiling (#850): the test repository starts at read.
    const readOnly = page.getByLabel('只读问答', { exact: true }), development = page.getByLabel('可开发并开 PR', { exact: true });
    await expect(readOnly).toBeChecked(); await expect(page.getByLabel('可评论和打标签', { exact: true })).not.toBeChecked();
    await development.check(); await page.getByRole('button', { name: '保存能力上限', exact: true }).click();
    await expect(page.locator('.flash')).toHaveText('已保存');
    expect((await admin('/api/repositories/101/policy')).value.policy.capability_ceiling).toBe('develop');
    const actions = page.getByLabel('接收默认分支和版本标签的 Actions 失败事件', { exact: true });
    await expect(actions).not.toBeChecked(); await actions.check();
    await page.getByLabel('PR 推送新提交', { exact: true }).uncheck();
    await page.getByRole('button', { name: '保存事件开关', exact: true }).click();
    await expect(page.getByText('已保存事件开关', { exact: true })).toBeVisible();
    await page.reload(); await expect(actions).toBeChecked();
    await expect(page.getByLabel('PR 推送新提交', { exact: true })).not.toBeChecked();

    // Manager keeps its own prompt/role settings and links to the project-level listener page.
    await page.getByRole('navigation', { name: '项目设置类别' }).getByRole('link', { name: '角色', exact: true }).click();
    await page.getByTestId('role-list-manager').click();
    await expect(page.getByLabel('Manager 提示词', { exact: true })).toBeVisible();
    await expect(actions).toHaveCount(0); await expect(readOnly).toHaveCount(0); await expect(development).toHaveCount(0);
    await page.getByLabel('Manager 提示词', { exact: true }).fill('Choose useful work within the project authority.');
    await page.getByRole('button', { name: '保存 Manager 提示词', exact: true }).click();
    await expect(page.getByText('已保存 Manager 提示词', { exact: true })).toBeVisible();
    await page.getByLabel('职责', { exact: true }).fill('Coordinate the task.'); await consoleSave(page).click();
    await expect(page.locator('.flash')).toHaveText('角色配置已保存，新任务使用新配置；收回权限会阻止后续调用');
    await screenshots(page, role, 'manager', page.getByRole('heading', { name: '项目 Manager 设置', exact: true }));
    await page.getByRole('link', { name: /监听与触发设置/ }).click();
    await expect(actions).toBeChecked(); await expect(development).toBeChecked();
    await actions.uncheck(); await page.getByRole('button', { name: '保存事件开关', exact: true }).click();
    await expect(page.getByText('已保存事件开关', { exact: true })).toBeVisible();
    await readOnly.check(); await page.getByRole('button', { name: '保存能力上限', exact: true }).click();
    await expect(page.locator('.flash')).toHaveText('已保存');
    await page.reload(); await expect(actions).not.toBeChecked(); await expect(readOnly).toBeChecked(); await expect(development).not.toBeChecked();
    expect((await admin('/api/repositories/101/policy')).value.policy.capability_ceiling).toBe('read');
    expect((await admin('/api/repositories/101/manager')).value.manager.events['pull_request.synchronize']).toBe(false);
    await screenshots(page, role, 'policy', page.getByRole('heading', { name: '能力上限', exact: true }));
    await screenshots(page, role, 'events', page.getByRole('heading', { name: '监听的事件来源', exact: true }));
    await page.getByRole('navigation', { name: '项目设置类别' }).getByRole('link', { name: '角色', exact: true }).click();
    await expect(page.getByLabel('开启角色协调', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/交给主控（/)).toHaveCount(0);
    await screenshots(page, role, 'roles', page.getByRole('link', { name: /监听与触发设置/ }));
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('project listeners load without the role engine, retry failed reads and reject conflicting saves', async ({ page }) => {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    let failRead = true;
    await page.route('**/api/repositories/101/manager', route => failRead ? route.fulfill({ status: 503, json: { error: 'unavailable' } }) : route.continue());
    await page.goto(h.admin + '/#/projects/101/triggers');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '监听与触发配置读取失败', exact: true })).toBeVisible();
    failRead = false; await page.getByRole('button', { name: '重新读取监听配置', exact: true }).click();
    const actions = page.getByLabel('接收默认分支和版本标签的 Actions 失败事件', { exact: true }); await expect(actions).not.toBeChecked();
    const { manager } = (await admin('/api/repositories/101/manager')).value;
    expect((await admin('/api/repositories/101/manager', 'PUT', { expected_revision: manager.prompt.revision, prompt: 'Updated elsewhere.' })).status).toBe(200);
    await actions.check(); await page.getByRole('button', { name: '保存事件开关', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '项目配置已被修改' })).toBeVisible();
    expect((await admin('/api/repositories/101')).value.policy.actions_failures_enabled).toBe(0);
    await page.reload(); await expect(actions).not.toBeChecked();
  } finally { await h.stop(); }
});
