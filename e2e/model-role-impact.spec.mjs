import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

async function prepared(page, shared = false) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
    const created = await admin('/api/models', 'POST', { repository_id: shared ? null : '101', model_name: 'Role-only model', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() });
    expect(created.status).toBe(201); const model = created.value.model;
    if (shared) expect((await admin(`/api/models/${model.id}/projects`, 'PUT', { repository_ids: ['101'] })).status).toBe(200);
    const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: false, roles: [{
      role_id: 'reviewer', name: 'Release reviewer', enabled: false, harness_ref: { id: 'native' },
      model_profile_ref: { model_id: model.id, api: 'openai-chat-completions', tool_calls: true, structured_output: 'tool_call' }
    }] }); expect(saved.status, JSON.stringify(saved.value)).toBe(200);
    if (shared) expect((await admin('/api/onboarding/model', 'POST', { model_id: model.id })).status).toBe(201);
    await page.goto(h.admin + (shared ? '/#/settings/models' : '/#/projects/101/model'));
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(row(page)).toBeVisible(); return { h, admin, model };
  } catch (error) { await h.stop(); throw error; }
}
const row = page => page.locator('li.model-entry').filter({ has: page.locator('.model-address').filter({ hasText: /^Role-only model$/ }) });
const dialog = page => page.getByRole('dialog', { name: '删除模型 Role-only model？', exact: true });

test('role-only references remain clear before cancelling deletion on desktop and small phones', async ({ page }) => {
  const { h, admin, model } = await prepared(page), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(row(page).locator('.model-usage')).toHaveText('无项目默认或工作类型引用');
    const before = h.store.all('SELECT * FROM audit');
    await row(page).getByRole('button', { name: '删除', exact: true }).click();
    await expect(dialog(page)).toContainText('fixture/project-101 · Release reviewer（reviewer） · 已停用');
    await expect(dialog(page)).toContainText('显式模型引用会保留为不可用');
    await expect(dialog(page)).toContainText('不包括历史运行快照');
    mkdirSync('.tmp/model-role-impact-230/previews', { recursive: true });
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: width < 400 ? 568 : 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(width)).toBe(true);
      const cancel = dialog(page).getByRole('button', { name: '取消', exact: true }); await cancel.scrollIntoViewIfNeeded();
      await expect(cancel).toBeInViewport();
      if ([390, 1440].includes(width)) await page.screenshot({ path: `.tmp/model-role-impact-230/previews/model-impact-${width}.png` });
    }
    await dialog(page).getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
    expect((await admin(`/api/models/${model.id}`)).status).toBe(200); expect(h.store.all('SELECT * FROM audit')).toEqual(before); expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('shared deletion names service roles and onboarding without changing them on cancellation', async ({ page }) => {
  const { h, admin, model } = await prepared(page, true);
  try {
    const roles = h.store.all('SELECT * FROM service_roles');
    await row(page).getByRole('button', { name: '删除', exact: true }).click();
    await expect(dialog(page)).toContainText('管理助手（management-assistant）');
    await expect(dialog(page)).toContainText('仓库问答助手（repository-assistant）');
    await expect(dialog(page)).toContainText('接入向导的默认模型');
    await page.setViewportSize({ width: 390, height: 568 });
    await dialog(page).getByRole('button', { name: '取消', exact: true }).click();
    expect(h.store.all('SELECT * FROM service_roles')).toEqual(roles); expect((await admin('/api/onboarding')).value.model_id).toBe(model.id);
  } finally { await h.stop(); }
});

test('missing metadata blocks deletion and a late detail cannot open a confirmation on another project', async ({ page }) => {
  const { h, model } = await prepared(page); let release;
  try {
    let deletes = 0;
    await page.route(`**/api/models/${model.id}`, async route => {
      if (route.request().method() === 'DELETE') { deletes++; return route.continue(); }
      const response = await route.fetch(), body = await response.json(); delete body.model.role_used_by;
      await route.fulfill({ response, json: body });
    });
    await row(page).getByRole('button', { name: '删除', exact: true }).click();
    await expect(row(page)).toContainText('暂时无法确认完整引用范围'); await expect(dialog(page)).toHaveCount(0); expect(deletes).toBe(0);
    await page.unroute(`**/api/models/${model.id}`);
    let entered; const seen = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/models/${model.id}`, async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); });
    await row(page).getByRole('button', { name: '删除', exact: true }).click(); await seen;
    await page.goto(h.admin + '/#/projects/202/model'); await expect(page.getByRole('heading', { name: '本项目专属模型', exact: true })).toBeVisible();
    release(); await expect(dialog(page)).toHaveCount(0);
  } finally { release?.(); await h.stop(); }
});
