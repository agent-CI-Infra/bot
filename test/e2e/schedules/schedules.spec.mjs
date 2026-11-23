import { test, expect } from '@playwright/test';
import { openScheduleTimeRules, openScheduleIdentity } from '../helpers/open-schedule-folds.mjs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomId } from '../../../dist/core/security.js';
import { defaultLimits } from '../../../dist/schedules/types.js';
import { migrateDailyReports } from '../../../dist/schedules/migration.js';
import { channelFixture, privateChat, boundGroup, registerDestination } from '../../fixtures/channel-fixture.mjs';

async function environment() {
  let now = Date.now(), worker;
  const f = await channelFixture(undefined, { schedules: { automatic: false, clock: () => now }, onSchedules: s => { worker = s; } });
  now = Date.now(); f.worker = worker; f.advance = ms => { now += ms; }; f.now = () => now;
  // A project scheduled task (manager.check) runs while its project is on (#1027).
  f.h.store.run("UPDATE policies SET enabled=1 WHERE repository_id='101'");
  // Event subscriptions still choose a chat; destinations are registered in the console (#312).
  f.chat = await privateChat(f); f.destination = await registerDestination(f.admin, f.chat);
  await f.service.tick(); return f;
}
async function login(page, f, username = 'administrator', password = f.password) {
  await page.goto(f.h.admin + '/#/projects/101/schedules');
  await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '预览触发时间', exact: true })).toBeVisible();
}
const read = async (f, operation) => (await f.admin('/api/management/query', 'POST', { operation, target: { project_id: '101' }, arguments: {} })).value;
test('user previews and creates a timezone-aware project scheduled task, then explicitly runs and stops it; nothing goes to Feishu', async ({ page }) => {
  test.setTimeout(90000); const f = await environment(), errors = [];
  page.on('pageerror', e => errors.push(e.message)); mkdirSync('.tmp/schedules-166', { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1100 }); await login(page, f);
    // #1027: a project plan has no Feishu destination and one kind of work, written as what to do.
    await expect(page.getByLabel('计划目的地', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: '执行内容', exact: true })).toHaveCount(0);
    await page.getByLabel('计划名称', { exact: true }).fill('每日 Nightly 检查');
    await page.getByRole('textbox', { name: '要做什么', exact: true }).fill('检查 Nightly 的结果，指标变差就分析原因并提 Issue。');
    await openScheduleTimeRules(page);
    await page.getByLabel('计划时区', { exact: true }).fill('Asia/Shanghai'); await page.getByLabel('Cron 表达式', { exact: true }).fill('0 9 * * *');
    await page.getByRole('button', { name: '预览触发时间', exact: true }).click();
    await expect(page.getByLabel('计划预览')).toContainText('Asia/Shanghai'); await expect(page.getByLabel('计划预览')).toContainText('未来触发');
    await page.screenshot({ path: '.tmp/schedules-166/check-preview-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1);
    const plan = (await read(f, 'list_schedules')).schedules[0];
    expect([plan.spec.workflow, plan.spec.destination_id, plan.spec.parameters.instruction]).toEqual(['manager.check', undefined, '检查 Nightly 的结果，指标变差就分析原因并提 Issue。']);
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id);
    await page.getByRole('button', { name: '立即运行一次', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedule_occurrences').n).toBe(1); const sends = f.wire.sent.length; await f.worker.tick();
    const run = (await read(f, 'list_occurrences')).records[0];
    // The due task is handed to the project's Manager; its results stay in the project, never in a chat.
    expect(run.state).toBe('succeeded'); expect(JSON.parse(f.h.store.get("SELECT facts FROM dispatch_events WHERE type='schedule.due'").facts).instruction).toBe(plan.spec.parameters.instruction);
    expect(f.h.store.get('SELECT count(*) n FROM notification_outbox').n).toBe(0); expect(f.wire.sent.length).toBe(sends);
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id); await page.getByRole('button', { name: '暂停计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT state FROM schedules').state).toBe('paused');
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/schedules-166/check-paused-mobile.png', fullPage: true });
    writeFileSync('.tmp/schedules-166/check-evidence.json', JSON.stringify({ schedule: plan, occurrence: run, page_errors: errors }, null, 2)); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
test('user personal schedule pauses after revocation and its queued run never starts', async ({ page }) => {
  test.setTimeout(90000); const f = await environment(); mkdirSync('.tmp/schedules-166', { recursive: true });
  try {
    // The same human can own a personal schedule and later lose their project authorization.
    await login(page, f); await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1);
    const plan = (await read(f, 'list_schedules')).schedules[0];
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id); await page.getByRole('button', { name: '立即运行一次', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedule_occurrences').n).toBe(1); const before = f.wire.sent.length;
    f.h.store.run('UPDATE users SET active=0 WHERE id=?', f.principal); await f.worker.tick();
    const schedule = f.h.store.get('SELECT id,state,reason FROM schedules'), occurrence = f.h.store.get('SELECT id,state,reason FROM schedule_occurrences');
    expect(schedule.state).toBe('paused'); expect(occurrence.state).toBe('blocked'); expect(f.wire.sent.length).toBe(before);
    expect(f.h.store.get("SELECT count(*) n FROM dispatch_events WHERE type='schedule.due'").n).toBe(0);
    writeFileSync('.tmp/schedules-166/revocation-evidence.json', JSON.stringify({ schedule, occurrence, sends_before: before, sends_after: f.wire.sent.length }, null, 2));
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
test('a group destination of an event subscription stops at preview and before delivery once its binding no longer reaches the project', async ({ page }) => {
  test.setTimeout(90000); const f = await environment(); mkdirSync('.tmp/schedules-166', { recursive: true });
  try {
    const chat = await boundGroup(f, ['101']), groupDestination = await registerDestination(f.admin, chat); await f.service.tick();
    await login(page, f); const editor = page.getByRole('region', { name: '事件订阅管理', exact: true });
    await page.getByLabel('订阅目的地', { exact: true }).selectOption(groupDestination); await page.getByLabel('订阅名称', { exact: true }).fill('群里的失败通知');
    await page.getByRole('button', { name: '保存事件订阅', exact: true }).click(); await expect(editor.getByText('事件订阅已保存', { exact: true })).toBeVisible();
    expect(JSON.parse(f.h.store.get('SELECT spec FROM notification_subscriptions').spec).destination_id).toBe(groupDestination);
    f.h.store.run("INSERT INTO schedule_events(event_key,project_id,type,incident,payload,created_at) VALUES('browser-group-failure','101','task.failed','task:browser-group-failure',?,?)", JSON.stringify({ task_id: 'browser-group-failure', status: 'failed' }), f.now());
    f.worker.fanout(); expect(f.h.store.get('SELECT state FROM notification_outbox').state).toBe('pending');
    const binding = f.h.store.get('SELECT revision FROM channel_service_bindings');
    expect((await f.admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { scope: { kind: 'repositories', repositories: ['102'] }, enabled: true, expected_revision: binding.revision })).status).toBe(200);
    await editor.getByRole('article', { name: '群里的失败通知', exact: true }).getByRole('button', { name: '编辑订阅', exact: true }).click();
    await page.getByRole('button', { name: '预览事件订阅时间', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('目的地或受众需要重新核验');
    // The editor's default five-minute aggregation window has passed: the queued notification is checked before sending.
    const before = f.wire.sent.length; f.advance(300000); await f.worker.tick(); const delivery = f.h.store.get('SELECT id,state,last_error FROM notification_outbox');
    expect(delivery.state).toBe('blocked'); expect(f.wire.sent.length).toBe(before);
    await page.screenshot({ path: '.tmp/schedules-166/group-scope-rejected.png', fullPage: true });
    writeFileSync('.tmp/schedules-166/group-scope-evidence.json', JSON.stringify({ delivery, sends_before: before, sends_after: f.wire.sent.length }, null, 2));
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('an administrator previews and saves a maintainer handover after the project owner leaves', async ({ page }) => {
  test.setTimeout(90000); const f = await environment();
  try {
    const successor = await f.member('handover-admin-browser', { role: 'super_admin' }), maintainer = await f.member('handover-maintainer-browser', { repository_ids: ['101'] });
    const service = randomId(), capabilities = JSON.stringify(['tasks.read', 'schedules.manage', 'tasks.write']);
    f.h.store.run("INSERT INTO principals(id,kind,project_id,tenant_id,maintenance) VALUES(?,'service','101','github.com:10','project maintainers')", service);
    f.h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
      VALUES(?,?,'github.com:10','101','project','service',?,'explicit_delegation',?,'schedule','fixture approval',?)`, randomId(), service, capabilities, f.principal, Date.now());
    await login(page, f); await openScheduleIdentity(page); await page.getByLabel('执行身份类型', { exact: true }).selectOption('project');
    await page.getByLabel('项目服务身份', { exact: true }).selectOption(service); await page.getByLabel('项目维护人', { exact: true }).selectOption(f.principal);
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1); const original = (await read(f, 'list_schedules')).schedules[0];
    expect((await successor.client('/api/users/' + f.principal, 'PATCH', { active: false })).status).toBe(200); await f.worker.tick();
    expect(f.h.store.get('SELECT state FROM schedules').state).toBe('paused');
    await page.context().clearCookies(); await page.reload(); await login(page, f, 'handover-admin-browser', successor.password);
    await page.getByLabel('编辑计划', { exact: true }).selectOption(original.id); await openScheduleIdentity(page); await page.getByLabel('项目维护人', { exact: true }).selectOption(maintainer.id);
    await page.getByRole('button', { name: '预览触发时间', exact: true }).click(); await expect(page.getByLabel('计划预览')).toContainText('Asia/Shanghai');
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT maintainer_id FROM schedules').maintainer_id).toBe(maintainer.id);
    const saved = f.h.store.get('SELECT * FROM schedules'); expect(saved.owner_id).toBe(original.owner_id); expect(saved.creator_id).toBe(original.creator_id); expect(saved.actor_id).toBe(service);
    expect(JSON.parse(saved.grant_snapshot).capabilities).toEqual(original.grant_snapshot.capabilities);
    expect(f.h.store.get('SELECT capabilities FROM scoped_grants WHERE principal_id=?', service).capabilities).toBe(capabilities);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('a lost schedule write is reconciled with its original key and creates only one plan',async({page})=>{
 const f=await environment(),keys=[];let lost=false;
 try{
  await login(page,f);await page.route('**/api/management/commands',async route=>{
   const body=route.request().postDataJSON();if(body.operation!=='schedule.register'){await route.continue();return;}
   keys.push(body.idempotency_key);if(!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();
  });
  await page.getByLabel('计划名称',{exact:true}).fill('one logical plan');await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect(page.getByRole('button',{name:'核对同一次计划操作',exact:true})).toBeVisible();await expect(page.getByLabel('计划名称',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'核对同一次计划操作',exact:true}).click();await expect(page.getByRole('region',{name:'项目定时任务列表'})).toContainText('one logical plan');expect(f.h.store.get('select count(*) n from schedules').n).toBe(1);expect(keys.length).toBe(2);expect(keys[1]).toBe(keys[0]);
 }finally{await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});

test('a delayed preview cannot replace the current timezone or an edited form',async({page})=>{
 const f=await environment();let release;
 try{
  await login(page,f);let entered;const seen=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/management/query',async route=>{
   const body=route.request().postDataJSON();if(body.operation==='preview_schedule'&&body.arguments.plan.timezone==='Pacific/Auckland'){const response=await route.fetch();entered();await gate;await route.fulfill({response});}else await route.continue();
  });
  await openScheduleTimeRules(page);
  await page.getByLabel('计划时区',{exact:true}).fill('Pacific/Auckland');await page.getByRole('button',{name:'预览触发时间',exact:true}).click();await seen;await page.getByLabel('计划时区',{exact:true}).fill('UTC');await page.getByRole('button',{name:'预览触发时间',exact:true}).click();await expect(page.getByLabel('计划预览')).toContainText('时区：UTC');
  const finished=page.waitForEvent('requestfinished',request=>request.url().endsWith('/query')&&request.postData()?.includes('Pacific/Auckland'));release();await finished;await page.evaluate(()=>new Promise(requestAnimationFrame));await expect(page.getByLabel('计划预览')).toContainText('时区：UTC');await expect(page.getByLabel('计划预览')).not.toContainText('Auckland');expect(f.h.store.get('select count(*) n from schedules').n).toBe(0);
 }finally{release?.();await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});

test('schedule editor steps and timezone preview stay reachable at six widths',async({page})=>{
 const f=await environment(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await login(page,f);await page.goto(f.h.admin+'/#/projects/101/schedules');await expect(page.getByRole('region',{name:'项目定时任务列表'})).toBeVisible();mkdirSync('.tmp/schedule-editor-234/previews',{recursive:true});
  for(const width of [320,390,768,1024,1440,1920]){
   await page.setViewportSize({width,height:1000});if(width<=760)for(const name of ['要做什么','身份与维护人','触发时间','运行限制']){await page.getByRole('navigation',{name:'计划编辑步骤'}).getByRole('button',{name,exact:true}).click();await expect(page.locator('.schedule-editor-section').filter({has:page.getByRole('heading',{name,exact:true})})).toBeVisible();}
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),String(width)).toBe(true);if([390,1440].includes(width))await page.screenshot({path:'.tmp/schedule-editor-234/previews/'+width+'.png',fullPage:true});
  }
  expect(errors).toEqual([]);expect(f.h.store.get('select count(*) n from schedules').n).toBe(0);
 }finally{await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});

test('a schedule version conflict retains the draft and requires comparison before saving against the new version',async({page})=>{
 const f=await environment();
 try{
  await login(page,f);await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect.poll(()=>f.h.store.get('select count(*) n from schedules').n).toBe(1);
  const before=await read(f,'list_schedules'),plan=before.schedules[0];await page.getByLabel('编辑计划',{exact:true}).selectOption(plan.id);await page.getByLabel('计划名称',{exact:true}).fill('my preserved draft');
  const key=randomId(),receipt=await f.admin('/api/management/commands','POST',{operation:'schedule.update',target:{project_id:'101'},arguments:{id:plan.id,revision:plan.revision,plan:{...plan.spec,name:'another maintainer'}},expected_revision:before.revision,idempotency_key:key,source_conversation:'fixture',source_message:key});expect(receipt.value.state).toBe('succeeded');
  await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect(page.getByLabel('计划名称',{exact:true})).toHaveValue('my preserved draft');await expect(page.getByRole('button',{name:'保存计划',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'刷新定时与通知',exact:true}).click();await expect(page.locator('.schedule-conflict')).toContainText('another maintainer');await expect(page.getByLabel('计划名称',{exact:true})).toHaveValue('my preserved draft');
  await page.getByRole('button',{name:'比较后保留草稿并采用当前版本',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'保留草稿',exact:true}).click();await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect.poll(async()=>(await read(f,'list_schedules')).schedules[0].spec.name).toBe('my preserved draft');
 }finally{await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});

test('a failed initial schedule read reports unknown state and recovers without creating work',async({page})=>{
 const f=await environment();let fail=true;
 try{
  await page.route('**/api/management/query',async route=>{if(fail&&route.request().postDataJSON().operation==='list_schedules')await route.fulfill({status:503,json:{error:'fixture_schedule_read_down'}});else await route.continue();});
  await page.goto(f.h.admin+'/#/projects/101/schedules');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(f.password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'数量及状态未知'})).toBeVisible();await expect(page.getByRole('button',{name:'保存计划',exact:true})).toHaveCount(0);fail=false;await page.getByRole('button',{name:'重新读取计划上下文',exact:true}).click();await expect(page.getByRole('button',{name:'保存计划',exact:true})).toBeVisible();expect(f.h.store.get('select count(*) n from schedules').n).toBe(0);
 }finally{await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});

test('running a saved plan preserves an unrelated unsaved edit in its form',async({page})=>{
 const f=await environment();
 try{
  await login(page,f);await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect.poll(()=>f.h.store.get('select count(*) n from schedules').n).toBe(1);
  const plan=(await read(f,'list_schedules')).schedules[0];await page.getByLabel('编辑计划',{exact:true}).selectOption(plan.id);await page.getByLabel('计划名称',{exact:true}).fill('keep this unsaved name');
  await page.getByRole('button',{name:'立即运行一次',exact:true}).click();await expect.poll(()=>f.h.store.get('select count(*) n from schedule_occurrences').n).toBe(1);
  await expect(page.getByLabel('计划名称',{exact:true})).toHaveValue('keep this unsaved name');expect((await read(f,'list_schedules')).schedules[0].spec.name).toBe(plan.spec.name);
  await page.getByLabel('编辑计划',{exact:true}).selectOption('');await expect(page.getByRole('dialog')).toContainText('未保存修改');await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByLabel('计划名称',{exact:true})).toHaveValue('keep this unsaved name');
 }finally{await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});

test('common time presets and instructions persist; a stored plan of a workflow nothing handles is listed but cannot be edited or saved',async({page})=>{
 const f=await environment();
 try{
  await login(page,f);await page.getByRole('textbox',{name:'要做什么',exact:true}).fill('Inspect blocked work without changing its scope');await page.getByLabel('常用触发时间',{exact:true}).selectOption('0 18 * * *');
  await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect.poll(()=>f.h.store.get('select count(*) n from schedules').n).toBe(1);let plan=(await read(f,'list_schedules')).schedules[0];expect(plan.spec.workflow).toBe('manager.check');expect(plan.spec.cron).toBe('0 18 * * *');expect(plan.spec.parameters.instruction).toBe('Inspect blocked work without changing its scope');expect(plan.spec.parameters.file_issues).toBeUndefined();expect(f.h.store.get('select count(*) n from schedule_occurrences').n).toBe(0);
  await page.getByLabel('编辑计划',{exact:true}).selectOption(plan.id);await expect(page.getByRole('textbox',{name:'要做什么',exact:true})).toHaveValue(plan.spec.parameters.instruction);
  // #1027: only the project scheduled task can be saved; a release plan is refused on the server.
  const {revision}=await read(f,'list_schedules'),key=randomId(),refused=await f.admin('/api/management/commands','POST',{operation:'schedule.register',target:{project_id:'101'},arguments:{plan:{...plan.spec,workflow:'release.scheduled'}},expected_revision:revision,idempotency_key:key,source_conversation:'fixture',source_message:key});
  expect(refused.value.result?.error??refused.value.error).toBe('schedule_workflow_unsupported');
  // A plan an older version saved for such a workflow stays listed, without an edit entry.
  f.h.store.run('update schedules set spec=json_set(spec,\'$.workflow\',\'release.scheduled\') where id=?',plan.id);await page.getByRole('button',{name:'刷新定时与通知',exact:true}).click();
  await expect(page.getByRole('region',{name:'项目定时任务列表'})).toContainText('release.scheduled（不支持）');await expect(page.getByLabel('编辑计划',{exact:true}).locator('option[value="'+plan.id+'"]')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'编辑计划：'+plan.spec.name,exact:true})).toHaveCount(0);
 }finally{await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});


test('a missing schedules capability is explained as missing authority rather than expired project access',async({page})=>{
 const f=await environment();
 try{
  await login(page,f);
  await page.route('**/api/management/query',async route=>{if(route.request().postDataJSON().operation==='list_schedules')await route.fulfill({status:403,json:{error:'capability_forbidden'}});else await route.continue();});
  await page.getByRole('button',{name:'刷新定时与通知',exact:true}).click();
  await expect(page.getByText('当前账号没有计划管理权限，请联系项目管理员核对授权。',{exact:true})).toBeVisible();
  await expect(page.getByText('计划访问权限已失效，请按当前授权重新进入。',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'保存计划',exact:true})).toHaveCount(0);
  expect(f.h.store.get('select count(*) n from schedules').n).toBe(0);
 }finally{await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});

for (const surface of ['management', 'project']) {
  test(`mobile ${surface} editor saves on the first press while an input is focused, then follows the plan to its run`, async ({ page }) => {
    test.setTimeout(90000);
    const f = await environment(), errors = [], commands = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().endsWith('/api/management/commands')) commands.push(request.postDataJSON().operation);
    });
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      if (surface === 'management') await login(page, f);
      else {
        await page.goto(f.h.admin + '/#/projects/101/schedules');
        await page.getByLabel('用户名', { exact: true }).fill('administrator');
        await page.getByLabel('密码', { exact: true }).fill(f.password);
        await page.getByRole('button', { name: '登录', exact: true }).click();
      }
      const steps = page.getByRole('navigation', { name: '计划编辑步骤' });
      await page.getByLabel('计划名称', { exact: true }).fill('Mobile delivery');
      await steps.getByRole('button', { name: '触发时间', exact: true }).click();
      await openScheduleTimeRules(page);
      await page.getByLabel('计划时区', { exact: true }).fill('America/Argentina/Buenos_Aires');
      await page.getByRole('button', { name: '预览触发时间', exact: true }).click();
      await expect(page.getByLabel('计划预览')).toContainText('America/Argentina/Buenos_Aires');
      await expect(page.getByLabel('计划预览')).toContainText('未来触发');
      await page.getByRole('button', { name: '保存计划', exact: true }).click();
      await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1);
      const plan = (await read(f, 'list_schedules')).schedules[0];
      await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id);
      await steps.getByRole('button', { name: '要做什么', exact: true }).click();
      // A reduced viewport models the space left by a keyboard. The pointer press must not lose its target on blur.
      await page.setViewportSize({ width: 390, height: 360 });
      const name = page.getByLabel('计划名称', { exact: true }), save = page.getByRole('button', { name: '保存计划', exact: true });
      await name.fill('Saved from the focused editor'); await name.focus(); await expect(name).toBeFocused();
      // #481: the bar no longer disappears behind the keyboard, so it must not sit between the reader and the control
      // they are about to press: the press has to land on the button itself.
      await save.scrollIntoViewIfNeeded(); await expect(save).toBeInViewport();
      expect(await save.evaluate(el => { const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!hit && (el === hit || el.contains(hit)); })).toBe(true);
      await save.click();
      await expect.poll(async () => (await read(f, 'list_schedules')).schedules[0].spec.name).toBe('Saved from the focused editor');
      expect(commands.filter(operation => operation === 'schedule.update')).toHaveLength(1);
      await page.setViewportSize({ width: 390, height: 844 });
      for (const [label, state] of [['暂停计划', 'paused'], ['恢复计划', 'active']]) {
        await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id);
        await page.getByRole('button', { name: label, exact: true }).click();
        await expect.poll(() => f.h.store.get('SELECT state FROM schedules').state).toBe(state);
      }
      await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id);
      await page.getByRole('button', { name: '立即运行一次', exact: true }).click();
      await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedule_occurrences').n).toBe(1);
      await f.worker.tick();
      const occurrence = (await read(f, 'list_occurrences')).records[0];
      expect(occurrence.state).toBe('succeeded'); expect(f.h.store.get('SELECT count(*) n FROM notification_outbox').n).toBe(0);
      const record = page.locator('.schedule-record').first();
      await page.getByRole('button', { name: '查看运行与跳过原因', exact: true }).click();
      await record.locator(':scope > summary').click();
      await expect(record).toHaveAttribute('data-record-id', occurrence.id); await expect(record).toContainText('执行成功');
      expect(commands.filter(operation => operation === 'schedule.register')).toHaveLength(1);
      expect(commands.filter(operation => operation === 'schedule.run-now')).toHaveLength(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
  });
}
// #234 验收第 2、3、4 条：预览里的下一触发必须与服务端 nextTime 一致（换时区后同样），有效期结束后不再给出时间；
// 键盘能到时间预览与主操作并用 Enter 触发；390px 下长时区与长目的地要能读全，不能被省略号截断。
test('schedule preview matches the server after a timezone change, is reachable by keyboard and keeps long names readable at 390px', async ({ page }) => {
  test.setTimeout(180000); const f = await environment();
  try {
    await page.setViewportSize({ width: 1440, height: 1300 }); await login(page, f);
    const start = new Date(Date.now() - 86400000).toISOString();
    await page.getByLabel('计划名称', { exact: true }).fill('跨时区长名称计划：大西洋两岸的日报协调');
    await openScheduleTimeRules(page);
    await page.getByLabel('计划时区', { exact: true }).fill('America/Argentina/ComodRivadavia');
    await page.getByLabel('有效期开始', { exact: true }).fill(start);
    // 键盘：从计划名称开始按 Tab 能到「预览触发时间」，Enter 触发预览。
    await page.getByLabel('计划名称', { exact: true }).focus();
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement?.textContent?.trim() === '预览触发时间'); }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('计划预览')).toContainText('未来触发');
    // 换时区后，预览列的每条未来时间必须等于服务端 preview_schedule 的 nextTime 结果。
    await openScheduleTimeRules(page);
    await page.getByLabel('计划时区', { exact: true }).fill('Europe/Berlin');
    await page.getByRole('button', { name: '预览触发时间', exact: true }).click();
    await expect(page.getByLabel('计划预览')).toContainText('Europe/Berlin');
    const plan = { name: '跨时区长名称计划：大西洋两岸的日报协调', kind: 'personal', actor_id: f.principal, owner_id: f.principal, maintainer_id: f.principal,
      workflow: 'manager.check', parameters: { instruction: '' }, timezone: 'Europe/Berlin', cron: '0 9 * * *', start_at: Date.parse(start), enabled: true,
      misfire: 'skip', grace_ms: 60000, limits: { ...defaultLimits } };
    const server = (await f.admin('/api/management/query', 'POST', { operation: 'preview_schedule', target: { project_id: '101' }, arguments: { plan } })).value;
    const ui = (await page.getByLabel('计划预览').innerText()).split('\n').filter(line => line.includes('Europe/Berlin') && !line.startsWith('时区：') && !line.startsWith('时间窗口'));
    const expected = [];
    // Independent oracle: the test builds the reading itself instead of asking the page for it, so a broken helper
    // cannot agree with itself. The shape is the one docs/design/console-and-api.md asks for: YYYY-MM-DD HH:mm:ss, 24-hour.
    const clockAt = (ts, zone) => {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts));
      const part = type => parts.find(item => item.type === type).value;
      return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} · ${zone}`;
    };
    for (const at of server.future) expected.push(clockAt(at, 'Europe/Berlin'));
    expect(ui).toEqual(expected);
    // 有效期结束后不再显示某个时间。
    await page.getByLabel('有效期结束（可留空）', { exact: true }).fill(new Date(Date.now() - 3600000).toISOString());
    await page.getByRole('button', { name: '预览触发时间', exact: true }).click();
    await expect(page.getByLabel('计划预览')).toContainText('无下一次触发');
    // 390px：长时区和长名称能读全，页面不横向溢出（项目定时任务没有飞书目的地，#1027）。
    await openScheduleTimeRules(page);
    await page.getByLabel('计划时区', { exact: true }).fill('America/Argentina/ComodRivadavia');
    await page.setViewportSize({ width: 390, height: 900 });
    const context = page.locator('.schedule-context');
    await expect(context).toContainText('America/Argentina/ComodRivadavia');
    expect(await context.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    const name = page.getByLabel('计划名称', { exact: true });
    expect(await name.evaluate(node => node.getBoundingClientRect().right <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

// #1027: daily report plans of an older version are moved to their chats' timers at start; the page lists each one.
test('the daily report migration report lists every moved plan and the stopped plan cannot be edited', async ({ page }) => {
  test.setTimeout(90000); const f = await environment(), errors = []; page.on('pageerror', e => errors.push(e.message));
  mkdirSync('.tmp/schedules-1027', { recursive: true });
  try {
    const spec = { name: '项目日报', kind: 'personal', actor_id: f.principal, owner_id: f.principal, maintainer_id: f.principal, workflow: 'report.daily', parameters: {},
      timezone: 'Asia/Shanghai', cron: '0 9 * * *', start_at: f.now(), enabled: true, misfire: 'skip', grace_ms: 60000, destination_id: f.destination, limits: defaultLimits };
    for (const [id, destination] of [['daily-moved', f.destination], ['daily-lost', 'no-such-registration']]) f.h.store.run(`INSERT INTO schedules(id,tenant_id,project_id,creator_id,owner_id,maintainer_id,actor_id,kind,approver_id,
      authorization_revision,grant_snapshot,spec,revision,state,reason,next_at,created_at,updated_at) VALUES(?,'github.com:10','101',?,?,?,?,'personal',NULL,1,'{"capabilities":[],"grants":[]}',?,1,'active',NULL,?,?,?)`,
      id, f.principal, f.principal, f.principal, f.principal, JSON.stringify({ ...spec, destination_id: destination }), f.now() + 60000, f.now(), f.now());
    const moved = migrateDailyReports(f.worker.service);
    expect(moved.map(row => [row.schedule_id, row.outcome]).sort()).toEqual([['daily-lost', 'failed'], ['daily-moved', 'migrated']]);
    await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto(f.h.admin + '/#/projects/101/schedules');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const report = page.getByRole('region', { name: '项目日报迁移记录', exact: true });
    await expect(report).toBeVisible(); await expect(report.getByRole('article')).toHaveCount(2);
    await expect(report).toContainText('已迁移'); await expect(report).toContainText('私聊'); await expect(report).toContainText('项目日报（agent-test-zone/admin-fixture-101）');
    await expect(report).toContainText('未迁移'); await expect(report).toContainText('原来的通知目的地已不存在');
    const list = page.getByRole('region', { name: '项目定时任务列表', exact: true });
    await expect(list).toContainText('项目日报（已停用）'); await expect(list).toContainText('已迁移到飞书会话的定时任务');
    await expect(page.getByLabel('编辑计划', { exact: true }).locator('option[value="daily-moved"]')).toHaveCount(0);
    await report.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.tmp/schedules-1027/migration-1440.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await report.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/schedules-1027/migration-390.png' }); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
