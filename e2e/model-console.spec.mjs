import {test,expect} from '@playwright/test';
import { openModelCatalog } from './open-model-folds.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync} from 'node:fs';
import {harness,setup,account,repository,testPassword} from '../test/helpers.mjs';

test('provider search, draft tests, pricing and conflict comparison share real state on desktop and mobile',async({page})=>{
  const calls=[],server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    calls.push({path:req.url,key:req.headers.authorization,body:raw?JSON.parse(raw):null});res.setHeader('Content-Type','application/json');
    res.end(req.url.endsWith('/models')?JSON.stringify({data:Array.from({length:80},(_,i)=>({id:'model-'+i}))}):JSON.stringify({model:'fixture',choices:[{message:{content:'ok'}}]}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`,h=await harness();
  try{
    const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
    const key=testPassword(),group=(await admin('/api/models/provider','POST',{repository_id:'101',api_url:origin+'/v1',api_key:key,model_names:['alpha','beta']})).value.models;
    await admin('/api/models/provider','POST',{api_url:origin+'/v1',api_key:testPassword(),model_names:['shared']});
    await admin(`/api/models/${group[0].id}`,'PATCH',{version:1,pricing:{currency:'CNY',input_per_million:2,output_per_million:8,cache_per_million:0.2}});
    await page.goto(h.admin+'/#/projects/101/model');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await openModelCatalog(page);
    const own=page.locator('.side-card').filter({has:page.getByRole('heading',{name:'本项目专属模型',exact:true})});
    await expect(own).toContainText('CNY / 百万 token');await expect(own).toContainText('未定价');
    const search=own.getByLabel('搜索供应商或模型',{exact:true});await search.fill('alpha');await expect(own.locator('.model-entry:visible')).toHaveCount(1);await search.fill('none');await expect(own).toContainText('没有匹配');await search.fill('');
    await own.getByRole('button',{name:'编辑供应商',exact:true}).click();const editor=page.locator('#provider-edit');
    await editor.getByLabel('接口 URL',{exact:true}).fill(origin+'/draft/v1');
    await editor.getByRole('button',{name:'测试当前连接',exact:true}).click();await expect(editor.locator('.probe-result')).toContainText('测试通过');
    expect(calls.at(-1).path).toBe('/draft/v1/chat/completions');expect(calls.at(-1).key).toBe('Bearer '+key);
    expect((await admin(`/api/models/${group[0].id}`)).value.model.api_url).toBe(origin+'/v1');
    await editor.getByRole('button',{name:'获取模型列表',exact:true}).click();await editor.getByRole('button',{name:'model-79',exact:true}).click();await expect(editor).toContainText('已选 1 个待添加模型');
    await page.setViewportSize({width:390,height:600});await expect(editor.getByRole('button',{name:'保存',exact:true})).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const bounds=await editor.boundingBox();expect([bounds.x,bounds.y,bounds.width,bounds.height]).toEqual([0,0,390,600]);
    mkdirSync('.tmp/model-console',{recursive:true});await page.screenshot({path:'.tmp/model-console/editor-mobile.png'});
    const latest=(await admin(`/api/models/${group[0].id}`)).value.model;
    await admin(`/api/models/${group[0].id}`,'PATCH',{version:latest.version,model_name:'alpha-updated'});
    await editor.getByRole('button',{name:'保存',exact:true}).click();await expect(editor.getByRole('alert')).toContainText('草稿已保留');
    await expect(editor.getByLabel('接口 URL',{exact:true})).toHaveValue(origin+'/draft/v1');
    await editor.getByRole('button',{name:'读取最新版本并比较',exact:true}).click();await expect(editor.locator('.provider-comparison')).toContainText('alpha-updated');
    await expect(editor.getByLabel('API Key（留空保持不变）',{exact:true})).toHaveValue('');
    await editor.getByRole('button',{name:'保存',exact:true}).click();await expect(editor).toHaveCount(0);
    // #385: the list repaints once the save round-trip lands, so a one-shot allTextContents() could read a
    // frame between the old and the new row. expect.poll re-reads until the rendered set is the expected one.
    await expect.poll(async()=>(await own.locator('.model-address').allTextContents()).sort()).toEqual(['alpha-updated','beta','model-79']);
    const models=(await admin('/api/models')).value.models;expect(models.filter(m=>m.repository_id==='101').every(m=>m.api_url===origin+'/draft/v1')).toBe(true);expect(models.find(m=>m.model_name==='shared').api_url).toBe(origin+'/v1');
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/model-console/models-desktop.png',fullPage:true});
    expect(await page.content()).not.toContain(key);
  }finally{await h.stop();await new Promise(resolve=>server.close(resolve));}
});
