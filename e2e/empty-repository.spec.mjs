import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
import {emptyRepositoryFixture} from '../test/empty-repository-helpers.mjs';

test('空仓库在列表和过程中等待首次提交，之后同一任务自动完成',async({page})=>{
  const h=await emptyRepositoryFixture(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await h.run();await page.goto(h.adminBase);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(h.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'检视',exact:true}).click();
    const row=page.locator('#rows .row',{hasText:'Issue #1'});await expect(row).toContainText('仓库还没有提交');await expect(row).toContainText('默认分支出现提交后会自动继续');await expect(row).not.toContainText('github_http_409');
    await row.getByRole('button',{name:'查看过程',exact:true}).click();await expect(page.locator('#task-badges')).toContainText('仓库还没有提交');await expect(page.locator('#timeline')).toContainText('等待首次提交');await expect(page.locator('#timeline-live')).toHaveText('仓库还没有提交；默认分支出现提交后会自动继续。');await expect(page.locator('#timeline')).not.toContainText('任务暂停或失败');
    await expect(page.locator('#timeline .step-waiting')).toHaveCount(1);await expect(page.locator('#timeline .step-fault')).toHaveCount(0);await expect(page.locator('#task-side')).toContainText('等待原因');
    mkdirSync('.tmp/empty-repository',{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/empty-repository/waiting-desktop.png'});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tmp/empty-repository/waiting-mobile.png'});
    // The detail view of a waiting task refreshes every 5 s, so allow more than one refresh to show the result.
    h.setBranch('ready');h.due();await h.run();await expect(page.locator('#task-badges')).toContainText('已完成',{timeout:15000});await expect(page.locator('#timeline')).toContainText('发布到 GitHub');expect(h.comments).toHaveLength(1);expect(h.store.get('SELECT count(*) n FROM tasks').n).toBe(1);await page.screenshot({path:'.tmp/empty-repository/completed-mobile.png'});
    expect(errors).toEqual([]);
  }finally{await h.close();}
});
