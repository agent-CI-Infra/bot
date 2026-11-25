import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';

const out='.tmp/project-navigation', work=[['overview','项目总览'],['inbox','待处理'],['management','管理助手'],['release','发版本'],['knowledge','项目知识'],['activity','运行状态']];
async function login(page,h,user,password,hash='#/projects') {
  await page.goto(h.admin+'/'+hash);await page.getByLabel('用户名',{exact:true}).fill(user);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#rows .row')).toHaveCount(1);
}
async function hit(locator) {await expect(locator).toBeInViewport({ratio:1});expect(await locator.evaluate(n=>{const r=n.getBoundingClientRect();return r.height>=44&&r.width>=44&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);}
for(const role of ['super','member']) test(`${role}: sidebar, phone destinations and settings follow the address scope`,async({page})=>{
  test.setTimeout(90000);const h=await harness(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');const memberPassword=testPassword();await admin('/api/users','POST',{username:'navigation-member',password:memberPassword,repository_ids:['101']});
    await login(page,h,role==='super'?'administrator':'navigation-member',role==='super'?password:memberPassword);
    // #1369: both roles see the same entries; the pinned 全局设置 below is the only difference.
    const all=[['projects','项目'],['inbox','待处理'],['management','管理助手'],['costs','用量与成本']];
    const project=[...work,['costs','用量与成本'],['basic','项目设置']];
    for(const scope of ['all','101']) {
      if(scope==='101'){await switchConsoleProject(page,'101');await expect(page.locator('.workspace-overview')).toBeVisible();}
      const entries=scope==='all'?all:project;
      for(const width of [1440,1024,768]) {
        await page.setViewportSize({width,height:1000});
        await expect(page.locator('.console-primary-nav a')).toHaveText(entries.map(([,name])=>name));
        expect(await page.locator('.console-primary-nav a').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')))).toEqual(entries.map(([key])=>scope==='all'?'#/'+key:'#/projects/101/'+key));
        await expect(page.locator('.console-settings-nav a')).toHaveText(role==='super'?['个人设置','全局设置']:['个人设置']);
        await expect(page.locator('#tabs [aria-current=page]')).toHaveText(scope==='all'?'项目':'项目总览');
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      }
      for(const width of [390,320]) {
        await page.setViewportSize({width,height:844});const bar=page.locator('#console-mobile-nav');
        // #1369: the bar carries the sidebar's all-projects pages for every role, 用量与成本 in the current scope.
        await expect(bar.locator('a')).toHaveText(['项目','待处理','助手','用量与成本']);for(const a of await bar.locator('a').all())await hit(a);
        const cost=bar.getByRole('link',{name:'用量与成本',exact:true});await expect(cost).toHaveAttribute('href',scope==='all'?'#/costs':'#/projects/101/costs');
        await Promise.all([page.waitForResponse(r=>r.url().includes('/api/costs?')&&r.status()===200),cost.click()]);
        await expect(page.locator('#costs-panel')).toBeVisible();await expect(cost).toHaveAttribute('aria-current','page');
        const picker=page.getByLabel('当前页面',{exact:true});
        if(scope==='101') {
          await hit(picker);await expect(picker).toHaveValue('#/projects/101/costs');
          await expect(picker.locator('optgroup[label="项目工作"] option')).toHaveText([...work.map(([,name])=>name),'用量与成本']);
          await expect(picker.locator('optgroup[label="设置"] option')).toHaveText(['基本设置','监听与触发','机器配置','角色','模型','定时任务与通知','外部执行','成员']);
          await picker.selectOption('#/projects/101/basic');await expect(page.getByRole('button',{name:'刷新项目设置',exact:true})).toBeVisible();
          await hit(picker);await picker.selectOption('#/projects/101/inbox');await expect(page.locator('.console-inbox')).toBeVisible();
          await hit(picker);await expect(picker).toHaveValue('#/projects/101/inbox');
        }else await expect(picker).toBeHidden();
        await bar.getByRole('link',{name:'项目',exact:true}).click();await expect(page).toHaveURL(scope==='all'?/#\/projects$/:/#\/projects\/101\/overview$/);await expect(scope==='all'?page.locator('#rows .row'):page.locator('.workspace-overview')).toBeVisible();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      }
    }
    await page.setViewportSize({width:1440,height:1000});await page.locator('#tabs').getByRole('link',{name:'待处理',exact:true}).click();await expect(page).toHaveURL(/#\/projects\/101\/inbox$/);await expect(page.locator('.console-inbox')).toBeVisible();
    await page.locator('#tabs').getByRole('link',{name:'项目设置',exact:true}).click();await expect(page.getByRole('button',{name:'刷新项目设置',exact:true})).toBeVisible();
    await page.locator('#console-secondary-nav').getByRole('link',{name:'模型',exact:true}).click();await expect(page.locator('#tabs [aria-current=page]')).toHaveText('项目设置');
    await page.setViewportSize({width:1440,height:600});const primary=page.locator('.console-primary-nav'),pinned=page.locator('.console-settings-nav');
    if(role==='super') {expect(await primary.evaluate(n=>n.scrollHeight>n.clientHeight)).toBe(true);await primary.evaluate(n=>n.scrollTop=n.scrollHeight);await hit(pinned.getByRole('link',{name:'个人设置',exact:true}));await pinned.getByRole('link',{name:'个人设置',exact:true}).click();await expect(page.getByRole('heading',{name:'身份与权限',exact:true})).toBeVisible();await expect(page.locator('.console-primary-nav a')).toHaveText(project.map(([,name])=>name));}
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:width===1440?1000:844});
      for(const [key,caption] of [['release','发版本'],['knowledge','项目知识'],['activity','运行状态']]) {
        if(width>=768)await page.locator('#tabs').getByRole('link',{name:caption,exact:true}).click();
        else await page.getByLabel('当前页面',{exact:true}).selectOption('#/projects/101/'+key);
        await expect(page.locator('#console-project-header .project-head h1')).toHaveText(caption);
        await expect(page.locator('#project-page .project-content > .console-state-loading')).toHaveCount(0);
      }
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:'English',exact:true}).click();
    await expect(page.locator('.console-primary-nav a')).toHaveText(['Project overview','Needs attention','Management assistant','Releases','Project knowledge','Activity','Usage & costs','Project settings']);
    await expect(page.locator('.console-settings-nav')).toHaveAccessibleName('Settings and administration');await expect(page.locator('.console-settings-nav a')).toHaveText(['Personal settings',...(role==='super'?['Global settings']:[])]);
    await page.getByRole('button',{name:'中文',exact:true}).click();
    await expect(page.locator('.console-primary-nav a').first()).toHaveText('项目总览');
    await expect(page.locator('.console-settings-nav')).toHaveAccessibleName('设置与管理');await expect(page.locator('.console-settings-nav a')).toHaveText(['个人设置',...(role==='super'?['全局设置']:[])]);
    expect(errors).toEqual([]);
  }finally{await h.stop();}
});

test('retired menu replaces its history entry and task detail resolves project links without an active item',async({page})=>{
 const h=await harness();try{const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await login(page,h,'administrator',password);
 await page.evaluate(()=>{location.hash='#/projects/101/menu';});await expect(page).toHaveURL(/#\/projects\/101\/overview$/);await expect(page.locator('.workspace-overview')).toBeVisible();await expect(page.getByText('项目入口',{exact:false})).toHaveCount(0);await page.goBack();await expect(page).toHaveURL(/#\/projects$/);
 h.store.run('INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES(?,?,?,?,?)','nav-task','101','review.issue','queued','Navigation detail');await page.goto(h.admin+'/#/tasks/nav-task');await expect(page.locator('#task-title')).toHaveText('Navigation detail');await expect(page.locator('.console-primary-nav a').first()).toHaveText('项目总览');await expect(page.locator('#tabs [aria-current=page]')).toHaveCount(0);
 }finally{await h.stop();}
});
