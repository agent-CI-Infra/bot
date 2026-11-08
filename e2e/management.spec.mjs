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
    await expect(page.getByLabel('默认提示词',{exact:true})).toBeVisible();
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
    await expect(page.getByLabel('默认提示词',{exact:true})).toHaveValue('Inspect evidence and cite the original logs.');
    await page.screenshot({path:'.tmp/management-164/configuration-desktop.png',fullPage:true});
    // Pause from chat, then read the same state with direct and existing APIs.
    await message.fill('暂停这个任务');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(feed).toContainText('操作 task.pause · succeeded');await expect(page.getByRole('button',{name:'停止',exact:true})).toBeHidden();
    expect((await query(admin,'get_task',{project_id:'101',task_id:'blocked'})).value.task.status).toBe('paused');expect((await admin('/api/tasks/blocked')).value.task.status).toBe('paused');
    const writes=h.store.get('SELECT count(*) n FROM management_commands').n;
    await page.reload();await expect(feed).toContainText('操作 task.pause · succeeded');expect(h.store.get('SELECT count(*) n FROM management_commands').n).toBe(writes);
    // Explicit UI form shares the task command handler and updates the same persisted state.
    await page.getByLabel('管理任务',{exact:true}).selectOption('blocked');await page.getByRole('button',{name:'重试任务',exact:true}).click();
    await expect(feed).toContainText('操作 task.retry · succeeded');expect((await query(admin,'get_task',{project_id:'101',task_id:'blocked'})).value.task.status).toBe('queued');
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'.tmp/management-164/task-mobile.png',fullPage:true});
    const audit=(await query(admin,'list_audit',{project_id:'101'})).value.audit;
    writeFileSync('.tmp/management-164/evidence.json',JSON.stringify({scenario:'query/configuration/task management',query:{status:direct.task.status,reason:direct.task.error_code,logs:direct.logs_url,runs:direct.runs_url},prompt:configured.workflows.find(w=>w.id==='review.issue').prompt,commands:audit.map(r=>({id:r.id,operation:r.operation,state:r.state,channel:r.channel,principal_id:r.principal_id,expected_revision:r.expected_revision,before_revision:r.before_revision,after_revision:r.after_revision,result:r.result})),model_requests:h.store.all('SELECT id,request_id,state,input_tokens,output_tokens FROM model_requests'),page_errors:errors},null,2));
    expect(errors).toEqual([]);expect(h.store.get('SELECT count(*) n FROM tasks').n).toBe(2);
  }finally{await f.close();rmSync(h.directory,{recursive:true,force:true});}
});
