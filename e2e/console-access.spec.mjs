import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, testPassword } from '../test/helpers.mjs';
import { identityFixture } from '../test/identity-fixture.mjs';

async function fill(page,username,password) {await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);}
const bounds=async page=>expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
function shots(){mkdirSync('.tmp/console-access',{recursive:true});}

test('first setup keeps one-time initialization and local recovery across screen sizes',async({page})=>{
  const h=await harness(),password=testPassword(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto(h.admin);await expect(page.getByRole('heading',{name:'创建第一名超级管理员',exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:'使用 GitHub 登录'})).toBeHidden();shots();
    for(const width of [320,390,768,1024,1440,1920]){
      await page.setViewportSize({width,height:900});await bounds(page);
      expect(await page.getByLabel('密码',{exact:true}).evaluate(n=>getComputedStyle(n).fontSize)).toBe('16px');
      if([390,1440].includes(width))await page.screenshot({path:`.tmp/console-access/setup-${width}.png`,fullPage:true});
    }
    await page.setViewportSize({width:390,height:500});await fill(page,'first-administrator',password);
    await page.getByRole('button',{name:'显示密码',exact:true}).click();await expect(page.locator('#access-password')).toHaveAttribute('type','text');
    await page.getByRole('button',{name:'隐藏密码',exact:true}).click();await expect(page.locator('#access-password')).toHaveAttribute('type','password');
    const submit=page.getByRole('button',{name:'初始化并登录',exact:true});await submit.scrollIntoViewIfNeeded();await expect(submit).toBeInViewport();await submit.click();
    await expect(page.locator('#workspace')).toBeVisible();expect(h.store.get('SELECT COUNT(*) AS n FROM users').n).toBe(1);
    expect((await h.client()('/api/setup','POST',{username:'second',password})).status).toBe(409);
    await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.getByRole('heading',{name:'登录',exact:true})).toBeVisible();
    await expect(page.locator('#access-password')).toHaveValue('');await expect(page.locator('#access-password')).toHaveAttribute('type','password');
    await fill(page,'first-administrator',password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
    expect(errors).toEqual([]);
  }finally{await h.stop();}
});

test('login errors remain beside the form and an interrupted request preserves inputs without duplicate submissions',async({page})=>{
  const h=await harness(),{password}=await setup(h);
  try {
    await page.goto(h.admin);await fill(page,'administrator',testPassword());await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.locator('#access-feedback #message')).toContainText('用户名或密码不正确');
    await page.route('**/api/auth/login',route=>route.fulfill({status:429,contentType:'application/json',body:'{"error":"login_rate_limited"}'}));
    await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#access-feedback #message')).toContainText('登录尝试过于频繁');
    await page.unroute('**/api/auth/login');
    let release,count=0;const gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/auth/login',async route=>{count++;await gate;await route.abort('failed');});
    await fill(page,'administrator',password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.locator('#access-form')).toHaveAttribute('aria-busy','true');await expect(page.getByLabel('密码',{exact:true})).toBeDisabled();
    await expect(page.getByRole('button',{name:'正在登录…',exact:true})).toBeDisabled();expect(count).toBe(1);release();
    await expect(page.locator('#access-feedback #message')).toContainText('网络连接失败');await expect(page.getByLabel('密码',{exact:true})).toHaveValue(password);
    expect(page.url()).not.toContain(password);expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain(password);
    await page.unroute('**/api/auth/login');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
  }finally{await h.stop();}
});

test('stale initialization returns to login without replacing the first administrator',async({page})=>{
  const h=await harness(),password=testPassword();
  try {
    await page.goto(h.admin);await expect(page.getByRole('button',{name:'初始化并登录',exact:true})).toBeVisible();
    const first=h.client();expect((await first('/api/setup','POST',{username:'first-admin',password})).status).toBe(201);
    await fill(page,'stale-admin',testPassword());await page.getByRole('button',{name:'初始化并登录',exact:true}).click();
    await expect(page.getByRole('heading',{name:'登录',exact:true})).toBeVisible();await expect(page.locator('#access-feedback #message')).toContainText('系统已经初始化');
    expect(h.store.get('SELECT COUNT(*) AS n FROM users').n).toBe(1);expect(h.store.get('SELECT username FROM users').username).toBe('first-admin');
    await fill(page,'first-admin',password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
  }finally{await h.stop();}
});

test('GitHub entry keeps callback errors and successful login without projects leads to effective access guidance',async({page})=>{
  const f=await identityFixture();f.state.owner=false;f.state.admin=false;
  await page.route('https://avatars.githubusercontent.com/**',route=>route.abort());
  try {
    await page.goto(f.h.admin);await expect(page.getByRole('link',{name:'使用 GitHub 登录',exact:true})).toBeVisible();
    shots();for(const width of [1440,390]){await page.setViewportSize({width,height:900});await bounds(page);await page.screenshot({path:`.tmp/console-access/login-${width}.png`,fullPage:true});}
    await page.goto(f.h.admin+'/?auth_error=invalid_oauth_state');await expect(page.locator('#access-feedback #message')).toContainText('登录验证已过期');
    await page.reload();await expect(page.locator('#access-feedback #message')).toContainText('请重新发起 GitHub 登录');
    shots();for(const width of [1440,390]){await page.setViewportSize({width,height:900});await bounds(page);await page.screenshot({path:`.tmp/console-access/login-error-${width}.png`,fullPage:true});}
    await page.getByRole('link',{name:'使用 GitHub 登录',exact:true}).click();
    await expect(page.locator('#identity-panel')).toBeVisible();await page.goto(f.h.admin+'/#/projects');
    await expect(page.getByRole('heading',{name:'已登录，尚无可管理的项目'})).toBeVisible();await expect(page.locator('#access')).toBeHidden();
    await page.getByRole('link',{name:'查看身份与权限',exact:true}).click();await expect(page.locator('#identity-panel')).toBeVisible();
  }finally{await f.close();}
});

test('unavailable GitHub status retains local recovery and can be read again',async({page})=>{
  const h=await harness(),{password}=await setup(h);
  try {
    await page.route('**/api/auth/github/status',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'}));
    await page.goto(h.admin);await expect(page.locator('#access-provider-status')).toContainText('暂不可读取');
    await expect(page.getByLabel('用户名',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'登录',exact:true})).toBeEnabled();
    await page.unroute('**/api/auth/github/status');await page.getByRole('button',{name:'重新读取登录入口',exact:true}).click();
    await expect(page.locator('#access-provider-status')).toBeEmpty();await fill(page,'administrator',password);
    // Authentication success followed by a workspace outage must not be reported as an invalid password.
    await page.route('**/api/repositories',route=>route.abort('failed'));await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.locator('#boot-message')).toContainText('控制台载入失败');await expect(page.locator('#access')).toBeHidden();
    await page.unroute('**/api/repositories');await page.getByRole('button',{name:'重试',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
  }finally{await h.stop();}
});
