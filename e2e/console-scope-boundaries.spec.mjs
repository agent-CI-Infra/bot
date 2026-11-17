import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { managementFixture, command } from '../test/management-fixture.mjs';
import { switchConsoleProject } from './console-scope-picker.mjs';

async function login(page,h,password,hash,user='administrator') {
 await page.goto(h.admin+'/'+hash);await page.getByLabel('用户名',{exact:true}).fill(user);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#access')).toBeHidden();
}
async function fixture() {const h=await harness(),{admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');return {h,admin,password,a};}
const out='.tmp/project-navigation-boundaries';

test('a project receipt retains the navigation scope and both back links reopen its assistant without replaying a command',async({page})=>{
 const f=await managementFixture();try {
  const conversation=(await f.admin('/api/management/conversations','POST',{scope:'project:101'})).value.conversation.id;
  const receipt=(await command(f.admin,'workflow.update',{project_id:'101',workflow_id:'review.issue'},{prompt:'Receipt scope regression.'})).value;
  f.h.store.run('UPDATE management_commands SET source_conversation=?,source_message=? WHERE id=?',conversation,'receipt-source',receipt.id);
  const before=f.h.store.get('SELECT count(*) n FROM management_commands').n;
  await login(page,f.h,f.password,'#/projects/101/management');await expect(page.locator('.management-scope-name')).toHaveAttribute('data-scope','project:101');
  await page.goto(f.h.admin+'/#/management/commands/'+receipt.id);await expect(page.locator('[data-receipt-state]')).toHaveText('已执行');
  await expect(page.locator('#console-project')).toHaveAttribute('data-project-id','101');await expect(page.locator('#console-inbox-link')).toHaveAttribute('href','#/projects/101/inbox');
  expect(await page.evaluate(()=>localStorage.getItem('console-last-scope:'+me.id))).toBe('101');
  mkdirSync(out,{recursive:true});
  for(const width of [1440,390]) {await page.setViewportSize({width,height:width===1440?1000:844});await page.screenshot({path:`${out}/receipt-scope-${width}.png`,animations:'disabled'});}
  await page.setViewportSize({width:1440,height:1000});
  for(const caption of ['返回管理助手','回到管理会话']) {
   const link=page.locator('#management-receipt-page').getByRole('link',{name:caption,exact:true});await expect(link).toHaveAttribute('href','#/projects/101/management');await link.click();
   await expect(page.locator('.management-scope-name')).toHaveAttribute('data-scope','project:101');await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled();
   await page.goto(f.h.admin+'/#/management/commands/'+receipt.id);await expect(page.locator('[data-receipt-state]')).toBeVisible();
  }
  expect(f.h.store.get('SELECT count(*) n FROM management_commands').n).toBe(before);
 }finally{await f.close();}
});

test('floating the assistant returns to the exact task, overview mode and inbox page unless its scope changes',async({page})=>{
 const f=await managementFixture();try{
  await login(page,f.h,f.password,'#/tasks/blocked');await expect(page.locator('#task-title')).toBeVisible();
  for(const address of ['#/tasks/blocked','#/projects/101/overview/tasks','#/projects/101/inbox/50']) {
   await page.goto(f.h.admin+'/'+address);
   if(address.includes('/tasks/blocked'))await expect(page.locator('#task-title')).toBeVisible();else if(address.includes('/overview/'))await expect(page.locator('.workspace-overview')).toBeVisible();else await expect(page.locator('.console-inbox')).toBeVisible();
   await page.locator('#tabs').getByRole('link',{name:'管理助手',exact:true}).click();await expect(page.locator('.management-scope-name')).toHaveAttribute('data-scope','project:101');
   await page.getByRole('button',{name:'切换为悬浮窗口',exact:true}).click();await expect(page).toHaveURL(f.h.admin+'/'+address);await expect(page.locator('#management-chat')).toBeVisible();await page.getByRole('button',{name:'收起管理助手',exact:true}).click();
  }
  await page.locator('#tabs').getByRole('link',{name:'管理助手',exact:true}).click();await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled();await switchConsoleProject(page,'102');await expect(page.locator('.management-scope-name')).toHaveAttribute('data-scope','project:102');
  await page.getByRole('button',{name:'切换为悬浮窗口',exact:true}).click();await expect(page).toHaveURL(/#\/projects\/102\/inbox$/);
 }finally{await f.close();}
});

test('revoking a retained project clears neutral navigation and memory while its explicit address still explains denial',async({page})=>{
 const {h,admin,password}=await fixture(),memberPassword=testPassword();const member=(await admin('/api/users','POST',{username:'revoked-scope',password:memberPassword,repository_ids:['101','202']})).value.user;
 try{
  await login(page,h,memberPassword,'#/projects/101/board','revoked-scope');await expect(page.locator('#board-columns')).toBeVisible();
  await admin('/api/project-admin-assignments','PUT',{user_id:member.id,repository_ids:['202']});await page.reload();await expect(page.locator('[data-project-unavailable=forbidden]')).toBeVisible();await expect(page).toHaveURL(/#\/projects\/101\/board$/);
  await page.goto(h.admin+'/#/identity');await expect(page.getByRole('heading',{name:'身份与权限',exact:true})).toBeVisible();await expect(page.locator('#console-project')).toHaveAttribute('data-project-id','');
  await expect(page.locator('#console-inbox-link')).toHaveAttribute('href','#/inbox');await expect(page.locator('#tabs').getByRole('link',{name:'任务看板',exact:true})).toHaveAttribute('href','#/board');
  expect(await page.evaluate(id=>localStorage.getItem('console-last-scope:'+id),member.id)).toBe('all');await page.locator('#tabs').getByRole('link',{name:'任务看板',exact:true}).click();await expect(page.locator('#board-columns')).toBeVisible();await expect(page).toHaveURL(/#\/board$/);
 }finally{await h.stop();}
});

test('empty and inverted cost dates survive a scope change without sending a default-range request',async({page})=>{
 const {h,password}=await fixture(),queries=[];mkdirSync(out,{recursive:true});page.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/costs')queries.push(u.searchParams);});
 try{
  await login(page,h,password,'#/costs');await expect(page.locator('#cost-body').getByRole('heading',{name:'项目占比',exact:true})).toBeVisible();
  const from=page.getByLabel('开始日期（本地）',{exact:true}),to=page.getByLabel('结束日期（本地）',{exact:true});
  for(const [width,name,value] of [[1440,'empty',''],[390,'inverted','2099-12-31']]) {
   await page.setViewportSize({width,height:width===1440?1000:844});await from.fill(value);await expect(page.getByRole('heading',{name:'请填写有效日期范围',exact:true})).toBeVisible();const before=queries.length,oldForm=await page.locator('.cost-filters').elementHandle();
   await switchConsoleProject(page,width===1440?'101':'202');await expect(page).toHaveURL(new RegExp('#/projects/'+(width===1440?'101':'202')+'/costs$'));await expect.poll(()=>oldForm.evaluate(n=>n.isConnected)).toBe(false);await expect(from).toHaveValue(value);await expect(page.locator('#count')).toHaveText('未查询');await expect(page.getByRole('heading',{name:'请填写有效日期范围',exact:true})).toBeVisible();expect(queries.length).toBe(before);
   await page.screenshot({path:`${out}/costs-${name}-${width}.png`,animations:'disabled'});
  }
  await from.fill('2026-11-01');await to.fill('2026-11-02');await Promise.all([page.waitForResponse(r=>r.url().includes('/api/costs?')&&r.status()===200),page.getByRole('button',{name:'查看统计',exact:true}).click()]);
  await expect(page.locator('#count')).toHaveText('2026-11-01 至 2026-11-02');expect(queries.at(-1).get('from')).toBe('2026-11-01');expect(queries.at(-1).get('to')).toBe('2026-11-02');expect(queries.at(-1).get('repository_id')).toBe('202');
 }finally{await h.stop();}
});

test('an authorized project outside the first management directory page opens by target',async({page})=>{
 test.setTimeout(60000);const {h,admin,password,a}=await fixture();try{
  for(let id=1000;id<1100;id++)await repository(admin,a.id,String(id));
  const first=(await admin('/api/management/query','POST',{operation:'list_projects',target:{},arguments:{limit:100}})).value;
  const target=['101','202',...Array.from({length:100},(_,i)=>String(i+1000))].find(id=>!first.projects.some(p=>p.id===id));expect(first.projects).toHaveLength(100);expect(target).toBeTruthy();
  const seen=[];page.on('request',r=>{if(r.url().endsWith('/api/management/query')&&r.postDataJSON()?.operation==='list_projects')seen.push(r.postDataJSON().target);});
  await login(page,h,password,'#/projects/'+target+'/management');await expect(page.locator('.management-scope-name')).toHaveAttribute('data-scope','project:'+target);await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled();expect(seen).toContainEqual({project_id:target});await switchConsoleProject(page,'101');await expect(page.locator('.management-scope-name')).toHaveAttribute('data-scope','project:101');await switchConsoleProject(page,target);await expect(page.locator('.management-scope-name')).toHaveAttribute('data-scope','project:'+target);await expect(page.getByRole('heading',{name:'无法打开管理助手',exact:true})).toHaveCount(0);
 }finally{await h.stop();}
});
