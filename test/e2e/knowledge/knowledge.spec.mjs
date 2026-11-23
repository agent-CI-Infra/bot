import { test, expect } from '@playwright/test';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { managerFixture } from '../../fixtures/project-manager-fixture.mjs';
import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';

async function fixture(page) {
  const cleanup=[],f=await managerFixture({after:fn=>cleanup.push(fn)}),h=await harness(undefined,f.manager),{admin,password}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');const errors=[];page.on('pageerror',e=>errors.push(e.message));
  return {h,admin,errors,notesRoot:f.projects.notesRoot,async login(){await page.goto(h.admin+'/#/projects/101/notes');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.knowledge-workspace')).toBeVisible();},async close(){await h.stop();await rm(h.directory,{recursive:true,force:true});for(const fn of cleanup.reverse())await fn();}};
}
const panel=page=>page.locator('.knowledge-main');
const exact=(page,name)=>page.getByRole('button',{name,exact:true});
const tree=page=>page.getByRole('complementary',{name:'文件目录',exact:true});
const treeFile=(page,path)=>exact(tree(page),'文件 '+path);
const treeFolder=(page,path)=>exact(tree(page),'目录 '+path);
async function createFolder(page,name){await exact(page,'新建文件夹').click();await page.getByRole('dialog').getByLabel('文件夹名称',{exact:true}).fill(name);await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);}
async function edit(page,content){await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill(content);await exact(page,'保存文件').click();await expect(page.locator('.knowledge-editor')).toHaveCount(0);}

test('real directories, stable file ids, safe previews and mobile version restore remain usable',async({page})=>{
  test.setTimeout(90000);const f=await fixture(page);
  try{
    const base='/api/repositories/101/knowledge-files';await f.admin('/api/repositories/101/notes/old.txt','PUT',{content:'old\r\nfree file\r\n'});
    f.h.store.db.exec('CREATE TABLE IF NOT EXISTS project_memories(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,fact_key TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL)');
    f.h.store.run("INSERT INTO project_memories VALUES('legacy01','101','legacy',1,?,'2026-01-01T00:00:00Z')",JSON.stringify({kind:'experience',status:'active',body:'old knowledge body',catalog:{title:'原有知识'}}));
    await f.login();await expect(page).toHaveURL(/\/knowledge$/);await treeFile(page,'old.txt').click();await exact(page,'编辑文件').click();await exact(page,'保存文件').click();
    expect((await f.admin('/api/repositories/101/notes/old.txt')).value.content).toBe('old\r\nfree file\r\n');await exact(page,'← 返回目录').click();
    await createFolder(page,'手册');await treeFolder(page,'手册').click();await expect(panel(page).getByText('这个目录是空的。',{exact:true})).toBeVisible();
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
    await exact(page,'← 返回目录').click();await page.reload();await expect(treeFile(page,'手册/重命名.md')).toBeVisible();expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('conflict comparisons preserve drafts and navigation asks before leaving unsaved content',async({page})=>{
  test.setTimeout(60000);const f=await fixture(page);
  try{
    const a=(await f.admin('/api/accounts')).value.accounts[0];await repository(f.admin,a.id,'202');
    const base='/api/repositories/101/knowledge-files',file=(await f.admin(base,'POST',{name:'draft.txt',content:'version one'})).value.file,endpoint=base+'/'+encodeURIComponent(file.id);
    await f.login();await treeFile(page,'draft.txt').click();await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill('my unsaved draft');
    await exact(page,'← 返回目录').click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByLabel('内容',{exact:true})).toHaveValue('my unsaved draft');
    await f.admin(endpoint,'PUT',{content:'another writer',expected_revision:1});await exact(page,'保存文件').click();await expect(page.getByLabel('内容',{exact:true})).toHaveValue('my unsaved draft');await expect(page.locator('.knowledge-conflict')).toContainText('another writer');await expect(page.locator('.knowledge-status')).toContainText('草稿已保留');
    await exact(page,'基于 v2 保存草稿').click();await page.getByRole('dialog').getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.locator('.knowledge-content')).toContainText('my unsaved draft');expect((await f.admin(endpoint)).value.file.revision).toBe(3);
    await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill('kept after route return');await page.locator('#tabs').getByRole('link',{name:'项目总览',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'离开文件',exact:true}).click();await expect(page).toHaveURL(/\/overview$/);
    await page.goto(f.h.admin+'/#/projects/101/knowledge');await expect(page.getByLabel('内容',{exact:true})).toHaveValue('kept after route return');
    // Scope switching uses the same guard: cancellation keeps both the editor and the shared default in this project.
    await switchConsoleProject(page,'202',{waitForNavigation:false});await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
    await expect(page).toHaveURL(/\/projects\/101\/knowledge$/);await expect(page.locator('#console-project')).toHaveAttribute('data-project-id','101');
    await expect(page.getByLabel('内容',{exact:true})).toHaveValue('kept after route return');
    await switchConsoleProject(page,'202',{waitForNavigation:false});await page.getByRole('dialog').getByRole('button',{name:'离开文件',exact:true}).click();
    await expect(page).toHaveURL(/\/projects\/202\/knowledge$/);await expect(page.locator('#console-project')).toHaveAttribute('data-project-id','202');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('six widths handle long paths and text, and failed reads retry without exposing revoked content',async({page})=>{
  test.setTimeout(60000);const f=await fixture(page);
  try{
    const name='很长的文件名称用于检查窄屏换行和目录定位.txt';await f.admin('/api/repositories/101/knowledge-files','POST',{name,content:'long-line-'+ 'x'.repeat(4000)+'\n\n完整文本'});
    await f.login();await treeFile(page,name).click();await mkdir('.tmp/knowledge-files-232/screenshots',{recursive:true});
    for(const width of [320,390,768,1024,1440,1920]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),String(width)).toBe(true);}
    await exact(page,'← 返回目录').click();await page.route('**/api/repositories/101/knowledge-files?*',route=>route.fulfill({status:503,json:{error:'fixture_unavailable'}}));await exact(page,'刷新文件').click();
    // An unknown code keeps the raw message; the manager codes covered below get their own explanation while the code stays visible.
    await expect(page.locator('.knowledge-status')).toContainText('fixture_unavailable');await page.unroute('**/api/repositories/101/knowledge-files?*');await exact(page,'重试读取').click();await expect(treeFile(page,name)).toBeVisible();
    await page.route('**/api/repositories/101/knowledge-files/*',route=>route.fulfill({status:403,json:{error:'capability_forbidden'}}));await treeFile(page,name).click();await expect(page.locator('.knowledge-status')).toContainText('文件访问权限已失效');await expect(page.locator('.knowledge-content')).toHaveCount(0);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('late file content cannot redraw a different project section',async({page})=>{
  const f=await fixture(page);let release;
  try{
    await f.admin('/api/repositories/101/knowledge-files','POST',{name:'late.txt',content:'private delayed content'});await f.login();
    const gate=new Promise(resolve=>{release=resolve;});await page.route('**/api/repositories/101/knowledge-files/*',async route=>{await gate;await route.continue();});
    await treeFile(page,'late.txt').click();await page.locator('#tabs').getByRole('link',{name:'项目总览',exact:true}).click();await expect(page).toHaveURL(/\/overview$/);
    await page.locator('#tabs').getByRole('link', { name: '项目总览', exact: true }).click();await expect(page).toHaveURL(/\/overview$/);
    // Drain the delayed read before removing its backing project directory.
    const delayedResponse=page.waitForResponse(response=>response.url().includes('/api/repositories/101/knowledge-files/'));release();await(await delayedResponse).finished();
    await expect(page.locator('.workspace-overview')).toBeVisible();await expect(page.locator('.knowledge-workspace')).toHaveCount(0);await expect(page.getByText('private delayed content',{exact:true})).toHaveCount(0);expect(f.errors).toEqual([]);
  }finally{release?.();await f.close();}
});

test('sidebar navigation, browser back, short screens and logout respect unsaved drafts',async({page})=>{
  test.setTimeout(60000);const f=await fixture(page);
  try{
    await f.admin('/api/repositories/101/knowledge-files','POST',{name:'navigation.txt',content:'saved'});await f.login();await treeFile(page,'navigation.txt').click();await exact(page,'历史版本').click();await page.goBack();await expect(page.locator('.knowledge-workspace')).toHaveAttribute('data-scene','preview');await page.goBack();await expect(treeFile(page,'navigation.txt')).toBeVisible();
    await treeFile(page,'navigation.txt').click();await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill('retained');
    await page.locator('#tabs').getByRole('link',{name:'待处理',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByLabel('内容',{exact:true})).toHaveValue('retained');
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
    await f.admin(base,'POST',{path:'指南/归档/commands.txt',content:'archived commands'});
    const raw=Buffer.from([0,255,254,10,65]);await writeFile(f.notesRoot+'/101/binary.data',raw);
    await f.login();await treeFile(page,'binary.data').click();await expect(page.locator('.knowledge-content')).toContainText('这种格式无法在此预览或编辑');await expect(exact(page,'编辑文件')).toHaveCount(0);
    const promise=page.waitForEvent('download');await exact(page,'下载文件').click();expect(await readFile(await(await promise).path())).toEqual(raw);
    await exact(page,'← 返回目录').click();
    await page.setViewportSize({width:1440,height:1000});
    await treeFolder(page,'指南').click();
    const guide=tree(page).locator('li.knowledge-tree-folder').filter({has:exact(page,'目录 指南')});
    const archived=treeFile(page,'指南/归档/commands.txt');
    await expect(guide.getByRole('button',{name:'文件 指南/commands.txt',exact:true})).toBeVisible();
    await expect(archived).toHaveCount(0);
    const expand=exact(tree(page),'展开目录 指南/归档');
    await expand.focus();await page.keyboard.press('Enter');
    await expect(exact(tree(page),'收起目录 指南/归档')).toBeFocused();
    await expect(guide.locator('li.knowledge-tree-folder').getByRole('button',{name:'文件 指南/归档/commands.txt',exact:true})).toBeVisible();
    await archived.click();await expect(page.locator('.knowledge-content')).toContainText('archived commands');
    await expect(archived).toHaveAttribute('aria-current','page');
    await expect(panel(page).getByRole('button',{name:'commands.txt',exact:true})).toHaveCount(0);
    const markdown=treeFile(page,'指南/项目约定.md');
    await markdown.click();await expect(page.locator('.knowledge-content')).toContainText('验证与交付');
    const [treeBox,previewBox]=await Promise.all([tree(page).boundingBox(),page.locator('.knowledge-content').boundingBox()]);
    expect(treeBox.x+treeBox.width).toBeLessThanOrEqual(previewBox.x);
    expect(previewBox.y).toBeLessThan(treeBox.y+treeBox.height);
    await mkdir('.tmp/knowledge-files-232/previews',{recursive:true});
    await page.getByText('更多操作',{exact:true}).click();
    await expect(exact(page,'重命名或移动')).toBeInViewport();
    await page.getByText('更多操作',{exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    await expect(tree(page)).toBeHidden();
    await page.getByText('更多操作',{exact:true}).click();
    await expect(exact(page,'重命名或移动')).toBeInViewport();
    await page.getByText('更多操作',{exact:true}).click();
    await exact(page,'← 返回目录').click();
    await expect(markdown).toBeVisible();await expect(archived).toBeVisible();
    await markdown.click();
    await expect(page.locator('.knowledge-content')).toContainText('验证与交付');
    await exact(page,'历史版本').click();await expect(page.getByRole('complementary',{name:'文件历史'})).toBeVisible();await exact(page,'v1').click();await expect(page.locator('.knowledge-content')).toContainText('验证与交付');expect((await f.admin(base+'/'+encodeURIComponent(file.id))).value.file.revision).toBe(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a saved editor waits for the authoritative file read before exposing its next actions',async({page})=>{
  const f=await fixture(page);let release;
  try{
    const file=(await f.admin('/api/repositories/101/knowledge-files','POST',{name:'refresh.txt',content:'before'})).value.file;
    await f.login();await treeFile(page,'refresh.txt').click();await exact(page,'编辑文件').click();await page.getByLabel('内容',{exact:true}).fill('after');
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
  await treeFile(page,'healthy.txt').click();await expect(page.locator('.knowledge-content')).toContainText('still available');expect((await f.admin(base+'?deleted_only=1')).value.files[0].id).toBe(file.id);expect(f.errors).toEqual([]);
 }finally{await f.close();}
});

test('an uncertain move explains why retries cannot unlock the project knowledge volume',async({page})=>{
 const f=await fixture(page);
 try{
  await page.route('**/api/repositories/101/knowledge-files?*',route=>route.fulfill({status:409,json:{error:'note_move_uncertain'}}));await f.login();
  await expect(page.locator('.knowledge-status')).toContainText('本项目知识区已暂停读写');await expect(page.locator('.knowledge-status')).toContainText('一致的完整知识卷');await exact(page,'重试读取').click();await expect(page.locator('.knowledge-status')).toContainText('重试不会解除此状态');expect(f.errors).toEqual([]);
 }finally{await f.close();}
});

test('a first knowledge read that reports manager_unavailable explains the temporary failure and recovers on retry',async({page})=>{
  const f=await fixture(page);
  try{
    await f.admin('/api/repositories/101/knowledge-files','POST',{name:'recovered.txt',content:'read after recovery'});
    // The route is in place before sign-in, so the very first directory read fails instead of a later refresh (#1278).
    await page.route('**/api/repositories/101/knowledge-files?*',route=>route.fulfill({status:503,json:{error:'manager_unavailable'}}));
    await f.login();
    const status=page.locator('.knowledge-status');
    // The page states the temporary failure and keeps the code the logs use; it never claims the manager is down or the files are gone.
    await expect(status).toContainText('暂时无法读取项目知识');
    await expect(status).toContainText('manager_unavailable');
    await expect(status).not.toContainText('知识卷');
    await expect(panel(page)).toContainText('文件列表尚未读取成功。');
    await expect(exact(page,'重试读取')).toBeVisible();
    await page.unroute('**/api/repositories/101/knowledge-files?*');
    await exact(page,'重试读取').click();
    await expect(treeFile(page,'recovered.txt')).toBeVisible();
    await expect(status).toBeEmpty();
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('manager_not_ready reads as a service still starting, not as an empty directory',async({page})=>{
  const f=await fixture(page);
  try{
    await f.admin('/api/repositories/101/knowledge-directories','POST',{path:'空目录'});
    await page.route('**/api/repositories/101/knowledge-files?*',route=>route.fulfill({status:503,json:{error:'manager_not_ready'}}));
    await f.login();
    const status=page.locator('.knowledge-status');
    await expect(status).toContainText('项目知识服务还没有就绪');
    await expect(status).toContainText('manager_not_ready');
    await expect(status).not.toContainText('这个目录是空的');
    await page.unroute('**/api/repositories/101/knowledge-files?*');
    await exact(page,'重试读取').click();
    await treeFolder(page,'空目录').click();
    await expect(panel(page).getByText('这个目录是空的。',{exact:true})).toBeVisible();
    await expect(status).toBeEmpty();
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a write that reports manager_unavailable keeps write wording and retries the current draft, not a read',async({page})=>{
  const f=await fixture(page);
  try{
    const base='/api/repositories/101/knowledge-files',file=(await f.admin(base,'POST',{name:'write-fault.txt',content:'original body'})).value.file,filePath=base+'/'+encodeURIComponent(file.id);
    let writes=0,reads=0;
    page.on('request',request=>{const url=new URL(request.url());if(url.pathname===base&&request.method()==='GET')reads++;});
    await page.route('**'+filePath,route=>{if(route.request().method()!=='PUT')return route.continue();writes++;return route.fulfill({status:503,json:{error:'manager_unavailable'}});});
    await f.login();await treeFile(page,'write-fault.txt').click();await exact(page,'编辑文件').click();
    await page.getByLabel('内容',{exact:true}).fill('saved despite the manager fault');await exact(page,'保存文件').click();
    const status=page.locator('.knowledge-status');
    // The shared failure view must name the failed operation: a save is not a directory read, and a read retry would rerun the wrong action.
    await expect(status).toContainText('项目知识操作未完成');await expect(status).toContainText('manager_unavailable');
    await expect(status).not.toContainText('无法读取');await expect(status).not.toContainText('重试读取');
    await expect(exact(page,'重试操作')).toBeVisible();
    const readsBefore=reads;await exact(page,'重试操作').click();await expect.poll(()=>writes).toBe(2);
    expect(reads).toBe(readsBefore);expect((await f.admin(base+'/'+encodeURIComponent(file.id))).value.file.content).toBe('original body');
    // Editing between the failed save and the retry must save the current draft, not the text captured before the first failure.
    await page.getByLabel('内容',{exact:true}).fill('typed after the failed save');await page.unroute('**'+filePath);await exact(page,'重试操作').click();
    await expect(page.locator('.knowledge-editor')).toHaveCount(0);await expect(page.locator('.knowledge-content')).toContainText('typed after the failed save');
    expect((await f.admin(base+'/'+encodeURIComponent(file.id))).value.file.content).toBe('typed after the failed save');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a legacy file whose name carries a control character is reported as unreadable instead of disappearing',async({page})=>{
  test.setTimeout(60000);const f=await fixture(page);
  try{
    const base='/api/repositories/101/knowledge-files';
    await f.admin(base,'POST',{name:'healthy.txt',content:'readable body'});
    // A volume written before the name rule can still hold a file under a name no request may address. Nothing renames
    // or deletes it: the listing reports it, the healthy file next to it stays readable, and the bad name is not clickable.
    const volume=join(f.notesRoot,'101'),bad='ctl\u0001name.txt',catalogPath=join(volume,'.write-history/file-tree.json');
    await writeFile(join(volume,bad),'old bytes');
    const catalog=JSON.parse(await readFile(catalogPath,'utf8'));
    catalog.files.push({id:'n:'+Buffer.from(bad).toString('base64url'),path:bad,aliases:[],history_key:'b'.repeat(64),legacy_paths:[bad]});
    await writeFile(catalogPath,JSON.stringify(catalog));
    await f.login();
    const notice=panel(page).getByText('另有 1 个无法打开的旧文件（名字含控制字符）',{exact:true});
    await expect(notice).toBeVisible();await notice.click();
    await expect(panel(page)).toContainText('ctl\\u0001name.txt');await expect(panel(page)).toContainText('名字含控制字符，无法打开');
    await expect(panel(page).getByRole('button',{name:bad,exact:true})).toHaveCount(0);
    await treeFile(page,'healthy.txt').click();await expect(page.locator('.knowledge-content')).toContainText('readable body');
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('search matches file names, path fragments and text body content in every directory',async({page})=>{
  test.setTimeout(90000);const f=await fixture(page);
  try{
    const base='/api/repositories/101/knowledge-files',dirs='/api/repositories/101/knowledge-directories';
    for(const path of ['手册','手册/归档','手册/归档/深层'])await f.admin(dirs,'POST',{path});
    await f.admin(base,'POST',{path:'手册/开始.md',content:'# 开始\n\n发布说明只写在正文里。'});
    await f.admin(base,'POST',{path:'手册/归档/深层/发布清单.md',content:'# 发布清单'});
    await f.admin(base,'POST',{path:'readme.txt',content:'root file'});
    // The server matches substrings in paths and UTF-8 text file bodies; it never builds a semantic index.
    const api=async query=>(await f.admin(base+'?'+new URLSearchParams({directory:'',query}))).value.files.map(file=>file.path);
    expect((await api('发布')).sort()).toEqual(['手册/开始.md','手册/归档/深层/发布清单.md'].sort());
    expect(await api('归档/深层')).toEqual(['手册/归档/深层/发布清单.md']);
    expect(await api('清单')).toEqual(['手册/归档/深层/发布清单.md']);
    expect(await api('eadm')).toEqual(['readme.txt']);
    expect(await api('发布说明')).toEqual(['手册/开始.md']);
    await f.login();
    const panel=page=>page.locator('.knowledge-main'),search=page.getByLabel('搜索文件名、路径或正文',{exact:true});
    // A listing read can finish after the input was refilled, so retry until the request actually carries this query.
    const searchFor=async query=>{for(let attempt=0;attempt<3;attempt++){
      await search.fill(query);
      const answer=page.waitForResponse(response=>{try{const params=new URL(response.url()).searchParams;return response.url().includes('/knowledge-files?')&&(query?params.get('query')===query:params.get('recursive')==='1');}catch{return false;}},{timeout:5000}).catch(()=>null);
      await page.getByRole('button',{name:'搜索',exact:true}).click();
      if(await answer)return;
    }throw new Error('search did not run for '+query);};
    // The page states the scope it has: file names, paths and text bodies in every directory, never semantic search.
    await searchFor('清单');
    await expect(panel(page).getByRole('button',{name:'发布清单.md',exact:true})).toBeVisible();
    await expect(panel(page)).toContainText('搜索范围：全部目录的文件名、路径和文本正文。');
    await expect(page.locator('.knowledge-workspace')).not.toContainText('语义');
    // A path fragment finds the deep file, and a body-only phrase finds the matching file with a preview excerpt.
    await searchFor('归档/深层');
    await expect(panel(page).getByRole('button',{name:'发布清单.md',exact:true})).toBeVisible();
    await searchFor('发布说明');
    await expect(panel(page).getByRole('button',{name:'发布清单.md',exact:true})).toHaveCount(0);
    await expect(panel(page).getByRole('button',{name:'开始.md',exact:true})).toBeVisible();
    await expect(panel(page).locator('.knowledge-search-preview')).toContainText('发布说明只写在正文里');
    // The scope stays every directory while browsing inside one: searching 手册 for a root file still finds it.
    await searchFor('');
    await treeFolder(page,'手册').click();
    await expect(treeFile(page,'手册/开始.md')).toBeVisible();
    await searchFor('readme');
    await expect(panel(page).getByRole('button',{name:'readme.txt',exact:true})).toBeVisible();
    await expect(panel(page)).toContainText('搜索范围：全部目录的文件名、路径和文本正文。');
    await page.setViewportSize({width:1440,height:1000});
    await page.setViewportSize({width:390,height:844});
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('keyboard users reach the directory, the file, its history and restore in order',async({page})=>{
  test.setTimeout(90000);const f=await fixture(page);
  try{
    await f.admin('/api/repositories/101/knowledge-directories','POST',{path:'手册'});
    const base='/api/repositories/101/knowledge-files',file=(await f.admin(base,'POST',{path:'手册/笔记.md',content:'# 第一版'})).value.file;
    await f.admin(base+'/'+encodeURIComponent(file.id),'PUT',{content:'# 第二版',expected_revision:file.revision});
    await f.login();
    const panel=page=>page.locator('.knowledge-main'),
      // A redraw replaces the whole workspace, so a focused control can vanish and focus fall back to <body>; that is a
      // lost focus, not an element named after the body's text (which is the whole page).
      focused=()=>page.evaluate(()=>{const el=document.activeElement;if(!el||el===document.body||el===document.documentElement)return '';return el.getAttribute('aria-label')||el.textContent?.trim()||'';});
    // The tree is redrawn while the page settles, so wait for the entry, focus it, and confirm focus landed before
    // counting Tabs; focusing again inside the poll keeps a redraw from leaving the walk to start over at <body>.
    const focusEntry=async(name,scope=page.locator('.knowledge-tree'))=>{const node=scope.getByRole('button',{name,exact:true});await expect(node).toBeVisible();await expect.poll(async()=>{await node.focus({timeout:2000}).catch(()=>{});return focused();}).toBe(name);return node;};
    const tabTo=async(start,target,limit=40,scope)=>{await focusEntry(start,scope);const seen=[];
      for(let i=0;i<limit;i++){await page.keyboard.press('Tab');const current=await focused();seen.push(current);
        if(current===target)return seen;if(!current)await focusEntry(start,scope);}
      throw new Error(`Tab never reached ${target} in ${limit} presses; focus sequence: ${JSON.stringify(seen)}`);};
    const tabOrder=async(start,count,scope)=>{await focusEntry(start,scope);const out=[];let attempts=0;
      while(out.length<count&&attempts<count+6){attempts++;await page.keyboard.press('Tab');const current=await focused();
        if(!current){await focusEntry(start,scope);continue;}out.push(current);}
      return out;};
    // Tab from the workspace's first control reaches the directory entry, and Enter opens that directory.
    await expect(page.locator('.knowledge-tree').getByRole('button',{name:'目录 手册',exact:true})).toBeVisible();
    await tabTo('全部文件','目录 手册');
    await page.keyboard.press('Enter');
    await expect(treeFile(page,'手册/笔记.md')).toBeVisible();
    // The file entry is reachable with Tab too, and Enter opens its content.
    await tabTo('全部文件','文件 手册/笔记.md');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('heading',{name:'笔记.md',exact:true})).toBeVisible();
    await expect(page.locator('.knowledge-content')).toContainText('第二版');
    // Focus order after the back link does not jump: the file actions follow in order, and Enter opens history.
    const back=page.getByRole('button',{name:'← 返回目录',exact:true});
    expect(await tabOrder('← 返回目录',3,page)).toEqual(['编辑文件','下载文件','历史版本']);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('complementary',{name:'文件历史'})).toBeVisible();
    await expect(panel(page).getByRole('textbox',{name:'搜索文件名、路径或正文',exact:true})).toHaveCount(0);
    // An old version opens from the keyboard and offers restore without leaving the keyboard.
    await page.getByRole('complementary',{name:'文件历史'}).getByRole('button',{name:'v1',exact:true}).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('正在查看 v1 · 只读，当前仍为 v2',{exact:true})).toBeVisible();
    await tabTo('← 返回目录','恢复此版本',10,page);
    await page.getByRole('button',{name:'恢复此版本',exact:true}).focus();await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button',{name:'恢复版本',exact:true})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('the knowledge page offers files and versions only, with no knowledge-governance columns',async({page})=>{
  const f=await fixture(page);
  try{
    expect((await f.admin('/api/repositories/101/memories','POST',{key:'legacy',body:'retired'})).status).toBe(410);
    await f.admin('/api/repositories/101/knowledge-files','POST',{name:'开始.md',content:'# 开始'});
    await f.login();
    await expect(page.locator('.knowledge-workspace')).toContainText('开始.md');
    for(const label of ['角色记忆','经验候选','可信度','验证者','知识晋升','知识条目','已验证'])await expect(page.locator('.knowledge-workspace')).not.toContainText(label);
    await expect(page.getByRole('complementary',{name:'文件目录'})).toBeVisible();
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});
