import {test,expect} from '@playwright/test';
import {releaseFixture,target,writes} from '../test/release-fixtures.mjs';
async function login(page,f){await page.goto(f.h.admin+'/#/projects/101/release');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(f.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('heading',{name:'发版本',exact:true})).toBeVisible();}

// #233: the release list is what a person reads before touching anything — version, exact commit, stage, initiator,
// update time and what is blocking right now. Every cell comes from a stored field, so a stage the page does not know
// says so instead of reading as fine; nothing here is inferred from GitHub at render time.
test('the release list names each stage, the exact commit and what is blocking without guessing',async({page})=>{
 const cleanup=[],f=await releaseFixture({after:fn=>cleanup.push(fn)}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  const created=await f.create('v1.2.3'),id=created.value.release.id,row=f.h.store.get('SELECT * FROM project_releases WHERE id=?',id),data=JSON.parse(row.data),now=new Date().toISOString();
  const actor=f.h.store.get("SELECT id FROM users WHERE username='administrator'").id;
  const seed=(suffix,version,stage,patch)=>f.h.store.run(`INSERT INTO project_releases(id,repository_id,version,target_sha,actor_id,stage,active,data,created_at,updated_at)
    VALUES(?,?,?,?,?,?,0,?,?,?)`,'release-'+suffix,'101',version,target,actor,stage,JSON.stringify({...data,version,stage,...patch}),now,now);
  // One record per state that has to read differently: a failed step, an unconfirmed write, a draft waiting on a person,
  // and a release that needed nothing from anyone.
  f.h.store.run('UPDATE project_releases SET stage=?,data=? WHERE id=?','failed',JSON.stringify({...data,stage:'failed',failure_step:'tagging',error:'release_tag_create_failed',detail:'同名标签已存在，未移动或删除。'}),id);
  seed('write-unknown','v1.2.4','write_unknown',{failure_step:'publishing',error:null,detail:''});
  seed('draft','v1.2.5','draft',{failure_step:null,error:null,detail:'',body:'notes'});
  seed('published','v1.2.6','published',{failure_step:null,error:null,detail:'已由仓库工作流／外部操作发布'});
  await login(page,f);
  const list=page.locator('.release-overview');
  await expect(list).toHaveCount(1);
  await expect(list.locator('tbody tr')).toHaveCount(4);
  // The full commit, not a shortening: the list has to be checkable against the tag the person is about to create.
  await expect(list).toContainText(target);
  await expect(list.locator('tr[data-version="v1.2.3"]')).toContainText('失败于');
  await expect(list.locator('tr[data-version="v1.2.3"]')).toContainText('同名标签已存在');
  await expect(list.locator('tr[data-version="v1.2.4"]')).toContainText('写入结果待查证');
  await expect(list.locator('tr[data-version="v1.2.5"]')).toContainText('草稿待人工确认发布');
  await expect(list.locator('tr[data-version="v1.2.6"]')).toContainText('无阻塞');
  // Reading the list writes nothing, and an unrecognised stage must not be reported as fine.
  expect(writes(f.state)).toEqual([]);
  await expect(page.locator('.release-panel')).not.toContainText('状态未确认，请以发布详情为准');
  // Phone: the table scrolls inside its own box instead of widening the page.
  await page.setViewportSize({width:390,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(list.locator('tr[data-version="v1.2.3"]')).toContainText(target);
  expect(errors).toEqual([]);
 }finally{for(const close of cleanup.reverse())await close();}
});
