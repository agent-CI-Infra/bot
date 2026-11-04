import {test,expect} from '@playwright/test';
import {rmSync,mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {harness,setup,account,repository,testPassword} from '../test/helpers.mjs';

test('供应商新增和编辑使用同一表单，连接管理集中在供应商层，模型保留自己的操作',async({page,browser})=>{
 const requests=[],upstream=createServer((req,res)=>{
  requests.push({url:req.url,key:req.headers.authorization});res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/models'))res.end(JSON.stringify({data:['alpha','beta','gamma'].map(id=>({id}))}));
  else if(req.url.endsWith('/chat/completions'))res.end(JSON.stringify({choices:[{message:{content:'ok'}}]}));
  else{res.statusCode=404;res.end('{}');}
 });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const origin=`http://127.0.0.1:${upstream.address().port}`,h=await harness(),errors=[];page.on('pageerror',e=>errors.push(e.message));mkdirSync('.tmp/provider-editor',{recursive:true});
 try{
  const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const ownKey=testPassword(),sharedKey=testPassword(),rotated=testPassword();
  const create=async(repo,url,names,key)=>(await admin('/api/models/provider','POST',{repository_id:repo,api_url:origin+url,api_key:key,model_names:names})).value.models;
  const own=await create('101','/v1',['beta'],ownKey);await create('101','/other/v1',['delta'],testPassword());await create(null,'/v1',['alpha'],sharedKey);
  await admin('/api/repositories/101/policy','PATCH',{model_id:own[0].id});
  await page.goto(h.admin+'/#/projects/101/model');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
  const ownCard=page.locator('.side-card').filter({has:page.getByRole('heading',{name:'本项目专属模型',exact:true})}),dialog=page.locator('#provider-edit');
  await expect(ownCard.locator('.provider-group')).toHaveCount(2);await expect(ownCard.getByRole('button',{name:'获取模型列表',exact:true})).toHaveCount(0);await expect(ownCard.getByRole('button',{name:/修改 URL|更换 Key|撤销 Key/})).toHaveCount(0);
  const group=ownCard.locator('.provider-group').first();await group.getByRole('button',{name:'编辑供应商',exact:true}).click();await expect(dialog.getByLabel('API Key（留空保持不变）',{exact:true})).toHaveValue('');
  await dialog.getByRole('button',{name:'获取模型列表',exact:true}).click();await expect(dialog.locator('.model-chips').first().getByRole('button',{name:'beta · 已添加',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'gamma',exact:true}).click();await dialog.getByLabel('手动模型名',{exact:true}).fill('custom-x');
  // Enter in the manual name box adds the name; it does not save the provider.
  await dialog.getByLabel('手动模型名',{exact:true}).press('Enter');await expect(dialog.getByRole('button',{name:'custom-x ×',exact:true})).toBeVisible();await expect(dialog.getByLabel('手动模型名',{exact:true})).toHaveValue('');
  await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(ownCard.locator('.provider-group').filter({hasText:origin+'/v1'}).locator('.model-address')).toHaveText(['beta','gamma','custom-x']);
  expect(requests.at(-1).key).toBe('Bearer '+ownKey);expect((await admin('/api/repositories/101')).value.policy.model_id).toBe(own[0].id);
  // The same editor is used in global settings, with no per-model connection/list actions.
  await page.goto(h.admin+'/#/settings/models');const shared=page.locator('.side-card').filter({has:page.getByRole('heading',{name:'部署共享模型',exact:true})});await expect(shared.locator('.provider-group')).toHaveCount(1);
  await shared.getByRole('button',{name:'新增供应商',exact:true}).click();await expect(dialog.getByRole('heading',{name:'新增供应商',exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'获取模型列表',exact:true})).toHaveCount(1);
  await dialog.getByLabel('接口 URL',{exact:true}).fill(origin+'/other/v1');await dialog.getByLabel('API Key',{exact:true}).fill(sharedKey);await dialog.getByRole('button',{name:'获取模型列表',exact:true}).click();await dialog.getByRole('button',{name:'beta',exact:true}).click();await dialog.getByRole('button',{name:'gamma',exact:true}).click();
  // Enter in the filter only filters: with the URL, Key and models filled in, it must not create the provider.
  const filter=dialog.getByLabel('筛选上游模型',{exact:true});await filter.fill('gam');await filter.press('Enter');
  await expect(dialog.locator('.model-chips').first().getByRole('button')).toHaveText(['gamma ✓']);await expect(shared.locator('.provider-group')).toHaveCount(1);await filter.fill('');
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/provider-editor/create-desktop.png',fullPage:true});await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(shared.locator('.provider-group')).toHaveCount(2);
  const added=shared.locator('.provider-group').filter({hasText:origin+'/other/v1'});await added.getByRole('button',{name:'编辑供应商',exact:true}).click();await expect(dialog.getByLabel('API Key（留空保持不变）',{exact:true})).toHaveValue('');
  await dialog.getByLabel('接口 URL',{exact:true}).fill(origin+'/new/v1');await dialog.getByLabel('API Key（留空保持不变）',{exact:true}).fill(rotated);await dialog.getByRole('button',{name:'获取模型列表',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('返回 3 个模型');expect(requests.at(-1).key).toBe('Bearer '+rotated);expect(requests.at(-1).url).toBe('/new/v1/models');
  await page.screenshot({path:'.tmp/provider-editor/edit-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tmp/provider-editor/edit-mobile.png',fullPage:true});
  await page.route('**/api/models/*/provider',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"storage_unavailable"}'}));await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('storage_unavailable');await expect(dialog.getByLabel('接口 URL',{exact:true})).toHaveValue(origin+'/new/v1');await page.unroute('**/api/models/*/provider');
  await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(dialog).toHaveCount(0);const updated=shared.locator('.provider-group').filter({hasText:origin+'/new/v1'});await expect(updated.locator('.model-address')).toHaveText(['beta','gamma']);
  await updated.locator('.model-entry').first().getByRole('button',{name:'测试模型',exact:true}).click();await expect(updated.locator('.probe-result').first()).toContainText('测试通过');expect(requests.at(-1).key).toBe('Bearer '+rotated);
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/provider-editor/list-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tmp/provider-editor/list-mobile.png',fullPage:true});
  await updated.getByRole('button',{name:'编辑供应商',exact:true}).click();await dialog.getByRole('button',{name:'撤销供应商 Key',exact:true}).click();await page.getByRole('dialog',{name:'撤销此供应商的 API Key？',exact:true}).getByRole('button',{name:'撤销',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(updated.getByText('Key 已撤销',{exact:true})).toHaveCount(2);
  await updated.getByRole('button',{name:'编辑供应商',exact:true}).click();await expect(dialog.getByLabel('API Key（留空保持不变）',{exact:true})).toHaveValue('');await dialog.getByLabel('API Key（留空保持不变）',{exact:true}).fill(rotated);await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(updated.getByRole('button',{name:'测试模型',exact:true})).toHaveCount(2);
  const before=(await admin('/api/models')).value.models.length;await shared.getByRole('button',{name:'新增供应商',exact:true}).click();await dialog.getByLabel('接口 URL',{exact:true}).fill(origin+'/cancel/v1');await dialog.getByRole('button',{name:'取消',exact:true}).click();expect((await admin('/api/models')).value.models.length).toBe(before);
  const raw=JSON.stringify((await admin('/api/models')).value);expect(raw).not.toContain(sharedKey);expect(raw).not.toContain(rotated);expect(raw).not.toContain(ownKey);
  const memberPassword=testPassword();await admin('/api/users','POST',{username:'member',password:memberPassword,repository_ids:['101']});const context=await browser.newContext({viewport:{width:390,height:844}}),member=await context.newPage();
  await member.goto(h.admin+'/#/projects/101/model');await member.getByLabel('用户名',{exact:true}).fill('member');await member.getByLabel('密码',{exact:true}).fill(memberPassword);await member.getByRole('button',{name:'登录',exact:true}).click();await expect(member.getByRole('button',{name:'编辑供应商',exact:true})).toHaveCount(2);await expect(member.getByRole('heading',{name:'部署共享模型',exact:true})).toHaveCount(1);await context.close();expect(errors).toEqual([]);
 }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});await new Promise(resolve=>upstream.close(resolve));}
});
