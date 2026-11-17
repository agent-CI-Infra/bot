import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

test('scope work links open real pages and the assistant deep link survives reload', async({page})=>{
  const h=await harness(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
    await page.goto(h.admin+'/#/projects/101/overview');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.workspace-overview')).toBeVisible();
    for(const [key,caption] of [['release','发版本'],['knowledge','项目知识'],['activity','运行状态'],['overview','项目总览']]) {
      await page.locator('#tabs').getByRole('link',{name:caption,exact:true}).click();await expect(page).toHaveURL(new RegExp('#/projects/101/'+key+'$'));
      await expect(page.locator('#project-page .project-content > .console-state-loading')).toHaveCount(0);
      await expect(page.locator('#tabs [aria-current=page]')).toHaveText(caption);await expect(page.locator('#console-secondary-nav')).toBeHidden();
    }
    await page.locator('#tabs').getByRole('link',{name:'管理助手',exact:true}).click();await expect(page.locator('#management-chat')).toBeVisible();await expect(page).toHaveURL(/#\/projects\/101\/management$/);
    await page.reload();await expect(page.locator('#management-chat')).toBeVisible();await expect(page.locator('#tabs [aria-current=page]')).toHaveText('管理助手');
    expect(errors).toEqual([]);
  }finally{await h.stop();}
});
