import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

async function login(page,h,password,username='administrator',hash='#/projects') {
  await page.goto(h.admin+'/'+hash);
  await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
}

test('shared desktop rail and mobile navigation expose real destinations across breakpoints',async({page})=>{
  const h=await harness(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
    await login(page,h,password);
    const out='.tmp/console-shell';mkdirSync(out,{recursive:true});
    for(const width of [320,390,768,1024,1440,1920]) {
      await page.setViewportSize({width,height:900});await page.goto(h.admin+'/#/more');
      await expect(page.getByRole('heading',{name:'更多功能',exact:true})).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(width>=768) {
        await expect(page.locator('#console-sidebar')).toBeVisible();
        await expect(page.locator('#console-sidebar').getByRole('link',{name:'更多功能',exact:true})).toHaveCount(0);
        const footer=await page.locator('.console-settings-nav').boundingBox();
        expect(footer.y+footer.height).toBeLessThanOrEqual(900);
        expect(footer.y+footer.height).toBeGreaterThan(870);
      } else await expect(page.locator('#console-sidebar')).toBeHidden();
      if(width<768){
        await expect(page.locator('#console-mobile-nav')).toBeVisible();
        await expect(page.locator('#console-mobile-nav a')).toHaveText(['⌂总览','▤任务','◷待处理','⋯更多']);
        const boxes=await page.locator('#console-mobile-nav a').evaluateAll(nodes=>nodes.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
        expect(boxes.every(b=>b.width>=44&&b.height>=44)).toBe(true);
      }
      await page.screenshot({path:`${out}/more-${width}.png`,fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1000});await page.goto(h.admin+'/#/projects/101/roles');
    for(const name of ['身份与权限','Webhook 投递','外部执行端']) await expect(page.locator('#tabs').getByRole('button',{name,exact:true})).toBeVisible();
    await expect(page.locator('#console-sidebar .project-nav')).toContainText('项目知识');
    await page.locator('#console-sidebar .project-nav').getByRole('link',{name:'模型',exact:true}).click();
    await expect(page).toHaveURL(/#\/projects\/101\/model$/);await page.reload();
    await expect(page.locator('#console-sidebar .project-nav [aria-current=page]')).toHaveText('模型');
    await page.setViewportSize({width:390,height:844});
    await page.getByLabel('当前页面',{exact:true}).selectOption('#/projects/101/knowledge');
    await expect(page).toHaveURL(/#\/projects\/101\/knowledge$/);
    await page.locator('#console-mobile-nav').getByRole('link',{name:'更多',exact:true}).click();
    await expect(page.locator('.console-group').filter({has:page.getByRole('heading',{name:'设置',exact:true})})).toContainText('机器配置');
    await expect(page.getByRole('link',{name:'公网接入',exact:false})).toBeVisible();
    // A short desktop keeps settings visible while a long category list scrolls above them.
    await page.setViewportSize({width:1440,height:500});await page.goto(h.admin+'/#/settings/users');
    await expect(page.locator('#settings-panel')).toContainText('administrator');
    const primary=page.locator('.console-primary-nav'), settings=page.locator('.console-settings-nav');
    expect(await primary.evaluate(node=>node.scrollHeight>node.clientHeight)).toBe(true);
    await primary.evaluate(node=>node.scrollTop=node.scrollHeight);
    const mainBox=await primary.boundingBox(), settingsBox=await settings.boundingBox();
    expect(mainBox.y+mainBox.height).toBeLessThanOrEqual(settingsBox.y);
    expect(settingsBox.y+settingsBox.height).toBeLessThanOrEqual(500);
    await settings.getByRole('button',{name:'设置',exact:true}).click();
    await expect(page.getByRole('heading',{name:'设置',exact:true})).toBeVisible();
    await expect(settings.getByRole('button',{name:'设置',exact:true})).toHaveAttribute('aria-current','page');
    await page.screenshot({path:`${out}/settings-footer-short-desktop.png`,fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:`${out}/settings-footer-desktop.png`,fullPage:true});
    expect(errors).toEqual([]);
  } finally {await h.stop();}
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
    await expect(page.locator('.console-settings-nav').getByRole('button',{name:'设置',exact:true})).toBeVisible();
    await expect(page.locator('.console-settings-nav').getByRole('button',{name:'全局设置',exact:true})).toBeHidden();
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
