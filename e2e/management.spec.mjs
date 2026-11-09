import { test,expect } from '@playwright/test';
import { mkdirSync,rmSync,writeFileSync } from 'node:fs';
import { managementFixture,query,settled } from '../test/management-fixture.mjs';

test('management UI, direct API and model tools agree on real persisted query, configuration and task results',async({page})=>{
  test.setTimeout(90000);
  const f=await managementFixture(),{h,admin,password}=f,errors=[];
  page.on('pageerror',e=>errors.push(e.message));mkdirSync('.tmp/management-164',{recursive:true});
  try{
    await page.setViewportSize({width:1440,height:1100});await page.goto(h.admin+'/#/management');
    await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    await expect(page.getByRole('dialog',{name:'管理助手',exact:true})).toBeVisible();
    await expect(page.getByLabel('默认提示词',{exact:true})).toBeHidden();
    const feed=page.getByRole('log',{name:'管理会话记录'}),message=page.getByLabel('管理消息',{exact:true});
    // A natural language request uses actual management_query, which reads the same SQLite task as the API.
    await message.fill('任务为什么没有继续？');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(feed).toContainText('environment_not_ready');await expect(feed).toContainText('Project computer is stopped');
    await expect(page.getByRole('button',{name:'停止',exact:true})).toBeHidden();
    const direct=(await query(admin,'get_task',{project_id:'101',task_id:'blocked'})).value;
    expect(direct.task.status).toBe('waiting_environment');expect(direct.task.error_code).toBe('environment_not_ready');
    await page.screenshot({path:'.tmp/management-164/query-desktop.png',fullPage:true});
    // The model submits a versioned command; the page and the old workflow API see the resulting default prompt.
    await message.fill('更新任务默认提示词');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(feed).toContainText('操作 workflow.update · succeeded');
    await expect(page.getByRole('button',{name:'停止',exact:true})).toBeHidden();
    const configured=(await query(admin,'get_effective_config',{project_id:'101'})).value;
    expect(configured.workflows.find(w=>w.id==='review.issue').prompt.effective).toBe('Inspect evidence and cite the original logs.');
    expect((await admin('/api/repositories/101/workflows/review.issue')).value.workflow.prompt.effective).toBe('Inspect evidence and cite the original logs.');
    await page.getByRole('button',{name:'快捷操作',exact:true}).click();
    await expect(page.getByLabel('默认提示词',{exact:true})).toHaveValue('Inspect evidence and cite the original logs.');
    await page.screenshot({path:'.tmp/management-164/configuration-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'返回对话',exact:true}).click();
    // Pause from chat, then read the same state with direct and existing APIs.
    await message.fill('暂停这个任务');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(feed).toContainText('操作 task.pause · succeeded');await expect(page.getByRole('button',{name:'停止',exact:true})).toBeHidden();
    expect((await query(admin,'get_task',{project_id:'101',task_id:'blocked'})).value.task.status).toBe('paused');expect((await admin('/api/tasks/blocked')).value.task.status).toBe('paused');
    const writes=h.store.get('SELECT count(*) n FROM management_commands').n;
    await page.reload();await page.getByRole('button',{name:'打开管理助手',exact:true}).click();await expect(feed).toContainText('操作 task.pause · succeeded');expect(h.store.get('SELECT count(*) n FROM management_commands').n).toBe(writes);
    // Explicit UI form shares the task command handler and updates the same persisted state.
    await page.getByRole('button',{name:'快捷操作',exact:true}).click();
    await page.getByLabel('管理任务',{exact:true}).selectOption('blocked');await page.getByRole('button',{name:'重试任务',exact:true}).click();
    await expect(feed).toContainText('操作 task.retry · succeeded');expect((await query(admin,'get_task',{project_id:'101',task_id:'blocked'})).value.task.status).toBe('queued');
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
    await page.locator('#tabs').getByRole('button', { name: '管理对话', exact: true }).click();
    await expect(page).toHaveURL(/#\/projects$/); await expect(chat).toBeVisible();
    await page.getByLabel('当前管理作用域').selectOption('project:101');
    const message = page.getByLabel('管理消息', { exact: true }); await message.fill('任务为什么没有继续？');
    await page.getByRole('button', { name: '收起管理助手', exact: true }).click();
    await launcher.click(); await expect(message).toHaveValue('任务为什么没有继续？');
    await page.locator('#tabs').getByRole('button', { name: '身份与权限', exact: true }).click();
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
    await page.keyboard.press('Escape'); await expect(chat).toBeHidden(); await expect(launcher).toBeFocused();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(launcher).toHaveCount(0); await expect(chat).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { release?.(); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('project chat links select the project, and a delayed old read cannot replace a new scope or its draft', async ({ page }) => {
  test.setTimeout(60000);
  const f = await managementFixture(), errors = []; let release;
  page.on('pageerror', error => errors.push(error.message));
  try {
    const conversation = (await f.admin('/api/management/conversations', 'POST', { scope: 'project:101' })).value.conversation.id;
    const sent = (await f.admin('/api/management/conversations/' + conversation + '/messages', 'POST', { source_message: 'history-query', content: '任务为什么没有继续？' })).value;
    await settled(f.admin, conversation, sent.id);
    await page.goto(f.h.admin + '/#/projects/101/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
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
    await page.locator('.project-nav').getByRole('link', { name: '工作流', exact: true }).click();
    await page.getByRole('button', { name: '用聊天新增', exact: true }).click();
    const workflow = page.getByRole('dialog', { name: '工作流助手', exact: true });
    await expect(workflow).toBeVisible(); await expect(page.getByRole('dialog', { name: '管理助手', exact: true })).toBeHidden();
    // The global launcher must not cover the unmoved workflow assistant's Send button.
    const send = workflow.getByRole('button', { name: '发送', exact: true });
    const unobstructed = node => { const rect = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); };
    expect(await send.evaluate(unobstructed)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await send.evaluate(unobstructed)).toBe(true);
    await page.getByRole('button', { name: '打开管理助手', exact: true }).click();
    await expect(workflow).toBeHidden(); await expect(message).toHaveValue('101 的草稿');
    expect(f.h.store.get('SELECT count(*) n FROM management_messages').n).toBe(1);
    expect(errors).toEqual([]);
  } finally { release?.(); await page.unrouteAll({ behavior: 'wait' }); await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
