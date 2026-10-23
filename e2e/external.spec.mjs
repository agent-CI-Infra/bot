import {test,expect} from '@playwright/test';
import {mkdirSync,rmSync} from 'node:fs';
import {generateKeyPairSync} from 'node:crypto';
import {externalFixture} from '../test/external-helpers.mjs';
import {testPassword} from '../test/helpers.mjs';

async function login(page,h,username='administrator',password=h.password){
  await page.goto(h.adminBase);await page.getByLabel('用户名',{exact:true}).fill(username);
  await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
}
async function project(page,h,id='101'){
  await page.goto(h.adminBase+'/#/projects/'+id+'/external');
  await expect(page.getByRole('heading',{name:'当前项目的外部执行',exact:true})).toBeVisible();
}
async function save(page){await page.locator('#external-form').getByRole('button',{name:'保存',exact:true}).click();}
async function noOverflow(page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
async function visibleButton(page,button){
  await button.scrollIntoViewIfNeeded();await expect(button).toBeVisible();
  expect(await button.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
}
async function cleanup(h){await h.stop();await new Promise(resolve=>h.github.server.close(resolve));rmSync(h.directory,{recursive:true,force:true});}

test('全局仅一套说明，选择客户端复制含轮询的指令；地址缺失与剪贴板失败有明确反馈',async({page,context})=>{
  const h=await externalFixture(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    const a=await h.client(),b=await h.client('202');
    const trust={audience:'fixture',subject:'repo:fixture/workflows:ref:refs/heads/main',repository:'fixture/workflows',repository_id:'900',owner_id:'10',workflow_ref:'fixture/workflows/.github/workflows/review.yml@refs/heads/main',ref:'refs/heads/main'};
    const oidc=await h.client('202',{name:'Actions executor',auth_type:'github_actions_oidc',trust});
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:h.adminBase});await login(page,h);
    await page.getByRole('button',{name:'外部执行端',exact:true}).click();
    const panel=page.locator('#external-panel'),guide=panel.locator('.external-guide');
    await expect(guide).toHaveCount(1);await expect(panel.locator('.row .external-guide')).toHaveCount(0);
    await expect(panel.getByRole('button',{name:'新增客户端',exact:true})).toHaveCount(0);
    await expect(panel.getByRole('button',{name:'新增转发订阅',exact:true})).toHaveCount(0);
    await expect(panel.getByRole('button',{name:'设置兑换地址',exact:true})).toBeVisible();
    await guide.locator('summary').click();const select=guide.getByRole('combobox',{name:'复制指令所用客户端',exact:true});await select.selectOption(a.client.id);
    await expect(select.locator('option')).toHaveCount(2);await expect(select.locator('option[value="'+oidc.client.id+'"]')).toHaveCount(0);
    await guide.getByRole('button',{name:'复制给我的 AI agent',exact:true}).click();await expect(guide.getByRole('status')).toHaveText('已复制接入指令');
    const copied=await page.evaluate(()=>navigator.clipboard.readText());
    for(const text of [a.client.id,h.audience,'iss 和 sub 都为 '+a.client.id,'"client_id":"'+a.client.id+'"','"request_id":"<与 jti 完全相同>"','curl --fail-with-body','--header @proof-header.txt','RS256 JWT','最长 120 秒','Authorization: Bearer <token>','contents: read、issues: write、pull_requests: write','expires_at','/external/revoke','grant_id','https://bot.invalid/external/events','同一个 token','每个客户端各自记住进度','服务端不补发','不消耗每小时 20 次兑换额度'])expect(copied).toContain(text);
    expect(copied).not.toContain(b.client.id);expect(copied).not.toContain('-----BEGIN PRIVATE KEY-----');expect(copied).not.toContain(h.github.privateKey);expect(copied).not.toContain('scripts/external-token.mjs');
    await select.selectOption(b.client.id);await guide.getByRole('button',{name:'复制给我的 AI agent',exact:true}).click();
    const changed=await page.evaluate(()=>navigator.clipboard.readText());expect(changed).toContain(b.client.id);expect(changed).not.toContain(a.client.id);
    const doc=await page.request.get(h.adminBase+'/docs/external-token-api.md');expect(doc.status()).toBe(200);expect(await doc.text()).toContain('# token-poll');
    mkdirSync('.tmp/external-e2e',{recursive:true});await page.setViewportSize({width:1365,height:1000});await noOverflow(page);
    await page.screenshot({path:'.tmp/external-e2e/global-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});await noOverflow(page);await visibleButton(page,guide.getByRole('button',{name:'复制给我的 AI agent',exact:true}));
    await page.screenshot({path:'.tmp/external-e2e/global-mobile.png',fullPage:true});
    await panel.getByRole('link',{name:'配置项目外部执行',exact:true}).first().click();await expect(page).toHaveURL(/\/projects\/101\/external$/);
    await expect(page.locator('#project-page .external-guide')).toHaveCount(0);
    await page.getByRole('link',{name:'查看全局接入说明与复制指令',exact:true}).click();await expect(guide).toHaveCount(1);
    h.store.run("DELETE FROM settings WHERE key='external_token_audience'");await page.getByRole('button',{name:'刷新',exact:true}).click();
    await guide.locator('summary').click();await select.selectOption(a.client.id);await guide.getByRole('button',{name:'复制给我的 AI agent',exact:true}).click();
    const missing=await page.evaluate(()=>navigator.clipboard.readText());expect(missing).toContain('兑换地址尚未配置');expect(missing).toContain('不要猜测或编造 URL');expect(missing).not.toContain(h.audience);expect(missing).not.toContain('curl --fail-with-body');expect(missing).not.toContain('https://bot.invalid/external/events');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('unavailable');}}}));
    await guide.getByRole('button',{name:'复制给我的 AI agent',exact:true}).click();await expect(guide.getByLabel('可手动复制的接入指令')).toHaveValue(missing);await expect(guide.getByRole('status')).toContainText('请手动复制');expect(errors).toEqual([]);
  }finally{await cleanup(h);}
});

test('项目内登记与更换公钥、创建和编辑 Webhook，只展示当前项目；项目管理员只读全局地址',async({page})=>{
  const h=await externalFixture(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    const foreign=await h.client('202',{name:'Foreign client'}),legacy=await h.client();
    await h.admin('/api/repositories/202/external/subscriptions','POST',{client_id:foreign.client.id,name:'Foreign subscription',url:'https://foreign.invalid/hook',filters:{events:['issues'],actions:[],exclude_drafts:false}});
    const foreignGrant=await h.exchange(foreign.client.id,foreign.privateKey);expect(foreignGrant.status).toBe(200);
    await h.hook(h.a.path,h.a.secret,'foreign-delivery',{repository:{id:202},action:'opened',issue:{number:1}});
    const foreignDelivery=h.store.get('SELECT id FROM external_deliveries').id;
    h.store.run("UPDATE external_clients SET auth_type='client_secret',secret_hash='retired',public_key=NULL WHERE id=?",legacy.client.id);await h.restart();
    await login(page,h);await project(page,h);const panel=page.locator('#project-page');
    for(const text of ['Foreign client','Foreign subscription',foreign.client.id,foreignGrant.value.grant_id,foreignDelivery])await expect(panel).not.toContainText(text);
    await expect(panel).toContainText('待登记公钥');await panel.getByRole('button',{name:'登记公钥',exact:true}).click();
    await expect(page.locator('#external-fields .external-guide')).toHaveCount(0);await page.getByLabel('RSA 公钥（PEM）',{exact:true}).fill(legacy.publicKey);await save(page);
    await expect(panel).not.toContainText('待登记公钥');
    await panel.getByRole('button',{name:'新增客户端',exact:true}).click();await expect(page.locator('#external-fields select[name=repository_id]')).toHaveCount(0);
    await page.getByLabel('客户端名称',{exact:true}).fill('Local review workstation');await page.getByLabel('RSA 公钥（PEM）',{exact:true}).fill('-----BEGIN PRIVATE KEY-----');await save(page);
    await expect(page.locator('#external-error')).toContainText('私钥必须留在个人电脑');await page.getByLabel('RSA 公钥（PEM）',{exact:true}).fill(foreign.publicKey);await save(page);
    await expect(panel).toContainText('Local review workstation');await expect(panel).toContainText('公钥指纹 SHA256');await expect(page.getByRole('dialog',{name:'一次性凭据'})).not.toBeVisible();
    const own=(await h.admin('/api/repositories/101/external/clients')).value.clients.find(c=>c.name==='Local review workstation');
    await panel.getByRole('button',{name:'新增转发订阅',exact:true}).click();const clients=page.locator('#external-fields select[name=client_id]');
    await expect(clients.locator('option[value="'+foreign.client.id+'"]')).toHaveCount(0);await clients.selectOption(own.id);
    await page.getByLabel('订阅名称',{exact:true}).fill('PR review events');await page.getByLabel('接收 URL',{exact:true}).fill('https://receiver.invalid/review');await save(page);
    await page.getByRole('button',{name:'已保存并关闭',exact:true}).click();await expect(panel).toContainText('PR review events');
    await panel.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('事件动作（留空表示全部）',{exact:true}).fill('synchronize');await save(page);await expect(panel).toContainText('synchronize');
    mkdirSync('.tmp/external-e2e',{recursive:true});await page.setViewportSize({width:1365,height:1000});await noOverflow(page);await page.screenshot({path:'.tmp/external-e2e/project-desktop.png',fullPage:true});
    const password=testPassword();await h.admin('/api/users','POST',{username:'member',password,repository_ids:['101']});await page.getByRole('button',{name:'退出登录',exact:true}).click();await login(page,h,'member',password);
    await page.getByRole('button',{name:'外部执行端',exact:true}).click();await expect(page.getByRole('button',{name:'设置兑换地址',exact:true})).toBeHidden();await expect(page.locator('#external-panel')).not.toContainText('仓库 202');
    await page.locator('#external-panel .external-guide summary').click();await expect(page.getByRole('combobox',{name:'复制指令所用客户端',exact:true}).locator('option[value="'+foreign.client.id+'"]')).toHaveCount(0);
    await project(page,h);const row=panel.locator('.row',{hasText:'Local review workstation'}),rotated=generateKeyPairSync('rsa',{modulusLength:2048});
    await row.getByRole('button',{name:'更换公钥',exact:true}).click();await page.getByLabel('RSA 公钥（PEM）',{exact:true}).fill(rotated.publicKey.export({type:'spki',format:'pem'}));await save(page);
    await expect(page.getByRole('dialog',{name:'更换客户端公钥'})).not.toBeVisible();expect((await h.exchange(own.id,foreign.privateKey)).status).toBe(401);expect((await h.exchange(own.id,rotated.privateKey)).status).toBe(200);
    await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:'.tmp/external-e2e/project-mobile.png',fullPage:true});
    await panel.getByRole('button',{name:'新增客户端',exact:true}).click();const modal=page.locator('#external-fields');
    await modal.locator('.external-key-help summary').click();await expect(modal).toContainText('openssl pkey -in bot-client.pem -pubout -out bot-client.pub.pem');
    await page.getByLabel('RSA 公钥（PEM）',{exact:true}).fill(foreign.publicKey);await visibleButton(page,page.locator('#external-form').getByRole('button',{name:'保存',exact:true}));await noOverflow(page);
    await page.screenshot({path:'.tmp/external-e2e/public-key-mobile.png'});await modal.locator('select[name=auth_type]').selectOption('github_actions_oidc');
    await expect(modal.locator('.external-key-help')).toBeHidden();await expect(page.getByLabel('RSA 公钥（PEM）',{exact:true})).toBeHidden();await expect(page.getByLabel('Audience',{exact:true})).toBeVisible();
    await page.screenshot({path:'.tmp/external-e2e/oidc-mobile.png'});await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByRole('dialog',{name:'新增客户端'})).not.toBeVisible();
    await page.goto(h.adminBase+'/#/projects/202/external');await expect(panel).toContainText('repository_forbidden');await expect(panel).not.toContainText('Foreign client');
    expect(errors).toEqual([]);
  }finally{await cleanup(h);}
});

test('空项目可直接新增，取消不留下草稿，全局仍只有一套说明',async({page})=>{
  const h=await externalFixture();try{
    await login(page,h);await page.getByRole('button',{name:'外部执行端',exact:true}).click();await expect(page.locator('#external-panel .external-guide')).toHaveCount(1);
    await expect(page.locator('#external-panel')).toContainText('尚未配置外部客户端');await project(page,h);await expect(page.locator('#project-page')).toContainText('尚未配置外部客户端');
    await page.getByRole('button',{name:'新增客户端',exact:true}).click();await page.getByLabel('客户端名称',{exact:true}).fill('Discarded draft');await page.getByRole('button',{name:'取消',exact:true}).click();
    await expect(page.locator('#project-page')).not.toContainText('Discarded draft');expect((await h.admin('/api/repositories/101/external/clients')).value.clients).toEqual([]);
  }finally{await cleanup(h);}
});
