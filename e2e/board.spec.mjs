import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { boardFixtures } from '../test/board-fixtures.mjs';

async function login(page,url,username,password){
  await page.goto(url);await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'看板',exact:true}).click();
  await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy','true');
}
test('看板按对象去重、保存筛选和个人视图，自定义字段拖动不改 bot 阶段',async({page,browser})=>{
  const h=await harness(),{admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');boardFixtures(h.store);
  const errors=[];page.on('pageerror',err=>errors.push(err.message));mkdirSync('.tmp/board-evidence',{recursive:true});
  try{
    await h.hook(a.path,a.secret,'draft',{repository:{id:101},pull_request:{number:60,title:'Draft molecular simulation',draft:true,state:'open'}},{'X-GitHub-Event':'pull_request'});
    await h.hook(a.path,a.secret,'closed',{repository:{id:101},issue:{number:70,title:'Closed experiment',state:'closed'}});
    await login(page,h.admin,'administrator',password);
    const columns=page.locator('.board-column');
    await expect(columns).toHaveCount(6);expect(await columns.locator('h2').allTextContents()).toEqual(['未检视','正在检视','已检视','正在开发','已开发','需要处理']);
    await expect(page.locator('[data-card-key="101/issue/3"]')).toHaveCount(1);
    await expect(page.locator('[data-stage=developing]')).toContainText('Develop this Issue');
    await expect(page.locator('[data-stage=developed]')).toContainText('Development has PR');
    await expect(page.locator('[data-stage=attention]')).toContainText('Review failed');
    await expect(page.locator('[data-stage=unreviewed]')).toContainText('草稿');
    await expect(page.locator('#board-columns')).not.toContainText('Closed experiment');
    const original=h.store.all('SELECT id,status FROM tasks ORDER BY id');
    const card=page.locator('[data-card-key="101/issue/3"]');expect(await card.getAttribute('draggable')).toBe('false');
    await card.dispatchEvent('drop');expect(h.store.all('SELECT id,status FROM tasks ORDER BY id')).toEqual(original);
    await card.getByRole('button',{name:'Develop this Issue',exact:true}).click();
    await expect(page.locator('#board-object .board-task-row')).toHaveCount(2);
    await expect(page.locator('#board-object').getByRole('link',{name:'在 GitHub 打开'})).toHaveAttribute('href','https://github.com/fixture/project-101/issues/3');
    await page.locator('#board-object').getByRole('button',{name:'查看任务详情'}).first().click();await expect(page.locator('#task-title')).toContainText('Issue #3');
    await page.locator('#task-actions').getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByRole('button',{name:'添加筛选',exact:true}).click();await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await expect(page.locator('.board-card')).toHaveCount(3);await expect(page.locator('#board-columns')).not.toContainText('Only successful review');
    await page.getByRole('button',{name:'添加筛选',exact:true}).click();await page.getByLabel('筛选条件 2',{exact:true}).selectOption('text');
    await page.getByLabel('条件值 2',{exact:true}).fill('molecular');await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await expect(page.locator('.board-card')).toHaveCount(1);await expect(page.locator('.board-card')).toContainText('Draft molecular simulation');
    await page.screenshot({path:'.tmp/board-evidence/board-filtered.png',fullPage:true});
    await page.getByRole('button',{name:'另存视图',exact:true}).click();await page.getByLabel('视图名称',{exact:true}).fill('Research PRs');
    await page.getByRole('button',{name:'创建视图',exact:true}).click();await expect(page.getByLabel('视图',{exact:true})).not.toHaveValue('default');
    await expect(page.locator('.board-card')).toHaveCount(1);
    await page.getByLabel('视图',{exact:true}).selectOption('default');await expect(page.locator('.board-card')).toHaveCount(8);
    await page.getByRole('button',{name:'加列',exact:true}).click();await expect(page.locator('#board-form')).toContainText('不能增加或改名');
    await page.getByLabel('字段名称',{exact:true}).fill('优先级');await page.getByLabel('第一列名称',{exact:true}).fill('高优先级');
    await page.getByRole('button',{name:'创建字段和视图',exact:true}).click();await expect(page.getByLabel('按字段分列',{exact:true})).not.toHaveValue('bot_stage');
    await expect(page.locator('[data-column-id=unassigned] .board-card')).toHaveCount(8);
    await page.getByRole('button',{name:'加列',exact:true}).click();await page.getByLabel('列名称',{exact:true}).fill('稍后安排');await page.getByRole('button',{name:'添加列',exact:true}).click();
    const high=page.locator('.board-column').filter({has:page.getByRole('heading',{name:'高优先级',exact:true})});
    const later=page.locator('.board-column').filter({has:page.getByRole('heading',{name:'稍后安排',exact:true})});
    await expect(high.locator('.board-card')).toHaveCount(0);await expect(later.locator('.board-card')).toHaveCount(0);
    await page.locator('[data-card-key="101/issue/3"]').getByLabel('拖动卡片',{exact:true}).dragTo(high);
    await expect(high.locator('[data-card-key="101/issue/3"]')).toHaveCount(1);await expect(high).toContainText('正在开发');
    expect(h.store.all('SELECT id,status FROM tasks ORDER BY id')).toEqual(original);
    const option=h.store.get("SELECT id FROM board_options WHERE name='稍后安排'").id;
    await high.getByLabel('优先级',{exact:true}).selectOption(option);await expect(later.locator('[data-card-key="101/issue/3"]')).toHaveCount(1);
    await page.locator('#board-column-settings summary').click();await page.getByRole('checkbox',{name:'高优先级',exact:true}).uncheck();await page.getByRole('button',{name:'保存视图',exact:true}).click();
    await expect(high).toHaveCount(0);await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(high).toHaveCount(0);await expect(later.locator('.board-card')).toHaveCount(1);
    await page.screenshot({path:'.tmp/board-evidence/board-custom.png',fullPage:true});
    await page.getByLabel('视图',{exact:true}).selectOption('default');await page.setViewportSize({width:1920,height:1000});
    await expect(page.locator('.board-column')).toHaveCount(6);await page.screenshot({path:'.tmp/board-evidence/board-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.locator('#board-columns').evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);await page.screenshot({path:'.tmp/board-evidence/board-mobile.png',fullPage:true});
    const memberPassword=testPassword();await admin('/api/users','POST',{username:'board-member',password:memberPassword,repository_ids:['101']});
    const context=await browser.newContext(),member=await context.newPage();
    try{
      await login(member,h.admin,'board-member',memberPassword);await expect(member.locator('.board-card')).toHaveCount(7);
      await expect(member.locator('#board-columns')).not.toContainText('Foreign private card');await expect(member.locator('[data-card-key^="202/"]')).toHaveCount(0);
      await member.screenshot({path:'.tmp/board-evidence/board-member.png',fullPage:true});
      await expect(member.getByLabel('视图',{exact:true}).locator('option')).toHaveCount(1);expect(await member.getByLabel('按字段分列',{exact:true}).locator('option').count()).toBe(1);
      await member.getByRole('button',{name:'添加筛选',exact:true}).click();await member.getByLabel('筛选条件 1',{exact:true}).selectOption('repository_id');
      expect(await member.getByLabel('条件值 1',{exact:true}).locator('option').allTextContents()).toEqual(['fixture/project-101']);
      await member.getByRole('button',{name:'应用筛选',exact:true}).click();await expect(member.locator('[data-card-key^="202/"]')).toHaveCount(0);
    }finally{await context.close();}
    await page.getByRole('button',{name:'检视',exact:true}).click();await expect(page.getByRole('heading',{name:'检视任务',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'开发',exact:true}).click();await expect(page.getByRole('heading',{name:'开发任务',exact:true})).toBeVisible();expect(errors).toEqual([]);
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
