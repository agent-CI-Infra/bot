import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

async function fixture() {
  const manager={call:async(_method,path)=>({repository_id:path.split('/')[3],generation:1,state:'ready',desired:'ready',revision:1,computer:{}})};
  const h=await harness(undefined,manager),{admin,password}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');await repository(admin,a.id,'202');
  const seed=(id,status,repo='101')=>h.store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',id,repo,'review.issue',status,
    {active:'检查移动端导航与任务详情',publishing:'整理验证证据并准备回复',blocked:'补齐项目模型配置',failed:'检查验证失败的原因'}[id]||`项目工作 ${id}`,1,'2026-11-10T14:00:00Z','2026-11-10T14:00:00Z');
  seed('active','running');seed('publishing','result_ready');seed('blocked','waiting_configuration');seed('failed','failed');seed('automatic','retry_wait');seed('foreign-private','failed','202');
  for(let i=0;i<12;i++)seed('queued-'+String(i).padStart(2,'0'),'queued');
  for(let i=0;i<75;i++)seed('done-'+i,'succeeded');
  return {h,admin,password,seed};
}
async function login(page,h,password,username='administrator',hash='#/projects/101/overview') {
  await page.goto(h.admin+'/'+hash);await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.workspace-overview')).toBeVisible();
}
const metric=(page,key)=>page.locator(`[data-task-group=${key}] strong`);

test('project totals and drill-down share real task records on desktop and mobile',async({page})=>{
  const {h,password,seed}=await fixture(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await login(page,h,password);await expect(metric(page,'all')).toHaveText('92');await expect(metric(page,'active')).toHaveText('2');
    await expect(metric(page,'queued')).toHaveText('12');await expect(metric(page,'attention')).toHaveText('2');
    await expect(page.locator('.workspace-task-rows [data-task-id]')).toHaveCount(2);
    await expect(page.locator('.workspace-health-status')).toContainText('不代表任务或 CI 成功');
    await page.locator('[data-task-group=queued]').click();await expect(page.locator('.workspace-task-rows [data-task-id]')).toHaveCount(10);
    const next=page.getByRole('navigation',{name:'总览任务分页'}).getByRole('link',{name:'下一页'});await next.focus();seed('queued-fresh','queued');
    await expect(metric(page,'queued')).toHaveText('13',{timeout:10000});await expect(next).toBeFocused();
    await page.getByRole('navigation',{name:'总览任务分页'}).getByRole('link',{name:'下一页'}).click();
    await expect(page).toHaveURL(/overview\/queued\.10$/);await expect(page.locator('.workspace-task-rows [data-task-id]')).toHaveCount(3);
    await page.reload();await expect(page.locator('.workspace-task-status')).toContainText('显示 11–13 项');
    await page.locator('[data-task-group=attention]').click();await expect(page.locator('.workspace-task-rows')).toContainText('补齐任务所需的模型');
  } finally {await h.stop();}
});

test('overview refresh preserves readings and focus, and labels stale or unavailable sources',async({page})=>{
  const {h,password,seed}=await fixture();
  try {
    await page.route('**/api/tasks?*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"tasks_unavailable"}'}));
    await login(page,h,password);await expect(page.locator('.workspace-task-status')).toContainText('暂时无法判断');
    await expect(metric(page,'active')).toHaveText('—');await expect(page.locator('.workspace-health-status')).toContainText('记录读取于');
    await page.unroute('**/api/tasks?*');await page.getByRole('button',{name:'刷新总览'}).click();await expect(metric(page,'active')).toHaveText('2');
    const focus=page.locator('[data-task-id=active] button');await focus.focus();const y=await page.evaluate(()=>scrollY);
    seed('queued-extra','queued');await expect(metric(page,'queued')).toHaveText('13',{timeout:10000});
    await expect(focus).toBeFocused();expect(await page.evaluate(()=>scrollY)).toBe(y);
    h.store.run("UPDATE tasks SET summary='检查桌面端导航与任务详情' WHERE id='active'");
    await expect(page.locator('[data-task-id=active]')).toContainText('检查桌面端导航与任务详情',{timeout:10000});
    await expect(focus).toBeFocused();expect(await page.evaluate(()=>scrollY)).toBe(y);
    await page.route('**/api/tasks?*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"tasks_unavailable"}'}));
    await page.route('**/api/environments/101',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"manager_unavailable"}'}));
    await page.getByRole('button',{name:'刷新总览'}).click();await expect(page.locator('.workspace-task-status')).toContainText('保留上次成功数据');
    await expect(page.locator('.workspace-health-status')).toContainText('可能已过期');await expect(metric(page,'active')).toHaveText('2');
    await page.unroute('**/api/tasks?*');await page.unroute('**/api/environments/101');await page.getByRole('button',{name:'刷新总览'}).click();
    await expect(page.locator('.workspace-task-status')).not.toContainText('可能已过期');
  }finally{await h.stop();}
});

test('overview deep links, live permissions and late responses retain scope across screen sizes',async({page})=>{
  const {h,admin}=await fixture(),password=testPassword();
  await admin('/api/users','POST',{username:'overview-member',password,repository_ids:['101']});
  try {
    await login(page,h,password,'overview-member');await expect(metric(page,'all')).toHaveText('92');
    mkdirSync('.tmp/project-overview',{recursive:true});
    for(const width of [320,390,768,1024,1440,1920]) {
      await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(width===390||width===1440)await page.screenshot({path:`.tmp/project-overview/overview-${width}.png`,fullPage:true});
    }
    await page.setViewportSize({width:390,height:844});await page.locator('[data-task-group=attention]').click();
    await expect(page.locator('.workspace-task-rows [data-task-id]')).toHaveCount(2);await expect(page.locator('.workspace-task-rows')).not.toContainText('foreign-private');
    await page.locator('[data-task-id=blocked] button').click();await expect(page.locator('#task-view')).toBeVisible();await page.keyboard.press('Escape');
    await expect(page.locator('[data-task-id=blocked] button')).toBeFocused();
    let release;const gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/tasks?*',async route=>{await gate;await route.continue();});
    await page.getByRole('button',{name:'刷新总览'}).click();await page.locator('#console-mobile-nav').getByRole('link',{name:'更多',exact:true}).click();release();
    await expect(page.getByRole('heading',{name:'更多功能',exact:true})).toBeVisible();await expect(page.locator('.workspace-overview')).toHaveCount(0);
    await page.unroute('**/api/tasks?*');await page.goto(h.admin+'/#/projects/202/overview');await expect(page.locator('#project-page')).toContainText('403');
    await page.goto(h.admin+'/#/projects/101/overview');await expect(metric(page,'active')).toHaveText('2');
    const user=h.store.get("SELECT id FROM users WHERE username='overview-member'");await admin('/api/project-admin-assignments','PUT',{user_id:user.id,repository_ids:[]});
    await page.getByRole('button',{name:'刷新总览'}).click();await expect(page.locator('#project-page')).toContainText('项目访问已变化');
    await expect(page.locator('.workspace-task-rows')).toHaveCount(0);
  }finally{await h.stop();}
});
