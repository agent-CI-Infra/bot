import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { identityFixture, openIdentityAdvanced } from '../test/identity-fixture.mjs';
import { harness, setup, account, testPassword } from '../test/helpers.mjs';
import { Onboarding } from '../dist/onboarding/service.js';

async function localLogin(page, origin, password) {
  await page.goto(origin); await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#identity')).toBeVisible();
}

test('独立 OAuth App 登录指引与仓库 App 分开，桌面和手机都能按顺序配置', async ({ page }) => {
  const h = await harness(), { password } = await setup(h), errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  try {
    h.store.run("INSERT INTO settings VALUES('onboarding.app',?)",JSON.stringify({account_id:'legacy',app_id:'123',slug:'repository-app'}));
    await localLogin(page,h.admin,password);await page.goto(h.admin+'/#/settings/onboarding/2');
    const panel=page.locator('#onboarding-panel'),guide=panel.locator('.login-guide');
    await expect(guide.locator(':scope > li > strong')).toHaveText(['创建独立 OAuth App','复制这个 OAuth App 的登录凭据','保存并启用登录']);
    await expect(guide.getByRole('link',{name:'在 GitHub 创建 OAuth App',exact:true})).toHaveAttribute('href','https://github.com/settings/applications/new');
    await expect(guide).toContainText('不申请额外 scope');await expect(guide).toContainText('不要复制第 2 步仓库 App 的凭据');
    await expect(page.getByLabel('Client ID',{exact:true})).toHaveValue('');
    await expect(guide.locator('.github-login-callback')).toHaveText(h.admin+'/auth/github/callback');
    await expect(panel.getByRole('button',{name:'刷新 App 信息',exact:true})).toHaveCount(0);
    await page.getByLabel('启用 GitHub 账号登录',{exact:true}).check();
    await page.getByLabel('Client ID',{exact:true}).fill('Iv1.repository-app');
    await page.getByLabel('Client secret（只保存，不回读）',{exact:true}).fill(testPassword());
    await page.getByRole('button',{name:'保存登录配置',exact:true}).click();
    await expect(panel).toContainText('不能使用仓库 GitHub App 的 Client ID');
    await page.getByLabel('Client ID',{exact:true}).fill('Ov23.login');await page.getByRole('button',{name:'保存登录配置',exact:true}).click();
    await expect(page.locator('#message')).toContainText('GitHub 登录已启用');
    await expect(page.getByLabel('Client secret（只保存，不回读）',{exact:true})).toHaveValue('');
    const redirect=new URL((await fetch(h.admin+'/auth/github/start',{redirect:'manual'})).headers.get('location'));
    expect(redirect.searchParams.get('client_id')).toBe('Ov23.login');expect(redirect.searchParams.get('scope')).toBe('');
    mkdirSync('.tmp/github-login-guide',{recursive:true});await page.screenshot({path:'.tmp/github-login-guide/oauth-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'.tmp/github-login-guide/oauth-mobile.png',fullPage:true});expect(errors).toEqual([]);
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});

test('旧 GitHub App 登录明确提示迁移，保存新 OAuth 凭据后切换，不复用旧 secret',async({page})=>{
  const h=await harness(),{password}=await setup(h);
  try{
    h.store.run("INSERT INTO settings VALUES('identity.github_login',?)",h.store.secrets.seal({enabled:true,client_id:'Iv1.legacy',client_secret:testPassword(),admin_origin:h.admin,account_id:'repository-app'},'identity.github_login'));
    await localLogin(page,h.admin,password);await page.goto(h.admin+'/#/settings/onboarding/2');
    await expect(page.locator('#onboarding-panel')).toContainText('当前登录仍复用旧 GitHub App');
    await expect(page.getByLabel('Client ID',{exact:true})).toHaveValue('');await expect(page.getByLabel('启用 GitHub 账号登录',{exact:true})).toBeChecked();
    const active=async()=>new URL((await fetch(h.admin+'/auth/github/start',{redirect:'manual'})).headers.get('location')).searchParams.get('client_id');
    expect(await active()).toBe('Iv1.legacy');await page.getByLabel('Client ID',{exact:true}).fill('Ov23.migrated');
    await page.getByRole('button',{name:'保存登录配置',exact:true}).click();await expect(page.locator('#onboarding-panel')).toContainText('启用前需要保存这个 OAuth App 的 Client secret');
    expect(await active()).toBe('Iv1.legacy');await page.getByLabel('Client secret（只保存，不回读）',{exact:true}).fill(testPassword());
    await page.getByRole('button',{name:'保存登录配置',exact:true}).click();await expect(page.locator('#message')).toContainText('GitHub 登录已启用');
    expect(await active()).toBe('Ov23.migrated');await expect(page.locator('#onboarding-panel')).not.toContainText('当前登录仍复用旧 GitHub App');
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});

test('切换或新建仓库 App 不会改动独立 OAuth 登录配置',async({page})=>{
  const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});let onboarding;
  const h=await harness(undefined,undefined,store=>({onboarding:onboarding=new Onboarding(store,{fetcher:async()=>new Response(JSON.stringify({id:123,slug:'new-repository-app',pem,webhook_secret:testPassword(),client_id:'Iv1.repository',client_secret:testPassword()}))})}));
  try{
    const{admin,password}=await setup(h);onboarding.save('public',{origin:'https://bot.invalid'});
    expect((await admin('/api/onboarding/github-login','PUT',{enabled:true,client_id:'Ov23.existing-login',client_secret:testPassword()})).status).toBe(200);
    const manifest=await admin('/api/onboarding/manifest','POST',{organization:'fixture',name:'new-repository-app'});
    expect(manifest.value.manifest.callback_urls).toBeUndefined();
    await localLogin(page,h.admin,password);await page.goto(h.admin+'/onboarding/github/callback?code=manifest-code&state='+new URL(manifest.value.create_url).searchParams.get('state'));
    await expect(page.getByLabel('Client ID',{exact:true})).toHaveValue('Ov23.existing-login');await expect(page.getByLabel('启用 GitHub 账号登录',{exact:true})).toBeChecked();
    await expect(page.locator('#onboarding-panel')).toContainText('更换仓库 App 不会更换登录配置');
    expect(new URL((await fetch(h.admin+'/auth/github/start',{redirect:'manual'})).headers.get('location')).searchParams.get('client_id')).toBe('Ov23.existing-login');
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});

test('系统超级管理员在全局设置向导启用 GitHub 登录，密钥不回显，普通用户不能进入配置', async ({ page, browser }) => {
  const f = await identityFixture(undefined, { wizardOnly: true }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const password = f.password;
    expect((await f.admin('/api/auth/github/status')).value.enabled).toBe(false);
    await page.goto(f.h.admin); await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#tabs').getByRole('button', { name: '接入向导', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '全局设置', exact: true }).click();
    await page.locator('.project-nav').getByRole('link', { name: '接入向导', exact: true }).click();
    await page.getByRole('button', { name: '3. GitHub 登录', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/onboarding\/2$/);
    // Without a verified public address the callback stays on this console, and the page says it only suits local testing.
    await expect(page.locator('.github-login-callback')).toHaveText(f.h.admin + '/auth/github/callback');
    await expect(page.locator('#onboarding-panel')).toContainText('只适合在本机测试');
    await expect(page.locator('.project-nav [aria-current=page]')).toHaveText('接入向导');
    await page.getByLabel('启用 GitHub 账号登录', { exact: true }).check();
    await page.getByLabel('Client ID', { exact: true }).fill('fixture-client');
    await page.getByLabel('Client secret（只保存，不回读）', { exact: true }).fill('fixture-secret');
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('GitHub 登录已启用');
    await expect(page.getByLabel('Client secret（只保存，不回读）', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('启用 GitHub 账号登录', { exact: true })).toBeChecked();
    mkdirSync('.tmp/onboarding-settings', { recursive: true });
    await page.screenshot({ path: '.tmp/onboarding-settings/github-login-desktop.png', fullPage: true });
    await page.reload(); await expect(page.getByLabel('Client ID', { exact: true })).toHaveValue('fixture-client');
    await expect(page.getByLabel('Client secret（只保存，不回读）', { exact: true })).toHaveValue('');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.github-login-callback').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/onboarding-settings/github-login-mobile.png', fullPage: true });
    await page.getByLabel('启用 GitHub 账号登录', { exact: true }).uncheck();
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('当前使用本地账号登录');
    expect((await f.admin('/api/auth/github/status')).value.enabled).toBe(false);
    await page.getByLabel('启用 GitHub 账号登录', { exact: true }).check();
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('GitHub 登录已启用');
    // #481: at 390 the header's sign-out button is inside the account menu.
    await page.locator('#console-account').click(); await page.locator('#console-account-menu').getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('link', { name: '使用 GitHub 登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接', exact: true })).toBeVisible();
    await expect(page.locator('#tabs').getByRole('button', { name: '全局设置', exact: true })).toBeHidden();
    await page.goto(f.h.admin + '/#/settings/onboarding/2');
    await expect(page.locator('#settings-panel')).toBeHidden();
    expect(await page.evaluate(async () => (await fetch('/api/onboarding')).status)).toBe(403);
    // A separately delegated local project/organization administrator is equally unable to configure OAuth.
    const memberPassword = testPassword(); await f.admin('/api/users', 'POST', { username: 'scoped-admin', password: memberPassword, organization_ids: ['10'] });
    const context = await browser.newContext(), member = await context.newPage();
    await member.goto(f.h.admin + '/#/settings/onboarding/2'); await member.getByLabel('用户名', { exact: true }).fill('scoped-admin');
    await member.getByLabel('密码', { exact: true }).fill(memberPassword); await member.getByRole('button', { name: '登录', exact: true }).click();
    await expect(member.locator('#settings-panel')).toBeHidden(); await context.close();
    await page.locator('#console-account').click(); await page.locator('#console-account-menu').getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.goto(f.h.admin + '/#/settings/onboarding/2');
    await page.getByLabel('清除登录 Client secret，并停用 GitHub 登录', { exact: true }).check();
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('当前使用本地账号登录');
    expect((await f.admin('/api/onboarding')).value.github_login.secret_configured).toBe(false);
    await page.locator('#console-account').click(); await page.locator('#console-account-menu').getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('link', { name: '使用 GitHub 登录', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
