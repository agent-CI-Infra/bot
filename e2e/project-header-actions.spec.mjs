import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

test('overview owns the project heading and GitHub action; work and settings pages name their page',async({page})=>{
  const h=await harness();
  try {
    const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
    await page.goto(h.admin+'/#/projects/101/overview');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:900});await page.goto(h.admin+'/#/projects/101/overview');
      await expect(page.locator('.workspace-overview')).toBeVisible();
      await expect(page.locator('.project-head h1')).toHaveText('fixture/project-101');
      await expect(page.locator('.project-head .status')).not.toHaveCount(0);
      await expect(page.locator('.project-head').getByRole('link')).toHaveText(['在 GitHub 打开']);
      await expect(page.locator('#console-context')).toHaveText('fixture / project-101');
      for(const [key,caption] of [['release','发版本'],['knowledge','项目知识'],['basic','基本设置']]) {
        if(width>=768) await page.locator('#tabs').getByRole('link',{name:key==='basic'?'项目设置':caption,exact:true}).click();
        else await page.getByLabel('当前页面',{exact:true}).selectOption('#/projects/101/'+key);
        await expect(page.locator('.project-head h1')).toHaveText(caption);
        await expect(page.locator('#project-page .project-content > .console-state-loading')).toHaveCount(0);
        await expect(page.locator('.project-head a')).toHaveCount(0);
        await expect(page.locator('#console-context')).toHaveText('fixture / project-101 / '+caption);
      }
      await expect(page.locator('#main-content')).not.toContainText('← 全部项目');
      await expect(page.getByText('项目入口',{exact:false})).toHaveCount(0);
    }
  }finally{await h.stop();}
});
