import { consoleNavigate } from '../helpers/console-navigation.mjs';
import { promptEditor, promptReading } from '../helpers/prompt-editor.mjs';
import { openModelCatalog } from '../helpers/open-model-folds.mjs';
import{test,expect}from'@playwright/test';import{ rmSync }from'node:fs';import{harness,setup,account,repository,testPassword}from'../../fixtures/helpers.mjs';import{RuleService}from'../../../dist/rules/service.js';import{managerPrompt,saveManager}from'../../../dist/dispatch/settings.js';import{TaskEngine}from'../../../dist/agent/engine.js';import{Onboarding}from'../../../dist/onboarding/service.js';

test('项目保存、规则刷新、未启动仓库、任务过程及390px导航提供可核验反馈',async({page})=>{
 const computer={cpus:2,memory_mb:4096,pids:512,tmp_mb:128,egress:true,packages:[],env:{},setup_script:'',network_policy:'internet egress'};
 const manager={call:async()=>({repository_id:'101',generation:1,state:'ready',desired:'ready',revision:1,computer})};let onboard;
 const h=await harness(undefined,manager,store=>({engine:new TaskEngine(store,manager),onboarding:onboard=new Onboarding(store)})),{admin,password}=await setup(h),a=await account(admin),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await repository(admin,a.id,'101');await repository(admin,a.id,'202');await admin('/api/repositories/202/policy','PATCH',{enabled:false});
  h.store.run('INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at) VALUES(?,?,?,?,?,0,1,?)',a.id,'303','fixture/new-project','10','fixture',new Date().toISOString());
  const model=(await admin('/api/models','POST',{repository_id:null,api_url:'https://model.invalid/a-long-but-visible-api-path/v1',api_key:testPassword(),model_name:'Visible model name'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id,review_enabled:true});
  // The review rule is the Manager's section and the label a project setting (#935); the repository's .bot/ files are names only.
  const current=managerPrompt(h.store,'101');saveManager(h.store,'101',{expected_revision:current.revision,prompt:current.content+'\n\nConsole-only directive'},null,'test');
  h.store.run("UPDATE policies SET rule_overrides=? WHERE repository_id='101'",JSON.stringify({'.bot/rules/issue-review.md':'Console-only directive'}));
  await admin('/api/repositories/101/policy','PATCH',{review_label:'console-label'});
  const rules=new RuleService(h.store,manager);rules.cache('101','a'.repeat(40),{'.bot/guide.md':'','.bot/rules/pr-review.md':'','.bot/computer.yaml':''});
  onboard.save('public',{origin:'https://hooks.invalid'});onboard.save('app',{slug:'fixture-app',account_id:a.id,installations:1});onboard.save('model',model.id);
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,head_sha) VALUES('timeline','101','review.pr','succeeded','Review',7,'done',?)",'a'.repeat(40));
  for(const [i,event]of [{type:'model',step:1,content:'Inspected code'},{type:'model',content:'Ready to finish'},{type:'tool',name:'create_pull_request',arguments:{summary:'Fixed the requested behavior',test_command:'npm test'},result:{finished:true}}].entries())h.store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)','log'+i,'timeline',JSON.stringify(event),new Date().toISOString());
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,error_code) VALUES('head-wait','101','development.pr','waiting_pr_head','Wait for pushed commit',8,'publish','pr_head_pending')");h.store.run("INSERT INTO development_candidates VALUES('head-wait',?)",JSON.stringify({remote_sha:'c'.repeat(40)}));
  await h.hook(a.path,a.secret,'linked',{repository:{id:101},action:'opened',issue:{number:9,title:'Review'}});
  await h.hook(a.path,a.secret,'draft',{repository:{id:101},action:'opened',pull_request:{number:10,draft:true,head:{sha:'b'.repeat(40)}}},{'X-GitHub-Event':'pull_request'});
  await h.hook(a.path,a.secret,'label',{repository:{id:101},action:'labeled',issue:{number:9}});await h.hook(a.path,a.secret,'label',{repository:{id:101},action:'labeled',issue:{number:9}});
  await page.goto(h.admin);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
  const prompt=page.getByLabel('Manager 提示词',{exact:true}),savePrompt=page.getByRole('button',{name:'保存 Manager 提示词',exact:true});
  await page.goto(h.admin+'/#/projects/101/roles/manager');
  await expect(page.locator('#project-page')).not.toContainText('项目检视指引');
  await expect(prompt).toHaveValue(/Console-only directive/);
  await promptEditor(page,'Manager 提示词');await prompt.fill((await prompt.inputValue()).replace('Console-only directive','Edited console directive'));await savePrompt.click();
  await expect(page.getByText('已保存 Manager 提示词',{exact:true})).toBeVisible();
  expect(JSON.parse(h.store.get("SELECT rule_overrides FROM policies WHERE repository_id='101'").rule_overrides)['.bot/rules/issue-review.md']).toBe('Console-only directive');
  await page.route('**/api/repositories/101/manager',route=>route.fulfill({status:400,contentType:'application/json',body:'{"error":"invalid_manager_prompt"}'}));
  await prompt.fill('Keep this failed draft');await savePrompt.click();
  await expect(page.locator('#project-page')).toContainText('invalid_manager_prompt');await page.unroute('**/api/repositories/101/manager');
  await prompt.fill('A complete dispatch prompt.');await savePrompt.click();
  await expect.poll(async()=>(await admin('/api/repositories/101/manager')).value.manager.prompt.content).toBe('A complete dispatch prompt.');
  await expect(page.getByText('已保存 Manager 提示词',{exact:true})).toBeVisible();
  await page.evaluate(()=>{location.hash='#/projects/101/basic';});await expect(page.locator('#project-page')).toContainText('Visible model name');await expect(page.locator('#project-page')).toContainText('2 CPU · 4096 MB');
  await expect(page.locator('[data-retired-rules]')).toContainText('.bot/computer.yaml');await expect(page.getByLabel('检视标签',{exact:true})).toHaveValue('console-label');
  await page.evaluate(()=>{location.hash='#/projects/101/machine';});await expect(page.getByText('仓库里的 .bot/computer.yaml 不再读取',{exact:false})).toBeVisible();await expect(page.getByLabel('CPU（核）',{exact:true})).toHaveValue('2');await expect(page.locator('#project-page')).not.toContainText('单条命令最长时间');
  // Repository skills: reading the default branch again happens once at a time, updates the list in place and reports a failure.
  await page.evaluate(()=>{location.hash='#/projects/101/roles/manager';});
  const skillRow=path=>page.locator(`[data-rule-file="${path}"]`),retired=page.locator('[data-retired-rules]'),refresh=page.getByRole('button',{name:'刷新默认分支文件',exact:true}),releaseSkill='.agents/skills/release-notes/SKILL.md';
  await expect(retired).toContainText('.bot/guide.md');await expect(skillRow('.bot/guide.md')).toHaveCount(0);await expect(refresh).toBeEnabled();
  await expect(page.getByText(/^章节与内置文本/)).toHaveCount(0);
  await page.evaluate(()=>window.sameRuleDocument=true);
  let release,count=0;const blocked=new Promise(resolve=>release=resolve);
  await page.route('**/api/repositories/101/rules/refresh',async route=>{count++;await blocked;rules.cache('101','b'.repeat(40),{'.bot/computer.yaml':'',[releaseSkill]:'Refreshed release notes from verified sources.'});await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify((await admin('/api/repositories/101/rules')).value)});});
  await refresh.click();await expect(page.getByRole('button',{name:'正在读取默认分支…',exact:true})).toBeDisabled();await page.getByRole('button',{name:'正在读取默认分支…',exact:true}).evaluate(node=>node.click());expect(count).toBe(1);release();
  await expect(page.locator('#project-page')).toContainText('默认分支提交 '+'b'.repeat(12));await expect(refresh).toBeEnabled();
  await expect(skillRow(releaseSkill)).toBeVisible();await expect(retired).not.toContainText('.bot/guide.md');expect(await page.evaluate(()=>window.sameRuleDocument)).toBe(true);
  await page.unroute('**/api/repositories/101/rules/refresh');await page.route('**/api/repositories/101/rules/refresh',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"github_unavailable"}'}));await refresh.click();await expect(page.locator('.rule-sync [role=status]')).toContainText('github_unavailable');await page.unroute('**/api/repositories/101/rules/refresh');
  // A repository release-notes skill replaces the release notes section; a failed read of the Manager shows an error instead of a guess.
  await page.reload();await expect(skillRow(releaseSkill)).toBeVisible();
  await page.route('**/api/repositories/101/manager',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"github_unavailable"}'}));await page.reload();
  await expect(page.locator('#project-page')).toContainText('503 · github_unavailable');await expect(prompt).toHaveCount(0);
  await page.unroute('**/api/repositories/101/manager');await page.reload();await expect(promptReading(page,'Manager 提示词')).toBeVisible();
  await page.setViewportSize({width:1365,height:900});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await skillRow(releaseSkill).getByRole('button',{name:'查看内容',exact:true}).click();await expect(page.locator('#project-detail .rule-card')).toContainText('Refreshed release notes');
  const sectionPicker=page.getByLabel('当前页面',{exact:true});await expect(sectionPicker).toBeVisible();
  await expect(sectionPicker.locator('option').filter({hasText:'项目入口'})).toHaveCount(0);
  for(const caption of ['使用的模型','检视','开发','规则总览'])await expect(page.getByRole('link',{name:caption,exact:true})).toHaveCount(0);
  await sectionPicker.selectOption('#/projects/101/model');await openModelCatalog(page);await expect(page.locator('.model-address').first()).toBeVisible();await page.locator('.model-address').first().scrollIntoViewIfNeeded();expect(await page.locator('.model-address').first().evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await consoleNavigate(page,'全局设置');await page.getByLabel('当前页面',{exact:true}).selectOption('#/settings/onboarding');await page.getByRole('button',{name:'1. 公网 HTTPS',exact:true}).click();await expect(page.getByRole('button',{name:'自建 HTTPS 中转',exact:true})).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Cloudflare Tunnel',exact:true}).click();await expect(page.getByRole('button',{name:'Cloudflare Tunnel',exact:true})).toHaveAttribute('aria-pressed','true');
  for(const caption of ['1. 公网 HTTPS','2. GitHub App','3. GitHub 登录','4. 安装','5. 模型','6. 规则','7. 完成'])await expect(page.getByRole('button',{name:caption,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'7. 完成',exact:true}).click();const fresh=page.locator('#onboarding-panel .row').filter({hasText:'fixture/new-project'});await expect(fresh).toContainText('未启动');await expect(fresh.getByRole('button',{name:'启动并启用检视',exact:true})).toBeEnabled();await fresh.getByRole('button',{name:'启动并启用检视',exact:true}).click();await expect(page.locator('#onboarding-panel .row').filter({hasText:'fixture/new-project'})).toContainText('检视已开启');
  await page.goto(h.admin+'/#/tasks/timeline');await expect(page.locator('#timeline')).toContainText('第 2 步');await expect(page.locator('#timeline')).not.toContainText('undefined');const raw=page.locator('#timeline details').filter({has:page.locator('summary',{hasText:'原始 JSON'})});await expect(raw).not.toHaveAttribute('open','');await expect(page.locator('#timeline')).toContainText('Fixed the requested behavior');
  await page.goto(h.admin+'/#/tasks/head-wait');await expect(page.locator('#timeline-live')).toContainText('PR 尚未指向刚推送的提交');await expect(page.locator('#timeline-live')).toContainText('c'.repeat(40));await expect(page.locator('#task-view')).not.toContainText('权限待处理');await page.setViewportSize({width:1365,height:900});expect(errors).toEqual([]);
 }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
