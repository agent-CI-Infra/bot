import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

// #230 验收第 4 条：「测试超时…有自动化用例」。上游 15 秒不响应必须是它自己的原因
// （upstream_timeout →「上游 15 秒内没有响应」），不能笼统报成「无法连接上游」——前者要人去看上游，
// 后者要人改地址，处理方向完全相反。这里也钉住：超时之后表单草稿还在、没有落库。
test('a provider probe that never answers is reported as a timeout, not as an unreachable address', async ({ page }) => {
  test.setTimeout(120000);
  const server = createServer((req, res) => {
    // /slow never answers: the probe's own deadline is what has to end the wait.
    if (req.url.startsWith('/slow')) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'alpha' }], model: 'fixture', choices: [{ message: { content: 'ok' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const group = (await admin('/api/models/provider', 'POST', { repository_id: '101', api_url: origin + '/v1', api_key: testPassword(), model_names: ['alpha'] })).value.models;
    const before = (await admin('/api/models')).value.models;
    await page.goto(h.admin + '/#/projects/101/model');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const own = page.locator('.side-card').filter({ has: page.getByRole('heading', { name: '本项目专属模型', exact: true }) });
    await own.getByRole('button', { name: '编辑供应商', exact: true }).click();
    const editor = page.locator('#provider-edit');
    await editor.getByLabel('接口 URL', { exact: true }).fill(origin + '/slow/v1');
    await editor.getByRole('button', { name: '测试当前连接', exact: true }).click();
    const result = editor.locator('.probe-result');
    await expect(result).toContainText('上游 15 秒内没有响应', { timeout: 40000 });
    // The two failures point at different people, so a timeout must never be worded as an unreachable address.
    await expect(result).not.toContainText('无法连接上游');
    // A failed test is not a save: the draft stays in the form and nothing extra is stored.
    await expect(editor.getByLabel('接口 URL', { exact: true })).toHaveValue(origin + '/slow/v1');
    await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    const after = (await admin('/api/models')).value.models;
    expect(after.length).toBe(before.length);
    expect(after.every(m => m.api_url !== origin + '/slow/v1')).toBe(true);
    expect((await admin(`/api/models/${group[0].id}`)).value.model.api_url).toBe(origin + '/v1');
    expect(errors).toEqual([]);
  } finally {
    await h.stop();
    await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
  }
});
