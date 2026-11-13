import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

async function login(page,h,password,username='administrator',hash='#/projects') {
  await page.goto(h.admin+'/'+hash);
  await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
}

test('four primary destinations and a compact More page preserve access at every breakpoint', async ({ page }) => {
  const h = await harness(), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    await login(page, h, password);
    const out = '.tmp/console-shell'; mkdirSync(out, { recursive: true });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await page.goto(h.admin + '/#/more');
      await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
      const more = page.locator('#console-page');
      await expect(more.locator('a[href="#/projects"], a[href="#/board"], a[href="#/preferences"]')).toHaveCount(0);
      await expect(more.locator('a[href^="#/projects/"]')).toHaveCount(0);
      await expect(more.locator('a[href^="#/settings"]')).toHaveCount(1);
      await expect(more.locator('a[href="#/identity"]')).toHaveCount(1);
      if (width >= 768) {
        await expect(page.locator('#console-sidebar')).toBeVisible();
        await expect(page.locator('#tabs button')).toHaveText(['项目', '管理对话', '看板', '更多功能']);
        await expect(more.locator('a[href="#/management"]')).toHaveCount(0);
        await expect(page.locator('#tabs [data-tab=more]')).toHaveAttribute('aria-current', 'page');
      } else {
        await expect(page.locator('#console-sidebar')).toBeHidden();
        await expect(page.locator('#console-mobile-nav a')).toHaveText(['⌂总览', '▤任务', '◷待处理', '⋯更多']);
        await expect(more.locator('a[href="#/management"]')).toBeVisible();
        await expect(more.locator('a[href^="#/inbox"]')).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${out}/more-${width}.png`, fullPage: true });
    }
    // Resizing the open page updates only the destinations supplied by the primary navigation.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#console-page a[href="#/management"]')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 360 });
    await expect(page.locator('#console-page a[href="#/management"]')).toHaveCount(0);
    await page.locator('#tabs [data-tab=more]').focus(); await expect(page.locator('#tabs [data-tab=more]')).toBeInViewport();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#console-page a[href="#/conversations"]').click();
    await expect(page.locator('#console-area')).toHaveText('工作区');
    await expect(page.locator('#console-secondary-nav')).toBeHidden();
    await page.goBack();
    await page.locator('#console-page a[href="#/identity"]').click();
    await expect(page.locator('#identity-panel')).toBeVisible();
    await expect(page.locator('#console-secondary-nav a[href="#/conversations"]')).toHaveCount(0);
    await page.goto(h.admin + '/#/preferences');
    await expect(page.locator('#identity-panel')).toBeVisible();
    await expect(page.locator('#tabs [data-tab=more]')).toHaveAttribute('aria-current', 'page');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('attention uses real tasks, does not count queued work, and handles failure, retry and details',async({page})=>{
  const h=await harness();
  try {
    const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
    for(const [id,status,text]of [['blocked','waiting_configuration','补齐模型配置'],['queued','queued','自动排队任务']])
      h.store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,phase) VALUES(?,?,?,?,?,?)',id,'101','review.issue',status,text,'model');
    await page.setViewportSize({width:390,height:844});await login(page,h,password,'administrator','#/inbox/101');
    await expect(page.locator('.console-attention-row')).toHaveCount(1);await expect(page.locator('.console-attention-row')).toContainText('补齐模型配置');
    await page.getByRole('button',{name:'查看任务',exact:true}).click();await expect(page.locator('#task-view')).toBeVisible();
    await page.keyboard.press('Escape');await expect(page.locator('#task-view')).not.toBeVisible();
    await expect(page.getByRole('button',{name:'查看任务',exact:true})).toBeFocused();
    await page.route('**/api/tasks?attention=*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture_unavailable'})}));
    await page.getByRole('button',{name:'刷新待处理',exact:true}).click();
    await expect(page.getByRole('heading',{name:'待处理事项未能读取'})).toBeVisible();
    await expect(page.locator('.console-state')).toContainText('尚不能判断');
    await page.unroute('**/api/tasks?attention=*');
    await page.getByRole('button',{name:'重新加载',exact:true}).click();await expect(page.locator('.console-attention-row')).toHaveCount(1);
    mkdirSync('.tmp/console-shell',{recursive:true});await page.screenshot({path:'.tmp/console-shell/inbox-390.png',fullPage:true});
    h.store.run("UPDATE tasks SET status='succeeded' WHERE id='blocked'");
    await page.getByRole('button',{name:'刷新待处理',exact:true}).click();
    await expect(page.locator('.console-state')).toContainText('不代表服务、CI 或其他任务已经全部成功');
  }finally{await h.stop();}
});

test('permissions, in-flight navigation, keyboard and history keep their boundaries',async({page})=>{
  const h=await harness();
  try {
    const {admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');
    const password=testPassword();await admin('/api/users','POST',{username:'member-shell',password,repository_ids:['101']});
    await page.setViewportSize({width:390,height:844});await login(page,h,password,'member-shell','#/more');
    await expect(page.getByRole('heading',{name:'全局设置',exact:true})).toHaveCount(0);
    await expect(page.getByRole('link',{name:'飞书连接',exact:false})).toHaveCount(0);
    await page.setViewportSize({width:1440,height:900});
    await expect(page.locator('#tabs button')).toHaveCount(4);
    await expect(page.locator('#console-page a[href="#/settings"]')).toHaveCount(0);
    await expect(page.locator('#console-page a[href="#/settings/storage"]')).toBeVisible();
    await page.setViewportSize({width:390,height:844});
    expect(await page.locator('#console-project option').allTextContents()).not.toContain('202');
    await page.goto(h.admin+'/#/settings/users');await expect(page.locator('#settings-panel')).toBeHidden();
    await page.goto(h.admin+'/#/inbox/202');await expect(page.locator('.console-state')).toContainText('403');
    let release;const gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/tasks?attention=*',async route=>{await gate;await route.continue();});
    await page.goto(h.admin+'/#/inbox');await expect(page.getByRole('heading',{name:'正在读取待处理事项'})).toBeVisible();
    await page.locator('#console-mobile-nav').getByRole('link',{name:'更多',exact:true}).click();
    release();await expect(page.getByRole('heading',{name:'更多功能',exact:true})).toBeVisible();
    await expect(page.locator('.console-attention-row')).toHaveCount(0);
    await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:320,height:500});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.keyboard.press('Tab');
    await page.getByRole('link',{name:'身份与权限',exact:false}).click();await expect(page.locator('#identity-panel')).toBeVisible();
    await page.goBack();await expect(page.getByRole('heading',{name:'更多功能',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.locator('#console-mobile-nav')).toBeHidden();await expect(page.locator('#console-sidebar')).toBeHidden();
  }finally{await h.stop();}
});
