import {test,expect} from '@playwright/test';
import {mkdirSync,rmSync} from 'node:fs';
import {harness,setup,account,repository,testPassword} from '../test/helpers.mjs';

test('项目列表直接切换检视和开发，保存失败保留状态，任务数刷新且项目管理员仅见自己的项目',async({page,browser})=>{
  const h=await harness(),{admin,password}=await setup(h),a=await account(admin),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    for(const id of ['101','202','303'])await repository(admin,a.id,id);
    await admin('/api/repositories/303/policy','PATCH',{enabled:false});
    h.store.run("INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at) VALUES(?,'404','fixture/new-project','10','fixture',0,1,?)",a.id,new Date().toISOString());
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('active','101','review.issue','running','Review in progress')");
    for(let i=0;i<65;i++)h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES(?,'101','review.issue','queued','Waiting for this computer')",'queue-'+i);
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('waiting','101','development.issue','waiting_configuration','Configure a model')");
    const login=async(p,user,secret)=>{await p.goto(h.admin);await p.getByLabel('用户名',{exact:true}).fill(user);await p.getByLabel('密码',{exact:true}).fill(secret);await p.getByRole('button',{name:'登录',exact:true}).click();await expect(p.getByRole('heading',{name:'项目',exact:true})).toBeVisible();};
    await login(page,'administrator',password);
    const row=id=>page.locator(`#rows [data-repository-id="${id}"]`),review=row('101').getByRole('switch',{name:'fixture/project-101 检视',exact:true}),development=row('101').getByRole('switch',{name:'fixture/project-101 开发',exact:true});
    await expect(review).toHaveAttribute('aria-checked','false');await expect(row('101')).toContainText('执行中 1');await expect(row('101')).toContainText('排队 65');await expect(row('202')).toContainText('执行中 0');
    await review.click();await expect(review).toHaveAttribute('aria-checked','true');await expect(row('101').getByRole('status')).toHaveText('检视已开启');
    await review.click();await expect(review).toHaveAttribute('aria-checked','false');await review.click();await expect(review).toHaveAttribute('aria-checked','true');
    await page.route('**/api/repositories/101/policy',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}));await development.click();await expect(row('101').getByRole('status')).toContainText('开发保存失败');await expect(row('101').getByRole('status')).toContainText('temporary_unavailable');await expect(development).toHaveAttribute('aria-checked','false');
    mkdirSync('.tmp/project-list',{recursive:true});await page.screenshot({path:'.tmp/project-list/save-error.png',fullPage:true});await page.unroute('**/api/repositories/101/policy');
    let release,count=0;const held=new Promise(done=>release=done);
    await page.route('**/api/repositories/101/policy',async route=>{count++;expect(route.request().postDataJSON()).toEqual({development_enabled:true});await held;await route.continue();});
    await development.click();await expect(development).toBeDisabled();await expect(review).toBeDisabled();await development.evaluate(node=>node.click());expect(count).toBe(1);release();await expect(development).toBeEnabled();await expect(development).toHaveAttribute('aria-checked','true');await expect(row('101').getByRole('status')).toHaveText('开发已开启');await page.unroute('**/api/repositories/101/policy');
    await expect(row('404').getByRole('switch').first()).toBeDisabled();await expect(row('404').getByRole('switch').last()).toBeDisabled();
    const disabledDevelopment=row('303').getByRole('switch',{name:'fixture/project-303 开发',exact:true});await disabledDevelopment.click();await expect(disabledDevelopment).toHaveAttribute('aria-checked','true');await expect(row('303').getByRole('status')).toHaveText('开发已开启；项目仍已禁用');expect((await admin('/api/repositories/303')).value.policy.enabled).toBe(0);
    h.store.run("UPDATE tasks SET status='succeeded' WHERE id='active'");h.store.run("UPDATE tasks SET status='running' WHERE id='queue-0'");
    await expect(row('101')).toContainText('排队 64',{timeout:10000});await expect(row('101')).toContainText('执行中 1');
    await page.setViewportSize({width:1440,height:900});const title=await row('101').locator('.row-content').boundingBox(),controls=await row('101').locator('.project-overview').boundingBox();expect(controls.x).toBeGreaterThan(title.x+title.width-1);await page.screenshot({path:'.tmp/project-list/desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(review).toBeVisible();await expect(development).toBeVisible();await page.screenshot({path:'.tmp/project-list/mobile.png',fullPage:true});
    await row('101').getByRole('link',{name:/正在执行 1 个任务/}).click();await expect(page).toHaveURL(/#\/projects\/101\/activity$/);await expect(page.getByRole('heading',{name:'fixture/project-101',exact:true})).toBeVisible();
    const memberPassword=testPassword();await admin('/api/users','POST',{username:'project-admin',password:memberPassword,repository_ids:['101']});
    const context=await browser.newContext({viewport:{width:390,height:844}}),member=await context.newPage();await login(member,'project-admin',memberPassword);await expect(member.locator('#rows .project-list-row')).toHaveCount(1);await expect(member.locator('#rows')).not.toContainText('fixture/project-202');await expect(member.locator('#rows')).toContainText('执行中 1');
    const own=member.getByRole('switch',{name:'fixture/project-101 开发',exact:true});await own.click();await expect(own).toHaveAttribute('aria-checked','false');await expect(member.locator('#rows [role=status]')).toHaveText('开发已关闭');await member.screenshot({path:'.tmp/project-list/member-mobile.png',fullPage:true});await context.close();
    expect((await admin('/api/repositories/101')).value.policy.development_enabled).toBe(0);expect(errors).toEqual([]);
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
