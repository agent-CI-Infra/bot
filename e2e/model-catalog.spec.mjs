import {test,expect} from '@playwright/test';
import {mkdirSync,rmSync} from 'node:fs';
import {harness,setup,account,repository,testPassword} from '../test/helpers.mjs';
import {modelCatalog} from '../dist/models/catalog.js';
import {openModelCatalog} from './open-model-folds.mjs';
const entry=(id)=>({id,name:id,canonical_model_id:'deepseek/'+id,attachment:false,reasoning:true,limit:{context:1048576,output:393216},modalities:{input:['text'],output:['text']},cost:{input:0.15,output:0.6,cache_read:0.003}});
async function login(page,url,username,password){await page.goto(url);await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();}
test('模型目录刷新、匹配与手动覆盖通过真实页面保存，失败保留快照，项目成员只能编辑自己的模型',async({page,browser})=>{
  const h=await harness(),{admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const catalog=modelCatalog(h.store);catalog.fetcher=async()=>new Response(JSON.stringify({deepseek:{models:{'deepseek-flash':entry('deepseek-flash')}}}));
  const shared=(await admin('/api/models','POST',{api_url:'https://relay.example/v1',api_key:testPassword(),model_name:'deepseek-flash'})).value.model;
  const errors=[];page.on('pageerror',error=>errors.push(error.message));mkdirSync('.tmp/model-catalog',{recursive:true});
  try {
    await login(page,h.admin+'/#/settings/models','administrator',password);
    await expect(page.locator('.model-catalog-status')).toContainText('目录尚未成功下载');
    await page.getByRole('button',{name:'立即刷新目录',exact:true}).click();
    await expect(page.locator('.model-catalog-status')).toContainText('1 个模型');
    const row=page.locator('.model-entry').filter({hasText:'deepseek-flash'});
    await expect(row).toContainText('deepseek/deepseek-flash');await expect(row).toContainText('最大输出 393216');await expect(row).toContainText('目录 USD 参考价');
    await row.getByRole('button',{name:'能力与目录',exact:true}).click();let dialog=page.locator('#model-capabilities');
    await dialog.getByLabel('最大输出（token）',{exact:true}).fill('12000');await dialog.getByLabel('推理能力',{exact:true}).selectOption('false');
    await dialog.getByRole('button',{name:'保存能力与目录',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(row).toContainText('最大输出 12000');await expect(row).toContainText('非推理模型');
    await row.getByRole('button',{name:'计费单价',exact:true}).click();dialog=page.locator('#model-pricing');
    await expect(dialog.getByLabel('输入单价 / 百万 token',{exact:true})).toHaveValue('');await dialog.getByLabel('输入单价 / 百万 token',{exact:true}).fill('2');
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/model-catalog/pricing-1440.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tmp/model-catalog/pricing-390.png',fullPage:true});
    await dialog.getByRole('button',{name:'保存单价',exact:true}).click();
    await expect(row).toContainText('输入 2 · 输出 0.6 · 缓存 0.003');
    await row.getByRole('button',{name:'计费单价',exact:true}).click();await page.locator('#model-pricing').getByRole('button',{name:'清除单价',exact:true}).click();await expect(row).toContainText('输入 0.15');
    await row.getByRole('button',{name:'能力与目录',exact:true}).click();dialog=page.locator('#model-capabilities');
    await dialog.getByLabel('目录匹配',{exact:true}).selectOption('manual');await dialog.getByLabel('搜索目录',{exact:true}).fill('deepseek-flash');await expect(dialog.getByLabel('目录条目',{exact:true})).toContainText('deepseek/deepseek-flash');
    await dialog.getByLabel('目录条目',{exact:true}).selectOption('deepseek/deepseek-flash');await dialog.getByLabel('最大输出（token）',{exact:true}).fill('');await dialog.getByLabel('推理能力',{exact:true}).selectOption('');
    await dialog.getByRole('button',{name:'保存能力与目录',exact:true}).click();await expect(row).toContainText('最大输出 393216');
    await row.getByRole('button',{name:'能力与目录',exact:true}).click();dialog=page.locator('#model-capabilities');
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/model-catalog/capabilities-1440.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tmp/model-catalog/capabilities-390.png',fullPage:true});
    await dialog.getByLabel('目录匹配',{exact:true}).selectOption('disabled');await dialog.getByRole('button',{name:'保存能力与目录',exact:true}).click();await expect(row).toContainText('最大输出 8192');await expect(row).toContainText('未定价');
    await row.getByRole('button',{name:'能力与目录',exact:true}).click();await page.locator('#model-capabilities').getByLabel('目录匹配',{exact:true}).selectOption('auto');await page.locator('#model-capabilities').getByRole('button',{name:'保存能力与目录',exact:true}).click();
    catalog.fetcher=async()=>{throw new Error('offline');};await page.getByRole('button',{name:'立即刷新目录',exact:true}).click();await expect(page.locator('.model-catalog-status')).toContainText('最近刷新失败');await expect(row).toContainText('最大输出 393216');
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/model-catalog/catalog-1440.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.tmp/model-catalog/catalog-390.png',fullPage:true});
    await admin('/api/models/'+shared.id+'/projects','PUT',{repository_ids:['101']});
    const memberPassword=testPassword();await admin('/api/users','POST',{username:'catalog-member',password:memberPassword,repository_ids:['101']});
    await admin('/api/models','POST',{repository_id:'101',api_url:'https://own-relay.example/v1',api_key:testPassword(),model_name:'deepseek-flash'});
    const context=await browser.newContext({viewport:{width:390,height:844}}),member=await context.newPage();
    try {await login(member,h.admin+'/#/projects/101/model','catalog-member',memberPassword);await openModelCatalog(member);await expect(member.getByRole('button',{name:'立即刷新目录',exact:true})).toHaveCount(0);await expect(member.getByRole('button',{name:'能力与目录',exact:true})).toHaveCount(1);
      const sharedGroup=member.locator('.provider-group').filter({hasText:'https://relay.example/v1'});await expect(sharedGroup.getByRole('button',{name:'能力与目录',exact:true})).toHaveCount(0);await expect(sharedGroup).toContainText('deepseek/deepseek-flash');
      await member.getByRole('button',{name:'能力与目录',exact:true}).click();await member.locator('#model-capabilities').getByLabel('最大输出（token）',{exact:true}).fill('10000');await member.locator('#model-capabilities').getByRole('button',{name:'保存能力与目录',exact:true}).click();await expect(member.locator('.provider-group').filter({hasText:'own-relay.example'})).toContainText('最大输出 10000');
      await member.setViewportSize({width:1440,height:1000});await member.screenshot({path:'.tmp/model-catalog/member-1440.png',fullPage:true});await member.setViewportSize({width:390,height:844});expect(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await member.screenshot({path:'.tmp/model-catalog/member-390.png',fullPage:true});}
    finally{await context.close();}
    expect(errors).toEqual([]);
  } finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
