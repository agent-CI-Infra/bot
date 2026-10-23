import {test,expect} from '@playwright/test';
import {generateKeyPairSync} from 'node:crypto';
import {mkdirSync,rmSync} from 'node:fs';
import {harness,setup,account} from '../test/helpers.mjs';
import {Onboarding} from '../dist/onboarding/service.js';

test('安装步骤解析组织链接并打开定向页面，错误或改动输入后不保留旧安装入口',async({page,context})=>{
  let onboarding,installed=false,hold=null,lookupStarted;
  const h=await harness(undefined,undefined,store=>({onboarding:onboarding=new Onboarding(store,{fetcher:async(raw)=>{
    const path=new URL(raw).pathname;
    if(path.startsWith('/users/')){lookupStarted?.();if(hold)await hold;const name=path.split('/').at(-1);return new Response(JSON.stringify({id:10,login:name==='personal'?'personal':'fixture-org',type:name==='personal'?'User':'Organization'}));}
    return new Response(JSON.stringify(installed?{id:77,app_id:123,account:{id:10}}:{}),{status:installed?200:404});
  }})})),{admin,password}=await setup(h),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'}),a=await account(admin,{type:'github_app',app_id:'123',private_key:key,token:undefined});onboarding.save('app',{account_id:a.id,app_id:'123',slug:'fixture-app',install_url:'https://github.com/apps/fixture-app/installations/new'});
    await page.goto(h.admin);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'接入向导',exact:true}).click();await page.getByRole('button',{name:'3. 安装',exact:true}).click();
    const target=page.getByLabel('安装组织',{exact:true}),resolve=page.getByRole('button',{name:'解析组织',exact:true}),result=page.locator('.installation-target-result');
    await target.fill('https://github.com/fixture-org/private-repo/pull/7');await resolve.click();const install=page.getByRole('link',{name:'前往 fixture-org 安装',exact:true});await expect(install).toHaveAttribute('href','https://github.com/apps/fixture-app/installations/new/permissions?suggested_target_id=10');await expect(result).toContainText('fixture-org');
    await context.route('https://github.com/**',route=>route.fulfill({contentType:'text/html',body:'<h1>GitHub installation confirmation</h1>'}));const opened=context.waitForEvent('page');await install.click();const popup=await opened;await popup.waitForLoadState('domcontentloaded');expect(new URL(popup.url()).searchParams.get('suggested_target_id')).toBe('10');await popup.close();
    mkdirSync('.tmp/installation-target',{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/installation-target/desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tmp/installation-target/mobile.png',fullPage:true});
    await target.fill('personal');await expect(install).toHaveCount(0);await resolve.click();await expect(page.locator('#onboarding-panel [role=alert]')).toContainText('个人用户');await expect(install).toHaveCount(0);
    let release;hold=new Promise(done=>release=done);const started=new Promise(done=>lookupStarted=done);await target.fill('fixture-org');await resolve.click();await started;await expect(resolve).toBeDisabled();await expect(result).toContainText('正在向 GitHub 核对');await target.fill('personal');release();await expect(resolve).toBeEnabled();await expect(install).toHaveCount(0);hold=null;
    installed=true;await target.fill('git@github.com:fixture-org/repo.git');await resolve.click();await expect(page.getByRole('link',{name:'打开 fixture-org 安装设置',exact:true})).toHaveAttribute('href','https://github.com/organizations/fixture-org/settings/installations/77');await page.screenshot({path:'.tmp/installation-target/existing-mobile.png',fullPage:true});
    expect(h.store.get('SELECT count(*) n FROM repositories').n).toBe(0);expect(errors).toEqual([]);
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
