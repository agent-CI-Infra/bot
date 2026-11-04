import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { boardTask, boardFixtures, boardRelease } from '../test/board-fixtures.mjs';

async function fixture(){
  const h=await harness(),{admin,password}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');await repository(admin,a.id,'202');boardFixtures(h.store);
  boardRelease(h.store,'release-running','101','v1.2.3','running');boardRelease(h.store,'release-done','101','v1.2.2','published');
  boardRelease(h.store,'release-foreign','202','v9.9.9','failed');return {h,admin,password};
}
async function login(page,url,password,username='administrator'){
  await page.goto(url);await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('#tabs').getByRole('button',{name:'看板',exact:true}).click();
  await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy','true');
}
const work=(page,key,category)=>page.locator(`[data-card-key="${key}"][data-card-category="${category}"]`);
const choose=(page,label,value)=>['仓库','工作类别','执行状态','对象类型','按…分列'].includes(label)
  ?page.getByRole('group',{name:label,exact:true}).locator('button[data-value="'+value+'"]').click()
  :page.getByLabel(label,{exact:true}).selectOption(value);
async function more(page){await page.getByRole('button',{name:'更多视图操作',exact:true}).click();}
async function closeTask(page){await page.locator('#task-actions').getByRole('button',{name:'关闭',exact:true}).click();}
async function screenshot(page,name){mkdirSync('.tmp/board-evidence',{recursive:true});await page.screenshot({path:'.tmp/board-evidence/'+name+'.png'});}
const noPageScroll=async page=>expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight&&document.documentElement.scrollWidth<=innerWidth)).toBe(true);

test('独立工作卡在所有维度保留状态、徽章和任务目标，全部对象同时展示 Issue 与 PR',async({page})=>{
  const {h,password}=await fixture(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  h.store.run("UPDATE tasks SET status='running',updated_at='2026-10-02' WHERE id='source-review'");
  h.store.run("UPDATE tasks SET status='succeeded',updated_at='2026-10-03' WHERE id='developing'");
  try{
    await page.setViewportSize({width:1600,height:900});await login(page,h.admin,password);
    await expect(page.getByRole('group',{name:'对象类型',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','');
    await expect(page.locator('.board-filter-controls select')).toHaveCount(0);
    await expect(work(page,'101/pr/2','review')).toBeVisible();await expect(work(page,'101/issue/3','review')).toBeVisible();
    await expect(work(page,'101/pr/2','review')).toContainText('PR #2');
    for(const group of ['execution_status','category','repository']){
      await choose(page,'按…分列',group);
      const review=work(page,'101/issue/3','review'),development=work(page,'101/issue/3','development');
      await expect(review).toContainText('检视 执行中');await expect(review).not.toContainText('开发 已完成');
      await expect(development).toContainText('开发 已完成');await expect(development).not.toContainText('检视 执行中');
      if(group==='execution_status'){
        await expect(page.locator('[data-column-id=running]')).toContainText('Issue #3');
        await expect(page.locator('[data-column-id=completed]')).toContainText('Issue #3');
        await expect(page.locator('[data-column-id=queued]')).toHaveCount(0);await expect(page.locator('#board-zero-counts')).toContainText('排队 0');
      }
      await review.locator('.board-card-title').click();await expect(page.locator('#task-title')).toHaveText('检视 · Issue #3');await expect(page.locator('#task-picker')).toBeHidden();await closeTask(page);
      await development.locator('.board-card-title').click();await expect(page.locator('#task-title')).toHaveText('开发 · Issue #3');await expect(page.locator('#task-picker')).toBeHidden();await closeTask(page);
      await screenshot(page,'desktop-'+group);
    }
    await expect(work(page,'101/issue/3','review').getByRole('link',{name:'在 GitHub 打开 Issue #3'})).toHaveAttribute('href','https://github.com/fixture/project-101/issues/3');
    boardTask(h.store,'old-review',3,'review.issue','succeeded',{title:'Develop this Issue',time:'2026-09-01'});
    await work(page,'101/issue/3','review').locator('.board-card-title').click();
    await expect(page.locator('#task-picker .task-choice-row')).toHaveCount(2);await expect(page.locator('#task-picker')).not.toContainText('开发 Issue');await closeTask(page);
    await choose(page,'对象类型','issue');await expect(page.locator('[data-card-key*="/pr/"]')).toHaveCount(0);
    await expect(page.getByRole('group',{name:'对象类型',exact:true}).getByRole('button')).toHaveText(['全部对象','Issue','PR']);
    await page.getByRole('button',{name:'移除筛选 对象类型：Issue',exact:true}).click();await expect(work(page,'101/pr/2','review')).toBeVisible();
    await choose(page,'工作类别','review');await choose(page,'仓库','101');await choose(page,'执行状态','running');
    await expect(work(page,'101/issue/3','review')).toBeVisible();await expect(work(page,'101/pr/2','review')).toBeVisible();await expect(page.locator('.board-card')).toHaveCount(2);
    await choose(page,'按…分列','repository');await expect(page.locator('.board-column')).toHaveCount(1);await expect(page.locator('.board-column')).toHaveAttribute('data-column-id','101');
    await page.getByRole('button',{name:'移除筛选 执行状态：正在执行',exact:true}).click();await expect(work(page,'101/issue/1','review')).toBeVisible();
    for(let i=0;i<15;i++)boardTask(h.store,'many-'+i,100+i,'review.issue','succeeded');
    await page.evaluate(()=>boardPoll());
    expect(await page.locator('.board-column-list').evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
    await noPageScroll(page);expect(errors).toEqual([]);
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});

test('旧地址只转换一次，保存视图恢复类别、对象类型、分列和折叠列',async({page})=>{
  const {h,admin,password}=await fixture();
  const saved=(await admin('/api/board/views','POST',{name:'PR follow-up',group_by:'category',filters:[{field:'category',value:'development'},{field:'object_type',value:'pr'}],hidden_columns:[]})).value.view;
  boardTask(h.store,'follow-up',2,'development.pr','completed');
  try{
    await page.setViewportSize({width:1600,height:900});await login(page,h.admin,password);
    await page.goto(h.admin+'/#/reviews');await expect(page).toHaveURL(/#\/board$/);await expect(page.getByRole('group',{name:'工作类别',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','review');
    await more(page);await choose(page,'视图',saved.id);await expect(page.getByRole('group',{name:'工作类别',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','development');
    await expect(work(page,'101/pr/2','development')).toContainText('跟进 已完成');
    await page.getByRole('button',{name:'折叠 开发',exact:true}).click();
    await more(page);await page.getByRole('button',{name:'另存视图',exact:true}).click();await page.getByLabel('视图名称',{exact:true}).fill('My follow-ups');await page.getByRole('button',{name:'创建视图',exact:true}).click();
    await expect(page.getByRole('group',{name:'工作类别',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','development');await expect(page.getByRole('group',{name:'对象类型',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','pr');
    const own=h.store.get("SELECT id FROM board_views WHERE name='My follow-ups'").id;
    await choose(page,'对象类型','issue');await more(page);await choose(page,'视图',own);
    await expect(page.getByRole('group',{name:'对象类型',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','pr');await expect(page.getByRole('group',{name:'按…分列',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','category');
    await expect(page.locator('[data-column-id=development]')).toHaveClass(/board-collapsed/);
    await page.locator('#tabs').getByRole('button',{name:'项目',exact:true}).click();await page.goBack();
    await expect(page.getByRole('group',{name:'工作类别',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','development');
    await page.getByRole('button',{name:'展开 开发',exact:true}).click();
    await choose(page,'对象类型','');await more(page);await page.getByRole('button',{name:'保存视图',exact:true}).click();
    await choose(page,'对象类型','issue');await more(page);await choose(page,'视图',own);await expect(page.getByRole('group',{name:'对象类型',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','');
    await page.goto(h.admin+'/#/developments');await expect(page).toHaveURL(/#\/board$/);await expect(page.getByRole('group',{name:'工作类别',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','development');
    await screenshot(page,'saved-view');
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});

test('390宽用分组下拉和纵向列表直接访问发版本，筛选结果和空状态可见',async({page})=>{
  const {h,password}=await fixture();for(let i=0;i<12;i++)boardRelease(h.store,'extra-'+i,'101','v2.0.'+i,'published');
  try{
    await page.setViewportSize({width:1600,height:900});await login(page,h.admin,password);await choose(page,'按…分列','category');
    await choose(page,'工作类别','release');await expect(page.locator('.board-column')).toHaveCount(1);await expect(page.locator('.board-column')).toHaveAttribute('data-column-id','release');
    await choose(page,'工作类别','');await page.setViewportSize({width:390,height:844});
    await expect(page.getByLabel('当前分组',{exact:true})).toBeVisible();await choose(page,'当前分组','release');
    await expect(work(page,'101/release/release-running','release')).toBeVisible();
    expect(await page.locator('#board-columns').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await noPageScroll(page);
    expect((await page.locator('.board-mobile-selected').boundingBox()).y).toBeLessThan(340);
    expect(await page.locator('#board-columns').evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);await screenshot(page,'mobile-release-list');
    await page.locator('#board-columns').evaluate(el=>el.scrollTop=200);
    h.store.run("UPDATE project_releases SET stage='externally_published' WHERE id='extra-11'");await page.evaluate(()=>boardPoll());
    expect(await page.locator('#board-columns').evaluate(el=>el.scrollTop)).toBeGreaterThan(150);
    await work(page,'101/release/release-running','release').locator('.board-card-title').click();await expect(page).toHaveURL(/#\/projects\/101\/release$/);
    await expect(page.locator('#project-page .release-record').filter({hasText:'v1.2.3'})).toContainText('工作流运行中');
    await page.locator('#tabs').getByRole('button',{name:'看板',exact:true}).click();await choose(page,'当前分组','review');
    await work(page,'101/issue/3','review').locator('.board-card-title').click();await expect(page.locator('#task-title')).toHaveText('检视 · Issue #3');await closeTask(page);
    await page.locator('.board-filter-details>summary').click();await choose(page,'工作类别','release');
    await expect(page.locator('.board-column:visible')).toHaveCount(1);await expect(page.locator('.board-column:visible')).toHaveAttribute('data-column-id','release');
    await screenshot(page,'mobile-options-open');
    await page.getByLabel('搜索编号或标题',{exact:true}).fill('no-matching-release');await expect(page.locator('.board-card')).toHaveCount(0);
    await expect(page.locator('.board-mobile-selected .board-empty')).toHaveText('当前筛选和分组下没有条目');
    await page.locator('.board-filter-details>summary').click();await expect(page.getByRole('group',{name:'按…分列',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','category');await screenshot(page,'mobile-empty');await noPageScroll(page);
    await page.getByRole('button',{name:'移除筛选 搜索：no-matching-release',exact:true}).click();await expect(page.locator('.board-card:visible')).not.toHaveCount(0);
    await screenshot(page,'mobile-filtered-release');
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});

test('自定义字段保留对象值与折叠列，成员视图和卡片不泄露其他仓库',async({page,browser})=>{
  const {h,admin,password}=await fixture();
  try{
    await login(page,h.admin,password);await more(page);await page.getByRole('button',{name:'新建自定义字段',exact:true}).click();
    await page.getByLabel('字段名称',{exact:true}).fill('Priority');await page.getByLabel('第一列名称',{exact:true}).fill('High');await page.getByRole('button',{name:'创建字段和视图',exact:true}).click();
    await expect(page.locator('#board-form')).toHaveCount(0);await expect(page.getByRole('group',{name:'按…分列',exact:true}).locator('button[aria-pressed=true]')).not.toHaveAttribute('data-value','bot_stage');
    const custom=await page.getByRole('group',{name:'按…分列',exact:true}).locator('button[aria-pressed=true]').getAttribute('data-value'),option=h.store.get("SELECT id FROM board_options WHERE name='High'").id;
    const card=work(page,'101/issue/3','review');await card.getByLabel('Priority',{exact:true}).selectOption(option);
    await expect(page.locator('[data-column-id="'+option+'"] .board-card')).toHaveCount(2);
    await page.getByRole('button',{name:'折叠 High',exact:true}).click();await more(page);await page.getByRole('button',{name:'保存视图',exact:true}).click();
    await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.locator('[data-column-id="'+option+'"]')).toHaveClass(/board-collapsed/);
    const memberPassword=testPassword();await admin('/api/users','POST',{username:'board-member',password:memberPassword,repository_ids:['101']});
    const context=await browser.newContext(),member=await context.newPage();
    try{
      await login(member,h.admin,memberPassword,'board-member');await expect(member.locator('[data-card-key^="202/"]')).toHaveCount(0);
      await expect(member.locator('#board-panel')).not.toContainText('v9.9.9');await expect(member.getByRole('group',{name:'仓库',exact:true}).getByRole('button')).toHaveText(['全部仓库','fixture/project-101']);
      await expect(member.getByRole('group',{name:'按…分列',exact:true}).getByRole('button')).toHaveCount(4);await more(member);await expect(member.getByLabel('视图',{exact:true}).locator('option')).toHaveCount(1);
    }finally{await context.close();}
    expect(custom).not.toBe('bot_stage');
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
