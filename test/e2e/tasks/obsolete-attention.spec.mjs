import {test,expect} from '@playwright/test';
import {emptyRepositoryFixture} from '../../fixtures/empty-repository-helpers.mjs';

// #713: a task the bot moved out of 待处理 says why in its timeline and its next step, and can still be retried by hand.
test('自动移出待处理的任务写明原因，详情里仍可点「重试」',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const h=await emptyRepositoryFixture(undefined);
  try{
    h.setBranch('ready');
    h.store.run("INSERT INTO tasks(id,repository_id,object_number,kind,status,error_code,summary,input,created_at,updated_at) VALUES('older-401','101',1,'review.issue','waiting_permission','github_permission_401','First issue',?,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z')",JSON.stringify({title:'First issue'}));
    h.store.run("INSERT INTO task_logs(id,task_id,content,created_at) VALUES('older-fault','older-401',?,'2026-11-01T00:00:00.000Z')",JSON.stringify({type:'fault',state:'waiting_permission',code:'github_permission_401',detail:'GitHub 请求 GET /repos/fixture/project-101/issues/1 返回 HTTP 401：Bad credentials'}));
    // The newer review of the same Issue starts and takes the older wait out of 待处理.
    await h.run();
    await page.goto(h.adminBase);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(h.password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.goto(h.adminBase+'/#/reviews');await expect(page.locator('[data-card-key="101/issue/1"]')).toBeVisible();
    await page.evaluate(()=>openTask('older-401'));
    const timeline=page.locator('#timeline'),obsolete=timeline.locator('.step-obsolete');
    // The original failure stays next to the dismissal, which names the state and code it left.
    await expect(timeline).toContainText('Bad credentials');
    await expect(obsolete).toContainText('自动移出待处理');await expect(obsolete).toContainText('原状态 waiting_permission（github_permission_401）');
    await expect(obsolete).toContainText('原因码 obsolete_superseded');
    await expect(page.locator('#task-next')).toContainText('已自动移出待处理，无需处理');
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.setViewportSize({width:1280,height:900});
    await page.locator('#task-actions').getByRole('button',{name:'重试',exact:true}).click();
    await expect(page.locator('#task-badges')).not.toContainText('已取消',{timeout:20000});
    expect(errors).toEqual([]);
  }finally{await h.close();}
});
