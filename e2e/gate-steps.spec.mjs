import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { gateFixture, writes, branchOf } from '../test/gate-onboarding-fixtures.mjs';
const button=(dialog,name)=>dialog.getByRole('button',{name,exact:true});
async function open(page,f){
  f.state.repos['octo/hello'].queue='ruleset';await page.goto(f.h.admin + '/#/settings/projects');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(f.password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.locator('.global-project-row[data-repository-id="101"]').getByRole('button',{name:'接入门禁',exact:true}).click();return page.locator('#quickstart-view');
}
async function ready(page,f){
  const dialog=await open(page,f);await button(dialog,'开始适配').click();
  await expect.poll(()=>f.h.store.get("SELECT count(*) n FROM tasks WHERE kind='gate.onboarding' AND status='queued'").n).toBe(1);await f.turn();await expect(dialog.locator('#gate-onboarding-compose')).toBeVisible();await expect(dialog.locator('#gate-onboarding-plan-title')).toContainText('门禁方案 · 第');return dialog;
}
async function turn(f){await expect.poll(()=>f.h.store.get("SELECT count(*) n FROM tasks WHERE kind='gate.onboarding' AND status='queued'").n).toBe(1);await f.turn();}
const step=(dialog,name)=>dialog.getByRole('tab',{name,exact:true}).click();

test('gate plans, actual diffs and verification sources stay usable through desktop and mobile steps',async({page})=>{
  test.setTimeout(60000);const cleanup=[],f=await gateFixture({after:fn=>cleanup.push(fn)}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    const dialog=await ready(page,f);await expect(dialog.locator('#gate-onboarding-preview')).toHaveAttribute('open','');await expect(dialog.locator('#gate-onboarding-files')).toContainText('.github/ci-gates.json');
    await expect(dialog.locator('#gate-onboarding-evidence')).toContainText('不代表 CI 或试跑通过');await expect(dialog.locator('.gate-validation-lanes')).toContainText('未配置 · 不适用');expect(writes(f.state)).toEqual([]);
    mkdirSync('.tmp/gate-onboarding-233/previews',{recursive:true});for(const width of [320,390,768,1024,1440,1920]){
      await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),String(width)).toBe(true);expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1),String(width)).toBe(true);
      if(width<=860){await step(dialog,'文件');await expect(dialog.locator('#gate-onboarding-files')).toBeVisible();await step(dialog,'验证');await expect(dialog.locator('#gate-onboarding-evidence')).toBeVisible();await step(dialog,'确认');await expect(dialog.locator('#gate-onboarding-summary')).toContainText((await f.session(f.gate.latest('101').id)).facts.head_sha);await step(dialog,'方案');}
      if([390,1440].includes(width))await page.screenshot({path:`.tmp/gate-onboarding-233/previews/${width}.png`,fullPage:true});
    }
    await page.setViewportSize({width:390,height:844});await step(dialog,'确认');await button(dialog,'确认并创建门禁 PR').click();await expect(dialog.getByRole('link',{name:'查看已创建的 PR',exact:true})).toBeVisible();expect(branchOf(f.state).files['.github/workflows/ci.yml']).toContain('gate:');expect(errors).toEqual([]);
  }finally{for(const close of cleanup.reverse())await close();}
});

test('only the current form preview can enable confirmation, with a read-only retry after failure',async({page})=>{
  test.setTimeout(60000);const cleanup=[],f=await gateFixture({after:fn=>cleanup.push(fn)});let release;
  try{
    const dialog=await ready(page,f);await page.setViewportSize({width:390,height:844});let entered;const firstSeen=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});let fail=false;
    await page.route('**/api/gate-onboarding/*/preview',async route=>{
      const plan=route.request().postDataJSON().plan;
      if(plan.install.includes('printf old-preview-only')){const response=await route.fetch();entered();await gate;await route.fulfill({response});}
      else if(fail)await route.fulfill({status:503,json:{error:'fixture_preview_down'}});else await route.continue();
    });
    const install=dialog.locator('textarea[name=install]');await install.fill('printf old-preview-only');await firstSeen;await install.fill('printf current-preview');await step(dialog,'文件');await expect(dialog.locator('#gate-onboarding-files')).toContainText('printf current-preview');
    const finished=page.waitForEvent('requestfinished',request=>request.url().endsWith('/preview')&&request.postData()?.includes('old-preview-only'));release();await finished;await page.evaluate(()=>new Promise(requestAnimationFrame));await expect(dialog.locator('#gate-onboarding-files')).not.toContainText('old-preview-only');
    fail=true;await step(dialog,'方案');await install.fill('printf retry-preview');await step(dialog,'文件');await expect(dialog.locator('#gate-onboarding-error')).toContainText('fixture_preview_down');await expect(dialog.locator('#gate-onboarding-confirm')).toBeDisabled();await expect(dialog.locator('#gate-onboarding-files')).not.toContainText('current-preview');expect(writes(f.state)).toEqual([]);
    fail=false;await button(dialog,'重新读取文件预览').click();await expect(dialog.locator('#gate-onboarding-files')).toContainText('printf retry-preview');await step(dialog,'确认');await button(dialog,'确认并创建门禁 PR').click();await expect(dialog.getByRole('link',{name:'查看已创建的 PR',exact:true})).toBeVisible();expect(branchOf(f.state).files['.github/workflows/ci.yml']).toContain('printf retry-preview');
  }finally{release?.();for(const close of cleanup.reverse())await close();}
});

test('a message returning after close and resume cannot reset the new composer or session',async({page})=>{
  test.setTimeout(60000);const cleanup=[],f=await gateFixture({after:fn=>cleanup.push(fn)});let release;
  try{
    const dialog=await ready(page,f),gate=new Promise(resolve=>{release=resolve;});let entered;const seen=new Promise(resolve=>{entered=resolve;});
    await page.route('**/api/gate-onboarding/*/messages',async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});});
    await dialog.getByLabel('发给 agent',{exact:true}).fill('old submitted message');await button(dialog,'发送').click();await seen;await button(dialog,'关闭').click();
    await page.locator('.global-project-row[data-repository-id="101"]').getByRole('button',{name:'接入门禁',exact:true}).click();await button(dialog,'继续上次的对话').click();await turn(f);await expect(dialog.getByLabel('发给 agent',{exact:true})).toBeVisible();await dialog.getByLabel('发给 agent',{exact:true}).fill('keep this new unsent message');
    const finished=page.waitForEvent('requestfinished',request=>request.url().endsWith('/messages'));release();await finished;await page.evaluate(()=>new Promise(requestAnimationFrame));await expect(dialog.getByLabel('发给 agent',{exact:true})).toHaveValue('keep this new unsent message');expect(writes(f.state)).toEqual([]);
  }finally{release?.();for(const close of cleanup.reverse())await close();}
});

test('withdrawn access removes the old plan and prevents an older preview from restoring it',async({page})=>{
  test.setTimeout(60000);const cleanup=[],f=await gateFixture({after:fn=>cleanup.push(fn)});let release;
  try{
    const dialog=await ready(page,f);let entered;const seen=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/gate-onboarding/*/preview',async route=>{
      if(route.request().postDataJSON().plan.install.includes('printf held-preview')){const response=await route.fetch();entered();await gate;await route.fulfill({response});}
      else await route.fulfill({status:403,json:{error:'authorization_changed'}});
    });
    await dialog.locator('textarea[name=install]').fill('printf held-preview');await seen;await dialog.locator('textarea[name=install]').fill('printf revoke-now');await expect(dialog.locator('#gate-onboarding-error')).toContainText('访问权限已失效');release();await page.evaluate(()=>new Promise(requestAnimationFrame));
    await expect(dialog.locator('#gate-onboarding-plan')).toBeHidden();await expect(dialog.locator('#gate-onboarding-files')).toBeEmpty();await expect(dialog.locator('#gate-onboarding-messages')).toBeEmpty();await expect(dialog.locator('textarea[name=install]')).toHaveValue('');expect(writes(f.state)).toEqual([]);
  }finally{release?.();for(const close of cleanup.reverse())await close();}
});

test('a changed preview basis stays blocked until session and file reads are renewed',async({page})=>{
  const cleanup=[],f=await gateFixture({after:fn=>cleanup.push(fn)});
  try{
    const dialog=await ready(page,f);let mismatch=true;
    await page.route('**/api/gate-onboarding/*/preview',async route=>{const response=await route.fetch(),data=await response.json();await route.fulfill({json:mismatch?{...data,basis:{...data.basis,revision:data.basis.revision+1}}:data});});
    await dialog.locator('textarea[name=install]').fill('printf basis-check');await expect(dialog.locator('#gate-onboarding-error')).toContainText('读取依据已变化');await expect(dialog.locator('#gate-onboarding-confirm')).toBeDisabled();expect(writes(f.state)).toEqual([]);
    mismatch=false;await button(dialog,'重新读取会话').click();await expect(dialog.locator('#gate-onboarding-files')).toContainText('printf basis-check');await expect(dialog.locator('#gate-onboarding-error')).toBeEmpty();await expect(dialog.locator('#gate-onboarding-confirm')).toBeEnabled();expect(writes(f.state)).toEqual([]);
  }finally{for(const close of cleanup.reverse())await close();}
});

test('an unavailable initial read has a read-only retry and never creates a session',async({page})=>{
  const cleanup=[],f=await gateFixture({after:fn=>cleanup.push(fn)});let failed=false;
  try{
    await page.route('**/api/projects/101/gate-onboarding',async route=>{if(route.request().method()==='GET'&&!failed){failed=true;await route.fulfill({status:503,json:{error:'fixture_initial_read_down'}});}else await route.continue();});
    const dialog=await open(page,f);await expect(dialog.locator('#gate-onboarding-error')).toContainText('fixture_initial_read_down');await expect(button(dialog,'开始适配')).toBeDisabled();await button(dialog,'重新读取会话').click();await expect(button(dialog,'开始适配')).toBeEnabled();expect(f.h.store.get('SELECT count(*) n FROM gate_onboarding_sessions').n).toBe(0);expect(writes(f.state)).toEqual([]);
  }finally{for(const close of cleanup.reverse())await close();}
});
