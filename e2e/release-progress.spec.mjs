import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
import {releaseFixture,run,target,writes} from '../test/release-fixtures.mjs';
async function login(page,f){await page.goto(f.h.admin+'/#/projects/101/release');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(f.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('heading',{name:'发版本',exact:true})).toBeVisible();}

test('release preparation exposes exact facts, waits for explicit writes and clears failed preflight data',async({page})=>{
 const cleanup=[],f=await releaseFixture({after:fn=>cleanup.push(fn)}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await login(page,f);await page.getByLabel('版本号',{exact:true}).fill('v1.2.3');await page.getByRole('button',{name:'检查候选提交',exact:true}).click();await expect(page.getByRole('button',{name:'确认打标签',exact:true})).toBeEnabled();await expect(page.locator('.release-preview')).toContainText(target);await expect(page.locator('.release-preview')).toContainText('新增提交');expect(writes(f.state)).toEqual([]);
  mkdirSync('.tmp/release-progress-233/previews',{recursive:true});for(const width of [320,390,768,1024,1440,1920]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);if([390,1440].includes(width))await page.screenshot({path:`.tmp/release-progress-233/previews/console-release-preparation-${width===390?'mobile':'desktop'}.png`,fullPage:true});}
  await page.route('**/releases/preflight?*',route=>route.fulfill({status:503,json:{error:'fixture_down'}}));await page.getByRole('button',{name:'检查候选提交',exact:true}).click();await expect(page.getByRole('button',{name:'确认打标签',exact:true})).toBeDisabled();await expect(page.locator('.release-preview')).not.toContainText(target);await expect(page.locator('.release-preview')).toContainText('读取失败');expect(writes(f.state)).toEqual([]);expect(errors).toEqual([]);
 }finally{for(const close of cleanup.reverse())await close();}
});

test('a later workflow attempt cannot inherit a previous attempt success and stale replies cannot redraw another section',async({page})=>{
 const cleanup=[],f=await releaseFixture({after:fn=>cleanup.push(fn)});let release;
 try{
  f.state.runs=[run()];f.state.jobs=[{id:1,run_id:800,run_attempt:1,name:'release',status:'completed',conclusion:'success'}];const created=await f.create();for(let i=0;i<2;i++)await f.service.worker.process(created.value.release.id);
  const record=f.h.store.get('SELECT * FROM project_releases WHERE id=?',created.value.release.id),data=JSON.parse(record.data);data.ci_success={run_id:800,attempt:1};data.run_attempt=2;data.run={status:'in_progress',conclusion:null};f.h.store.run('UPDATE project_releases SET stage=\'running\',data=? WHERE id=?',JSON.stringify(data),record.id);
  await login(page,f);await expect(page.locator('.release-process')).toContainText('in_progress');await expect(page.locator('.release-process')).not.toContainText('attempt 1 已通过');
  const gate=new Promise(resolve=>{release=resolve;});await page.route('**/api/repositories/101/releases',async route=>{await gate;await route.fulfill({json:{releases:[{...data,id:record.id,version:'stale secret',stage:'running',target_sha:target}]}});});
  await page.getByRole('button',{name:'刷新发布记录',exact:true}).click();await page.locator('#console-secondary-nav').getByRole('link',{name:'项目总览',exact:true}).click();release();await expect(page).toHaveURL(/\/overview$/);await expect(page.getByText('stale secret',{exact:true})).toHaveCount(0);
 }finally{release?.();for(const close of cleanup.reverse())await close();}
});

test('access loss clears previews and records before an older successful preflight can return',async({page})=>{
 const cleanup=[],f=await releaseFixture({after:fn=>cleanup.push(fn)});let release;
 try{
  await f.create();await login(page,f);await page.getByLabel('版本号',{exact:true}).fill('v1.2.4');await page.getByRole('button',{name:'检查候选提交',exact:true}).click();await expect(page.locator('.release-record')).toHaveCount(1);
  const gate=new Promise(resolve=>{release=resolve;});await page.route('**/releases/preflight?*',async route=>{const response=await route.fetch();const body=await response.json();await gate;await route.fulfill({json:{...body,available:true,target_title:'stale candidate'}});});
  await page.getByRole('button',{name:'检查候选提交',exact:true}).click();await page.route('**/api/repositories/101/releases',route=>route.fulfill({status:403,json:{error:'repository_forbidden'}}));await page.getByRole('button',{name:'刷新发布记录',exact:true}).click();await expect(page.locator('.release-panel')).toContainText('发布权限已失效');release();
  await expect(page.locator('.release-preview')).toBeEmpty();await expect(page.locator('.release-record')).toHaveCount(0);await expect(page.getByRole('button',{name:'确认打标签',exact:true})).toBeDisabled();await expect(page.getByText('stale candidate',{exact:true})).toHaveCount(0);
 }finally{release?.();for(const close of cleanup.reverse())await close();}
});

test('a published Release with an intentionally empty body is still shown as an existing Release',async({page})=>{
 const cleanup=[],f=await releaseFixture({after:fn=>cleanup.push(fn)});
 try{
  f.state.runs=[run()];f.state.jobs=[{id:1,run_id:800,run_attempt:1,name:'release',status:'completed',conclusion:'success'}];const created=await f.create();for(let i=0;i<4;i++)await f.service.worker.process(created.value.release.id);
  let record=(await f.admin(f.endpoint)).value.releases[0];const saved=await f.admin(f.endpoint+'/'+record.id+'/draft','PATCH',{body:'',revision:record.revision,body_revision:record.body_revision});expect(saved.status).toBe(200);record=saved.value.release;
  const published=await f.admin(f.endpoint+'/'+record.id+'/publish','POST',{revision:record.revision,body_revision:record.body_revision});expect(published.status).toBe(201);expect(published.value.release.stage).toBe('published');
  await login(page,f);await expect(page.locator('.release-process')).toContainText('已记录 Release');await expect(page.locator('.release-process')).not.toContainText('尚未生成');
 }finally{for(const close of cleanup.reverse())await close();}
});
