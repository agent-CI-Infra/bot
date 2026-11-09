import { test, expect } from '@playwright/test';
import { mkdir, rm } from 'node:fs/promises';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { managerFixture } from '../test/project-manager-fixture.mjs';

test('项目知识统一自由文件，旧入口跳转，版本可恢复且不覆盖并发修改', async ({page})=>{
  const cleanup=[],f=await managerFixture({after:fn=>cleanup.push(fn)}),h=await harness(undefined,f.manager),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await mkdir('.tmp/knowledge-files/screenshots',{recursive:true});
  try {
    const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
    await admin('/api/repositories/101/notes/old.txt','PUT',{content:'old\r\nfree file\r\n'});
    await admin('/api/repositories/101/memories','POST',{key:'legacy',kind:'experience',body:'old knowledge body',sources:[{reference:'legacy source'}],expected_revision:0,reason:'fixture',catalog:{title:'原有知识'}});
    await page.goto(h.admin+'/#/projects/101/notes');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page).toHaveURL(/\/knowledge$/);await expect(page.getByRole('link',{name:'项目笔记',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'old.txt',exact:true})).toBeVisible();await page.getByRole('button',{name:'old.txt',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();expect((await admin('/api/repositories/101/notes/old.txt')).value.content).toBe('old\r\nfree file\r\n');await page.getByRole('button',{name:/^原有知识--/}).click();await expect(page.getByLabel('内容',{exact:true})).toHaveValue('old knowledge body');
    await expect(page.getByLabel('知识类型',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'复核／改变状态',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'新建文件',exact:true}).click();await page.getByLabel('文件名',{exact:true}).fill('自由笔记.txt');const original='{\n  "自由格式": true\n}\n';await page.getByLabel('内容',{exact:true}).fill(original);await page.getByRole('button',{name:'保存',exact:true}).click();
    await expect(page.getByRole('heading',{name:'自由笔记.txt',exact:true})).toBeVisible();await page.getByLabel('内容',{exact:true}).fill('second version');await page.getByRole('button',{name:'保存',exact:true}).click();
    await expect(page.getByLabel('历史版本',{exact:true})).toHaveValue('2');await page.getByLabel('历史版本',{exact:true}).selectOption('1');await expect(page.getByLabel('内容',{exact:true})).toHaveValue(original);await expect(page.getByLabel('内容',{exact:true})).toHaveAttribute('readonly','');
    await page.getByRole('button',{name:'恢复此版本',exact:true}).click();await expect(page.getByLabel('历史版本',{exact:true})).toHaveValue('3');await expect(page.getByLabel('内容',{exact:true})).toHaveValue(original);
    const files=(await admin('/api/repositories/101/knowledge-files')).value.files,file=files.find(f=>f.name==='自由笔记.txt');
    await admin('/api/repositories/101/knowledge-files/'+encodeURIComponent(file.id),'PUT',{content:'another writer',expected_revision:3});
    await page.getByLabel('内容',{exact:true}).fill('stale editor');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByText('文件已被其他操作更新，请刷新后再保存。',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'自由笔记.txt',exact:true}).click();await expect(page.getByLabel('内容',{exact:true})).toHaveValue('another writer');
    await page.getByRole('button',{name:'删除文件',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();await expect(page.getByText('文件已删除。选择删除前的版本即可恢复。',{exact:true})).toBeVisible();
    await page.getByLabel('历史版本',{exact:true}).selectOption('4');await page.getByRole('button',{name:'恢复此版本',exact:true}).click();await expect(page.getByLabel('历史版本',{exact:true})).toHaveValue('6');
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载文件',exact:true}).click();expect((await download).suggestedFilename()).toBe('自由笔记.txt');
    await page.screenshot({path:'.tmp/knowledge-files/screenshots/desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tmp/knowledge-files/screenshots/mobile.png',fullPage:true});expect(errors).toEqual([]);
  } finally {await h.stop();await rm(h.directory,{recursive:true,force:true});for(const fn of cleanup.reverse())await fn();}
});
