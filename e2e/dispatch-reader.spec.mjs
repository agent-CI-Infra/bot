import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

async function prepared(page) {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    const add = (id, values = {}) => {
      const v = { state: 'decided', decision: 'ignore', type: 'issue.opened', ...values };
      h.store.run(`INSERT INTO dispatch_events(id,repository_id,event_key,type,source,summary,facts,options,created_at,state,decision,reason,model,error,attempts)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, '101', id, v.type, 'github', 'Visible event ' + id, '{}', '[]', '2026-11-11T10:00:00.000Z', v.state, v.decision,
        'Existing request already covers this event.', 'Recorded fixture model', v.state === 'failed' ? '{"code":"invalid_decision","detail":"No offered option matched."}' : null, v.state === 'failed' ? 8 : 1);
    };
    for (let i = 0; i < 25; i++) add('event-' + String(i).padStart(2, '0'));
    add('created', { decision: 'create', type: 'review.published' }); add('failed', { state: 'failed', decision: null });
    await page.goto(h.admin + '/#/projects/101/roles/manager');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('Manager 提示词', { exact: true })).toBeVisible();
    const reader = page.getByRole('region', { name: 'Manager 分派记录', exact: true }); await expect(reader.locator('[data-dispatch-event]')).toHaveCount(20);
    return { h, admin, add, reader };
  } catch (error) { await h.stop(); throw error; }
}
const detail = page => page.getByRole('dialog', { name: '分派详情', exact: true });

test('dispatch filters and recorded detail remain usable at six widths, with a shareable event address', async ({ page }) => {
  const { h, reader } = await prepared(page), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await reader.getByRole('combobox', { name: '分派结果', exact: true }).selectOption('create');
    await reader.getByLabel('开始时间（含）', { exact: true }).fill('2026-11-11T00:00');
    await reader.getByLabel('结束时间（不含）', { exact: true }).fill('2026-11-10T00:00');
    await reader.getByRole('button', { name: '应用分派筛选', exact: true }).click(); await expect(reader).toContainText('结束时间必须晚于开始时间');
    await reader.getByLabel('结束时间（不含）', { exact: true }).fill('2026-11-12T00:00');
    await reader.getByRole('button', { name: '应用分派筛选', exact: true }).click();
    await expect(reader.locator('[data-dispatch-event]')).toHaveCount(1); await expect(reader).toContainText('Visible event created');
    mkdirSync('.tmp/manager-dispatch-229/previews', { recursive: true });
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 950 }); await reader.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await reader.getByRole('button', { name: '查看分派详情', exact: true }).click();
      await expect(detail(page)).toContainText('Recorded fixture model'); await expect(detail(page)).toContainText('触发事件'); await expect(detail(page)).toContainText('当前没有可读取的关联任务');
      expect(await detail(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if ([390, 1440].includes(width)) await page.screenshot({ path: `.tmp/manager-dispatch-229/previews/manager-dispatch-${width}.png` });
      await detail(page).getByRole('button', { name: '关闭分派详情', exact: true }).click();
    }
    await reader.getByRole('combobox', { name: '分派结果', exact: true }).selectOption('ignore'); await reader.getByRole('button', { name: '应用分派筛选', exact: true }).click();
    await expect(reader.locator('[data-dispatch-event]').first()).toContainText('不分派任务'); await reader.getByRole('button', { name: '查看分派详情', exact: true }).first().click();
    await expect(detail(page)).toContainText('工具操作应结合已保存理由与实际记录核对'); await detail(page).getByRole('button', { name: '关闭分派详情', exact: true }).click();
    await reader.getByRole('combobox', { name: '分派结果', exact: true }).selectOption('create'); await reader.getByRole('button', { name: '应用分派筛选', exact: true }).click();
    await reader.getByRole('button', { name: '查看分派详情', exact: true }).click(); await expect(page).toHaveURL(/dispatch=created/);
    await page.reload(); await expect(detail(page)).toContainText('Visible event created'); await expect(detail(page)).toContainText('Recorded fixture model');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('a newer arrival cannot duplicate an older cursor page; a failed read keeps records and retries without losing filters', async ({ page }) => {
  const { h, add, reader } = await prepared(page);
  try {
    add('new-arrival'); await reader.getByRole('button', { name: '更早的分派', exact: true }).click();
    await expect(reader.locator('[data-dispatch-event]')).toHaveCount(27);
    const ids = await reader.locator('[data-dispatch-event]').evaluateAll(nodes => nodes.map(el => el.dataset.dispatchEvent)); expect(new Set(ids).size).toBe(27); expect(ids).not.toContain('new-arrival');
    await page.route('**/api/repositories/101/dispatch?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture_unavailable"}' }));
    await reader.getByRole('button', { name: '重新读取分派', exact: true }).click(); await expect(reader).toContainText('保留上次读取的记录'); await expect(reader.locator('[data-dispatch-event]')).toHaveCount(27);
    await page.unroute('**/api/repositories/101/dispatch?*'); await reader.getByRole('button', { name: '重新读取分派', exact: true }).click();
    await expect(reader.locator('[data-dispatch-event="new-arrival"]')).toBeVisible();
    await page.route('**/api/repositories/101/dispatch?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture_unavailable"}' }));
    await page.reload(); const again = page.getByRole('region', { name: 'Manager 分派记录', exact: true }); await expect(again).toContainText('读取失败，分派状态未知');
    await page.unroute('**/api/repositories/101/dispatch?*'); await again.getByRole('button', { name: '重新读取分派', exact: true }).click(); await expect(again.locator('[data-dispatch-event]')).toHaveCount(20);
  } finally { await h.stop(); }
});

test('retry retains the original failure and event identity, and repeated clicks submit once', async ({ page }) => {
  const { h, reader } = await prepared(page); let release, writes = 0;
  try {
    await reader.locator('[data-dispatch-event="failed"]').getByRole('button', { name: '查看分派详情', exact: true }).click(); await expect(detail(page)).toContainText('No offered option matched.');
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/repositories/101/dispatch/failed/retry', async route => { writes++; await gate; await route.continue(); });
    const retry = detail(page).getByRole('button', { name: '重试这条分派', exact: true }); await retry.click(); await expect(retry).toBeDisabled(); await retry.evaluate(el => el.click()); expect(writes).toBe(1); release();
    await expect(detail(page)).toContainText('原轮尝试 8 次'); await expect(detail(page)).toContainText('等待或自动重试'); await expect(retry).toBeHidden();
    expect(h.store.get("SELECT count(*) n FROM dispatch_retries WHERE event_id='failed'").n).toBe(1); expect(h.store.get('SELECT count(*) n FROM tasks').n).toBe(0);
    await page.reload(); await expect(detail(page)).toContainText('原轮尝试 8 次'); await expect(detail(page)).toContainText('invalid_decision');
  } finally { release?.(); await h.stop(); }
});

test('a permission failure clears the list and detail, rejecting an older successful list response', async ({ page }) => {
  const { h, reader } = await prepared(page); let release;
  try {
    const old = await page.evaluate(() => window.api('/api/repositories/101/dispatch?limit=20'));
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/repositories/101/dispatch?*', async route => { await gate; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(old) }); });
    await reader.getByRole('button', { name: '重新读取分派', exact: true }).click();
    await page.route('**/api/repositories/101/dispatch/failed', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' }));
    await reader.locator('[data-dispatch-event="failed"]').getByRole('button', { name: '查看分派详情', exact: true }).click();
    await expect(reader).toContainText('当前身份无法读取分派'); await expect(detail(page)).toBeHidden(); release();
    await expect(reader.locator('[data-dispatch-event]')).toHaveCount(0); await expect(reader.getByRole('button', { name: '重新读取分派', exact: true })).toBeEnabled();
    await page.unroute('**/api/repositories/101/dispatch?*'); await page.unroute('**/api/repositories/101/dispatch/failed');
    await reader.getByRole('button', { name: '重新读取分派', exact: true }).click(); await expect(reader.locator('[data-dispatch-event]')).toHaveCount(20);
  } finally { release?.(); await h.stop(); }
});

test('a late detail for one project cannot appear in another project', async ({ page }) => {
  const { h, reader } = await prepared(page); let release;
  try {
    const old = await page.evaluate(() => window.api('/api/repositories/101/dispatch/failed'));
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/repositories/101/dispatch/failed', async route => { await gate; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(old) }); });
    await reader.locator('[data-dispatch-event="failed"]').getByRole('button', { name: '查看分派详情', exact: true }).click();
    await page.goto(h.admin + '/#/projects/102/roles/manager'); await expect(page.getByRole('region', { name: 'Manager 分派记录', exact: true })).toContainText('当前筛选没有分派记录'); release();
    await expect(page.locator('dialog.dispatch-detail')).toHaveCount(1); await expect(detail(page)).toBeHidden(); await expect(page.locator('#project-page')).not.toContainText('Visible event failed');
  } finally { release?.(); await h.stop(); }
});
