import { test, expect } from '@playwright/test';
import { openModelCatalog } from './open-model-folds.mjs';
import { strict as assert } from 'node:assert';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

// #230 slice: the model list is where an administrator decides whether a model is usable and what depends on it, so a
// row identifies project-default/work-type references from the list route's `used_by`; role impact is read before deletion.
// Pricing and provider key state are asserted next to it because they live in the same row and the same header.
test('模型行显示使用位置与单价，供应商组显示 Key 状态', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
    const host = 'http://127.0.0.1:9/v1';
    const created = (await admin('/api/models/provider', 'POST', { repository_id: '101', api_url: host, api_key: 'sk-usage-fixture', model_names: ['deepseek-chat', 'glm-5'] })).value.models;
    const priced = created.find(model => model.model_name === 'deepseek-chat'), unpriced = created.find(model => model.model_name === 'glm-5');
    assert.equal((await admin('/api/models/' + priced.id, 'PATCH', { version: priced.version, pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2, cache_per_million: 0.5 } })).status, 200);
    // A deployment-shared model that two projects select as their default: the usage line has to name both projects,
    // because deletion clears those project-default selections.
    const shared = (await admin('/api/models/provider', 'POST', { repository_id: null, api_url: 'http://127.0.0.1:8/v1', api_key: testPassword(), model_names: ['shared-model'] })).value.models[0];
    assert.equal((await admin('/api/repositories/101/policy', 'PATCH', { model_id: shared.id })).status, 200);
    assert.equal((await admin('/api/repositories/202/policy', 'PATCH', { model_id: shared.id })).status, 200);

    await page.goto(h.admin + '/#/projects/101/model');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await openModelCatalog(page);
    const card = name => page.locator('.side-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const own = card('本项目专属模型');
    await expect(own.getByRole('heading', { name: '本项目专属模型', exact: true })).toBeVisible();
    const group = own.locator('.provider-group').first();

    // The group header states the connection: a provider whose key was revoked is not a working provider.
    await expect(group.locator('.provider-head')).toContainText('Key 已配置');
    await expect(group.locator('.provider-head')).not.toContainText('Key 已撤销');

    const pricedRow = group.locator('li.model-entry').filter({ hasText: 'deepseek-chat' });
    const unpricedRow = group.locator('li.model-entry').filter({ hasText: 'glm-5' });
    // Unit price is per million tokens with its currency, and the absence of a price is stated instead of shown as 0.
    await expect(pricedRow.locator('.model-price')).toHaveText('USD / 百万 token · 输入 1 · 输出 2 · 缓存 0.5');
    await expect(unpricedRow.locator('.model-price')).toHaveText('未定价 · 不按 0 估算');

    // No project references either of the project's own models; that is stated rather than left blank.
    await expect(pricedRow.locator('.model-usage')).toHaveText('无项目默认或工作类型引用');
    await expect(unpricedRow.locator('.model-usage')).toHaveText('无项目默认或工作类型引用');
    // The shared model is the default of two projects, so both full names appear, in project order.
    const sharedRow = card('部署共享模型').locator('li.model-entry').filter({ hasText: 'shared-model' });
    await expect(sharedRow.locator('.model-usage')).toHaveText('项目默认/工作类型引用：fixture/project-101、fixture/project-202');

    // The usage line is part of the row on a phone too: it must not push the card wider than the screen.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(sharedRow.locator('.model-usage')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });

    // Revoking the provider key flips the header and the row stays readable: failure is shown, not hidden.
    // A provider edit uses one fresh snapshot of membership and endpoint/name versions; pricing keeps versions fixed.
    const live = (await admin('/api/models?repository_id=101')).value.models.filter(model => model.api_url === host);
    assert.equal((await admin('/api/models/' + priced.id + '/provider', 'PATCH', { versions: live.map(model => ({ id: model.id, version: model.version })), revoke_key: true })).status, 200);
    await page.reload();
    await openModelCatalog(page);
    const revoked = card('本项目专属模型').locator('.provider-group').first();
    await expect(revoked.locator('.provider-head')).toContainText('Key 已撤销');
    await expect(revoked.locator('li.model-entry').filter({ hasText: 'deepseek-chat' }).locator('.model-usage')).toHaveText('无项目默认或工作类型引用');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// The usage line names projects, so it must line up with what the reader may see: someone who only administers 202 must
// not learn that a shared model is also the default of 101 from this projection.
test('使用位置只列调用者可见的项目', async () => {
  const h = await harness(undefined, undefined);
  try {
    const { admin } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
    const shared = (await admin('/api/models/provider', 'POST', { repository_id: null, api_url: 'http://127.0.0.1:8/v1', api_key: testPassword(), model_names: ['shared-model'] })).value.models[0];
    assert.equal((await admin('/api/repositories/101/policy', 'PATCH', { model_id: shared.id })).status, 200);
    assert.equal((await admin('/api/repositories/202/policy', 'PATCH', { model_id: shared.id })).status, 200);
    const member = testPassword();
    assert.equal((await admin('/api/users', 'POST', { username: 'model-member', password: member, repository_ids: ['202'] })).status, 201);
    const reader = h.client();
    assert.equal((await reader('/api/auth/login', 'POST', { username: 'model-member', password: member })).status, 200);
    const listed = await reader('/api/models?repository_id=202');
    assert.equal(listed.status, 200);
    const model = listed.value.models.find(entry => entry.model_name === 'shared-model');
    assert.deepEqual(model.used_by.map(project => project.full_name), ['fixture/project-202']);
  } finally { await h.stop(); }
});
