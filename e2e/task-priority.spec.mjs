import {rmSync} from 'node:fs';
import {test,expect} from '@playwright/test';
import {harness,setup,account,repository} from '../test/helpers.mjs';
import {TaskEngine} from '../dist/agent/engine.js';

test('任务详情展示持久化优先级，调整后进入新级队尾并保留理由',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const h=await harness(undefined,undefined,store=>({engine:new TaskEngine(store,{call:async()=>null})}));
 try{
  const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('priority-ui','101','task.request','queued','检查文档与交付优先级','{}')");
  const before=h.store.get("SELECT queue_seq FROM tasks WHERE id='priority-ui'").queue_seq;
  await page.goto(h.admin);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();await page.goto(h.admin+'/#/projects/101/activity');await expect(page.getByRole('heading',{name:'fixture/project-101',exact:true})).toBeVisible();
  await page.evaluate(()=>openTask('priority-ui'));
  await expect(page.getByLabel('任务优先级',{exact:true})).toHaveValue('P2');
  await page.getByLabel('任务优先级',{exact:true}).selectOption('P3');await page.getByLabel('优先级调整理由',{exact:true}).fill('仅文档措辞；功能和必需测试已经通过，不阻塞交付');await page.getByRole('button',{name:'调整优先级',exact:true}).click();
  await expect(page.getByLabel('任务优先级',{exact:true})).toHaveValue('P3');
  const row=h.store.get("SELECT priority,queue_seq FROM tasks WHERE id='priority-ui'");expect(row.priority).toBe('P3');expect(row.queue_seq).toBeGreaterThan(before);
  expect(h.store.get("SELECT data FROM task_history WHERE task_id='priority-ui' AND type='priority_changed'").data).toContain('不阻塞交付');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
