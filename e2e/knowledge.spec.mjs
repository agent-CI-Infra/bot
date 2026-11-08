import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

test('管理员从项目知识页查别名、读历史、复核并观察并发冲突', async ({ page }) => {
  const h=await harness(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  mkdirSync('.tmp/knowledge-173/screenshots',{recursive:true});
  try {
    const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
    await page.goto(h.admin+'/#/projects/101/knowledge');
    await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByRole('button',{name:'新建知识',exact:true}).click();
    await page.getByLabel('条目标识',{exact:true}).fill('transport.retry');await page.getByLabel('标题',{exact:true}).fill('网络重试经验');
    await page.getByLabel('正文',{exact:true}).fill('先确认重试次数与失败条件，再重试网络请求。');await page.getByLabel('别名（逗号分隔）',{exact:true}).fill('socket reset, ECONNRESET');
    await page.getByLabel('目录／文件路径',{exact:true}).fill('src/net/client.ts');await page.getByLabel('适用模块',{exact:true}).last().fill('transport');
    await page.getByLabel('来源与环境（JSON 列表）',{exact:true}).fill(JSON.stringify([{reference:'check:local-network-fixture',environment:{node:'22'}}]));await page.getByLabel('修改原因',{exact:true}).fill('记录可复现的失败条件');
    await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('heading',{name:'网络重试经验',exact:true})).toBeVisible();
    await page.getByLabel('搜索',{exact:true}).fill('ECONNRESET');await page.getByRole('button',{name:'搜索知识',exact:true}).click();await expect(page.getByRole('button',{name:'网络重试经验',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'复核／改变状态',exact:true}).click();await page.getByLabel('证据引用（每行一条检查结果、运行产物或来源）',{exact:true}).fill('check:local-network-fixture/output#42');await page.getByLabel('原因',{exact:true}).fill('已独立复现失败并核对日志');await page.getByRole('button',{name:'保存',exact:true}).click();
    await expect(page.getByText(/状态 active（当前 active） · observed/)).toBeVisible();
    await page.getByLabel('查看历史版本',{exact:true}).selectOption('1');await expect(page.getByText(/human_asserted/).last()).toBeVisible();
    await page.getByLabel('查看历史版本',{exact:true}).selectOption('2');await page.getByRole('button',{name:'编辑条目',exact:true}).click();
    const current=(await admin('/api/repositories/101/memories')).value.items[0];await admin('/api/repositories/101/memories/'+current.id,'PATCH',{expected_revision:2,reason:'另一个管理员更新标题',catalog:{title:'新的网络重试经验'}});
    await page.getByLabel('修改原因',{exact:true}).fill('过期页面上的修改');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByText(/memory_revision_changed/)).toBeVisible();
    await page.getByRole('button',{name:'搜索知识',exact:true}).click();await page.getByRole('button',{name:'新的网络重试经验',exact:true}).click();
    await page.screenshot({path:'.tmp/knowledge-173/screenshots/desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect((await page.locator('.knowledge-list li').first().getByRole('button').boundingBox()).height).toBeLessThan(60);await page.screenshot({path:'.tmp/knowledge-173/screenshots/mobile.png',fullPage:true});
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出当前视图',exact:true}).click();await expect((await download).suggestedFilename()).toBe('project-knowledge.json');
    expect(errors).toEqual([]);
  } finally { await h.stop();rmSync(h.directory,{recursive:true,force:true}); }
});
