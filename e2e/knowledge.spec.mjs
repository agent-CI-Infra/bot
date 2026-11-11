import { test, expect } from '@playwright/test';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { managerFixture } from '../test/project-manager-fixture.mjs';

async function fixture(page) {
  const cleanup=[],f=await managerFixture({after:fn=>cleanup.push(fn)}),h=await harness(undefined,f.manager),{admin,password}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');const errors=[];page.on('pageerror',e=>errors.push(e.message));
  return {h,admin,errors,notesRoot:f.projects.notesRoot,async login(){await page.goto(h.admin+'/#/projects/101/notes');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.knowledge-workspace')).toBeVisible();},async close(){await h.stop();await rm(h.directory,{recursive:true,force:true});for(const fn of cleanup.reverse())await fn();}};
}
const panel=page=>page.locator('.knowledge-main');
const exact=(page,name)=>page.getByRole('button',{name,exact:true});
async function createFolder(page,name){await exact(page,'新建文件夹').click();await page.getByRole('dialog').getByLabel('文件夹名称',{exact:true}).fill(name);await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);}
async function edit(page,content){await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill(content);await exact(page,'保存文件').click();await expect(page.locator('.knowledge-editor')).toHaveCount(0);}

test('real directories, stable file ids, safe previews and mobile version restore remain usable',async({page})=>{
  test.setTimeout(90000);const f=await fixture(page);
  try{
    const base='/api/repositories/101/knowledge-files';await f.admin('/api/repositories/101/notes/old.txt','PUT',{content:'old\r\nfree file\r\n'});
    await f.admin('/api/repositories/101/memories','POST',{key:'legacy',kind:'experience',body:'old knowledge body',sources:[{reference:'legacy source'}],expected_revision:0,reason:'fixture',catalog:{title:'原有知识'}});
    await f.login();await expect(page).toHaveURL(/\/knowledge$/);await exact(page,'old.txt').click();await exact(page,'编辑文件').click();await exact(page,'保存文件').click();
    expect((await f.admin('/api/repositories/101/notes/old.txt')).value.content).toBe('old\r\nfree file\r\n');await exact(page,'← 返回目录').click();
    await createFolder(page,'手册');await panel(page).getByRole('button',{name:'▱ 手册',exact:true}).click();await expect(panel(page).getByText('这个目录是空的。',{exact:true})).toBeVisible();
    await exact(page,'新建文件').click();await page.getByLabel('文件名',{exact:true}).fill('开始.md');const original='# 项目手册\n\n保留完整内容。\n\n<script>window.fileExecuted=1</script>\n<img src=x onerror="window.fileExecuted=2">\n[危险链接](javascript:alert(1))';await page.getByLabel('内容',{exact:true}).fill(original);await exact(page,'保存文件').click();
    await expect(panel(page).getByRole('heading',{name:'开始.md',exact:true})).toBeVisible();await expect(page.locator('.knowledge-content')).toContainText('项目手册');expect(await page.evaluate(()=>window.fileExecuted)).toBeUndefined();await expect(page.locator('.knowledge-content script,.knowledge-content img,.knowledge-content a[href^="javascript:"]')).toHaveCount(0);
    const file=(await f.admin(base+'?directory='+encodeURIComponent('手册'))).value.files[0];await edit(page,'# 第二版\n\n新的内容。');
    await page.getByText('更多操作',{exact:true}).click();await exact(page,'重命名或移动').click();await page.getByRole('dialog').getByLabel('目标路径',{exact:true}).fill('手册/重命名.md');await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();await expect(panel(page).getByRole('heading',{name:'重命名.md',exact:true})).toBeVisible();
    expect((await f.admin(base+'/'+encodeURIComponent(file.id))).value.file.path).toBe('手册/重命名.md');
    await page.setViewportSize({width:390,height:844});await exact(page,'历史版本').click();await expect(page.getByRole('complementary',{name:'文件历史'})).toBeVisible();await exact(page,'v1').click();await expect(page.getByText('正在查看 v1 · 只读，当前仍为 v3',{exact:true})).toBeVisible();await expect(exact(page,'编辑文件')).toHaveCount(0);
    await exact(page,'恢复此版本').click();await page.getByRole('dialog').getByRole('button',{name:'恢复版本',exact:true}).click();await expect(page.getByText(/^v4 ·/)).toBeVisible();expect((await f.admin(base+'/'+encodeURIComponent(file.id))).value.file.content).toBe(original);
    const download=page.waitForEvent('download');await exact(page,'下载文件').click();expect((await download).suggestedFilename()).toBe('重命名.md');
    await page.getByText('更多操作',{exact:true}).click();await exact(page,'删除文件').click();await page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();await expect(page.getByText('文件已删除。打开历史版本，选择删除前的版本即可恢复。',{exact:true})).toBeVisible();
    await exact(page,'历史版本').click();await exact(page,'v4').click();await exact(page,'恢复此版本').click();await page.getByRole('dialog').getByRole('button',{name:'恢复版本',exact:true}).click();await expect(page.getByText(/^v6 ·/)).toBeVisible();
    await exact(page,'← 返回目录').click();await page.reload();await expect(panel(page).getByRole('button',{name:'重命名.md',exact:true})).toBeVisible();expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('conflict comparisons preserve drafts and navigation asks before leaving unsaved content',async({page})=>{
  test.setTimeout(60000);const f=await fixture(page);
  try{
    const base='/api/repositories/101/knowledge-files',file=(await f.admin(base,'POST',{name:'draft.txt',content:'version one'})).value.file,endpoint=base+'/'+encodeURIComponent(file.id);
    await f.login();await exact(page,'draft.txt').click();await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill('my unsaved draft');
    await exact(page,'← 返回目录').click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByLabel('内容',{exact:true})).toHaveValue('my unsaved draft');
    await f.admin(endpoint,'PUT',{content:'another writer',expected_revision:1});await exact(page,'保存文件').click();await expect(page.getByLabel('内容',{exact:true})).toHaveValue('my unsaved draft');await expect(page.locator('.knowledge-conflict')).toContainText('another writer');await expect(page.locator('.knowledge-status')).toContainText('草稿已保留');
    await exact(page,'基于 v2 保存草稿').click();await page.getByRole('dialog').getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.locator('.knowledge-content')).toContainText('my unsaved draft');expect((await f.admin(endpoint)).value.file.revision).toBe(3);
    await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill('kept after route return');await page.locator('#console-secondary-nav').getByRole('link',{name:'项目总览',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'离开文件',exact:true}).click();await expect(page).toHaveURL(/\/overview$/);
    await page.goto(f.h.admin+'/#/projects/101/knowledge');await expect(page.getByLabel('内容',{exact:true})).toHaveValue('kept after route return');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('six widths handle long paths and text, and failed reads retry without exposing revoked content',async({page})=>{
  test.setTimeout(60000);const f=await fixture(page);
  try{
    const name='很长的文件名称用于检查窄屏换行和目录定位.txt';await f.admin('/api/repositories/101/knowledge-files','POST',{name,content:'long-line-'+ 'x'.repeat(4000)+'\n\n完整文本'});
    await f.login();await exact(page,name).click();await mkdir('.tmp/knowledge-files-232/screenshots',{recursive:true});
    for(const width of [320,390,768,1024,1440,1920]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),String(width)).toBe(true);if([390,1440].includes(width))await page.screenshot({path:'.tmp/knowledge-files-232/screenshots/'+width+'.png',fullPage:true});}
    await exact(page,'← 返回目录').click();await page.route('**/api/repositories/101/knowledge-files?*',route=>route.fulfill({status:503,json:{error:'fixture_unavailable'}}));await exact(page,'刷新文件').click();await expect(page.locator('.knowledge-status')).toContainText('fixture_unavailable');await page.unroute('**/api/repositories/101/knowledge-files?*');await exact(page,'重试读取').click();await expect(exact(page,name)).toBeVisible();
    await page.route('**/api/repositories/101/knowledge-files/*',route=>route.fulfill({status:403,json:{error:'capability_forbidden'}}));await exact(page,name).click();await expect(page.locator('.knowledge-status')).toContainText('文件访问权限已失效');await expect(page.locator('.knowledge-content')).toHaveCount(0);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('late file content cannot redraw a different project section',async({page})=>{
  const f=await fixture(page);let release;
  try{
    await f.admin('/api/repositories/101/knowledge-files','POST',{name:'late.txt',content:'private delayed content'});await f.login();
    const gate=new Promise(resolve=>{release=resolve;});await page.route('**/api/repositories/101/knowledge-files/*',async route=>{await gate;await route.continue();});
    await exact(page,'late.txt').click();await page.locator('#console-secondary-nav').getByRole('link',{name:'项目总览',exact:true}).click();await expect(page).toHaveURL(/\/overview$/);
    // Drain the delayed read before removing its backing project directory.
    const delayedResponse=page.waitForResponse(response=>response.url().includes('/api/repositories/101/knowledge-files/'));release();await(await delayedResponse).finished();
    await expect(page.locator('.workspace-overview')).toBeVisible();await expect(page.locator('.knowledge-workspace')).toHaveCount(0);await expect(page.getByText('private delayed content',{exact:true})).toHaveCount(0);expect(f.errors).toEqual([]);
  }finally{release?.();await f.close();}
});

test('sidebar navigation, browser back, short screens and logout respect unsaved drafts',async({page})=>{
  test.setTimeout(60000);const f=await fixture(page);
  try{
    await f.admin('/api/repositories/101/knowledge-files','POST',{name:'navigation.txt',content:'saved'});await f.login();await exact(page,'navigation.txt').click();await exact(page,'历史版本').click();await page.goBack();await expect(page.locator('.knowledge-workspace')).toHaveAttribute('data-scene','preview');await page.goBack();await expect(exact(page,'navigation.txt')).toBeVisible();
    await exact(page,'navigation.txt').click();await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill('retained');
    await page.locator('#tabs').getByRole('button',{name:'看板',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByLabel('内容',{exact:true})).toHaveValue('retained');
    await page.setViewportSize({width:320,height:430});await page.getByLabel('内容',{exact:true}).focus();await exact(page,'保存文件').scrollIntoViewIfNeeded();const box=await exact(page,'保存文件').boundingBox(),nav=await page.locator('#console-mobile-nav').boundingBox();expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(nav ? nav.y+1 : 431);
    await exact(page,'保存文件').click();await expect(page.locator('.knowledge-content')).toContainText('retained');await page.setViewportSize({width:1440,height:900});await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill('discard at logout');
    await exact(page,'退出登录').click();await page.getByRole('dialog').getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.getByRole('heading',{name:'登录',exact:true})).toBeVisible();expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('binary downloads keep raw bytes and useful previews share the console layout',async({page})=>{
  test.setTimeout(60000);const f=await fixture(page);
  try{
    const base='/api/repositories/101/knowledge-files',dirs='/api/repositories/101/knowledge-directories';
    await f.admin(dirs,'POST',{path:'指南'});await f.admin(dirs,'POST',{path:'指南/归档'});
    const file=(await f.admin(base,'POST',{path:'指南/项目约定.md',content:'# 项目约定\n\n开始工作前，请先确认当前项目与执行环境。\n\n## 验证与交付\n\n- 修改前同步主干，使用独立分支。\n- 保存真实验证结果，保留需要追踪的版本。\n- 版本冲突时先比较最新正文。\n\n```sh\nnpm run check\nnpm test\n```\n\n## 常用入口\n\n| 入口 | 用途 |\n| --- | --- |\n| 项目总览 | 查看正在推进的工作 |\n| 运行状态 | 跟踪任务与公开日志 |\n'})).value.file;
    await f.admin(base,'POST',{path:'指南/commands.txt',content:'npm run check\nnpm test\n'});
    const raw=Buffer.from([0,255,254,10,65]);await writeFile(f.notesRoot+'/101/binary.data',raw);
    await f.login();await exact(page,'binary.data').click();await expect(page.locator('.knowledge-content')).toContainText('这种格式无法在此预览或编辑');await expect(exact(page,'编辑文件')).toHaveCount(0);
    const promise=page.waitForEvent('download');await exact(page,'下载文件').click();expect(await readFile(await(await promise).path())).toEqual(raw);
    await exact(page,'← 返回目录').click();await panel(page).getByRole('button',{name:'▱ 指南',exact:true}).click();await exact(page,'项目约定.md').click();await mkdir('.tmp/knowledge-files-232/previews',{recursive:true});
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/knowledge-files-232/previews/console-knowledge-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.tmp/knowledge-files-232/previews/console-knowledge-mobile.png',fullPage:true});
    await exact(page,'历史版本').click();await expect(page.getByRole('complementary',{name:'文件历史'})).toBeVisible();await exact(page,'v1').click();await expect(page.locator('.knowledge-content')).toContainText('验证与交付');expect((await f.admin(base+'/'+encodeURIComponent(file.id))).value.file.revision).toBe(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a saved editor waits for the authoritative file read before exposing its next actions',async({page})=>{
  const f=await fixture(page);let release;
  try{
    const file=(await f.admin('/api/repositories/101/knowledge-files','POST',{name:'refresh.txt',content:'before'})).value.file;
    await f.login();await exact(page,'refresh.txt').click();await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill('after');
    const gate=new Promise(resolve=>{release=resolve;});let seen;const waiting=new Promise(resolve=>{seen=resolve;});
    await page.route('**/knowledge-files/'+encodeURIComponent(file.id),async route=>{if(route.request().method()==='GET'){seen();await gate;}await route.continue();});
    await exact(page,'保存文件').click();await waiting;await expect(page.locator('.knowledge-editor')).toHaveCount(1);await expect(exact(page,'重命名或移动')).toHaveCount(0);release();
    await expect(page.locator('.knowledge-content')).toContainText('after');await page.getByText('更多操作',{exact:true}).click();await exact(page,'重命名或移动').click();await expect(page.getByRole('dialog')).toBeVisible();expect(f.errors).toEqual([]);
  }finally{release?.();await f.close();}
});

test('a deleted file path cannot become a folder and the workspace remains usable after the conflict',async({page})=>{
 const f=await fixture(page);
 try{
  const base='/api/repositories/101/knowledge-files',file=(await f.admin(base,'POST',{name:'reserved.txt',content:'old content'})).value.file;
  await f.admin(base+'/'+encodeURIComponent(file.id),'DELETE',{expected_revision:1});await f.admin(base,'POST',{name:'healthy.txt',content:'still available'});await f.login();
  await exact(page,'新建文件夹').click();const dialog=page.getByRole('dialog');await dialog.getByLabel('文件夹名称',{exact:true}).fill('reserved.txt');await dialog.getByRole('button',{name:'确认',exact:true}).click();await expect(dialog).toContainText('note_path_conflict');await expect(dialog.getByLabel('文件夹名称',{exact:true})).toHaveValue('reserved.txt');await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await exact(page,'healthy.txt').click();await expect(page.locator('.knowledge-content')).toContainText('still available');expect((await f.admin(base+'?deleted_only=1')).value.files[0].id).toBe(file.id);expect(f.errors).toEqual([]);
 }finally{await f.close();}
});

test('an uncertain move explains why retries cannot unlock the project knowledge volume',async({page})=>{
 const f=await fixture(page);
 try{
  await page.route('**/api/repositories/101/knowledge-files?*',route=>route.fulfill({status:409,json:{error:'note_move_uncertain'}}));await f.login();
  await expect(page.locator('.knowledge-status')).toContainText('本项目知识区已暂停读写');await expect(page.locator('.knowledge-status')).toContainText('一致的完整知识卷');await exact(page,'重试读取').click();await expect(page.locator('.knowledge-status')).toContainText('重试不会解除此状态');expect(f.errors).toEqual([]);
 }finally{await f.close();}
});
