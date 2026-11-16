import {test,expect} from '@playwright/test';
import {emptyRepositoryFixture} from '../test/empty-repository-helpers.mjs';

// #769: the timeline shows which worktree a task worked in and who chose it: its agent, or the system at the first file it
// needed.
test('任务时间线写明用了哪个工作区、谁选的',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const h=await emptyRepositoryFixture(undefined);
  try{
    const log=(task,n,content)=>h.store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)',`${task}-${n}`,task,JSON.stringify(content),`2026-11-15T13:0${n}:00.000Z`);
    const task=(id,number,title)=>h.store.run("INSERT INTO tasks(id,repository_id,object_number,kind,status,summary,input,created_at,updated_at) VALUES(?,'101',?,'review.issue','succeeded',?,'{}','2026-11-15T13:00:00.000Z','2026-11-15T13:09:00.000Z')",id,number,title);
    task('chose-own',1,'Review with a reused worktree');task('system-choice',3,'Review the system bound');
    log('chose-own',1,{type:'workspace_chosen',decided_by:'agent',choice:'use',worktree_id:'7'.repeat(48),mode:'write',head:'a'.repeat(40),on_changes:'reset',saved_changes:{path:'../context/saved-changes-777777777777-aaaaaaaaaaaa.patch',count:2},
      detail:'执行 agent 选用 worktree 777777777777（写，提交 aaaaaaa），先还原，原有改动（2 个文件）已保存到 ../context/saved-changes-777777777777-aaaaaaaaaaaa.patch。'});
    log('system-choice',1,{type:'workspace_chosen',decided_by:'system',choice:'create',worktree_id:'8'.repeat(48),mode:'read',head:'a'.repeat(40),detail:'系统新建 worktree 888888888888（读，提交 aaaaaaa）。'});
    await page.goto(h.adminBase);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(h.password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.goto(h.adminBase+'/#/reviews');await expect(page.locator('[data-card-key="101/issue/1"]')).toBeVisible();
    await page.evaluate(()=>openTask('chose-own'));
    const own=page.locator('#timeline li').filter({hasText:'选用 worktree'});
    await expect(own).toContainText('工作区');await expect(own).toContainText('自选');await expect(own).toContainText('原有改动（2 个文件）已保存到 ../context/saved-changes-');
    await page.evaluate(()=>openTask('system-choice'));
    const system=page.locator('#timeline li').filter({hasText:'系统新建 worktree'});
    await expect(system).toContainText('工作区');await expect(system).toContainText('系统选择');
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  }finally{await h.close();}
});
