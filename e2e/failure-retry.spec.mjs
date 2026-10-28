import {test,expect} from '@playwright/test';
import {emptyRepositoryFixture} from '../test/empty-repository-helpers.mjs';

test('GitHub 写入返回 500 后，过程写明原因和处理办法，点「重试」只发布一次',async({page})=>{
  let fail=true;const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const h=await emptyRepositoryFixture(undefined,{github(path,send,res){
    if(!fail||!path.endsWith('/issues/1/comments')||res.req.method!=='POST')return false;
    fail=false;res.setHeader('X-GitHub-Request-Id','C5D4:3A2B:1');send({message:'Server Error'},500);return true;
  }});
  try{
    h.setBranch('ready');await h.run();h.due();await h.run();
    await page.goto(h.adminBase);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(h.password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByRole('button',{name:'检视',exact:true}).click();
    const row=page.locator('#rows .row',{hasText:'Issue #1'});await expect(row).toContainText('GitHub 写入结果未知（github_publication_unknown）');
    await row.getByRole('button',{name:'查看过程',exact:true}).click();
    const timeline=page.locator('#timeline');
    await expect(timeline).toContainText('暂停或失败 · 外部服务或网络波动');
    await expect(timeline).toContainText('GitHub 请求 POST /repos/fixture/project-101/issues/1/comments 返回 HTTP 500，写入结果尚未确认：Server Error（GitHub 请求 ID：C5D4:3A2B:1）');
    await expect(timeline).toContainText('暂停或失败 · GitHub 写入结果未知');
    await expect(page.locator('#task-side')).toContainText('点「重试」会先再查一次，确实没有才重新发送');
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.setViewportSize({width:1280,height:900});
    await page.locator('#task-actions').getByRole('button',{name:'重试',exact:true}).click();
    await expect(page.locator('#task-badges')).toContainText('已完成',{timeout:20000});expect(h.comments).toHaveLength(1);
    expect(errors).toEqual([]);
  }finally{await h.close();}
});
