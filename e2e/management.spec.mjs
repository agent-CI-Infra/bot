import { consoleNavigate } from './console-navigation.mjs';
import { test,expect } from '@playwright/test';
import { mkdirSync,rmSync,writeFileSync } from 'node:fs';
import { managementFixture,query,settled } from '../test/management-fixture.mjs';

test('mobile management sends and previews a configuration on the first press while an editor is focused', async ({ page }) => {
  const f = await managementFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 390, height: 360 });
    await page.goto(f.h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    const send = page.getByRole('button', { name: '发送', exact: true });
    await expect(send).toBeEnabled();
    const message = page.getByLabel('管理消息', { exact: true });
    await message.fill('任务为什么没有继续？'); await message.focus(); await expect(message).toBeFocused();
    await send.click();
    await expect(page.getByRole('log', { name: '管理会话记录' })).toContainText('任务正在等待项目电脑');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    await page.getByRole('button', { name: '快捷操作', exact: true }).click();
    const commandsBefore = f.h.store.get('SELECT count(*) n FROM management_commands').n;
    const prompt = page.getByLabel('默认提示词', { exact: true });
    await prompt.fill('Preserve current authorization.'); await prompt.focus(); await expect(prompt).toBeFocused();
    const save = page.getByRole('button', { name: '保存默认提示词', exact: true });
    await save.scrollIntoViewIfNeeded(); await save.click();
    const preview = page.getByRole('region', { name: '执行前确认', exact: true });
    await expect(preview).toBeVisible(); await expect(preview).toContainText('Preserve current authorization.');
    expect(f.h.store.get('SELECT count(*) n FROM management_commands').n).toBe(commandsBefore);
    await preview.getByRole('button', { name: '取消', exact: true }).click();
    await expect(prompt).toHaveValue('Preserve current authorization.');
    expect(f.h.store.get('SELECT count(*) n FROM management_commands').n).toBe(commandsBefore); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('management UI, direct API and model tools agree on real persisted query, configuration and task results',async({page})=>{
  test.setTimeout(90000);
  const f=await managementFixture(),{h,admin,password}=f,errors=[];
  page.on('pageerror',e=>errors.push(e.message));mkdirSync('.tmp/management-164',{recursive:true});
  try{
    await page.setViewportSize({width:1440,height:1100});await page.goto(h.admin+'/#/management');
    await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByLabel('当前管理作用域').selectOption('project:101');
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
    await page.getByRole('button',{name:'快捷操作',exact:true}).click();
    await expect(page.getByLabel('默认提示词',{exact:true})).toHaveValue('Inspect evidence and cite the original logs.');
    await page.screenshot({path:'.tmp/management-164/configuration-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'返回对话',exact:true}).click();
    // Pause from chat, then read the same state with direct and existing APIs.
    await message.fill('暂停这个任务');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(feed).toContainText('操作 暂停任务 · 已执行');await expect(page.getByRole('button',{name:'停止',exact:true})).toBeHidden();
    expect((await query(admin,'get_task',{project_id:'101',task_id:'blocked'})).value.task.status).toBe('paused');expect((await admin('/api/tasks/blocked')).value.task.status).toBe('paused');
    const writes=h.store.get('SELECT count(*) n FROM management_commands').n;
    // #480: a page-local scope is not restored on reload; the assistant opens on the shell default (none here, so platform).
    await page.reload();await expect(page).toHaveURL(/#\/management$/);
    await expect(page.getByLabel('当前管理作用域')).toHaveValue('platform');
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    // The receipt is persisted on the server, so the project's conversation still shows it once that scope is chosen.
    await expect(feed).toContainText('操作 暂停任务 · 已执行');expect(h.store.get('SELECT count(*) n FROM management_commands').n).toBe(writes);
    // Explicit UI form shares the task command handler and updates the same persisted state.
    await page.getByRole('button',{name:'快捷操作',exact:true}).click();
    await page.getByLabel('管理任务',{exact:true}).selectOption('blocked');await page.getByRole('button',{name:'重试任务',exact:true}).click();
    await page.getByRole('region',{name:'执行前确认',exact:true}).getByRole('button',{name:'确认执行',exact:true}).click();
    await expect(feed).toContainText('操作 重试任务 · 已执行');expect((await query(admin,'get_task',{project_id:'101',task_id:'blocked'})).value.task.status).toBe('queued');
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'.tmp/management-164/task-mobile.png',fullPage:true});
    const audit=(await query(admin,'list_audit',{project_id:'101'})).value.audit;
    writeFileSync('.tmp/management-164/evidence.json',JSON.stringify({scenario:'query/configuration/task management',query:{status:direct.task.status,reason:direct.task.error_code,logs:direct.logs_url,runs:direct.runs_url},prompt:configured.workflows.find(w=>w.id==='review.issue').prompt,commands:audit.map(r=>({id:r.id,operation:r.operation,state:r.state,channel:r.channel,principal_id:r.principal_id,expected_revision:r.expected_revision,before_revision:r.before_revision,after_revision:r.after_revision,result:r.result})),model_requests:h.store.all('SELECT id,request_id,state,input_tokens,output_tokens FROM model_requests'),page_errors:errors},null,2));
    expect(errors).toEqual([]);expect(h.store.get('SELECT count(*) n FROM tasks').n).toBe(2);
  }finally{await f.close();rmSync(h.directory,{recursive:true,force:true});}
});

test('global management chat keeps drafts and a running conversation across navigation and minimize, without replaying writes', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), errors = []; let release;
  const writes = f.h.store.get('SELECT count(*) n FROM management_commands').n;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const launcher = page.getByRole('button', { name: '打开管理助手', exact: true }), chat = page.getByRole('dialog', { name: '管理助手', exact: true });
    await expect(launcher).toBeVisible(); await expect(chat).toBeHidden();
    await launcher.click();
    await expect(page).toHaveURL(/#\/projects$/); await expect(chat).toBeVisible();
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    const message = page.getByLabel('管理消息', { exact: true }); await message.fill('任务为什么没有继续？');
    await page.getByRole('button', { name: '收起管理助手', exact: true }).click();
    await launcher.click(); await expect(message).toHaveValue('任务为什么没有继续？');
    await consoleNavigate(page, '身份与权限');
    await expect(page).toHaveURL(/#\/identity$/); await expect(message).toHaveValue('任务为什么没有继续？');
    f.modelState.gate = new Promise(resolve => { release = resolve; });
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '收起管理助手', exact: true }).click();
    await expect(launcher).toContainText('正在处理');
    await page.locator('#tabs').getByRole('button', { name: '项目', exact: true }).click();
    release(); f.modelState.gate = null;
    await expect(launcher).toContainText('有新回复'); await launcher.click();
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await expect(feed).toContainText('任务正在等待项目电脑'); await expect(feed.locator('.management-user')).toHaveCount(1);
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    expect(f.h.store.get('SELECT count(*) n FROM management_commands').n).toBe(writes);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(message).toBeInViewport(); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/management-164/floating-mobile.png' });
    // #481: on a phone the bar's 助手 destination replaces both the floating launcher and the header's sign-out button.
    await page.keyboard.press('Escape'); await expect(chat).toBeHidden();
    await expect(page.locator('#console-mobile-nav a[data-page="assistant"]')).toBeFocused(); await expect(launcher).toBeHidden();
    await page.locator('#console-account').click();
    await page.locator('#console-account-menu').getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(launcher).toHaveCount(0); await expect(chat).toHaveCount(0);
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
    // The chat address has no settings section of its own: it keeps the project and opens its first page underneath.
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    const scope = page.getByLabel('当前管理作用域'), message = page.getByLabel('管理消息', { exact: true }), feed = page.getByRole('log', { name: '管理会话记录' });
    await expect(scope).toHaveValue('project:101'); await expect(feed).toContainText('environment_not_ready');
    await message.fill('101 的草稿');
    let blocked; const arrived = new Promise(resolve => { blocked = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route('**/conversations/' + conversation + '/events?after=*', async route => {
      const response = await route.fetch(); blocked(); await gate;
      try { await route.fulfill({ response }); } catch { /* Scope changes abort this obsolete read. */ }
    });
    await page.getByRole('button', { name: '快捷操作', exact: true }).click();
    await page.getByRole('button', { name: '重新连接', exact: true }).click(); await arrived;
    await scope.selectOption('project:102');
    await page.getByRole('button', { name: '返回对话', exact: true }).click();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await message.fill('102 的草稿'); release();
    await expect(feed).not.toContainText('environment_not_ready'); await expect(message).toHaveValue('102 的草稿');
    await page.unrouteAll({ behavior: 'wait' });
    await scope.selectOption('project:101'); await expect(message).toHaveValue('101 的草稿'); await expect(feed).toContainText('environment_not_ready');
    // Opening the project entry again reuses the same chat and keeps the current settings page.
    await page.locator('.project-nav').getByRole('link', { name: '角色', exact: true }).click();
    await page.locator('.project-nav').getByRole('link', { name: '管理对话', exact: true }).click();
    await expect(page).toHaveURL(/#\/projects\/101\/roles$/); await expect(scope).toHaveValue('project:101'); await expect(message).toHaveValue('101 的草稿');
    await scope.selectOption('project:102'); await expect(message).toHaveValue('102 的草稿');
    await page.getByRole('button', { name: '收起管理助手', exact: true }).click();
    await page.getByRole('button', { name: '打开管理助手', exact: true }).click();
    await expect(scope).toHaveValue('project:102'); await expect(message).toHaveValue('102 的草稿');
    await page.locator('#tabs').getByRole('button', { name: '管理对话', exact: true }).click();
    await expect(scope).toHaveValue('project:101'); await expect(message).toHaveValue('101 的草稿');
    await expect(page).toHaveURL(/#\/management$/); await expect(page.getByRole('region', { name: '管理助手', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '切换为悬浮窗口', exact: true }).click(); await expect(page).toHaveURL(/#\/projects\/101\/roles$/);
    // With the chat collapsed on a narrow screen, its launcher covers none of the header navigation.
    await page.getByRole('button', { name: '收起管理助手', exact: true }).click();
    const unobstructed = node => { const rect = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); };
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => scrollTo(0, 0));
    for (const nav of await page.locator('#tabs button:visible').all()) { await nav.scrollIntoViewIfNeeded(); expect(await nav.evaluate(unobstructed)).toBe(true); }
    mkdirSync('.tmp/management-fixes', { recursive: true }); await page.screenshot({ path: '.tmp/management-fixes/narrow-header.png' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '打开管理助手', exact: true }).click(); await expect(message).toHaveValue('101 的草稿');
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
    const scope = page.getByLabel('当前管理作用域'), message = page.getByLabel('管理消息', { exact: true }), send = page.getByRole('button', { name: '发送', exact: true });
    await scope.selectOption('project:101'); await expect(send).toBeEnabled();
    async function delayedSend(text, newerDraft = null) {
      let accepted; const arrived = new Promise(resolve => { accepted = resolve; }), gate = new Promise(resolve => { release = resolve; });
      const pattern = '**/api/management/conversations/*/messages';
      await page.route(pattern, async route => { const response = await route.fetch(); accepted(); await gate; await route.fulfill({ response }); });
      await message.fill(text); await send.click(); await arrived;
      if (newerDraft !== null) await message.fill(newerDraft);
      await scope.selectOption('project:102'); await expect(send).toBeEnabled(); await message.fill('102 的新草稿');
      const received = page.waitForResponse(response => response.request().method() === 'POST' && /\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
      release(); await (await received).finished(); await page.unroute(pattern);
      await expect(message).toHaveValue('102 的新草稿');
      await scope.selectOption('project:101'); await expect(message).toHaveValue(newerDraft ?? ''); await expect(send).toBeEnabled();
    }
    await delayedSend('send this only once');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    // New text typed before leaving is another draft, not the text covered by the old receipt.
    await delayedSend('send this second message once', '下一条尚未发送的草稿');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(2);
    // A rejected POST must leave the unsent draft available after changing scope.
    await page.route('**/api/management/conversations/*/messages', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_unavailable' }) }));
    await message.fill('发送失败的草稿'); await send.click(); await expect(page.locator('.management-status')).toContainText('fixture_unavailable');
    await scope.selectOption('project:102'); await expect(send).toBeEnabled(); await scope.selectOption('project:101'); await expect(message).toHaveValue('发送失败的草稿');
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
    const scope = page.getByLabel('当前管理作用域'), message = page.getByLabel('管理消息', { exact: true }), send = page.getByRole('button', { name: '发送', exact: true });
    await scope.selectOption('project:101'); await expect(send).toBeEnabled(); await message.fill('101 保留的草稿');
    let arrived, finished, held = false;
    const blocked = new Promise(resolve => { arrived = resolve; }), done = new Promise(resolve => { finished = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/management/conversations', async route => {
      if (route.request().method() !== 'GET' || held) return route.continue();
      held = true; const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }); finished();
    });
    await scope.selectOption('project:102'); await blocked;
    await expect(message).toBeDisabled(); await expect(send).toBeDisabled();
    await expect(page.getByRole('button', { name: /查看任务进展/ })).toBeDisabled();
    await scope.selectOption('project:201'); await expect(message).toBeEnabled(); await message.fill('201 载入后的新草稿');
    release(); await done; await expect(scope).toHaveValue('project:201'); await expect(message).toHaveValue('201 载入后的新草稿');
    await page.unrouteAll({ behavior: 'wait' });
    await scope.selectOption('project:101'); await expect(message).toHaveValue('101 保留的草稿');
    await scope.selectOption('project:102'); await expect(message).toBeEnabled(); await message.fill('102 载入后的新草稿');
    await scope.selectOption('project:201'); await expect(message).toHaveValue('201 载入后的新草稿');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(0); expect(errors).toEqual([]);
  } finally { release?.(); await page.unrouteAll({ behavior: 'wait' }); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('management tab opens a full page, and resizing or maximizing the floating view preserves its conversation and draft', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), errors = []; let releaseReturn;
  page.on('pageerror', error => errors.push(error.message)); mkdirSync('.tmp/management-display', { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(f.h.admin + '/#/projects');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const chat = page.locator('#management-chat'), launcher = page.getByRole('button', { name: '打开管理助手', exact: true });
    await launcher.click(); await page.getByLabel('当前管理作用域').selectOption('project:101');
    const message = page.getByLabel('管理消息', { exact: true }), send = page.getByRole('button', { name: '发送', exact: true });
    await message.fill('任务为什么没有继续？'); await send.click();
    await expect(page.getByRole('log', { name: '管理会话记录' })).toContainText('任务正在等待项目电脑'); await expect(send).toBeEnabled();
    await message.fill('保留这条尚未发送的草稿');
    const grip = page.getByRole('button', { name: '调整管理助手窗口大小', exact: true }), before = await chat.boundingBox(), handle = await grip.boundingBox();
    await page.mouse.move(handle.x + 8, handle.y + 8); await page.mouse.down(); await page.mouse.move(handle.x - 132, handle.y - 62, { steps: 10 }); await page.mouse.up();
    const grown = await chat.boundingBox(); expect(grown.width).toBeGreaterThan(before.width + 100); expect(grown.height).toBeGreaterThan(before.height + 40);
    await grip.focus(); await page.keyboard.press('ArrowRight');
    const resized = await chat.boundingBox(); expect(Math.abs(resized.width - (grown.width - 24))).toBeLessThan(2);
    await expect(send).toBeInViewport(); await page.screenshot({ path: '.tmp/management-display/floating-desktop.png' });
    await page.getByRole('button', { name: '全屏显示管理助手', exact: true }).click();
    await expect(chat).toHaveAttribute('aria-modal', 'true');
    const fullscreen = await chat.boundingBox(); expect([fullscreen.x, fullscreen.y, fullscreen.width, fullscreen.height]).toEqual([0, 0, 1440, 1000]);
    await expect(message).toHaveValue('保留这条尚未发送的草稿'); await send.focus(); await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '退出管理助手全屏', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); const restored = await chat.boundingBox();
    expect(Math.abs(restored.width - resized.width)).toBeLessThan(2); expect(Math.abs(restored.height - resized.height)).toBeLessThan(2);
    await page.locator('#tabs').getByRole('button', { name: '管理对话', exact: true }).click();
    await expect(page).toHaveURL(/#\/management$/); await expect(page.locator('#tabs [aria-current=page]')).toHaveText('管理对话');
    await expect(chat).toHaveAttribute('role', 'region'); await expect(grip).toBeHidden(); await expect(launcher).toBeHidden();
    const pageBox = await chat.boundingBox(), header = await page.locator('body > header').boundingBox();
    const rail = await page.locator('#console-sidebar').boundingBox();
    expect(pageBox.x).toBe(rail.x + rail.width); expect(pageBox.width).toBe(1440 - rail.width); expect(Math.abs(pageBox.y - header.height)).toBeLessThan(2); expect(pageBox.y + pageBox.height).toBe(1000);
    await expect(message).toHaveValue('保留这条尚未发送的草稿'); await expect(send).toBeInViewport();
    await page.screenshot({ path: '.tmp/management-display/page-desktop.png' });
    await page.getByRole('button', { name: '全屏显示管理助手', exact: true }).click();
    await page.getByRole('button', { name: '退出管理助手全屏', exact: true }).click(); await expect(chat).toHaveAttribute('role', 'region');
    await page.getByRole('button', { name: '切换为悬浮窗口', exact: true }).click();
    await expect(page).toHaveURL(/#\/projects$/); expect(Math.abs((await chat.boundingBox()).width - resized.width)).toBeLessThan(2);
    await page.locator('#tabs').getByRole('button', { name: '管理对话', exact: true }).click();
    await consoleNavigate(page, '身份与权限');
    await expect(chat).toBeHidden(); await launcher.click(); await expect(message).toHaveValue('保留这条尚未发送的草稿');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    expect(f.h.store.get("SELECT count(*) n FROM management_conversations WHERE scope='project:101'").n).toBe(1);
    await page.locator('#tabs').getByRole('button', { name: '管理对话', exact: true }).click(); await page.reload();
    await expect(page).toHaveURL(/#\/management$/); await expect(chat).toHaveAttribute('role', 'region');
    // #480: the reload reopens on the shell default (no project picked here), not on the page-local scope chosen before it.
    await expect(page.getByLabel('当前管理作用域')).toHaveValue('platform');
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    await message.fill('窄屏整页中的草稿'); await page.setViewportSize({ width: 390, height: 844 });
    await expect(send).toBeInViewport(); await expect(message).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.tmp/management-display/page-mobile.png' });
    await page.getByRole('button', { name: '全屏显示管理助手', exact: true }).click();
    const mobileFull = await chat.boundingBox(); expect([mobileFull.x, mobileFull.y, mobileFull.width, mobileFull.height]).toEqual([0, 0, 390, 844]);
    await expect(send).toBeInViewport(); await message.focus(); await page.keyboard.press('Escape');
    await expect(chat).toHaveAttribute('role', 'region'); await expect(message).toHaveValue('窄屏整页中的草稿');
    let returnArrived; const returning = new Promise(resolve => { returnArrived = resolve; }), returnGate = new Promise(resolve => { releaseReturn = resolve; });
    await page.route('**/api/installations?**', async route => { const response = await route.fetch(); returnArrived(); await returnGate; await route.fulfill({ response }); });
    await page.getByRole('button', { name: '切换为悬浮窗口', exact: true }).click(); await returning; await grip.focus();
    const returned = page.waitForResponse(response => response.url().includes('/api/installations?'));
    releaseReturn(); await (await returned).finished(); await expect(page.locator('#rows .row')).toHaveCount(3); await expect(grip).toBeFocused();
    await page.unrouteAll({ behavior: 'wait' });
    for (let n = 0; n < 12; n++) { await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowDown'); }
    const small = await chat.boundingBox(); expect(small.width).toBe(360); expect(small.height).toBe(460); expect(small.x).toBeGreaterThanOrEqual(0); expect(small.y).toBeGreaterThanOrEqual(0);
    await expect(send).toBeInViewport(); await expect(message).toHaveValue('窄屏整页中的草稿');
    await page.screenshot({ path: '.tmp/management-display/floating-mobile.png' });
    await page.setViewportSize({ width: 520, height: 430 }); await expect(send).toBeInViewport();
    const short = await chat.boundingBox(); expect(short.y).toBeGreaterThanOrEqual(0); expect(short.y + short.height).toBeLessThanOrEqual(430);
    await page.setViewportSize({ width: 390, height: 844 });
    // #481: at this width the bar's 助手 destination is the way back in; the floating launcher is not on screen.
    await page.getByRole('button', { name: '收起管理助手', exact: true }).click();
    await page.locator('#console-mobile-nav a[data-page="assistant"]').click();
    expect((await chat.boundingBox()).width).toBe(360); expect((await chat.boundingBox()).height).toBe(460);
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1); expect(errors).toEqual([]);
  } finally { releaseReturn?.(); await page.unrouteAll({ behavior: 'wait' }); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('a console write previews its operation, target and expected revision, and sends nothing before it is confirmed', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), { h, admin, password } = f;
  const commands = () => h.store.get('SELECT count(*) n FROM management_commands').n;
  const taskStatus = async () => (await query(admin, 'get_task', { project_id: '101', task_id: 'blocked' })).value.task.status;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    await page.getByRole('button', { name: '快捷操作', exact: true }).click();
    await page.getByLabel('管理任务', { exact: true }).selectOption('blocked');
    const preview = page.getByRole('region', { name: '执行前确认', exact: true }), before = commands();
    await expect(preview).toBeHidden();
    // Choosing a write shows what it will do and still sends nothing.
    await page.getByRole('button', { name: '暂停任务', exact: true }).click();
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('暂停任务');
    await expect(preview).toContainText('项目 101 · 任务 Inspect task facts');
    await expect(preview).toContainText('预计版本');
    expect(commands()).toBe(before); expect(await taskStatus()).toBe('waiting_environment');
    // The preview keeps the command inside a 390 px panel instead of widening it.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await preview.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: '.tmp/management-preview-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // 取消 drops it without a command.
    await preview.getByRole('button', { name: '取消', exact: true }).click();
    await expect(preview).toBeHidden();
    expect(commands()).toBe(before); expect(await taskStatus()).toBe('waiting_environment');
    // 确认执行 sends exactly the previewed command.
    await page.getByRole('button', { name: '暂停任务', exact: true }).click();
    await page.screenshot({ path: '.tmp/management-preview-desktop.png', fullPage: true });
    await preview.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(page.getByRole('log', { name: '管理会话记录' })).toContainText('操作 暂停任务 · 已执行');
    expect(commands()).toBe(before + 1); expect(await taskStatus()).toBe('paused');
  } finally { await f.close(); rmSync(h.directory, { recursive: true, force: true }); }
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
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    await page.getByRole('button', { name: '快捷操作', exact: true }).click();
    const before = commands(), original = await prompt();
    await page.getByLabel('默认提示词', { exact: true }).fill('回滚要能回到的旧提示词');
    await page.getByRole('button', { name: '保存默认提示词', exact: true }).click();
    await page.getByRole('region', { name: '执行前确认', exact: true }).getByRole('button', { name: '确认执行', exact: true }).click();
    const feed = page.getByRole('log', { name: '管理会话记录' });
    await expect(feed).toContainText('操作 更新工作配置 · 已执行');
    expect(commands()).toBe(before + 1); expect(await prompt()).toBe('回滚要能回到的旧提示词');
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
    expect(commands()).toBe(before + 1); expect(await prompt()).toBe('回滚要能回到的旧提示词');
    const shown = await preview.evaluate(el => { const b = el.getBoundingClientRect();
      const head = el.querySelector('h3').getBoundingClientRect(), hit = document.elementFromPoint(head.left + 8, head.top + head.height / 2);
      return { top: b.top, bottom: b.bottom, hit: !!hit && el.contains(hit), inside: b.top >= 0 && b.bottom <= innerHeight }; });
    expect(shown.hit).toBe(true); expect(shown.inside).toBe(true);
    await page.screenshot({ path: '.tmp/management-rollback/1440.png', fullPage: true });
    // The same confirmation stays inside a 390 px panel instead of widening it.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(preview).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await preview.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await preview.evaluate(el => el.scrollIntoView({ block: 'center' }));
    const mobileShown = await preview.evaluate(el => { const b = el.getBoundingClientRect();
      const head = el.querySelector('h3').getBoundingClientRect(), hit = document.elementFromPoint(head.left + 8, head.top + head.height / 2);
      return { top: b.top, bottom: b.bottom, hit: !!hit && el.contains(hit), inside: b.top >= 0 && b.top <= innerHeight - 48 }; });
    expect(mobileShown.hit).toBe(true); expect(mobileShown.inside).toBe(true);
    await page.screenshot({ path: '.tmp/management-rollback/390.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // 取消 drops the rollback without a command.
    await preview.getByRole('button', { name: '取消', exact: true }).click();
    await expect(preview).toBeHidden();
    expect(commands()).toBe(before + 1); expect(await prompt()).toBe('回滚要能回到的旧提示词');
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
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(panel.getByRole('heading', { name: '无法打开管理会话' })).toBeVisible();
    await expect(panel.getByRole('button', { name: '重试', exact: true })).toBeInViewport();
    await page.screenshot({ path: '.tmp/ui-522/after-empty-390.png', fullPage: true });

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
