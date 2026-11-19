import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';
import { consoleNavigate } from '../helpers/console-navigation.mjs';
import { test,expect } from '@playwright/test';
import { mkdirSync,rmSync,writeFileSync } from 'node:fs';
import { command,managementFixture,query,settled } from '../../fixtures/management-fixture.mjs';

test('mobile management opens its conversation list and sends on the first press while the editor is focused', async ({ page }) => {
  const f = await managementFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await switchConsoleProject(page, '101');
    const send = page.getByRole('button', { name: '发送', exact: true });
    await expect(send).toBeEnabled();
    const sessions = page.getByRole('button', { name: '会话记录', exact: true });
    const sidebar = page.getByRole('complementary', { name: '会话记录', exact: true });
    await expect(sidebar).toBeHidden(); await sessions.click(); await expect(sidebar).toBeVisible();
    await expect(sessions).toHaveAttribute('aria-expanded', 'true');
    const close = page.getByRole('button', { name: '关闭会话列表', exact: true });
    await close.click();
    await expect(sidebar).toBeHidden(); await expect(sessions).toBeFocused();
    for (const viewport of [{ width: 390, height: 640 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport); await sessions.click(); await expect(sidebar).toBeVisible();
      await expect(close).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeInViewport({ ratio: 1 });
      const geometry = await close.evaluate(el => {
        const buttonBox = el.getBoundingClientRect(), drawer = el.closest('.management-sidebar').getBoundingClientRect();
        const nav = document.querySelector('#console-mobile-nav').getBoundingClientRect();
        const hit = document.elementFromPoint(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
        return { closeHit: !!hit && el.contains(hit), drawerBottom: drawer.bottom, navTop: nav.top };
      });
      expect(geometry.closeHit, JSON.stringify(geometry)).toBe(true);
      expect(geometry.drawerBottom, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.navTop + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      await page.keyboard.press('Escape'); await expect(sidebar).toBeHidden(); await expect(sessions).toBeFocused();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const name of ['快捷操作', '全屏显示管理助手', '切换为悬浮窗口']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    const message = page.getByLabel('管理消息', { exact: true });
    await message.fill('任务为什么没有继续？'); await message.focus(); await expect(message).toBeFocused();
    await send.click();
    await expect(page.getByRole('log', { name: '管理会话记录' })).toContainText('任务正在等待项目电脑');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('management UI, direct API and model tools agree on real persisted query, configuration and task results',async({page})=>{
  test.setTimeout(90000);
  const f=await managementFixture(),{h,admin,password}=f,errors=[];
  page.on('pageerror',e=>errors.push(e.message));mkdirSync('.tmp/management-164',{recursive:true});
  try{
    await page.setViewportSize({width:1440,height:1100});await page.goto(h.admin+'/#/management');
    await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await switchConsoleProject(page, '101');
    await expect(page.getByRole('region',{name:'管理助手',exact:true})).toBeVisible();
    await expect(page.getByLabel('默认提示词',{exact:true})).toBeHidden();
    const feed=page.getByRole('log',{name:'管理会话记录'}),message=page.getByLabel('管理消息',{exact:true});
    // A natural language request uses actual management_query, which reads the same SQLite task as the API.
    await message.fill('任务为什么没有继续？');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(feed).toContainText('environment_not_ready');await expect(feed).toContainText('Project computer is stopped');
    await expect(page.getByRole('button',{name:'停止',exact:true})).toBeHidden();
    const direct=(await query(admin,'get_task',{project_id:'101',task_id:'blocked'})).value;
    expect(direct.task.status).toBe('waiting_environment');expect(direct.task.error_code).toBe('environment_not_ready');
    await page.screenshot({path:'.tmp/management-164/query-desktop.png',fullPage:true});
    // The model submits a versioned command; the page and the Manager API see the resulting Manager section.
    await message.fill('更新任务默认提示词');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(feed).toContainText('操作 更新工作配置 · 已执行');
    await expect(page.getByRole('button',{name:'停止',exact:true})).toBeHidden();
    const configured=(await query(admin,'get_effective_config',{project_id:'101'})).value;
    expect(configured.workflows.find(w=>w.id==='review.issue').prompt.effective).toBe('Inspect evidence and cite the original logs.');
    expect((await admin('/api/repositories/101/manager')).value.manager.sections.find(entry=>entry.id==='review.issue').content).toBe('Inspect evidence and cite the original logs.');
    await page.screenshot({path:'.tmp/management-164/configuration-desktop.png',fullPage:true});
    // Pause from chat, then read the same state with direct and existing APIs.
    await message.fill('暂停这个任务');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(feed).toContainText('操作 暂停任务 · 已执行');await expect(page.getByRole('button',{name:'停止',exact:true})).toBeHidden();
    expect((await query(admin,'get_task',{project_id:'101',task_id:'blocked'})).value.task.status).toBe('paused');expect((await admin('/api/tasks/blocked')).value.task.status).toBe('paused');
    const writes=h.store.get('SELECT count(*) n FROM management_commands').n;
    // The explicit project address reopens the same scope on reload.
    await page.reload();await expect(page).toHaveURL(/#\/projects\/101\/management$/);
    await expect(page.locator('.management-scope-name')).toHaveAttribute('data-scope', 'project:101');
    await switchConsoleProject(page, '101');
    // The receipt is persisted on the server, so the project's conversation still shows it once that scope is chosen.
    await expect(feed).toContainText('操作 暂停任务 · 已执行');expect(h.store.get('SELECT count(*) n FROM management_commands').n).toBe(writes);
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'.tmp/management-164/task-mobile.png',fullPage:true});
    const audit=(await query(admin,'list_audit',{project_id:'101'})).value.audit;
    writeFileSync('.tmp/management-164/evidence.json',JSON.stringify({scenario:'query/configuration/task management',query:{status:direct.task.status,reason:direct.task.error_code,logs:direct.logs_url,runs:direct.runs_url},prompt:configured.workflows.find(w=>w.id==='review.issue').prompt,commands:audit.map(r=>({id:r.id,operation:r.operation,state:r.state,channel:r.channel,principal_id:r.principal_id,expected_revision:r.expected_revision,before_revision:r.before_revision,after_revision:r.after_revision,result:r.result})),model_requests:h.store.all('SELECT id,request_id,state,input_tokens,output_tokens FROM model_requests'),page_errors:errors},null,2));
    expect(errors).toEqual([]);expect(h.store.get('SELECT count(*) n FROM tasks').n).toBe(2);
  }finally{await f.close();rmSync(h.directory,{recursive:true,force:true});}
});

test('the management page keeps drafts and a running conversation across console navigation without replaying writes', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), errors = []; let release;
  const writes = f.h.store.get('SELECT count(*) n FROM management_commands').n;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const chat = page.getByRole('region', { name: '管理助手', exact: true });
    await expect(page.locator('#management-launcher')).toHaveCount(0); await expect(chat).toBeHidden();
    await page.locator('#tabs').getByRole('link', { name: '管理助手', exact: true }).click();
    await expect(page).toHaveURL(/#\/management$/); await expect(chat).toBeVisible();
    await switchConsoleProject(page, '101');
    const message = page.getByLabel('管理消息', { exact: true }); await message.fill('任务为什么没有继续？');
    await consoleNavigate(page, '身份与权限');
    await expect(page).toHaveURL(/#\/identity$/); await expect(chat).toBeHidden(); await expect(message).toHaveValue('任务为什么没有继续？');
    await consoleNavigate(page, '管理助手'); await expect(message).toHaveValue('任务为什么没有继续？');
    f.modelState.gate = new Promise(resolve => { release = resolve; });
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await consoleNavigate(page, '身份与权限'); await expect(chat).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    const assistant = page.locator('#console-mobile-nav a[data-page="assistant"]');
    await expect(assistant).toHaveAttribute('data-active', '1');
    release(); f.modelState.gate = null;
    await expect(assistant).toHaveAttribute('data-unread', '1'); await assistant.click();
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await expect(feed).toContainText('任务正在等待项目电脑'); await expect(feed.locator('.management-user')).toHaveCount(1);
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    expect(f.h.store.get('SELECT count(*) n FROM management_commands').n).toBe(writes);
    await expect(message).toBeInViewport(); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/management-164/page-mobile.png' });
    await page.locator('#console-account').click();
    await page.locator('#console-account-menu').getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(chat).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { release?.(); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('project chat links select the project, and a delayed old read cannot replace a new scope or its draft', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), errors = []; let release;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const conversation = (await f.admin('/api/management/conversations', 'POST', { scope: 'project:101' })).value.conversation.id;
    const sent = (await f.admin('/api/management/conversations/' + conversation + '/messages', 'POST', { source_message: 'history-query', content: '任务为什么没有继续？' })).value;
    await settled(f.admin, conversation, sent.id);
    await page.goto(f.h.admin + '/#/projects/101/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/#\/projects\/101\/management$/);
    const scope = page.locator('.management-scope-name'), message = page.getByLabel('管理消息', { exact: true }), feed = page.getByRole('log', { name: '管理会话记录' });
    await expect(scope).toHaveAttribute('data-scope', 'project:101'); await expect(feed).toContainText('environment_not_ready');
    await message.fill('101 的草稿');
    let blocked; const arrived = new Promise(resolve => { blocked = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route('**/conversations/' + conversation + '/events?after=*', async route => {
      const response = await route.fetch(); blocked(); await gate;
      try { await route.fulfill({ response }); } catch { /* Scope changes abort this obsolete read. */ }
    });
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const original = page.locator(`.management-conversation[data-conversation-id="${conversation}"]`);
    await original.click(); await arrived;
    await switchConsoleProject(page, '102');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await message.fill('102 的草稿'); release();
    await expect(feed).not.toContainText('environment_not_ready'); await expect(message).toHaveValue('102 的草稿');
    await page.unrouteAll({ behavior: 'wait' });
    await switchConsoleProject(page, '101'); await expect(message).toHaveValue('101 的草稿'); await expect(feed).toContainText('environment_not_ready');
    await page.evaluate(() => { location.hash = '#/projects/101/roles'; });
    await expect(page).toHaveURL(/#\/projects\/101\/roles$/); await expect(page.getByRole('region', { name: '管理助手', exact: true })).toBeHidden();
    await page.locator('#tabs').getByRole('link',{name:'管理助手',exact:true}).click();
    await expect(page).toHaveURL(/#\/projects\/101\/management$/); await expect(scope).toHaveAttribute('data-scope', 'project:101'); await expect(message).toHaveValue('101 的草稿');
    await switchConsoleProject(page, '102'); await expect(message).toHaveValue('102 的草稿');
    await switchConsoleProject(page, '101'); await expect(message).toHaveValue('101 的草稿');
    await expect(page.getByRole('region', { name: '管理助手', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#management-launcher')).toHaveCount(0);
    const sessions = page.getByRole('button', { name: '会话记录', exact: true });
    await sessions.click(); await expect(original).toBeVisible(); await expect(original).toHaveAttribute('aria-current', 'true');
    mkdirSync('.tmp/management-fixes', { recursive: true }); await page.screenshot({ path: '.tmp/management-fixes/narrow-sidebar.png' });
    await original.click(); await expect(page.getByRole('complementary', { name: '会话记录', exact: true })).toBeHidden();
    await expect(message).toHaveValue('101 的草稿');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    expect(errors).toEqual([]);
  } finally { release?.(); await page.unrouteAll({ behavior: 'wait' }); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('a delayed send receipt clears only the submitted draft even when its conversation is no longer selected', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), errors = []; let release;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const scope = page.locator('.management-scope-name'), message = page.getByLabel('管理消息', { exact: true }), send = page.getByRole('button', { name: '发送', exact: true });
    await switchConsoleProject(page, '101'); await expect(send).toBeEnabled();
    async function delayedSend(text, newerDraft = null) {
      let accepted; const arrived = new Promise(resolve => { accepted = resolve; }), gate = new Promise(resolve => { release = resolve; });
      const pattern = '**/api/management/conversations/*/messages';
      await page.route(pattern, async route => { const response = await route.fetch(); accepted(); await gate; await route.fulfill({ response }); });
      await message.fill(text); await send.click(); await arrived;
      if (newerDraft !== null) await message.fill(newerDraft);
      await switchConsoleProject(page, '102'); await expect(send).toBeEnabled(); await message.fill('102 的新草稿');
      const received = page.waitForResponse(response => response.request().method() === 'POST' && /\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
      release(); await (await received).finished(); await page.unroute(pattern);
      await expect(message).toHaveValue('102 的新草稿');
      await switchConsoleProject(page, '101'); await expect(message).toHaveValue(newerDraft ?? ''); await expect(send).toBeEnabled();
    }
    await delayedSend('send this only once');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    // New text typed before leaving is another draft, not the text covered by the old receipt.
    await delayedSend('send this second message once', '下一条尚未发送的草稿');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(2);
    // A rejected POST must leave the unsent draft available after changing scope.
    await page.route('**/api/management/conversations/*/messages', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_unavailable' }) }));
    await message.fill('发送失败的草稿'); await send.click(); await expect(page.locator('.management-status')).toContainText('fixture_unavailable');
    await switchConsoleProject(page, '102'); await expect(send).toBeEnabled(); await switchConsoleProject(page, '101'); await expect(message).toHaveValue('发送失败的草稿');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(2); expect(errors).toEqual([]);
  } finally { release?.(); await page.unrouteAll({ behavior: 'wait' }); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('loading a scope disables composing until its draft is restored, and abandoning that load cannot replace newer input', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), errors = []; let release;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const scope = page.locator('.management-scope-name'), message = page.getByLabel('管理消息', { exact: true }), send = page.getByRole('button', { name: '发送', exact: true });
    await switchConsoleProject(page, '101'); await expect(send).toBeEnabled(); await message.fill('101 保留的草稿');
    let arrived, finished, held = false;
    const blocked = new Promise(resolve => { arrived = resolve; }), done = new Promise(resolve => { finished = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/management/conversations', async route => {
      if (route.request().method() !== 'GET' || held) return route.continue();
      held = true; const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }); finished();
    });
    await switchConsoleProject(page, '102'); await blocked;
    await expect(message).toBeDisabled(); await expect(send).toBeDisabled();
    await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeDisabled();
    await switchConsoleProject(page, '201'); await expect(message).toBeEnabled(); await message.fill('201 载入后的新草稿');
    release(); await done; await expect(scope).toHaveAttribute('data-scope', 'project:201'); await expect(message).toHaveValue('201 载入后的新草稿');
    await page.unrouteAll({ behavior: 'wait' });
    await switchConsoleProject(page, '101'); await expect(message).toHaveValue('101 保留的草稿');
    await switchConsoleProject(page, '102'); await expect(message).toBeEnabled(); await message.fill('102 载入后的新草稿');
    await switchConsoleProject(page, '201'); await expect(message).toHaveValue('201 载入后的新草稿');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(0); expect(errors).toEqual([]);
  } finally { release?.(); await page.unrouteAll({ behavior: 'wait' }); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('management uses one shell header and a persistent conversation sidebar on desktop and mobile', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); mkdirSync('.tmp/management-display', { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(f.h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const chat = page.locator('#management-chat');
    await page.locator('#tabs').getByRole('link', { name: '管理助手', exact: true }).click(); await switchConsoleProject(page, '101');
    const message = page.getByLabel('管理消息', { exact: true }), send = page.getByRole('button', { name: '发送', exact: true });
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await message.fill('任务为什么没有继续？'); await send.click();
    await expect(feed).toContainText('任务正在等待项目电脑'); await expect(send).toBeEnabled();
    const current = page.locator('.management-conversation[aria-current=true]'), first = await current.getAttribute('data-conversation-id');
    await message.fill('保留这条尚未发送的草稿');
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    await expect(current).not.toHaveAttribute('data-conversation-id', first); await expect(message).toHaveValue('');
    const second = await current.getAttribute('data-conversation-id');
    await message.fill('新会话的草稿');
    await page.locator(`.management-conversation[data-conversation-id="${first}"]`).click();
    await expect(feed).toContainText('任务正在等待项目电脑'); await expect(message).toHaveValue('保留这条尚未发送的草稿');
    await expect(page.locator('.management-conversation')).toHaveCount(2);
    for (const name of ['快捷操作', '全屏显示管理助手', '切换为悬浮窗口', '收起管理助手']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    for (const text of ['查看任务进展', '分析阻塞原因', '了解项目配置', '从了解情况，到推进下一步']) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    await expect(page.locator('#management-launcher')).toHaveCount(0); await expect(page.locator('.management-window-head')).toHaveCount(0);
    await expect(page.locator('body > header')).toBeVisible(); await expect(page.locator('#tabs [aria-current=page]')).toHaveText('管理助手');
    const pageBox = await chat.boundingBox(), header = await page.locator('body > header').boundingBox();
    const rail = await page.locator('#console-sidebar').boundingBox(), sidebar = await page.locator('.management-sidebar').boundingBox();
    expect(pageBox.x).toBe(rail.x + rail.width); expect(pageBox.width).toBe(1440 - rail.width); expect(Math.abs(pageBox.y - header.height)).toBeLessThan(2); expect(pageBox.y + pageBox.height).toBe(1000);
    expect(sidebar.x).toBe(pageBox.x); expect(sidebar.width).toBeGreaterThan(200); expect(sidebar.x + sidebar.width).toBeLessThan((await message.boundingBox()).x);
    await page.screenshot({ path: '.tmp/management-display/page-desktop.png' });
    await consoleNavigate(page, '身份与权限'); await expect(chat).toBeHidden();
    await consoleNavigate(page, '管理助手'); await expect(message).toHaveValue('保留这条尚未发送的草稿');
    await page.reload(); await expect(page).toHaveURL(/#\/projects\/101\/management$/);
    await expect(chat).toHaveAttribute('role', 'region'); await expect(feed).toContainText('任务正在等待项目电脑');
    await expect(page.locator('.management-scope-name')).toHaveAttribute('data-scope', 'project:101');
    await page.setViewportSize({ width: 390, height: 844 });
    const sessions = page.getByRole('button', { name: '会话记录', exact: true });
    const history = page.getByRole('complementary', { name: '会话记录', exact: true });
    await expect(history).toBeHidden(); await sessions.click(); await expect(history).toBeVisible();
    await page.locator(`.management-conversation[data-conversation-id="${second}"]`).click();
    await expect(history).toBeHidden(); await expect(current).toHaveAttribute('data-conversation-id', second); await expect(feed).not.toContainText('任务正在等待项目电脑');
    await sessions.click(); await page.locator(`.management-conversation[data-conversation-id="${first}"]`).click();
    await expect(history).toBeHidden(); await expect(feed).toContainText('任务正在等待项目电脑');
    await expect(send).toBeInViewport(); await expect(message).toBeInViewport();
    await expect(page.locator('#console-mobile-nav a[data-page="assistant"]')).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/management-display/page-mobile.png' });
    await sessions.click(); await page.screenshot({ path: '.tmp/management-display/page-mobile-sidebar.png' });
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    expect(f.h.store.get("SELECT count(*) n FROM management_conversations WHERE scope='project:101'").n).toBe(2); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('a rollback previews the command it would send, and sends it only after it is confirmed', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), { h, admin, password } = f;
  const commands = () => h.store.get('SELECT count(*) n FROM management_commands').n;
  const prompt = async () => (await query(admin, 'get_effective_config', { project_id: '101' })).value.workflows
    .find(w => w.id === 'review.issue').prompt.effective;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await switchConsoleProject(page, '101');
    const original = 'The original prompt that rollback must restore.', updated = 'A changed prompt that the rollback must replace.';
    const seeded = await command(admin, 'workflow.update', { project_id: '101', workflow_id: 'review.issue' }, { prompt: original });
    expect(seeded.value.state).toBe('succeeded');
    const before = commands(); expect(await prompt()).toBe(original);
    expect(updated).not.toBe(original); f.modelState.configurationPrompt = updated;
    await page.getByLabel('管理消息', { exact: true }).fill('更新任务默认提示词');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await expect(feed).toContainText('操作 更新工作配置 · 已执行');
    expect(commands()).toBe(before + 1); expect(await prompt()).toBe(updated);
    const receipt = feed.locator('.management-receipt').filter({ hasText: '操作 更新工作配置' }).last();
    const rollback = receipt.getByRole('button', { name: '按原值回滚', exact: true });
    const preview = receipt.getByRole('region', { name: '执行前确认', exact: true });
    // A rollback is a write too: it names the command it would send and leaves the receipt untouched until confirmed.
    await expect(preview).toBeHidden();
    await rollback.click();
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('更新工作配置');
    await expect(preview).toContainText('项目 101');
    await expect(preview).toContainText('预计版本');
    await expect(preview).toContainText(original); await expect(preview).not.toContainText(updated);
    expect(commands()).toBe(before + 1); expect(await prompt()).toBe(updated);
    const shown = await preview.evaluate(el => { const b = el.getBoundingClientRect();
      const head = el.querySelector('h3').getBoundingClientRect(), hit = document.elementFromPoint(head.left + 8, head.top + head.height / 2);
      return { top: b.top, bottom: b.bottom, hit: !!hit && el.contains(hit), inside: b.top >= 0 && b.bottom <= innerHeight }; });
    expect(shown.hit).toBe(true); expect(shown.inside).toBe(true);
    await page.screenshot({ path: '.tmp/management-rollback/1440.png', fullPage: true });
    // Both phone widths keep the confirmation heading reachable within the conversation.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(preview).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await preview.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await preview.evaluate(el => el.scrollIntoView({ block: 'center' }));
      const mobileShown = await preview.evaluate(el => { const b = el.getBoundingClientRect();
        const head = el.querySelector('h3').getBoundingClientRect(), hit = document.elementFromPoint(head.left + 8, head.top + head.height / 2);
        return { top: b.top, bottom: b.bottom, headingTop: head.top, occluder: hit?.className, hit: !!hit && el.contains(hit), inside: b.top >= 0 && b.top <= innerHeight - 48 }; });
      expect(mobileShown.hit, JSON.stringify(mobileShown)).toBe(true); expect(mobileShown.inside).toBe(true);
      const confirm = preview.getByRole('button', { name: '确认执行', exact: true });
      await confirm.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await expect(confirm).toBeInViewport({ ratio: 1 });
      expect(await confirm.evaluate(el => { const b = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); })).toBe(true);
      await page.screenshot({ path: `.tmp/management-rollback/${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    // 取消 drops the rollback without a command.
    await preview.getByRole('button', { name: '取消', exact: true }).click();
    await expect(preview).toBeHidden();
    expect(commands()).toBe(before + 1); expect(await prompt()).toBe(updated);
    // 确认执行 sends exactly one rollback and the restored value is readable from the API.
    await rollback.click();
    await preview.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(feed).toContainText('操作 更新工作配置 · 已执行', { timeout: 15000 });
    await expect.poll(prompt).toBe(original);
    expect(commands()).toBe(before + 2);
  } finally { await f.close(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('项目管理员在没有已启动项目或接口 403 时看到原因和重试，不会一直停在正在读取', async ({ page }) => {
  const f = await managementFixture(), empty = await f.member('no-project', {});
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('no-project');
    await page.getByLabel('密码', { exact: true }).fill(empty.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('.management-panel');
    await expect(panel.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('.console-state')).toContainText('已启动');
    await expect(panel.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    await expect(panel.getByRole('link', { name: '查看项目列表' })).toBeVisible();
    await expect(panel.getByRole('link', { name: '查看身份与权限' })).toBeVisible();
    await expect(panel.getByText('正在读取会话…', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('正在连接管理助手…')).toHaveCount(0);
    await expect(page.getByLabel('管理消息')).toBeDisabled();
    await page.screenshot({ path: '.tmp/ui-522/after-empty-desktop.png', fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await expect(panel.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible();
      await expect(panel.getByRole('button', { name: '重试', exact: true })).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: `.tmp/ui-522/after-empty-${width}.png`, fullPage: true });
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/projects');
    await page.getByRole('button', { name: '退出登录' }).click();
    const granted = await f.member('has-project', { repository_ids: ['101'] });
    await page.route('**/api/management/conversations', route => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 403, json: { error: 'scope_forbidden' } });
      return route.continue();
    });
    await page.getByLabel('用户名', { exact: true }).fill('has-project');
    await page.getByLabel('密码', { exact: true }).fill(granted.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.goto(f.h.admin + '/#/management');
    await expect(page.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    await page.unroute('**/api/management/conversations');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: '无法打开管理会话' })).toHaveCount(0);

    await page.route('**/api/management/conversations/**/messages', route => {
      if (route.request().method() === 'POST') return route.fulfill({ status: 500, json: { error: 'send_failed' } });
      return route.continue();
    });
    await page.getByLabel('管理消息', { exact: true }).fill('这条会失败');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.management-status')).toContainText('send_failed');
    await expect(page.locator('.management-status')).not.toContainText('无法打开管理会话');
  } finally { await f.close(); }
});
