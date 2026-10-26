import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { boardTask, boardFixtures } from '../test/board-fixtures.mjs';

async function login(page,url,username,password){
  await page.goto(url);await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('header').getByRole('button',{name:'看板',exact:true}).click();
  await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy','true');
}
const pageScrolls=page=>page.evaluate(()=>document.documentElement.scrollHeight>innerHeight||document.documentElement.scrollWidth>innerWidth);
test('Issue 和 PR 分开成两块全屏看板，保存筛选和个人视图，自定义字段拖动不改 bot 阶段',async({page,browser})=>{
  const h=await harness(),{admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');boardFixtures(h.store);
  // Enough finished reviews to overflow one column; they live in the repository the member below cannot see.
  for(let i=0;i<20;i++)boardTask(h.store,'many-'+i,100+i,'review.issue','succeeded',{repo:'202',title:`Reviewed experiment ${i} with a longer title about solvent models`,time:`2026-09-${String(i+1).padStart(2,'0')}T08:00:00.000Z`});
  const errors=[];page.on('pageerror',err=>errors.push(err.message));mkdirSync('.tmp/board-evidence',{recursive:true});
  try{
    await h.hook(a.path,a.secret,'draft',{repository:{id:101},pull_request:{number:60,title:'Draft molecular simulation',draft:true,state:'open'}},{'X-GitHub-Event':'pull_request'});
    await h.hook(a.path,a.secret,'closed',{repository:{id:101},issue:{number:70,title:'Closed experiment',state:'closed'}});
    await page.setViewportSize({width:1600,height:900});await login(page,h.admin,'administrator',password);
    // Scoped to the type switcher: card titles such as "PR #40" are buttons too.
    const columns=page.locator('.board-column'),types=page.getByRole('group',{name:'对象类型'}),issues=types.getByRole('button',{name:/^Issue/}),prs=types.getByRole('button',{name:/^PR/});
    await expect(issues).toHaveAttribute('aria-pressed','true');await expect(issues).toHaveText('Issue 25');await expect(prs).toHaveText('PR 3');
    await expect(columns).toHaveCount(6);expect(await columns.locator('h2').allTextContents()).toEqual(['未检视','正在检视','已检视','正在开发','已开发','需要处理']);
    await expect(page.locator('.board-card')).toHaveCount(25);await expect(page.locator('[data-card-key*="/pr/"]')).toHaveCount(0);
    await expect(page.locator('[data-card-key="101/issue/3"]')).toHaveCount(1);
    await expect(page.locator('[data-stage=developing]')).toContainText('Develop this Issue');await expect(page.locator('[data-stage=developing]')).toContainText('开发 开发中');
    const developed=page.locator('[data-stage=developed] [data-card-key="101/issue/4"]');
    await expect(developed.getByRole('link',{name:'→ PR #40'})).toHaveAttribute('href','https://github.com/fixture/project-101/pull/40');
    await expect(page.locator('[data-stage=attention]')).toContainText('Review failed');await expect(page.locator('[data-stage=attention]')).toContainText('检视 失败');
    // Full screen: the page never scrolls; the long column scrolls inside itself.
    expect(await pageScrolls(page)).toBe(false);
    expect(await page.locator('[data-stage=reviewed] .board-column-list').evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
    await page.screenshot({path:'.tmp/board-evidence/board-issues.png'});
    await expect(page.locator('#board-columns')).not.toContainText('Closed experiment');
    await page.getByLabel('含已关闭',{exact:true}).check();await expect(page.locator('#board-columns')).toContainText('Closed experiment');
    await expect(page.locator('[data-card-key="101/issue/70"]')).toContainText('已关闭');await page.getByLabel('含已关闭',{exact:true}).uncheck();
    await expect(page.locator('#board-columns')).not.toContainText('Closed experiment');
    const original=h.store.all('SELECT id,status FROM tasks ORDER BY id');
    const card=page.locator('[data-card-key="101/issue/3"]');expect(await card.getAttribute('draggable')).toBe('false');
    await card.dispatchEvent('drop');expect(h.store.all('SELECT id,status FROM tasks ORDER BY id')).toEqual(original);
    await expect(card.getByRole('link',{name:'在 GitHub 打开 Issue #3'})).toHaveAttribute('href','https://github.com/fixture/project-101/issues/3');
    await card.getByRole('button',{name:'#3 Develop this Issue',exact:true}).click();
    await expect(page.locator('#board-object .board-task-row')).toHaveCount(2);await expect(page.locator('#board-object')).toContainText('正在开发');
    await expect(page.locator('#board-object').getByRole('link',{name:'在 GitHub 打开'})).toHaveAttribute('href','https://github.com/fixture/project-101/issues/3');
    await page.locator('#board-object').getByRole('button',{name:'查看任务详情'}).first().click();await expect(page.locator('#task-title')).toContainText('Issue #3');
    await page.locator('#task-actions').getByRole('button',{name:'关闭',exact:true}).click();
    await prs.click();await expect(prs).toHaveAttribute('aria-pressed','true');await expect(page.locator('.board-card')).toHaveCount(3);
    expect(await columns.locator('h2').allTextContents()).toEqual(['未检视','正在检视','已检视','正在跟进','已跟进','需要处理']);
    await expect(page.locator('[data-card-key*="/issue/"]')).toHaveCount(0);await expect(page.locator('[data-stage=unreviewed]')).toContainText('草稿');
    await page.screenshot({path:'.tmp/board-evidence/board-prs.png'});
    await page.getByLabel('搜索编号或标题',{exact:true}).fill('molecular');
    await expect(page.locator('.board-card')).toHaveCount(1);await expect(page.locator('.board-card')).toContainText('Draft molecular simulation');
    await expect(prs).toHaveText('PR 1');await expect(issues).toHaveText('Issue 0');
    await page.getByRole('button',{name:'更多视图操作'}).click();await page.getByRole('button',{name:'另存视图',exact:true}).click();
    await page.getByLabel('视图名称',{exact:true}).fill('Research');await page.getByRole('button',{name:'创建视图',exact:true}).click();
    await expect(page.getByLabel('视图',{exact:true})).not.toHaveValue('default');await expect(page.locator('.board-card')).toHaveCount(1);
    await expect(page.getByLabel('搜索编号或标题',{exact:true})).toHaveValue('molecular');
    await page.getByLabel('视图',{exact:true}).selectOption('default');await expect(page.locator('.board-card')).toHaveCount(3);
    await expect(page.getByLabel('搜索编号或标题',{exact:true})).toHaveValue('');
    await issues.click();await expect(page.locator('.board-card')).toHaveCount(25);
    await page.getByLabel('仓库',{exact:true}).selectOption('101');await expect(page.locator('.board-card')).toHaveCount(4);
    await expect(page.getByRole('button',{name:'保存视图',exact:true})).toBeVisible();await page.getByLabel('仓库',{exact:true}).selectOption('');
    await expect(page.getByRole('button',{name:'保存视图',exact:true})).toBeHidden();
    await page.getByRole('button',{name:'加列',exact:true}).click();await expect(page.locator('#board-form')).toContainText('不能增加或改名');
    await page.getByLabel('字段名称',{exact:true}).fill('优先级');await page.getByLabel('第一列名称',{exact:true}).fill('高优先级');
    await page.getByRole('button',{name:'创建字段和视图',exact:true}).click();await expect(page.getByLabel('分列',{exact:true})).not.toHaveValue('bot_stage');
    await expect(page.locator('[data-column-id=unassigned] .board-card')).toHaveCount(25);
    await page.getByRole('button',{name:'加列',exact:true}).click();await page.getByLabel('列名称',{exact:true}).fill('稍后安排');await page.getByRole('button',{name:'添加列',exact:true}).click();
    const high=page.locator('.board-column').filter({has:page.getByRole('heading',{name:'高优先级',exact:true})});
    const later=page.locator('.board-column').filter({has:page.getByRole('heading',{name:'稍后安排',exact:true})});
    await expect(high.locator('.board-card')).toHaveCount(0);await expect(later.locator('.board-card')).toHaveCount(0);
    await page.locator('[data-card-key="101/issue/3"]').getByLabel('拖动卡片',{exact:true}).dragTo(high);
    await expect(high.locator('[data-card-key="101/issue/3"]')).toHaveCount(1);await expect(high).toContainText('正在开发');
    expect(h.store.all('SELECT id,status FROM tasks ORDER BY id')).toEqual(original);
    const option=h.store.get("SELECT id FROM board_options WHERE name='稍后安排'").id;
    await high.getByLabel('优先级',{exact:true}).selectOption(option);await expect(later.locator('[data-card-key="101/issue/3"]')).toHaveCount(1);
    await page.getByRole('button',{name:'折叠 高优先级',exact:true}).click();await expect(high).toHaveClass(/board-collapsed/);
    await page.getByRole('button',{name:'保存视图',exact:true}).click();await expect(page.getByRole('button',{name:'保存视图',exact:true})).toBeHidden();
    await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(high).toHaveClass(/board-collapsed/);await expect(later.locator('.board-card')).toHaveCount(1);
    await page.screenshot({path:'.tmp/board-evidence/board-custom.png'});
    await page.getByLabel('视图',{exact:true}).selectOption('default');await page.setViewportSize({width:1920,height:1000});
    await expect(page.locator('.board-column')).toHaveCount(6);expect(await pageScrolls(page)).toBe(false);await page.screenshot({path:'.tmp/board-evidence/board-desktop.png'});
    // The periodic refresh picks up a task that starts while the board is open.
    boardTask(h.store,'late',9,'review.issue','running',{repo:'202',title:'Arrived while watching',time:'2026-10-05T12:00:00.000Z'});
    await page.evaluate(()=>boardPoll());await expect(page.locator('[data-stage=reviewing]')).toContainText('Arrived while watching');
    await page.setViewportSize({width:390,height:844});expect(await pageScrolls(page)).toBe(false);
    expect(await page.locator('#board-columns').evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);await page.screenshot({path:'.tmp/board-evidence/board-mobile.png'});
    const memberPassword=testPassword();await admin('/api/users','POST',{username:'board-member',password:memberPassword,repository_ids:['101']});
    const context=await browser.newContext(),member=await context.newPage();
    try{
      await login(member,h.admin,'board-member',memberPassword);await expect(member.locator('.board-card')).toHaveCount(4);
      await expect(member.getByRole('button',{name:/^PR/})).toHaveText('PR 3');
      await expect(member.locator('#board-columns')).not.toContainText('Foreign private card');await expect(member.locator('[data-card-key^="202/"]')).toHaveCount(0);
      await member.screenshot({path:'.tmp/board-evidence/board-member.png'});
      await expect(member.getByLabel('视图',{exact:true}).locator('option')).toHaveCount(1);expect(await member.getByLabel('分列',{exact:true}).locator('option').count()).toBe(1);
      expect(await member.getByLabel('仓库',{exact:true}).locator('option').allTextContents()).toEqual(['全部仓库','fixture/project-101']);
    }finally{await context.close();}
    await page.setViewportSize({width:1600,height:900});
    await page.locator('header').getByRole('button',{name:'检视',exact:true}).click();await expect(page.getByRole('heading',{name:'检视任务',exact:true})).toBeVisible();
    await page.locator('header').getByRole('button',{name:'开发',exact:true}).click();await expect(page.getByRole('heading',{name:'开发任务',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.body.classList.contains('board-mode'))).toBe(false);await page.screenshot({path:'.tmp/board-evidence/developments.png'});
    expect(errors).toEqual([]);
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
