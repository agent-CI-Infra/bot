import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { channelFixture, privateChat, registerDestination } from '../../fixtures/channel-fixture.mjs';

async function environment() {
  let now=Date.now(),worker;
  const f=await channelFixture(undefined,{schedules:{automatic:false,clock:()=>now},onSchedules:s=>{worker=s;}});
  f.worker=worker; f.destination=await registerDestination(f.admin,await privateChat(f)); await f.service.tick();
  f.query=async operation=>(await f.admin('/api/management/query','POST',{operation,target:{project_id:'101'},arguments:{}})).value;
  f.command=async(operation,args)=>{
    const {revision}=await f.query('list_schedules'),key=crypto.randomUUID();
    const result=await f.admin('/api/management/commands','POST',{operation,target:{project_id:'101'},arguments:args,expected_revision:revision,idempotency_key:key,source_conversation:'notification-browser-fixture',source_message:key});
    expect(result.value.state).toBe('succeeded');return result.value;
  };
  // Notifications come from event subscriptions only (#1027): one failed task, delivered to the private chat.
  await f.command('notification.register',{subscription:{name:'失败事件通知',destination_id:f.destination,events:['task.failed'],projects:['101'],aggregate_ms:0,timezone:'Asia/Shanghai',enabled:true}});
  f.h.store.run("INSERT INTO schedule_events(event_key,project_id,type,incident,payload,created_at) VALUES('browser-failure','101','task.failed','task:browser-failure',?,?)",JSON.stringify({task_id:'browser-failure',status:'failed'}),now);
  worker.fanout(); await worker.tick();
  f.delivery=(await f.query('list_notification_deliveries')).records[0];
  return f;
}
async function login(page,f){
  await page.goto(f.h.admin+'/#/management');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(f.password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await switchConsoleProject(page, '101');await page.getByRole('button',{name:'快捷操作',exact:true}).click();
  await page.getByRole('button',{name:'查看通知及失败队列',exact:true}).click();
  await expect(page.locator('.schedule-record')).toHaveCount(1);
}
const card=page=>page.locator('.schedule-record').first();
test('notification timeline shows real source, events, attempts and destination on desktop and mobile',async({page})=>{
  const f=await environment(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await login(page,f);await card(page).locator(':scope > summary').click();
    await expect(card(page)).toContainText('失败事件通知');await expect(card(page)).toContainText('事件订阅');await expect(card(page)).toContainText('Asia/Shanghai');await expect(card(page)).toContainText('第 1 次 · 已送达');await expect(card(page)).toContainText('当前有效');await expect(card(page)).toContainText('私聊');await expect(card(page)).toContainText('task:browser-failure');await expect(card(page)).toContainText('task.failed');
    mkdirSync('.tmp/notification-trace-234',{recursive:true});
    for(const width of [320,390,768,1024,1440,1920]){await page.setViewportSize({width,height:900});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);if([390,1440].includes(width)){await card(page).locator(':scope > summary').evaluate(node=>node.scrollIntoView({block:'start'}));await page.screenshot({path:'.tmp/notification-trace-234/notification-'+width+'.png',fullPage:true});}}
    expect(errors).toEqual([]);expect(f.h.store.get('select manual_retries from notification_outbox').manual_retries).toBe(0);
  }finally{await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});
test('unknown retry requires consent and reconciles a lost response with exactly the original command key',async({page})=>{
  const f=await environment(),keys=[];let lost=false;
  try{
    f.h.store.run("update notification_outbox set state='unknown',last_error='notification_result_unknown' where id=?",f.delivery.id);
    await login(page,f);await card(page).locator(':scope > summary').click();
    await page.getByRole('button',{name:'人工补发 '+f.delivery.id.slice(0,12),exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'请先接受可能重复送达的风险'})).toBeVisible();expect(f.h.store.get('select manual_retries from notification_outbox').manual_retries).toBe(0);
    await page.route('**/api/management/commands',async route=>{const body=route.request().postDataJSON();if(body.operation!=='notification.retry'){await route.continue();return;}keys.push(body.idempotency_key);if(!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
    await page.getByLabel('接受未知结果可能重复送达',{exact:true}).check();await page.getByRole('button',{name:'人工补发 '+f.delivery.id.slice(0,12),exact:true}).click();
    await page.getByRole('button',{name:'确认人工补发',exact:true}).click();await expect(page.getByRole('button',{name:'核对同一次通知补发',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'核对同一次通知补发',exact:true}).click();await expect(page.getByLabel('通知补发回执')).toBeEmpty();
    expect(keys.length).toBe(2);expect(keys[1]).toBe(keys[0]);expect(f.h.store.get('select manual_retries from notification_outbox').manual_retries).toBe(1);expect(f.h.store.get('select state from notification_outbox').state).toBe('retry');
  }finally{await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});
test('read failure retains observed rows, permits retry, and late results cannot restore revoked content',async({page})=>{
  const f=await environment();let fail=false,held,release;
  try{
    await login(page,f);await page.route('**/api/management/query',async route=>{const body=route.request().postDataJSON();if(body.operation!=='list_notification_deliveries'){await route.continue();return;}if(fail){await route.fulfill({status:503,json:{error:'fixture_read_failed'}});return;}await route.continue();});
    fail=true;await page.getByRole('button',{name:'重新读取当前记录',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'最新状态未知；保留上次读取的 1 条'})).toBeVisible();await expect(card(page)).toBeVisible();
    fail=false;await page.getByRole('button',{name:'重新读取当前记录',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'已读取 1 条记录'})).toBeVisible();
    await page.unroute('**/api/management/query');let entered;const gate=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{entered=resolve;});
    await page.route('**/api/management/query',async route=>{const body=route.request().postDataJSON();if(body.operation==='list_notification_deliveries'&&!held){held=true;const response=await route.fetch();entered();await gate;await route.fulfill({response});}else if(body.operation==='list_occurrences'){await route.fulfill({status:403,json:{error:'authorization_changed'}});}else await route.continue();});
    await page.getByRole('button',{name:'重新读取当前记录',exact:true}).click();await seen;await page.getByRole('button',{name:'查看运行与跳过原因',exact:true}).click();await expect(page.getByText('计划访问权限已失效，请按当前授权重新进入。',{exact:true})).toBeVisible();const late=page.waitForResponse(response=>response.request().postDataJSON()?.operation==='list_notification_deliveries'&&response.status()===201);release();await (await late).finished();await expect(page.locator('.schedule-record')).toHaveCount(0);
  }finally{release?.();await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});

test('a confirmed reply arriving after a scope switch unlocks the reopened original project without another retry',async({page})=>{
  const f=await environment();let release;let entered;const seen=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});let commands=0;
  try{
    f.h.store.run("update notification_outbox set state='dead' where id=?",f.delivery.id);await login(page,f);await card(page).locator(':scope > summary').click();
    await page.route('**/api/management/commands',async route=>{if(route.request().postDataJSON().operation!=='notification.retry'){await route.continue();return;}commands++;const response=await route.fetch();entered();await gate;await route.fulfill({response});});
    await page.getByRole('button',{name:'人工补发 '+f.delivery.id.slice(0,12),exact:true}).click();await page.getByRole('button',{name:'确认人工补发',exact:true}).click();await seen;
    await switchConsoleProject(page, '102');await expect(page.getByLabel('通知补发回执')).toBeEmpty();
    await switchConsoleProject(page, '101');
    await expect(page.getByRole('button',{name:'核对同一次通知补发',exact:true})).toBeDisabled();release();
    await expect(page.getByLabel('通知补发回执')).toBeEmpty();await expect(page.getByRole('status').filter({hasText:'已读取 1 条记录'})).toBeVisible();
    expect(commands).toBe(1);expect(f.h.store.get('select manual_retries from notification_outbox').manual_retries).toBe(1);
  }finally{release?.();await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});
