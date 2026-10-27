import{test,expect}from'@playwright/test';import{mkdirSync,rmSync}from'node:fs';import{generateKeyPairSync,randomBytes}from'node:crypto';
import{harness,setup,account,repository,testPassword}from'../test/helpers.mjs';import{Onboarding}from'../dist/onboarding/service.js';import{RuleService}from'../dist/rules/service.js';

test('接入向导验证地址、准备 manifest、跳过安装、保存模型并查看项目规则来源',async({page})=>{
 let onboarding;const h=await harness(undefined,undefined,store=>({onboarding:onboarding=new Onboarding(store,{probe:async raw=>{const u=new URL(raw);return u.pathname.includes('probe')?{status:200,body:JSON.stringify(onboarding.probe(u.searchParams.get('nonce'),'webhook'))}:{status:404,body:'{}'};}})}));
 const{admin,password}=await setup(h),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(h.admin);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('heading',{name:'接入向导',exact:true})).toBeVisible();
  await page.getByLabel('公网 HTTPS 地址',{exact:true}).fill('https://hooks.invalid');await page.getByRole('button',{name:'检查并使用',exact:true}).click();await expect(page.locator('#onboarding-panel')).toContainText('已验证地址');
  mkdirSync('.tmp/onboarding',{recursive:true});await page.setViewportSize({width:1365,height:900});await page.screenshot({path:'.tmp/onboarding/wizard-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'2. GitHub App',exact:true}).click();await page.getByLabel('App 所属组织',{exact:true}).fill('fixture');await page.getByLabel('App 名称',{exact:true}).fill('Fixture bot');await page.getByRole('button',{name:'准备 GitHub 确认页',exact:true}).click();const manifestForm=page.locator('#onboarding-panel form[target=_blank]');await expect(manifestForm).toBeVisible();expect(await manifestForm.getAttribute('action')).toMatch(/^https:\/\/github.com\/organizations\/fixture\/settings\/apps\/new\?state=/);const manifest=JSON.parse(await manifestForm.locator('textarea[name=manifest]').inputValue());expect(manifest.default_events).toEqual(['issues','pull_request']);expect(manifest.default_permissions.contents).toBe('write');
  await page.getByRole('button',{name:'3. 安装',exact:true}).click();await page.getByRole('button',{name:'暂时跳过安装',exact:true}).click();await expect(page.locator('.wizard-notice')).toContainText('仓库检视不会开始');
  await page.getByLabel('接口 URL',{exact:true}).fill('https://model.invalid/v1');await page.getByLabel('API Key',{exact:true}).fill(testPassword());await page.getByLabel('模型名',{exact:true}).fill('fixture-model');await page.getByRole('button',{name:'保存并继续',exact:true}).click();await expect(page.locator('#onboarding-panel')).toContainText('.bot/rules/issue-development.md');expect((await admin('/api/models')).value.models[0].api_key).toBeUndefined();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tmp/onboarding/wizard-mobile.png',fullPage:true});
  const a=await account(admin);await repository(admin,a.id,'101');const rules=new RuleService(h.store);rules.cache('101','a'.repeat(40),{'.bot/guide.md':'Repository behavior override','.agents/skills/demo/SKILL.md':'Demo skill'});
  await page.goto(h.admin+'/#/projects/101/rules');await expect(page.getByRole('heading',{name:'规则总览',exact:true})).toBeVisible();const guideRow=page.locator('.rule-table tr').filter({hasText:'.bot/guide.md'});await expect(guideRow.locator('td[data-label=仓库文件]')).toHaveText('生效');await expect(page.locator('.rule-table')).toContainText('.agents/skills/demo/SKILL.md');
  const guide=page.locator('[data-rule-path=".bot/guide.md"]');await expect(guide).toContainText('Repository behavior override');await guide.getByRole('button',{name:'添加控制台覆盖',exact:true}).click();await guide.getByLabel('.bot/guide.md 控制台覆盖',{exact:true}).fill('Console behavior');await guide.getByRole('button',{name:'保存',exact:true}).click();
  await expect(guide.locator('.flash')).toHaveText('已保存控制台覆盖');await expect(guide).toContainText('默认分支的仓库文件整份覆盖控制台内容');await expect(guide).toContainText('生效：仓库文件');await expect(guideRow.locator('td[data-label=项目控制台]')).toHaveText('被覆盖');
  await page.setViewportSize({width:1365,height:900});await page.screenshot({path:'.tmp/onboarding/rules-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tmp/onboarding/rules-mobile.png',fullPage:true});expect(errors).toEqual([]);expect(h.store.get('SELECT count(*) n FROM tasks').n).toBe(0);
 }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
test('GitHub 创建 App 后回到第 3 步安装，地址保留步骤，已保存 tunnel 时第 1 步选中 Cloudflare Tunnel',async({page})=>{
 const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});let onboarding;
 const h=await harness(undefined,undefined,store=>({onboarding:onboarding=new Onboarding(store,{fetcher:async()=>new Response(JSON.stringify({id:123,slug:'fixture-app',name:'Fixture',pem,webhook_secret:randomBytes(32).toString('hex')}))})}));
 onboarding.options.tunnelFile=h.directory+'/tunnel/token';
 const{admin,password}=await setup(h),errors=[],count=page.locator('#count');page.on('pageerror',error=>errors.push(error.message));
 const login=async()=>{await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();};
 const open=async address=>{await page.goto('about:blank');await page.goto(h.admin+address);};
 try{
  onboarding.save('public',{origin:'https://hooks.invalid',checked_at:new Date().toISOString()});
  const state=new URL((await admin('/api/onboarding/manifest','POST',{organization:'fixture',name:'Fixture'})).value.create_url).searchParams.get('state');
  await page.goto(h.admin);await login();await expect(count).toHaveText('第 1 / 6 步');
  // After the App is confirmed GitHub opens redirect_url; the callback answers 303 to the install step.
  await page.goto(`${h.admin}/onboarding/github/callback?code=fixture-code&state=${state}`);await expect(page).toHaveURL(/\/#onboarding\/2$/);
  await expect(count).toHaveText('第 3 / 6 步');await expect(page.getByRole('button',{name:'3. 安装',exact:true})).toHaveAttribute('aria-current','step');
  await expect(page.locator('#onboarding-panel')).toContainText('fixture-app');await expect(page.getByRole('link',{name:'在 GitHub 选择账号',exact:true})).toHaveAttribute('href','https://github.com/apps/fixture-app/installations/new');
  // Moving between steps rewrites the address in place: same document, no history entry, and a reload stays on the step.
  const entries=await page.evaluate(()=>{window.sameDocument=true;return history.length;});
  await page.getByRole('button',{name:'4. 模型',exact:true}).click();await expect(count).toHaveText('第 4 / 6 步');await expect(page).toHaveURL(/#onboarding\/3$/);
  await page.getByRole('button',{name:'下一步',exact:true}).click();await expect(count).toHaveText('第 5 / 6 步');await expect(page).toHaveURL(/#onboarding\/4$/);
  expect(await page.evaluate(()=>[window.sameDocument,history.length])).toEqual([true,entries]);
  await page.reload();await expect(count).toHaveText('第 5 / 6 步');
  // #onboarding without a step starts at the first step; an unknown step falls back to it instead of breaking the page.
  await open('/#onboarding');await expect(count).toHaveText('第 1 / 6 步');
  await page.getByRole('button',{name:'2. GitHub App',exact:true}).click();await expect(count).toHaveText('第 2 / 6 步');
  await page.evaluate(()=>{location.hash='#onboarding/9';});await expect(count).toHaveText('第 1 / 6 步');
  await open('/#onboarding/9');await expect(page.locator('#page-title')).toHaveText('项目');
  // With a saved tunnel token step 1 opens on Cloudflare Tunnel, also when coming back after choosing the other way.
  const token=Buffer.from(JSON.stringify({a:'fixture-account',t:'fixture-tunnel',s:randomBytes(32).toString('hex')})).toString('base64');expect((await admin('/api/onboarding/tunnel','POST',{token})).status).toBe(201);
  const tunnelChoice=page.getByRole('button',{name:'Cloudflare Tunnel',exact:true});
  await open('/#onboarding/0');await expect(count).toHaveText('第 1 / 6 步');await expect(tunnelChoice).toHaveAttribute('aria-pressed','true');await expect(page.locator('#wizard-tunnel')).toBeVisible();await expect(page.locator('#wizard-proxy')).toBeHidden();
  await page.getByRole('button',{name:'自建 HTTPS 中转',exact:true}).click();await expect(page.locator('#wizard-proxy')).toBeVisible();
  await page.getByRole('button',{name:'3. 安装',exact:true}).click();await page.getByRole('button',{name:'1. 公网 HTTPS',exact:true}).click();await expect(tunnelChoice).toHaveAttribute('aria-pressed','true');await expect(page.locator('#wizard-tunnel')).toBeVisible();
  // Logging out still clears the step.
  await page.getByRole('button',{name:'3. 安装',exact:true}).click();await expect(page).toHaveURL(/#onboarding\/2$/);
  await page.locator('#logout').click();await login();await expect(count).toHaveText('第 1 / 6 步');await expect(page).toHaveURL(/#onboarding$/);
  expect(errors).toEqual([]);
 }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
