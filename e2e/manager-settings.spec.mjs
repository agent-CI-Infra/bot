import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { consoleSave } from './console-save.mjs';

for (const role of ['super_admin','project_admin']) test(`${role} finds one Manager settings page and event choices survive unrelated saves`,async({page})=>{
  test.setTimeout(90000);
  const h=await harness(undefined,undefined,store=>({engine:new TaskEngine(store,{call:async()=>null})})),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
    const memberPassword=testPassword();
    await admin('/api/users','POST',{username:'project-manager',password:memberPassword,repository_ids:['101']});
    // Emulate a saved pre-upgrade project whose duplicate switches were all closed.
    const {configuration}= (await admin('/api/repositories/101/roles')).value;
    h.store.run("INSERT INTO settings VALUES('roles:101',?)",JSON.stringify({...configuration,enabled:false,controller:{role:'manager',entries:{development:false,request:false,review:false,actions:false}}}));
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(h.admin+'/#/projects/101/basic');
    await page.getByLabel('用户名',{exact:true}).fill(role==='super_admin'?'administrator':'project-manager');
    await page.getByLabel('密码',{exact:true}).fill(role==='super_admin'?password:memberPassword);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    const entry=page.getByRole('link',{name:/项目 Manager 设置/});
    await expect(entry).toBeVisible();
    mkdirSync('.tmp/manager-settings',{recursive:true});
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});await entry.scrollIntoViewIfNeeded();
      await page.screenshot({path:`.tmp/manager-settings/basic-${role}-${width}.png`});
    }
    await page.setViewportSize({width:1440,height:1000});
    await entry.focus();await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/roles\/manager$/);
    const events=page.locator('[data-overview-anchor=manager-events]');
    await expect(events.getByRole('heading',{name:'交给 Manager 的事件',exact:true})).toBeVisible();
    await expect(page.getByLabel('开启角色协调',{exact:true})).toHaveCount(0);
    await expect(page.getByText(/交给主控（/)).toHaveCount(0);
    const actions=page.getByLabel('接收默认分支的 Actions 失败事件',{exact:true});
    await expect(actions).not.toBeChecked();
    await page.getByLabel('PR 推送新提交',{exact:true}).uncheck();
    await actions.check();await page.getByRole('button',{name:'保存事件开关',exact:true}).click();
    await expect(page.getByText('已保存事件开关',{exact:true})).toBeVisible();
    await page.reload();await expect(actions).toBeChecked();
    await expect(page.getByLabel('PR 推送新提交',{exact:true})).not.toBeChecked();
    await page.getByLabel('Manager 提示词',{exact:true}).fill('Choose useful work within the project authority.');
    await page.getByRole('button',{name:'保存 Manager 提示词',exact:true}).click();
    await expect(page.getByText('已保存 Manager 提示词',{exact:true})).toBeVisible();
    await expect(actions).toBeChecked();
    // Role settings save on the same page cannot reset event intake.
    await page.getByLabel('职责',{exact:true}).fill('Coordinate the task.');await consoleSave(page).click();
    await expect(page.locator('.flash')).toHaveText('角色配置已保存，新任务使用新配置；收回权限会阻止后续调用');
    await expect(actions).toBeChecked();
    await actions.uncheck();await page.getByRole('button',{name:'保存事件开关',exact:true}).click();
    await expect(page.getByText('已保存事件开关',{exact:true})).toBeVisible();
    await page.reload();await expect(actions).not.toBeChecked();
    const saved=(await admin('/api/repositories/101/manager')).value.manager.events;
    expect([saved['actions.run_failed'],saved['pull_request.synchronize']]).toEqual([false,false]);
    mkdirSync('.tmp/manager-settings',{recursive:true});
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      await page.getByRole('heading',{name:'项目 Manager 设置',exact:true}).scrollIntoViewIfNeeded();
      await actions.scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await expect(actions).toBeInViewport();
      await page.screenshot({path:`.tmp/manager-settings/${role}-${width}.png`});
    }
    await page.goto(h.admin+'/#/projects/101/roles');
    await expect(page.getByRole('heading',{name:'角色概览',exact:true})).toBeVisible();
    await expect(page.getByLabel('开启角色协调',{exact:true})).toHaveCount(0);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      await page.getByRole('link',{name:/项目 Manager 设置/}).scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await page.screenshot({path:`.tmp/manager-settings/roles-${role}-${width}.png`});
    }
    expect(errors).toEqual([]);
  } finally {await h.stop();}
});
