import{test,expect}from'@playwright/test';import{mkdirSync}from'node:fs';import{createServer}from'node:http';import{once}from'node:events';import{generateKeyPairSync}from'node:crypto';
import{harness,setup,account}from'../test/helpers.mjs';import{InstallationSync}from'../dist/app/installations.js';

test('机器人账号页检查 GitHub App 权限，列出缺少的项并给出修改与接受的链接',async({page})=>{
 const full={contents:'write',issues:'write',pull_requests:'write',statuses:'write',actions:'write',checks:'write',metadata:'read'};
 const app={slug:'fixture-app',html_url:'https://github.com/apps/fixture-app',owner:{login:'fixture',type:'Organization'},permissions:{contents:'write',issues:'write',pull_requests:'write',metadata:'read',statuses:'read'}};
 const installations=[{id:7,account:{login:'fixture'},html_url:'https://github.com/organizations/fixture/settings/installations/7',permissions:{contents:'write',issues:'write',pull_requests:'write',metadata:'read'}}];
 const github=createServer((req,res)=>{const url=new URL(req.url,'http://fake');res.setHeader('Content-Type','application/json');
  if(url.pathname==='/app')return res.end(JSON.stringify(app));if(url.pathname==='/app/installations')return res.end(JSON.stringify(url.searchParams.get('page')==='1'?installations:[]));res.statusCode=404;res.end('{}');});
 github.listen(0,'127.0.0.1');await once(github,'listening');
 const h=await harness(undefined,undefined,store=>({installations:new InstallationSync(store,`http://127.0.0.1:${github.address().port}`)}));
 try{
  const{admin,password}=await setup(h),keys=generateKeyPairSync('rsa',{modulusLength:2048});
  await account(admin,{name:'Department App',type:'github_app',app_id:'123',private_key:keys.privateKey.export({type:'pkcs8',format:'pem'}),token:undefined});
  await page.goto(h.admin);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'全局设置',exact:true}).click();await page.locator('.project-nav').getByRole('link',{name:'机器人账号',exact:true}).click();
  const row=page.locator('.row',{hasText:'Department App'});await row.getByRole('button',{name:'检查权限',exact:true}).click();
  const result=row.locator('.permission-result');
  await expect(result).toContainText('第 1 步');await expect(result).toContainText('Actions：改为「Read and write」（当前「No access」）');await expect(result).toContainText('Commit statuses：改为「Read and write」（当前「Read-only」）');
  await expect(result.getByRole('link',{name:'打开 App 的 Permissions & events'})).toHaveAttribute('href','https://github.com/organizations/fixture/settings/apps/fixture-app/permissions');
  await expect(result.getByRole('link',{name:'前往接受'})).toHaveAttribute('href','https://github.com/organizations/fixture/settings/installations/7');
  mkdirSync('.tmp/app-permissions',{recursive:true});
  for(const[width,height]of[[1365,900],[390,844]]){await page.setViewportSize({width,height});await result.scrollIntoViewIfNeeded();await page.screenshot({path:`.tmp/app-permissions/missing-${width}.png`,fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  // The App owner saves and the installation accepts on GitHub; checking again shows nothing left to do.
  app.permissions=full;installations[0].permissions=full;await row.getByRole('button',{name:'重新检查',exact:true}).click();
  await expect(result).toContainText('权限齐全：App 和 1 个安装都已具备所需权限。');await expect(result.getByRole('link')).toHaveCount(0);
 }finally{await h.stop();github.close();}
});
