import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { identityFixture } from '../test/identity-fixture.mjs';
import { harness, setup, account, testPassword } from '../test/helpers.mjs';
import { Onboarding } from '../dist/onboarding/service.js';

async function localLogin(page, origin, password) {
  await page.goto(origin); await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#identity')).toBeVisible();
}

test('登录指引给出所选 App 的设置入口、Client ID 与 App ID 的区别，以及同一入口下各自用途的 GitHub 地址', async ({ page }) => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), errors = [];
  let onboarding;
  const h = await harness(undefined, undefined, store => ({ onboarding: onboarding = new Onboarding(store, { fetcher: async () => new Response(JSON.stringify({
    id: 123, slug: 'org-app', owner: { login: 'fixture-org', type: 'Organization' }, html_url: 'https://github.com/apps/org-app',
    pem, webhook_secret: testPassword(), client_id: 'Iv1.org-app', client_secret: testPassword(),
  })) }) }));
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h); onboarding.save('public', { origin: 'https://bot.invalid', checked_at: new Date().toISOString() });
    const manifest = await admin('/api/onboarding/manifest', 'POST', { organization: 'fixture-org', name: 'org-app' });
    await localLogin(page, h.admin, password);
    await page.goto(h.admin + '/onboarding/github/callback?code=manifest-code&state=' + new URL(manifest.value.create_url).searchParams.get('state'));
    const panel = page.locator('#onboarding-panel'), guide = panel.locator('.login-guide');
    await expect(guide.getByRole('link', { name: '打开 org-app 的 GitHub App 设置', exact: true })).toHaveAttribute('href', 'https://github.com/organizations/fixture-org/settings/apps/org-app');
    await expect(guide).toContainText('这个 App 属于组织 fixture-org'); await expect(panel).toContainText('GitHub 显示 404 时');
    await expect(guide).toContainText('它不是 App ID（这个 App 的 App ID 是 123）');
    await expect(guide.locator(':scope > li > strong')).toHaveText(['General：填写 Client ID 和登录回调','Credentials：填写 Client secret','Permissions & events：确认组织身份验证权限','回到本页：保存并启用']);
    await expect(guide.locator(':scope > li').nth(0).getByLabel('Client ID',{exact:true})).toBeVisible();
    await expect(guide.locator(':scope > li').nth(1).getByLabel('Client secret（只保存，不回读）',{exact:true})).toBeVisible();
    await expect(guide.locator(':scope > li').nth(1)).toContainText('左侧切换到「Credentials」');await expect(guide).not.toContainText('在同一页');
    // The wizard-created App returned reusable credentials: the page says so instead of asking for a new secret.
    await expect(guide).toContainText('不用再生成'); await expect(page.getByLabel('Client ID', { exact: true })).toHaveValue('Iv1.org-app');
    await expect(guide.locator('.github-login-callback')).toHaveText('https://bot.invalid/auth/github/callback');
    for (const text of ['https://bot.invalid/onboarding/github/setup', '/onboarding/github/callback', 'https://bot.invalid/hooks/github/<account_id>/<endpoint_id>', '不能互相替代'])
      await expect(panel).toContainText(text);
    await expect(panel).not.toContainText('8792'); await expect(panel).not.toContainText('控制台访问地址');
    mkdirSync('.tmp/github-login-guide', { recursive: true });
    await page.screenshot({ path: '.tmp/github-login-guide/organization-app-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/github-login-guide/organization-app-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    // A personal App links to its owner's settings; a legacy selection is repaired on this page.
    const saved = onboarding.saved('app');
    onboarding.save('app', { ...saved, owner: 'octo', owner_type: 'User', settings_url: 'https://github.com/settings/apps/org-app' }); await page.reload();
    await expect(guide.getByRole('link', { name: '打开 org-app 的 GitHub App 设置', exact: true })).toHaveAttribute('href', 'https://github.com/settings/apps/org-app');
    await expect(guide).toContainText('这个 App 属于个人账号 octo');
    const { owner, owner_type, settings_url, ...unknown } = saved; onboarding.save('app', unknown); await page.reload();
    await expect(guide.getByRole('link',{name:'打开 org-app 的 GitHub App 设置',exact:true})).toHaveAttribute('href',saved.settings_url);
    expect(onboarding.saved('app').owner).toBe('fixture-org');await expect(page).toHaveURL(/#\/settings\/onboarding\/2$/);
    await expect(guide).not.toContainText('重新检查安装');await expect(panel).not.toContainText('不提供直达链接');
    await page.screenshot({ path: '.tmp/github-login-guide/legacy-owner-recovered.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('旧 App 在登录步骤自动补查，失败可原地重试，异步刷新保留已填写的 Client ID 和 secret',async({page})=>{
  const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}),calls=[];
  let onboarding,failed=true,started,release;
  const h=await harness(undefined,undefined,store=>({onboarding:onboarding=new Onboarding(store,{fetcher:async raw=>{
    calls.push(new URL(raw).pathname);if(failed)return new Response('{}',{status:503});
    started();await new Promise(resolve=>{release=resolve;});
    return new Response(JSON.stringify({id:123,slug:'legacy-app',owner:{login:'fixture',type:'Organization'}}));
  }})}));
  try{
    const{admin,password}=await setup(h),a=await account(admin,{type:'github_app',app_id:'123',private_key:pem,token:undefined});
    onboarding.save('app',{account_id:a.id,app_id:'123',slug:'legacy-app',installations:2});
    await localLogin(page,h.admin,password);await page.goto(h.admin+'/#/settings/onboarding/2');
    const panel=page.locator('#onboarding-panel'),client=page.getByLabel('Client ID',{exact:true}),secret=page.getByLabel('Client secret（只保存，不回读）',{exact:true});
    await expect(panel.getByRole('status')).toContainText('暂时无法读取 App 信息');
    await expect(panel.locator('.login-guide').getByRole('link')).toHaveCount(0);
    await client.fill('Iv1.draft');const typed=testPassword();await secret.fill(typed);
    failed=false;const ready=new Promise(resolve=>{started=resolve;});await page.getByRole('button',{name:'刷新 App 信息',exact:true}).click();await ready;
    await client.fill('Iv1.kept-draft');release();
    await expect(panel.getByRole('link',{name:'打开 legacy-app 的 GitHub App 设置',exact:true})).toHaveAttribute('href','https://github.com/organizations/fixture/settings/apps/legacy-app');
    await expect(client).toHaveValue('Iv1.kept-draft');await expect(secret).toHaveValue(typed);
    await expect(page).toHaveURL(/#\/settings\/onboarding\/2$/);expect(calls).toEqual(['/app','/app']);
    await expect(panel).not.toContainText('重新检查安装');
    await page.getByLabel('启用 GitHub 账号登录',{exact:true}).check();await page.getByRole('button',{name:'保存登录配置',exact:true}).click();
    await expect(page.locator('#message')).toContainText('GitHub 登录已启用');await expect(secret).toHaveValue('');
    const redirect=await fetch(h.admin+'/auth/github/start',{redirect:'manual'});expect(new URL(redirect.headers.get('location')).searchParams.get('client_id')).toBe('Iv1.kept-draft');
    mkdirSync('.tmp/github-login-guide',{recursive:true});await page.screenshot({path:'.tmp/github-login-guide/in-place-retry-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'.tmp/github-login-guide/in-place-retry-mobile.png',fullPage:true});
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});

test('升级前为独立控制台地址保存的登录配置，页面提示改用统一入口的 Callback URL，保存一次后提示消失', async ({ page }) => {
  const h = await harness(), { password } = await setup(h);
  try {
    h.store.run("INSERT INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://bot.invalid', checked_at: new Date().toISOString() }));
    h.store.run('INSERT INTO settings VALUES(?,?)', 'identity.github_login', h.store.secrets.seal({ enabled: true, client_id: 'Iv1.legacy', client_secret: testPassword(),
      admin_origin: 'https://console.invalid', account_id: null }, 'identity.github_login'));
    await localLogin(page, h.admin, password); await page.goto(h.admin + '/#/settings/onboarding/2');
    const warning = page.locator('#onboarding-panel .endpoint-warning');
    await expect(warning).toContainText('从 https://console.invalid/auth/github/callback 改为 https://bot.invalid/auth/github/callback');
    await expect(page.getByLabel('启用 GitHub 账号登录', { exact: true })).toBeChecked();
    mkdirSync('.tmp/github-login-guide', { recursive: true });
    await page.screenshot({ path: '.tmp/github-login-guide/migrated-callback.png', fullPage: true });
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('GitHub 登录已启用'); await expect(warning).toHaveCount(0);
    expect(new URL((await fetch(h.admin + '/auth/github/start', { redirect: 'manual' })).headers.get('location')).searchParams.get('redirect_uri')).toBe('https://bot.invalid/auth/github/callback');
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

for (const returned of [true, false]) test(`已有登录配置后新建 App，${returned ? '带出新凭据' : '明确要求新凭据'}并在保存后切换`, async ({ page }) => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  let onboarding;
  const h = await harness(undefined, undefined, store => ({ onboarding: onboarding = new Onboarding(store, { fetcher: async () => new Response(JSON.stringify({
    id: 123, slug: 'new-app', pem, webhook_secret: testPassword(), ...(returned ? { client_id: 'Iv1.new-app', client_secret: testPassword() } : {}),
  })) }) }));
  try {
    const { admin, password } = await setup(h); onboarding.save('public', { origin: 'https://hooks.invalid' });
    await admin('/api/onboarding/github-login', 'PUT', { enabled: true, client_id: 'Iv1.old-app', client_secret: testPassword() });
    const manifest = await admin('/api/onboarding/manifest', 'POST', { organization: 'fixture', name: 'new-app' });
    await localLogin(page, h.admin, password);
    await page.goto(h.admin + '/onboarding/github/callback?code=manifest-code&state=' + new URL(manifest.value.create_url).searchParams.get('state'));
    await expect(page.locator('#onboarding-panel')).toContainText('所选 App：new-app');
    await expect(page.locator('#onboarding-panel')).toContainText('保存并启用后才会切换');
    const client = page.getByLabel('Client ID', { exact: true }), enabled = page.getByLabel('启用 GitHub 账号登录', { exact: true });
    await expect(client).toHaveValue(returned ? 'Iv1.new-app' : ''); await expect(enabled).not.toBeChecked();
    await expect(page.getByLabel('Client secret（只保存，不回读）', { exact: true })).toHaveValue('');
    const activeClient = async () => new URL((await fetch(h.admin + '/auth/github/start', { redirect: 'manual' })).headers.get('location')).searchParams.get('client_id');
    expect(await activeClient()).toBe('Iv1.old-app'); await enabled.check();
    if (!returned) {
      await expect(page.locator('#onboarding-panel')).toContainText('不能沿用旧 App 的值');
      expect(await client.evaluate(el => el.validity.valueMissing)).toBe(true);
      await client.fill('Iv1.new-app'); await page.getByLabel('Client secret（只保存，不回读）', { exact: true }).fill(testPassword());
    }
    mkdirSync('.tmp/onboarding-settings-fix', { recursive: true });
    await page.screenshot({ path: `.tmp/onboarding-settings-fix/new-app-${returned ? 'saved' : 'manual'}.png`, fullPage: true });
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('GitHub 登录已启用'); expect(await activeClient()).toBe('Iv1.new-app');
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
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
    await page.locator('#logout').click(); await page.getByRole('link', { name: '使用 GitHub 登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '当前角色与授权来源', exact: true })).toBeVisible();
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
    await page.locator('#logout').click(); await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.goto(f.h.admin + '/#/settings/onboarding/2');
    await page.getByLabel('清除已保存的 Client secret，并停用 GitHub 登录', { exact: true }).check();
    await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
    await expect(page.locator('#message')).toContainText('当前使用本地账号登录');
    expect((await f.admin('/api/onboarding')).value.github_login.secret_configured).toBe(false);
    await page.locator('#logout').click(); await expect(page.getByRole('link', { name: '使用 GitHub 登录', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
