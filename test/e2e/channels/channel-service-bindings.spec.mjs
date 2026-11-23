import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { transport, connector, bindFixture, inGroup, post } from '../../fixtures/channel-fixture.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';

for (const width of [1440, 390]) test(`maintainer binds a group to the repository assistant over chosen repositories, chooses its permission level, manages schedules inside Feishu conversations and disables it at ${width}px (protocol fixtures)`, async ({ page }) => {
  const wire = transport(), errors = [], h = await harness(undefined, undefined, store => ({
    engine: new TaskEngine(store, { call: async () => null }), channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }
  }));
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    const id = await connector(admin), principal = (await admin('/api/auth/me')).value.id;
    bindFixture(h, id, principal); const quiet = inGroup('', 'ou_alice'); quiet.event.message.mentions = []; quiet.event.message.content = JSON.stringify({ text: 'Original local group decision' }); await post(h, id, quiet);
    await page.setViewportSize({ width, height: 900 }); await page.goto(h.admin + '/#/identity/feishu');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '飞书身份绑定', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '飞书群聊助手', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '创建个人绑定', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '创建群绑定', exact: true }).click();
    await expect(page).toHaveURL(/#\/identity\/feishu\/groups\/new$/);
    await expect(page.getByLabel('助手模型', { exact: true })).toHaveValue('');
    // A new group starts at decoupled defaults (#1206): GitHub read, tasks none, project_memory read; platform capabilities visible directly.
    const github = page.getByRole('group', { name: 'GitHub 权限', exact: true });
    const tasks = page.getByRole('group', { name: '项目任务权限', exact: true });
    const platform = page.getByRole('group', { name: '平台能力', exact: true });
    await expect(github.getByLabel('只读', { exact: true })).toBeChecked();
    await expect(tasks.getByLabel('不可访问', { exact: true })).toBeChecked();
    await expect(tasks.getByRole('radio')).toHaveCount(4);
    await expect(platform).toBeVisible();
    await expect(platform.getByLabel('项目共享知识', { exact: true })).toHaveValue('read');
    await expect(platform.getByLabel('项目设置与角色配置', { exact: true })).toHaveValue('none');
    await expect(platform.getByLabel('项目定时与通知', { exact: true })).toHaveValue('none');
    await expect(platform.getByLabel('使用虚拟电脑', { exact: true })).toHaveCount(0);
    await expect(platform.getByLabel('使用任务浏览器', { exact: true })).toHaveCount(0);
    await expect(platform).toContainText('不影响本群定时任务');
    await expect(page.locator('#feishu-group-editor')).toContainText('包括没有平台账号的人和其他企业的外部成员');
    await expect(github.getByLabel('Contents', { exact: true })).toBeHidden();
    await expect(page.getByText(/群内所有成员都能看到助手读取的所选仓库内容/)).toBeVisible();
    await page.getByRole('checkbox', { name: 'fixture/project-101', exact: true }).check(); await page.getByRole('checkbox', { name: 'fixture/project-102', exact: true }).check();
    await page.getByRole('button', { name: '保存群聊助手', exact: true }).click();
    await expect(page).toHaveURL(/#\/identity\/feishu$/);
    const binding = page.getByRole('article', { name: '群聊助手绑定' });
    await expect(binding.getByText('生效中', { exact: true })).toBeVisible();
    await expect(binding.getByText('未配置模型', { exact: true })).toBeVisible();
    await expect(binding.getByText('项目范围：fixture/project-101、fixture/project-102', { exact: true })).toBeVisible();
    await expect(binding).toContainText('GitHub 只读');
    await expect(binding).toContainText('平台 项目共享知识 只读');
    await expect(binding).toContainText('负责人：administrator');
    // Repositories and the decoupled permissions remain one click away via the dedicated configuration route.
    await binding.getByRole('link', { name: '配置群聊助手', exact: true }).click();
    await expect(page.locator('#feishu-group-editor')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'fixture/project-101', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'fixture/project-102', exact: true })).toBeChecked();
    // #1072: GitHub write tier explains workflow_dispatch ("跑一下 Nightly").
    await expect(github).toContainText('并触发、重跑或取消 Actions 工作流（例如「跑一下 Nightly」）');
    // Orthogonal preset: GitHub read + project tasks create (#1206), without forcing GitHub write.
    await page.getByRole('button', { name: '只读 + 可派活', exact: true }).click();
    await expect(github.getByLabel('只读', { exact: true })).toBeChecked();
    await expect(tasks.getByLabel('只读 + 可新增', { exact: true })).toBeChecked();
    await expect(platform.getByLabel('项目共享知识', { exact: true })).toHaveValue('read');
    await github.evaluate(node => { node.scrollIntoView({ block: 'start' }); scrollBy(0, -100); });
    await platform.evaluate(node => { node.scrollIntoView({ block: 'start' }); scrollBy(0, -100); });
    await page.getByRole('button', { name: '保存群聊助手', exact: true }).click();
    await expect(binding).toContainText('GitHub 只读');
    await expect(binding).toContainText('项目任务 只读 + 可新增');
    await expect(binding).toContainText('平台 项目共享知识 只读');
    expect(JSON.parse(h.store.get('SELECT permissions FROM channel_service_bindings').permissions)).toMatchObject({ delegation: 'allow', project_tasks: 'create', github_issues: 'read', github_actions: 'read', github_contents: 'read', project_memory: 'read' });
    // Quick preset for collaborate + dispatch sets GitHub write + tasks create while keeping Contents read.
    await binding.getByRole('link', { name: '配置群聊助手', exact: true }).click();
    await page.getByRole('button', { name: '可协作 + 可派活', exact: true }).click();
    await page.getByRole('button', { name: '保存群聊助手', exact: true }).click();
    await expect(binding).toContainText('GitHub Issue / PR / Actions 读写');
    expect(JSON.parse(h.store.get('SELECT permissions FROM channel_service_bindings').permissions)).toMatchObject({ delegation: 'allow', project_tasks: 'create', github_issues: 'write', github_actions: 'write', github_contents: 'read', project_memory: 'read' });
    // Merging from the group (Contents write) is only an individual GitHub item, starting from the GitHub tier chosen before.
    await binding.getByRole('link', { name: '配置群聊助手', exact: true }).click();
    await expect(github.getByLabel('Issue / PR / Actions 读写', { exact: true })).toBeChecked();
    await github.getByLabel('逐项设置', { exact: true }).check();
    await expect(tasks.getByLabel('只读 + 可新增', { exact: true })).toBeChecked();
    await tasks.getByLabel('完全可读写', { exact: true }).check();
    await github.getByLabel('Contents', { exact: true }).selectOption('write');
    await platform.getByLabel('项目共享知识', { exact: true }).selectOption('write');
    await github.evaluate(node => { node.scrollIntoView({ block: 'start' }); scrollBy(0, -100); });
    await page.getByRole('button', { name: '保存群聊助手', exact: true }).click();
    await expect(binding).toContainText(/GitHub 逐项：.*Contents 读写/);
    await expect(binding).toContainText('项目任务 完全可读写');
    await expect(binding).toContainText('平台 项目共享知识 读写');
    expect(JSON.parse(h.store.get('SELECT permissions FROM channel_service_bindings').permissions)).toMatchObject({ project_tasks: 'write', github_contents: 'write', project_memory: 'write' });
    await binding.getByRole('link', { name: '配置群聊助手', exact: true }).click();
    await expect(tasks.getByLabel('完全可读写', { exact: true })).toBeChecked();
    await expect(github.getByLabel('逐项设置', { exact: true })).toBeChecked(); await expect(github.getByLabel('Contents', { exact: true })).toHaveValue('write');
    await expect(platform.getByLabel('项目共享知识', { exact: true })).toHaveValue('write');
    await page.locator('#feishu-group-editor').getByRole('link', { name: '← 返回飞书绑定', exact: true }).click();
    await expect(page).toHaveURL(/#\/identity\/feishu$/);
    const row = h.store.get('SELECT * FROM channel_service_bindings');
    expect(row.service_role_id).toBe('group-assistant');
    expect(h.store.all('SELECT project_id FROM scoped_grants WHERE principal_id=? ORDER BY project_id', row.principal_id).map(g => g.project_id)).toEqual(['101', '102']);
    expect(h.store.get('SELECT kind FROM principals WHERE id=?', row.principal_id).kind).toBe('service');
    // Chat schedules live inside Feishu Conversations (#1232): clicking 定时任务 opens #/conversations/<id>?section=schedules.
    await binding.getByRole('link', { name: '定时任务', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/conversations/${row.chat_id}\\?section=schedules$`));
    const schedulesPanel = page.locator('.channel-schedules-details');
    await expect(schedulesPanel).toBeVisible();
    await expect(schedulesPanel.getByLabel('定时任务名称', { exact: true })).toBeVisible();
    await schedulesPanel.getByLabel('定时任务名称', { exact: true }).fill('工作日巡检');
    await schedulesPanel.getByLabel('任务提示词', { exact: true }).fill('检查本群绑定仓库今天新开的 bug 类 Issue 和仍未合入的 PR，整理成简报。');
    await schedulesPanel.getByLabel('Cron 表达式（分 时 日 月 周）', { exact: true }).fill('0 18 * * 1-5');
    await schedulesPanel.getByRole('button', { name: '预览触发时间', exact: true }).click();
    await expect(schedulesPanel.getByText(/^接下来：/)).toBeVisible();
    await schedulesPanel.getByRole('button', { name: '保存定时任务', exact: true }).click();
    const timer = page.getByRole('article', { name: '定时任务 工作日巡检' });
    await expect(timer.getByText('生效中 · 工作日巡检', { exact: true })).toBeVisible();
    await expect(timer.getByText(/^接下来：/)).toBeVisible();
    expect({ ...h.store.get('SELECT kind,state,cron,timezone FROM channel_schedules') }).toEqual({ kind: 'group', state: 'active', cron: '0 18 * * 1-5', timezone: 'Asia/Shanghai' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await timer.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByRole('article', { name: '定时任务 工作日巡检' }).getByText('已暂停 · 工作日巡检', { exact: true })).toBeVisible();
    expect(h.store.get('SELECT reason FROM channel_schedules').reason).toBe('user_paused');
    await page.getByRole('link', { name: '返回飞书绑定', exact: true }).click();
    await expect(page).toHaveURL(/#\/identity\/feishu$/);
    // Clicking the group binding row opens its chat history directly, with local search and a return link.
    await binding.locator('.feishu-row-title strong').click();
    await expect(page).toHaveURL(new RegExp(`#/conversations/${row.chat_id}$`));
    await expect(page.getByLabel('消息与执行时间线')).toContainText('Original local group decision');
    await expect(page.getByText('当前群绑定：模型 未配置 · 范围：fixture/project-101、fixture/project-102', { exact: true })).toBeVisible();
    await page.getByText('搜索本地消息记录', { exact: true }).click();
    await page.getByLabel('消息关键词', { exact: true }).fill('absent-local-term');
    await page.getByRole('button', { name: '搜索本地记录', exact: true }).click();
    await expect(page.getByText('本地已同步范围没有匹配消息；这不代表飞书历史中从未存在。', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '返回飞书绑定', exact: true }).click();
    await expect(page).toHaveURL(/#\/identity\/feishu$/);
    await page.getByRole('article', { name: '群聊助手绑定' }).getByRole('button', { name: '停用群聊助手', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认停用', exact: true }).click();
    await expect(page.getByRole('article', { name: '群聊助手绑定' }).getByText('已停用', { exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: '群聊助手绑定' }).getByRole('link', { name: '重新启用并配置', exact: true })).toBeVisible();
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
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(h.admin + '/#/identity/feishu/groups');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('checkbox', { name: 'fixture/project-101', exact: true }).check();
    const save = page.getByRole('button', { name: '保存群聊助手', exact: true }), alert = page.locator('form').filter({ has: save }).getByRole('alert');
    await save.click();
    await expect(alert).toHaveText('飞书应用还没有读取群成员的权限，无法核验你是否在群中。请超级管理员在「全局设置 → 飞书连接」查看缺少的权限，为应用开通 im:chat.members:read 并发布新版本后再保存。');
    // After the scope is granted, an entry proxy still answers once with its own page (Cloudflare replaces 502 bodies).
    wire.state.audience = null;
    await page.route('**/service-binding', route => route.fulfill({ status: 502, contentType: 'text/html', body: '<!DOCTYPE html><html><body>Bad gateway</body></html>' }), { times: 1 });
    await save.click();
    await expect(alert).toHaveText('502 · 入口网关返回了错误页面，没有带回具体原因。请稍后重试；持续出现时请管理员查看服务日志。');
    await save.click();
    const boundRow = page.getByRole('article', { name: '群聊助手绑定' });
    await expect(boundRow.getByText('生效中', { exact: true })).toBeVisible();
    await expect(boundRow.getByText('未配置模型', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
