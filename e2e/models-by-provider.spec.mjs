import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

test('模型按供应商分组显示；获取上游列表后一键添加同一供应商的模型，沿用已保存的 Key', async ({ page }) => {
  // A fake OpenAI-compatible upstream with two providers; every model request records the key it carried.
  const keys = [], upstream = createServer((req, res) => {
    keys.push(req.headers.authorization); res.setHeader('Content-Type', 'application/json');
    const ids = req.url === '/v1/models' ? ['alpha', 'beta', 'gamma'] : req.url === '/other/v1/models' ? ['delta'] : null;
    if (!ids) { res.statusCode = 404; res.end('{}'); return; }
    res.end(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const origin = `http://127.0.0.1:${upstream.address().port}`, h = await harness(), errors = []; page.on('pageerror', e => errors.push(e.message));
  mkdirSync('.tmp/models-by-provider', { recursive: true });
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const ownKey = testPassword(), add = body => admin('/api/models', 'POST', { api_key: testPassword(), ...body });
    await add({ repository_id: null, api_url: origin + '/v1', model_name: 'alpha' });
    // A trailing slash is the same provider; another path is another one.
    await add({ repository_id: '101', api_url: origin + '/v1/', model_name: 'beta', api_key: ownKey });
    await add({ repository_id: '101', api_url: origin + '/other/v1', model_name: 'delta' });
    await page.goto(h.admin + '/#/projects/101/model'); await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();

    // The chooser lists the models under their provider.
    const chooser = page.locator('.side-card').filter({ has: page.getByRole('heading', { name: '使用的模型' }) });
    await expect(chooser.locator('.choice-group')).toHaveCount(2);
    await expect(chooser.locator('.choice-group').first()).toContainText(origin.slice(7) + ' ' + origin + '/v1');
    const own = page.locator('.side-card').filter({ has: page.getByRole('heading', { name: '本项目专属模型' }) }), groups = own.locator('.provider-group');
    await expect(groups).toHaveCount(2);
    await expect(groups.first().locator('.provider-head')).toContainText('1 个模型');
    await expect(groups.first().locator('.model-entry .model-address')).toHaveText(['beta']);

    // One click on an upstream id adds it with the provider's saved key; names already there are marked.
    const first = groups.first();
    await first.getByRole('button', { name: '添加该供应商的模型', exact: true }).click();
    const chips = first.locator('.model-chip');
    await expect(chips).toHaveText(['alpha', 'beta ✓', 'gamma']); await expect(chips.nth(1)).toBeDisabled();
    await page.screenshot({ path: '.tmp/models-by-provider/project-desktop.png', fullPage: true });
    await chips.nth(2).click(); await expect(chips.nth(2)).toHaveText('gamma ✓'); await expect(chips.nth(2)).toBeDisabled();
    await first.getByLabel('筛选模型 id', { exact: true }).fill('alp'); await expect(chips.filter({ visible: true })).toHaveText(['alpha']);
    await first.getByLabel('列表外的模型名', { exact: true }).fill('custom-x'); await first.getByRole('button', { name: '添加', exact: true }).click();
    await expect(first.locator('.provider-add .probe-result')).toContainText('已添加 custom-x');
    await first.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.locator('#project-page')).toContainText('已添加 gamma、custom-x');
    await expect(groups.first().locator('.model-entry .model-address')).toHaveText(['beta', 'gamma', 'custom-x']);
    const saved = (await admin('/api/models')).value.models.filter(m => ['gamma', 'custom-x'].includes(m.model_name));
    expect(saved.map(m => [m.repository_id, m.api_url, m.key_configured])).toEqual([['101', origin + '/v1/', true], ['101', origin + '/v1/', true]]);
    expect(keys.at(-1)).toBe('Bearer ' + ownKey);

    // Global settings group the shared models the same way; phones keep everything inside the screen.
    await page.goto(h.admin + '/#/settings/models');
    const shared = page.locator('.side-card').filter({ has: page.getByRole('heading', { name: '部署共享模型' }) });
    await expect(shared.locator('.provider-group')).toHaveCount(1); await expect(shared.locator('.model-entry .model-address')).toHaveText(['alpha']);
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(h.admin + '/#/projects/101/model'); await expect(groups).toHaveCount(2);
    await groups.first().getByRole('button', { name: '添加该供应商的模型', exact: true }).click(); await expect(groups.first().locator('.model-chip')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/models-by-provider/project-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); await new Promise(resolve => upstream.close(resolve)); }
});
