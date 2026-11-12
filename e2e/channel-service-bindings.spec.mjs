import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { transport, connector, bindFixture, inGroup, post } from '../test/channel-fixture.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

for (const width of [1440, 390]) test(`maintainer binds a group to the repository assistant over chosen repositories, adds a prompt timer, reads local history and disables it at ${width}px (protocol fixtures)`, async ({ page }) => {
  const wire = transport(), errors = [], h = await harness(undefined, undefined, store => ({
    engine: new TaskEngine(store, { call: async () => null }), channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }
  }));
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    const id = await connector(admin), principal = (await admin('/api/auth/me')).value.id;
    bindFixture(h, id, principal); const quiet = inGroup('', 'ou_alice'); quiet.event.message.mentions = []; quiet.event.message.content = JSON.stringify({ text: 'Original local group decision' }); await post(h, id, quiet);
    await page.setViewportSize({ width, height: 900 }); await page.goto(h.admin + '/#/identity');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '飞书群聊助手', exact: true })).toBeVisible();
    await expect(page.getByLabel('服务角色', { exact: true })).toHaveValue('repository-assistant');
    await expect(page.getByText(/群内所有成员都能看到助手读取的所选仓库内容/)).toBeVisible();
    await page.getByLabel('fixture/project-101', { exact: true }).check(); await page.getByLabel('fixture/project-102', { exact: true }).check();
    await page.getByRole('button', { name: '保存群聊助手', exact: true }).click();
    const binding = page.getByRole('article', { name: '群聊助手绑定' });
    await expect(binding.getByText('生效中 · 仓库问答助手', { exact: true })).toBeVisible();
    await expect(binding.getByText('项目范围：fixture/project-101、fixture/project-102', { exact: true })).toBeVisible();
    await expect(binding.getByText('负责人：administrator', { exact: true })).toBeVisible();
    const row = h.store.get('SELECT * FROM channel_service_bindings');
    expect(row.service_role_id).toBe('repository-assistant');
    expect(h.store.all('SELECT project_id FROM scoped_grants WHERE principal_id=? ORDER BY project_id', row.principal_id).map(g => g.project_id)).toEqual(['101', '102']);
    expect(h.store.get('SELECT kind FROM principals WHERE id=?', row.principal_id).kind).toBe('service');
    await binding.getByRole('button', { name: '查询该群本地记录', exact: true }).click();
    await expect(page.getByText('Original local group decision', { exact: true })).toBeVisible();
    await page.getByLabel('查询关键词', { exact: true }).fill('absent-local-term');
    await page.getByRole('button', { name: '搜索本地记录', exact: true }).click();
    await expect(page.getByText('本地已同步范围没有匹配记录；这不代表飞书历史中从未存在。', { exact: true })).toBeVisible();
    // The group's timers replace per-project destination registration (#330): a prompt for its own assistant.
    await expect(binding.getByLabel('通知项目')).toHaveCount(0);
    await binding.getByLabel('定时任务名称', { exact: true }).fill('工作日巡检');
    await binding.getByLabel('任务提示词', { exact: true }).fill('检查本群绑定仓库今天新开的 bug 类 Issue 和仍未合入的 PR，整理成简报。');
    await binding.getByLabel('Cron 表达式（分 时 日 月 周）', { exact: true }).fill('0 18 * * 1-5');
    await binding.getByRole('button', { name: '预览触发时间', exact: true }).click();
    await expect(binding.getByText(/^接下来：/)).toBeVisible();
    await binding.getByRole('button', { name: '保存定时任务', exact: true }).click();
    const timer = page.getByRole('article', { name: '定时任务 工作日巡检' });
    await expect(timer.getByText('生效中 · 工作日巡检', { exact: true })).toBeVisible();
    await expect(timer.getByText(/^接下来：/)).toBeVisible();
    expect({ ...h.store.get('SELECT kind,state,cron,timezone FROM channel_schedules') }).toEqual({ kind: 'group', state: 'active', cron: '0 18 * * 1-5', timezone: 'Asia/Shanghai' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mkdirSync('.tmp/channel-service-bindings-312', { recursive: true }); await page.screenshot({ path: `.tmp/channel-service-bindings-312/binding-${width}.png`, fullPage: true });
    await timer.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByRole('article', { name: '定时任务 工作日巡检' }).getByText('已暂停 · 工作日巡检', { exact: true })).toBeVisible();
    expect(h.store.get('SELECT reason FROM channel_schedules').reason).toBe('user_paused');
    await page.getByRole('article', { name: '群聊助手绑定' }).getByRole('button', { name: '停用群聊助手', exact: true }).click();
    await expect(page.getByRole('article', { name: '群聊助手绑定' }).getByText('已停用 · 仓库问答助手', { exact: true })).toBeVisible();
    expect(h.store.get('SELECT active FROM principals WHERE id=?', row.principal_id).active).toBe(0); expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('saving explains an app without the member scope, and a gateway page, instead of a JSON parse error (protocol fixtures)', async ({ page }) => {
  const wire = transport(), errors = [], h = await harness(undefined, undefined, store => ({
    engine: new TaskEngine(store, { call: async () => null }), channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }
  }));
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const id = await connector(admin), principal = (await admin('/api/auth/me')).value.id;
    bindFixture(h, id, principal); const quiet = inGroup('', 'ou_alice'); quiet.event.message.mentions = []; quiet.event.message.content = JSON.stringify({ text: 'Group discussion' }); await post(h, id, quiet);
    // Feishu refuses the member lookup when the app holds none of the member-reading scopes.
    wire.state.audience = () => Response.json({ code: 99991672, msg: 'Access denied.' }, { status: 400 });
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(h.admin + '/#/identity');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('fixture/project-101', { exact: true }).check();
    const save = page.getByRole('button', { name: '保存群聊助手', exact: true }), alert = page.locator('form').filter({ has: save }).getByRole('alert');
    await save.click();
    await expect(alert).toHaveText('飞书应用还没有读取群成员的权限，无法核验你是否在群中。请超级管理员在「全局设置 → 飞书连接」查看缺少的权限，为应用开通 im:chat.members:read 并发布新版本后再保存。');
    // After the scope is granted, an entry proxy still answers once with its own page (Cloudflare replaces 502 bodies).
    wire.state.audience = null;
    await page.route('**/service-binding', route => route.fulfill({ status: 502, contentType: 'text/html', body: '<!DOCTYPE html><html><body>Bad gateway</body></html>' }), { times: 1 });
    await save.click();
    await expect(alert).toHaveText('502 · 入口网关返回了错误页面，没有带回具体原因。请稍后重试；持续出现时请管理员查看服务日志。');
    await save.click();
    await expect(page.getByRole('article', { name: '群聊助手绑定' }).getByText('生效中 · 仓库问答助手', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
