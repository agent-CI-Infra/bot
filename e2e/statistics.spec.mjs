import {test,expect} from '@playwright/test';
import {mkdirSync,rmSync} from 'node:fs';
import {harness,setup,account,repository,testPassword} from '../test/helpers.mjs';
import {metricTask,usageRequest} from '../test/metrics-fixtures.mjs';

test.use({timezoneId:'Asia/Shanghai'});
async function login(page,url,username,password){
  await page.goto(url);await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'统计',exact:true}).click();
}
async function dates(page,from,to=from){
  await page.getByLabel('开始日期（本地）',{exact:true}).fill(from);await page.getByLabel('结束日期（本地）',{exact:true}).fill(to);
  await page.getByRole('button',{name:'查看统计',exact:true}).click();await expect(page.locator('#count')).toContainText(from+' 至 '+to);
}
test('统计按浏览器本地日显示费用、token、四类任务，并支持仓库筛选、权限与空数据',async({page,browser})=>{
  const h=await harness(),{admin,password}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');await repository(admin,a.id,'202');
  const kinds=['review.issue','review.pr','development.issue','development.pr'];
  for(const [index,kind] of kinds.entries()){
    metricTask(h.store,kind,'101',kind);h.store.run('UPDATE tasks SET created_at=? WHERE id=?','2026-11-03T16:30:00.000Z',kind);
    h.store.run('UPDATE task_metrics SET runtime_ms=? WHERE task_id=?',[90061000,120000,30000,0][index],kind);
  }
  h.store.run("DELETE FROM task_metrics WHERE task_id='development.pr'");
  metricTask(h.store,'foreign','202','review.pr');h.store.run("UPDATE tasks SET created_at='2026-11-03T16:30:00.000Z' WHERE id='foreign'");
  for(const repo of ['101','202']){
    metricTask(h.store,'undated-'+repo,repo,'development.pr');h.store.run("UPDATE tasks SET created_at='' WHERE id=?",'undated-'+repo);
    h.store.run('UPDATE task_metrics SET complete=0 WHERE task_id=?','undated-'+repo);
  }
  for(const [task,time,cost] of [
    ['review.issue','2026-11-03T16:30:00.000Z',2],['foreign','2026-11-03T16:30:00.000Z',3],
    ['review.issue','2026-11-04T16:00:00.000Z',4],['review.issue','2026-11-03T15:59:59.999Z',8],
  ]){const id=usageRequest(h.store,task,'fixture-model',{cost});h.store.run('UPDATE model_requests SET requested_at=? WHERE id=?',time,id);}
  const errors=[];page.on('pageerror',error=>errors.push(error.message));mkdirSync('.tmp/statistics-evidence',{recursive:true});
  const taskRow=(target,kind)=>target.locator(`.statistics-task-summary tr[data-kind="${kind}"]`);
  try{
    await page.clock.setFixedTime(new Date('2026-11-03T16:45:00Z'));
    await login(page,h.admin,'administrator',password);await expect(page.getByRole('heading',{name:'统计',exact:true})).toBeVisible();
    await expect(page.getByLabel('结束日期（本地）',{exact:true})).toHaveValue('2026-11-04');
    await dates(page,'2026-11-04');await expect(page.locator('.cost-summary')).toContainText('USD 5.00');
    await expect(page.locator('.cost-token-summary')).toContainText('2,000,000');
    await expect(page.locator('rect[data-date="2026-11-04"]')).toHaveCount(2);await expect(page.locator('rect[data-date="2026-11-03"]')).toHaveCount(0);
    await expect(taskRow(page,'review.pr').locator('td').nth(1)).toHaveText('2');
    await expect(taskRow(page,'review.issue')).toContainText('25 小时 1 分');
    await expect(taskRow(page,'development.pr').locator('td').nth(2)).toHaveText('— · 1 项耗时不完整');
    await expect(page.locator('.statistics-undated')).toContainText('日期不明的历史任务');
    await page.getByText('每日任务明细',{exact:true}).click();
    await expect(page.locator('.statistics-tasks details tbody')).toContainText('2026-11-04');
    await expect(page.locator('.statistics-tasks details tbody')).toContainText('25 小时 1 分');
    await expect(page.locator('#costs-panel')).toContainText('不含外部执行端自行发起');await expect(page.locator('#costs-panel')).not.toContainText('UTC');
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/statistics-evidence/statistics-desktop.png',fullPage:true});
    await page.getByLabel('统计项目',{exact:true}).selectOption('101');await page.getByRole('button',{name:'查看统计',exact:true}).click();
    await expect(page.locator('.cost-summary')).toContainText('USD 2.00');await expect(taskRow(page,'review.pr').locator('td').nth(1)).toHaveText('1');
    await expect(page.locator('#cost-body')).not.toContainText('project-202');
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.locator('.statistics-task-summary').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await page.screenshot({path:'.tmp/statistics-evidence/statistics-mobile.png',fullPage:true});
    await dates(page,'2026-11-05');await expect(page.locator('.cost-summary')).toContainText('USD 4.00');
    await expect(page.locator('.statistics-tasks')).toContainText('这个日期范围内没有任务记录。');
    await dates(page,'2020-01-01');await expect(page.locator('#costs-panel')).toContainText('这个日期范围内没有模型请求记录。');
    await expect(page.locator('.cost-summary')).toContainText('USD 0.00');await expect(taskRow(page,'review.issue').locator('td').nth(1)).toHaveText('0');
    await expect(page.locator('.statistics-undated')).toContainText('— · 1 项耗时不完整');
    await page.screenshot({path:'.tmp/statistics-evidence/statistics-empty.png',fullPage:true});
    const memberPassword=testPassword();await admin('/api/users','POST',{username:'statistics-member',password:memberPassword,repository_ids:['101']});
    const context=await browser.newContext({timezoneId:'Asia/Shanghai'}),member=await context.newPage();
    try{
      await login(member,h.admin,'statistics-member',memberPassword);await dates(member,'2026-11-04');
      await expect(member.locator('.cost-summary')).toContainText('USD 2.00');await expect(member.locator('#costs-panel')).not.toContainText('project-202');
      await expect(member.getByLabel('统计项目',{exact:true}).locator('option')).toHaveCount(2);
      expect((await context.request.get(h.admin+'/api/costs?from=2026-11-04&to=2026-11-04&repository_id=202&timezone=Asia%2FShanghai')).status()).toBe(403);
      await member.screenshot({path:'.tmp/statistics-evidence/statistics-member.png',fullPage:true});
    }finally{await context.close();}
    expect(errors).toEqual([]);
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
