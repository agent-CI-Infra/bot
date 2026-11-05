import {test,expect} from '@playwright/test';
import {mkdirSync,rmSync} from 'node:fs';
import {harness,setup,account,repository,testPassword} from '../test/helpers.mjs';
import {metricTask,usageRequest} from '../test/metrics-fixtures.mjs';
async function login(page,url,username,password){await page.goto(url);await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();}
test('任务用量、单价配置与每日项目费用通过真实页面查询且遵守项目权限',async({page,browser})=>{
  const manager={call:async(_method,path)=>({repository_id:path.split('/')[3],generation:1,state:'ready',desired:'ready',revision:1,computer:{}})};
  const h=await harness(undefined,manager),{admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');
  const price={currency:'USD',input_per_million:2,output_per_million:10,cache_per_million:0.2};
  const model=(await admin('/api/models','POST',{repository_id:null,api_url:'https://model.invalid/v1',api_key:testPassword(),model_name:'Usage fixture',pricing:price})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id});
  metricTask(h.store,'review-usage');metricTask(h.store,'development-usage','101','development.issue');metricTask(h.store,'foreign-usage','202','review.pr');
  h.store.run("UPDATE tasks SET status='succeeded' WHERE id<>'development-usage'");h.store.run("UPDATE tasks SET status='running' WHERE id='development-usage'");
  h.store.run("UPDATE task_metrics SET runtime_ms=65234,active_since=NULL WHERE task_id='review-usage'");
  usageRequest(h.store,'review-usage',model.id,{usage:{prompt_tokens:1000000,completion_tokens:100000,prompt_tokens_details:{cached_tokens:800000}}});
  usageRequest(h.store,'foreign-usage',model.id,{cost:3});usageRequest(h.store,'development-usage',model.id,{date:'2026-10-23',cost:4});
  usageRequest(h.store,'development-usage',model.id,{date:'2026-10-23',priced:false,usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:50}});
  usageRequest(h.store,'development-usage',model.id,{date:'2026-10-23',usage:null});await h.projects.reconcile();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));mkdirSync('.tmp/metrics-evidence',{recursive:true});
  try{
    await login(page,h.admin,'administrator',password);await page.goto(h.admin+'/#/reviews');
    const own=page.locator('[data-card-key="101/issue/1"]');await expect(own).toBeVisible();await own.locator('.board-card-title').click();
    await expect(page.locator('#task-side')).toContainText('用量统计');await expect(page.locator('#task-side')).toContainText('USD 1.560000');
    await expect(page.locator('#task-side .task-metrics')).toContainText('运行 1 分 5 秒');await expect(page.locator('#task-side .task-metrics')).toContainText('输入 1,000,000');
    await expect(page.locator('#task-side .task-metrics')).toContainText('输出 100,000');await expect(page.locator('#task-side .task-metrics')).toContainText('缓存 800,000');await expect(page.locator('#task-side .task-metrics')).toContainText('命中率 80.0%');
    await page.screenshot({path:'.tmp/metrics-evidence/task-detail.png',fullPage:true});await page.locator('#task-actions').getByRole('button',{name:'关闭',exact:true}).click();
    await page.goto(h.admin+'/#/developments');await page.locator('[data-card-key="101/issue/1"] .board-card-title').click();await expect(page.locator('#task-side')).toContainText('统计不完整');
    await page.locator('#task-actions').getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('group',{name:'工作流',exact:true}).getByRole('button',{name:'全部工作流',exact:true}).click();
    await page.locator('[data-card-key="101/issue/1"][data-card-category="review.issue"] .board-card-title').click();
    await expect(page.locator('#task-picker')).toBeHidden();await expect(page.locator('#task-side .task-metrics')).toHaveCount(1);await page.locator('#task-actions').getByRole('button',{name:'关闭',exact:true}).click();
    await page.goto(h.admin+'/#/projects/101/activity');await expect(page.getByRole('heading',{name:'最近任务',exact:true})).toBeVisible();await expect(page.locator('#project-page .task-metrics')).toHaveCount(2);
    await page.goto(h.admin+'/#/settings/models');await page.getByRole('button',{name:'计费单价',exact:true}).click();
    await expect(page.getByLabel('输入单价 / 百万 token',{exact:true})).toHaveValue('2');await page.getByLabel('输入单价 / 百万 token',{exact:true}).fill('5');
    await page.getByRole('button',{name:'保存单价',exact:true}).click();await expect(page.locator('#model-pricing')).toHaveCount(0);
    expect(h.store.get("SELECT cost FROM model_requests WHERE task_id='review-usage'").cost).toBe(1.56);
    await page.getByRole('button',{name:'统计',exact:true}).click();await page.getByLabel('开始日期（本地）',{exact:true}).fill('2026-10-22');await page.getByLabel('结束日期（本地）',{exact:true}).fill('2026-10-23');
    await page.getByRole('button',{name:'查看统计',exact:true}).click();await expect(page.locator('.cost-summary')).toContainText('USD 8.56');await expect(page.locator('.cost-incomplete')).toContainText('2 次请求');
    await expect(page.locator('rect[data-project]')).toHaveCount(3);const segment=page.locator('rect[data-project="101"][data-date="2026-10-22"]');
    await segment.focus();await expect(page.locator('.cost-chart-detail')).toContainText('fixture/project-101');await expect(page.locator('.cost-chart-detail')).toContainText('USD 1.56');await expect(page.locator('.cost-chart-detail')).toContainText('当日 34.2%');
    await expect(page.locator('.cost-legend')).toContainText('fixture/project-101');await expect(page.locator('.cost-legend')).toContainText('fixture/project-202');
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/metrics-evidence/cost-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.locator('.cost-chart-scroll').evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);await page.screenshot({path:'.tmp/metrics-evidence/cost-mobile.png',fullPage:true});
    await page.getByLabel('统计项目',{exact:true}).selectOption('101');await page.getByRole('button',{name:'查看统计',exact:true}).click();await expect(page.locator('.cost-summary')).toContainText('USD 5.56');await expect(page.locator('rect[data-project="202"]')).toHaveCount(0);
    await page.getByLabel('费用币种',{exact:true}).selectOption('CNY');await page.getByRole('button',{name:'查看统计',exact:true}).click();await expect(page.locator('.cost-summary')).toContainText('暂无可计价记录');
    const memberPassword=testPassword();await admin('/api/users','POST',{username:'metrics-member',password:memberPassword,repository_ids:['101']});
    const context=await browser.newContext(),member=await context.newPage();
    try{
      await login(member,h.admin,'metrics-member',memberPassword);await member.getByRole('button',{name:'统计',exact:true}).click();
      await member.getByLabel('开始日期（本地）',{exact:true}).fill('2026-10-22');await member.getByLabel('结束日期（本地）',{exact:true}).fill('2026-10-23');await member.getByRole('button',{name:'查看统计',exact:true}).click();
      await expect(member.locator('.cost-summary')).toContainText('USD 5.56');await expect(member.locator('#costs-panel')).not.toContainText('project-202');
      expect(await member.getByLabel('统计项目',{exact:true}).locator('option').count()).toBe(2);
      await member.screenshot({path:'.tmp/metrics-evidence/cost-member.png',fullPage:true});
    }finally{await context.close();}
    await page.goto(h.admin+'/#/reviews');await expect(page.getByRole('group',{name:'工作流',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','review');await page.locator('[data-card-key="101/issue/1"][data-card-category="review.issue"] .board-card-title').click();await expect(page.locator('#task-side .task-metrics')).toHaveCount(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tmp/metrics-evidence/task-mobile.png',fullPage:true});expect(errors).toEqual([]);
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});

test('没有费用信息时按输入加输出 token 堆叠，缓存不重复累计并遵守项目范围',async({page,browser})=>{
  const h=await harness(),{admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');
  const model=(await admin('/api/models','POST',{repository_id:null,api_url:'https://model.invalid/v1',api_key:testPassword(),model_name:'Unpriced fixture'})).value.model;
  metricTask(h.store,'unpriced-own');metricTask(h.store,'unpriced-foreign','202');
  usageRequest(h.store,'unpriced-own',model.id,{priced:false,usage:{prompt_tokens:1000,completion_tokens:100,prompt_cache_hit_tokens:800}});
  usageRequest(h.store,'unpriced-foreign',model.id,{priced:false,usage:{prompt_tokens:2000,completion_tokens:200,prompt_cache_hit_tokens:1600}});
  usageRequest(h.store,'unpriced-own',model.id,{date:'2026-10-23',priced:false,usage:null});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));mkdirSync('.tmp/metrics-evidence',{recursive:true});
  const filter=async(from,to)=>{
    await page.getByLabel('开始日期（本地）',{exact:true}).fill(from);await page.getByLabel('结束日期（本地）',{exact:true}).fill(to);
    await page.getByRole('button',{name:'查看统计',exact:true}).click();
  };
  try{
    await page.setViewportSize({width:1440,height:1000});await login(page,h.admin,'administrator',password);await page.getByRole('button',{name:'统计',exact:true}).click();await filter('2026-10-22','2026-10-23');
    await expect(page.getByRole('heading',{name:'每日 token · 按项目堆叠',exact:true})).toBeVisible();
    const chart=page.locator('.cost-chart-section');await expect(chart.locator('svg')).toHaveAttribute('data-metric','tokens');await expect(chart.locator('rect')).toHaveCount(2);
    const own=chart.locator('rect[data-project="101"]');await expect(own).toHaveAttribute('data-value','1100');await own.focus();
    await expect(page.locator('.cost-chart-detail')).toContainText('1,100 token（输入 1,000，输出 100）');await expect(page.locator('.cost-chart-detail')).toContainText('当日 33.3%');
    await expect(chart).toContainText('缓存命中已包含在输入中，不重复相加');await expect(page.locator('.cost-summary')).toContainText('暂无可计价记录');
    await chart.scrollIntoViewIfNeeded();await page.screenshot({path:'.tmp/metrics-evidence/token-chart-desktop.png'});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await chart.scrollIntoViewIfNeeded();await page.screenshot({path:'.tmp/metrics-evidence/token-chart-mobile.png'});
    await page.getByLabel('统计项目',{exact:true}).selectOption('101');await filter('2026-10-22','2026-10-23');
    await expect(chart.locator('rect[data-project="202"]')).toHaveCount(0);await expect(chart.locator('rect')).toHaveCount(1);
    await filter('2026-10-23','2026-10-23');await expect(chart).toContainText('没有可靠的 token 记录');await expect(chart.locator('svg')).toHaveCount(0);
    await filter('2026-10-24','2026-10-24');await expect(chart).toContainText('没有模型请求记录');await expect(chart.locator('svg')).toHaveCount(0);
    const memberPassword=testPassword();await admin('/api/users','POST',{username:'token-member',password:memberPassword,repository_ids:['101']});
    const context=await browser.newContext(),member=await context.newPage();
    try{
      await login(member,h.admin,'token-member',memberPassword);await member.getByRole('button',{name:'统计',exact:true}).click();
      await expect(member.locator('.cost-chart-section svg')).toHaveAttribute('data-metric','tokens');await expect(member.locator('rect[data-project="202"]')).toHaveCount(0);await expect(member.locator('.cost-legend')).not.toContainText('project-202');
    }finally{await context.close();}
    expect(errors).toEqual([]);
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
