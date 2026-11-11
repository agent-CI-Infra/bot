import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { fail } from '../dist/core/security.js';
import { harness, setup, account, repository } from '../test/helpers.mjs';

async function fixture() {
  const state={offline:false,absent:false,recovering:false,responseError:false,liveState:'ready',metricsFail:false,stats:{running:true,cpu_percent:0,memory_bytes:1048576,memory_limit_bytes:2147483648,pids:3},computer:{cpus:2,memory_mb:2048,pids:512,tmp_mb:512,
    defaults:{cpus:2,memory_mb:2048,pids:512,tmp_mb:512},inherited:['cpus','memory_mb','pids','tmp_mb'],packages:[],env:{},setup_script:'',network_policy:'internal, no egress',
    image:'approved/project-computer@sha256:'+'a'.repeat(64),build:{state:'ready',output:'Public package build output'},setup:{state:'succeeded',exit_code:0,output:'Public initialization output',generation:1}}};
  const manager={async call(_method,path){const id=path.split('/')[3];if(path.endsWith('/stats')){if(state.metricsFail)throw new Error('metrics_unavailable');return {...state.stats,sampled_at:state.stats.sampled_at||new Date().toISOString()};}
    if(state.offline)throw new Error('manager_unavailable');if(state.recovering)fail(503,'manager_not_ready');if(state.responseError)fail(403,'private_response_detail');if(state.absent)return null;
    return {repository_id:id,generation:1,state:state.liveState,desired:'ready',revision:1,computer:structuredClone(state.computer)};}};
  const h=await harness(undefined,manager),{admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');
  for(const [id,status] of [['active','running'],['queued-old','queued'],['queued-new','queued']])h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES(?,'101','task.request',?,?)",id,status,id);
  h.store.run("INSERT INTO task_claims VALUES('active','101','fixture-claim',?)",new Date().toISOString());
  return {h,admin,password,state,close:async()=>{await h.stop();rmSync(h.directory,{recursive:true,force:true});}};
}
async function login(page,f) {
  await page.goto(f.h.admin+'/#/projects/101/machine');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(f.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#machine-status')).toContainText('运行任务记录');
}
const card=(page,name)=>page.locator('#machine-status .side-card').filter({has:page.getByRole('heading',{name,exact:true})});

test('computer state, real zero metrics and the same activity records stay readable across six widths',async({page})=>{
  const f=await fixture(),errors=[];page.on('pageerror',err=>errors.push(err.message));
  try{
    await login(page,f);await expect(card(page,'实时资源')).toContainText('0%');await expect(card(page,'机器')).toContainText('不是电脑心跳');await expect(card(page,'机器')).toContainText('2 CPU · 内存 2048 MB · 进程 512 个 · /tmp 512 MB');
    await expect(card(page,'运行与排队记录')).toContainText('运行任务记录1排队任务记录2');
    mkdirSync('.tmp/project-computer-231',{recursive:true});
    for(const width of [320,390,768,1024,1440,1920]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>scrollTo(0,0));
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if([390,1440].includes(width))await page.screenshot({path:`.tmp/project-computer-231/computer-${width}.png`,fullPage:true});}
    await page.getByRole('link',{name:'查看运行与排队任务',exact:false}).click();await expect(page).toHaveURL(/#\/projects\/101\/activity$/);
    const queue=page.locator('#activity-status .side-card').filter({has:page.getByRole('heading',{name:'排队任务 2',exact:true})});
    await expect(queue.getByRole('button')).toHaveCount(2);
    await expect(page.getByRole('heading',{name:'正在执行 1／1',exact:true})).toBeVisible();expect(errors).toEqual([]);
  }finally{await f.close();}
});

test('a manager outage or absent record is unknown instead of the saved ready state, and retry restores observation',async({page})=>{
  const f=await fixture();
  try{await login(page,f);f.state.offline=true;await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();
    await expect(card(page,'机器')).toContainText('manager_unavailable');await expect(page.locator('[data-project-environment-state]')).toHaveText('电脑待核验');
    await expect(page.locator('#computer-action-1')).toBeDisabled();
    f.state.offline=false;f.state.absent=true;await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();await expect(card(page,'机器')).toContainText('未找到电脑记录');
    f.state.absent=false;await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();await expect(page.locator('[data-project-environment-state]')).toHaveText('就绪');
    await expect(page.locator('#computer-action-1')).toBeEnabled();
  }finally{await f.close();}
});

test('an initially unavailable computer offers explicit configuration recovery after its connection returns',async({page})=>{
  const f=await fixture();
  try{f.state.offline=true;await login(page,f);await expect(page.getByLabel('CPU（核）',{exact:true})).toHaveCount(0);
    f.state.offline=false;await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();await expect(page.locator('[data-project-environment-state]')).toHaveText('就绪');
    await page.getByRole('button',{name:'重新读取电脑配置',exact:true}).click();await expect(page.getByLabel('CPU（核）',{exact:true})).toBeVisible();
  }finally{await f.close();}
});

test('missing metrics remain unknown, old samples are marked stale, and a read outage retains labelled evidence',async({page})=>{
  const f=await fixture();
  try{await login(page,f);f.state.stats={running:true};await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();
    await expect(card(page,'实时资源')).toContainText('未知');await expect(card(page,'实时资源')).not.toContainText('undefined');await expect(card(page,'实时资源')).not.toContainText('0%');
    f.state.stats={running:true,cpu_percent:12.5,sampled_at:'2020-01-01T00:00:00Z'};await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();
    await expect(card(page,'实时资源')).toContainText('采样已过期');await expect(card(page,'实时资源')).toContainText('12.5%');
    f.state.metricsFail=true;await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();await expect(card(page,'实时资源')).toContainText('保留上次成功采样');
    await expect(card(page,'实时资源')).toContainText('12.5%');
    f.state.metricsFail=false;f.state.stats={};await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();
    await expect(card(page,'实时资源')).toContainText('运行状态未知');await expect(card(page,'实时资源')).not.toContainText('虚拟电脑未运行');
  }finally{await f.close();}
});

test('status refresh preserves form drafts, expanded logs, focus and position while stale page responses are discarded',async({page})=>{
  const f=await fixture();let release=()=>{};
  try{await login(page,f);const cpu=page.getByLabel('CPU（核）',{exact:true});await cpu.fill('3');
    const build=page.locator('#machine-status details').filter({has:page.getByText('构建输出',{exact:true})});await build.locator('summary').click();
    const refresh=page.getByRole('button',{name:'刷新电脑状态',exact:true});await refresh.focus();const y=await page.evaluate(()=>scrollY);await page.evaluate(()=>refreshProjectStatus(renderToken));
    await expect(refresh).toBeFocused();await expect(build).toHaveAttribute('open','');await expect(cpu).toHaveValue('3');expect(await page.evaluate(()=>scrollY)).toBe(y);
    const gate=new Promise(resolve=>{release=resolve;});await page.route('**/api/environments/101',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
    await page.evaluate(()=>{void refreshProjectStatus(renderToken);});await page.evaluate(()=>{location.hash='#/projects/202/machine';});
    await expect(page.locator('.project-head h1')).toHaveText('fixture/project-202');release();await page.unrouteAll({behavior:'wait'});
    await expect(page.locator('.project-head h1')).toHaveText('fixture/project-202');
  }finally{release();await f.close();}
});

test('permission loss clears all previous computer data and a late successful read cannot restore it',async({page})=>{
  const f=await fixture();let release=()=>{},first=true;
  try{await login(page,f);const gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/environments/101',async route=>{if(first){first=false;const response=await route.fetch();await gate;await route.fulfill({response});}else await route.fulfill({status:403,json:{error:'repository_forbidden'}});});
    await page.evaluate(()=>{void refreshProjectStatus(renderToken);});await expect.poll(()=>first).toBe(false);
    await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();await expect(page.getByRole('heading',{name:'项目电脑暂不可访问',exact:true})).toBeVisible();
    release();await page.unrouteAll({behavior:'wait'});await expect(page.locator('#machine-status')).toHaveCount(0);await expect(page.getByLabel('CPU（核）',{exact:true})).toHaveCount(0);
  }finally{release();await f.close();}
});


test('manager recovery and answered errors remain distinct from an outage across the header and project overview',async({page})=>{
  const f=await fixture();
  try{await login(page,f);
    f.state.recovering=true;await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();
    await expect(card(page,'机器')).toContainText('manager_not_ready');await expect(card(page,'机器')).not.toContainText('暂不可达');
    await expect(page.locator('.project-head [data-project-environment-state]')).toHaveText('管理服务恢复中');
    f.state.recovering=false;f.state.responseError=true;await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();
    await expect(card(page,'机器')).toContainText('manager_read_failed');await expect(card(page,'机器')).not.toContainText('private_response_detail');
    await expect(page.locator('.project-head [data-project-environment-state]')).toHaveText('电脑状态未知');
    f.state.responseError=false;f.state.liveState='future_state';await page.getByRole('button',{name:'刷新电脑状态',exact:true}).click();
    await expect(page.locator('.project-head [data-project-environment-state]')).toHaveText('电脑状态未知');
    await expect(page.locator('#computer-action-1')).toBeDisabled();
    f.state.offline=true;await page.evaluate(()=>{location.hash='#/projects/101/basic';});
    await expect(page.locator('.project-head [data-project-environment-state]')).toHaveText('电脑待核验');
    await expect(page.locator('.project-body [data-project-environment-state]')).toHaveText('电脑待核验');
  }finally{await f.close();}
});
