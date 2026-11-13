import { test, expect } from '@playwright/test';
import { openScheduleTimeRules, openScheduleIdentity } from './open-schedule-folds.mjs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomId } from '../dist/core/security.js';
import { defaultLimits } from '../dist/schedules/types.js';
import { channelFixture, bindFixture, privateChat, boundGroup, registerDestination } from '../test/channel-fixture.mjs';

async function environment() {
  let now = Date.now(), worker;
  const f = await channelFixture(undefined, { schedules: { automatic: false, clock: () => now }, onSchedules: s => { worker = s; } });
  now = Date.now(); f.worker = worker; f.advance = ms => { now += ms; };
  // Destinations are registered in the console (#312).
  f.destination = await registerDestination(f.admin, await privateChat(f));
  await f.service.tick(); return f;
}
async function login(page, f, username = 'administrator', password = f.password) {
  await page.goto(f.h.admin + '/#/management');
  await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('当前管理作用域').selectOption('project:101');
  await page.getByRole('button', { name: '快捷操作', exact: true }).click();
  await expect(page.getByRole('button', { name: '预览日报计划', exact: true })).toBeVisible();
}
const read = async (f, operation) => (await f.admin('/api/management/query', 'POST', { operation, target: { project_id: '101' }, arguments: {} })).value;
test('user previews and creates a timezone-aware daily report, then explicitly runs and stops it', async ({ page }) => {
  test.setTimeout(90000); const f = await environment(), errors = [];
  page.on('pageerror', e => errors.push(e.message)); mkdirSync('.tmp/schedules-166', { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1100 }); await login(page, f);
    await page.getByLabel('计划名称', { exact: true }).fill('每日项目证据');
    await openScheduleTimeRules(page);
    await page.getByLabel('计划时区', { exact: true }).fill('Asia/Shanghai'); await page.getByLabel('Cron 表达式', { exact: true }).fill('0 9 * * *');
    await page.getByRole('button', { name: '预览日报计划', exact: true }).click();
    await expect(page.getByLabel('计划预览')).toContainText('Asia/Shanghai'); await expect(page.getByLabel('计划预览')).toContainText('缺数');
    await expect(page.getByLabel('计划预览')).toContainText('waiting_environment');
    await page.screenshot({ path: '.tmp/schedules-166/daily-preview-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1);
    const plan = (await read(f, 'list_schedules')).schedules[0];
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id);
    await page.getByRole('button', { name: '立即运行一次', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedule_occurrences').n).toBe(1); await f.worker.tick();
    const run = (await read(f, 'list_occurrences')).records[0], delivery = (await read(f, 'list_notification_deliveries')).records[0];
    expect(run.state).toBe('succeeded'); expect(delivery.state).toBe('sent'); expect(delivery.payload.report.evidence.some(e => e.id === 'task:blocked')).toBe(true);
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id); await page.getByRole('button', { name: '暂停计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT state FROM schedules').state).toBe('paused');
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/schedules-166/daily-paused-mobile.png', fullPage: true });
    writeFileSync('.tmp/schedules-166/daily-evidence.json', JSON.stringify({ schedule: plan, occurrence: run, delivery, page_errors: errors }, null, 2)); expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
test('user personal schedule pauses after revocation and its queued report never leaves the channel', async ({ page }) => {
  test.setTimeout(90000); const f = await environment(); mkdirSync('.tmp/schedules-166', { recursive: true });
  try {
    // The same human can own a personal schedule and later lose their project authorization.
    await login(page, f); await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1);
    const plan = (await read(f, 'list_schedules')).schedules[0];
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id); await page.getByRole('button', { name: '立即运行一次', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedule_occurrences').n).toBe(1);
    f.worker.dispatch(f.worker.claimOccurrence()); const before = f.wire.sent.length;
    f.h.store.run('UPDATE users SET active=0 WHERE id=?', f.principal); await f.worker.tick();
    const schedule = f.h.store.get('SELECT id,state,reason FROM schedules'), delivery = f.h.store.get('SELECT id,state,last_error FROM notification_outbox');
    expect(schedule.state).toBe('paused'); expect(delivery.state).toBe('blocked'); expect(f.wire.sent.length).toBe(before);
    writeFileSync('.tmp/schedules-166/revocation-evidence.json', JSON.stringify({ schedule, delivery, sends_before: before, sends_after: f.wire.sent.length }, null, 2));
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
test('a group destination stops at preview and before delivery once its binding no longer reaches the project', async ({ page }) => {
  test.setTimeout(90000); const f = await environment(); mkdirSync('.tmp/schedules-166', { recursive: true });
  try {
    const chat = await boundGroup(f, ['101']), groupDestination = await registerDestination(f.admin, chat); await f.service.tick();
    await login(page, f); await page.getByLabel('计划目的地', { exact: true }).selectOption(groupDestination);
    await page.getByRole('button', { name: '保存计划', exact: true }).click(); await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1);
    const plan = (await read(f, 'list_schedules')).schedules[0];
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id); await page.getByRole('button', { name: '立即运行一次', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedule_occurrences').n).toBe(1); f.worker.dispatch(f.worker.claimOccurrence());
    const binding = f.h.store.get('SELECT revision FROM channel_service_bindings');
    expect((await f.admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['102'] }, enabled: true, expected_revision: binding.revision })).status).toBe(200);
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id); await page.getByRole('button', { name: '预览日报计划', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'channel_service_scope_paused' })).toBeVisible();
    const before = f.wire.sent.length; await f.worker.tick(); const delivery = f.h.store.get('SELECT id,state,last_error FROM notification_outbox');
    expect(delivery.state).toBe('blocked'); expect(f.wire.sent.length).toBe(before);
    await page.screenshot({ path: '.tmp/schedules-166/group-scope-rejected.png', fullPage: true });
    writeFileSync('.tmp/schedules-166/group-scope-evidence.json', JSON.stringify({ delivery, sends_before: before, sends_after: f.wire.sent.length, preview_error: 'channel_service_scope_paused' }, null, 2));
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});

test('an administrator previews and saves a maintainer handover after the project owner leaves', async ({ page }) => {
  test.setTimeout(90000); const f = await environment();
  try {
    const successor = await f.member('handover-admin-browser', { role: 'super_admin' }), maintainer = await f.member('handover-maintainer-browser', { repository_ids: ['101'] });
    const service = randomId(), capabilities = JSON.stringify(['tasks.read', 'schedules.manage']);
    f.h.store.run("INSERT INTO principals(id,kind,project_id,tenant_id,maintenance) VALUES(?,'service','101','github.com:10','project maintainers')", service);
    f.h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
      VALUES(?,?,'github.com:10','101','project','service',?,'explicit_delegation',?,'schedule','fixture approval',?)`, randomId(), service, capabilities, f.principal, Date.now());
    // The group is bound by a maintainer who stays; the departing owner's authority does not carry the group's scope.
    const keeper = await f.member('group-keeper-browser', { repository_ids: ['101'] });
    bindFixture(f.h, f.id, keeper.id, 'ou_keeper'); f.wire.state.members.push({ member_id_type: 'open_id', member_id: 'ou_keeper', tenant_key: 'actor-tenant' });
    const destination = await registerDestination(f.admin, await boundGroup(f, ['101'], 'oc_group', keeper.client));
    await login(page, f); await openScheduleIdentity(page); await page.getByLabel('执行身份类型', { exact: true }).selectOption('project');
    await page.getByLabel('项目服务身份', { exact: true }).selectOption(service); await page.getByLabel('项目维护人', { exact: true }).selectOption(f.principal);
    await page.getByLabel('计划目的地', { exact: true }).selectOption(destination); await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1); const original = (await read(f, 'list_schedules')).schedules[0];
    expect((await successor.client('/api/users/' + f.principal, 'PATCH', { active: false })).status).toBe(200); await f.worker.tick();
    expect(f.h.store.get('SELECT state FROM schedules').state).toBe('paused');
    await page.context().clearCookies(); await page.reload(); await login(page, f, 'handover-admin-browser', successor.password);
    await page.getByLabel('编辑计划', { exact: true }).selectOption(original.id); await openScheduleIdentity(page); await page.getByLabel('项目维护人', { exact: true }).selectOption(maintainer.id);
    await page.getByRole('button', { name: '预览日报计划', exact: true }).click(); await expect(page.getByLabel('计划预览')).toContainText('Asia/Shanghai');
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
  await page.getByRole('button',{name:'核对同一次计划操作',exact:true}).click();await expect(page.getByRole('region',{name:'项目计划列表'})).toContainText('one logical plan');expect(f.h.store.get('select count(*) n from schedules').n).toBe(1);expect(keys.length).toBe(2);expect(keys[1]).toBe(keys[0]);
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
  await page.getByLabel('计划时区',{exact:true}).fill('Pacific/Auckland');await page.getByRole('button',{name:'预览日报计划',exact:true}).click();await seen;await page.getByLabel('计划时区',{exact:true}).fill('UTC');await page.getByRole('button',{name:'预览日报计划',exact:true}).click();await expect(page.getByLabel('计划预览')).toContainText('时区：UTC');
  const finished=page.waitForEvent('requestfinished',request=>request.url().endsWith('/query')&&request.postData()?.includes('Pacific/Auckland'));release();await finished;await page.evaluate(()=>new Promise(requestAnimationFrame));await expect(page.getByLabel('计划预览')).toContainText('时区：UTC');await expect(page.getByLabel('计划预览')).not.toContainText('Auckland');expect(f.h.store.get('select count(*) n from schedules').n).toBe(0);
 }finally{release?.();await f.close();rmSync(f.h.directory,{recursive:true,force:true});}
});

test('schedule editor steps and timezone preview stay reachable at six widths',async({page})=>{
 const f=await environment(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await login(page,f);await page.goto(f.h.admin+'/#/projects/101/schedules');await expect(page.getByRole('region',{name:'项目计划列表'})).toBeVisible();mkdirSync('.tmp/schedule-editor-234/previews',{recursive:true});
  for(const width of [320,390,768,1024,1440,1920]){
   await page.setViewportSize({width,height:1000});if(width<=760)for(const name of ['执行内容','身份与维护人','触发时间','通知目的地','运行限制']){await page.getByRole('navigation',{name:'计划编辑步骤'}).getByRole('button',{name,exact:true}).click();await expect(page.locator('.schedule-editor-section').filter({has:page.getByRole('heading',{name,exact:true})})).toBeVisible();}
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
  await page.goto(f.h.admin+'/#/management');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(f.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByLabel('当前管理作用域').selectOption('project:101');await page.getByRole('button',{name:'快捷操作',exact:true}).click();
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

test('common time presets and manager instructions persist while unsupported release plans cannot run',async({page})=>{
 const f=await environment();
 try{
  await login(page,f);await page.getByRole('combobox',{name:'执行内容',exact:true}).selectOption('manager.check');await page.getByLabel('定时检查内容',{exact:true}).fill('Inspect blocked work without changing its scope');await page.getByLabel('常用触发时间',{exact:true}).selectOption('0 18 * * *');
  await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect.poll(()=>f.h.store.get('select count(*) n from schedules').n).toBe(1);let plan=(await read(f,'list_schedules')).schedules[0];expect(plan.spec.cron).toBe('0 18 * * *');expect(plan.spec.parameters.instruction).toBe('Inspect blocked work without changing its scope');expect(f.h.store.get('select count(*) n from schedule_occurrences').n).toBe(0);
  await page.getByLabel('编辑计划',{exact:true}).selectOption(plan.id);await expect(page.getByLabel('定时检查内容',{exact:true})).toHaveValue(plan.spec.parameters.instruction);await page.getByRole('combobox',{name:'执行内容',exact:true}).selectOption('release.scheduled');await page.getByRole('button',{name:'保存计划',exact:true}).click();
  await expect.poll(async()=>(await read(f,'list_schedules')).schedules[0].spec.workflow).toBe('release.scheduled');await page.getByLabel('编辑计划',{exact:true}).selectOption(plan.id);await expect(page.getByRole('button',{name:'立即运行一次',exact:true})).toBeDisabled();await expect(page.getByRole('region',{name:'项目计划列表'})).toContainText('未支持，不表示可执行');
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
  test(`mobile ${surface} editor saves on the first press while an input is focused, then follows the plan to delivery`, async ({ page }) => {
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
      await page.getByRole('button', { name: '预览日报计划', exact: true }).click();
      await expect(page.getByLabel('计划预览')).toContainText('America/Argentina/Buenos_Aires');
      await expect(page.getByLabel('计划预览')).toContainText('未来触发');
      await page.getByRole('button', { name: '保存计划', exact: true }).click();
      await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1);
      const plan = (await read(f, 'list_schedules')).schedules[0];
      await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id);
      await steps.getByRole('button', { name: '执行内容', exact: true }).click();
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
      const occurrence = (await read(f, 'list_occurrences')).records[0], delivery = (await read(f, 'list_notification_deliveries')).records[0];
      expect(occurrence.state).toBe('succeeded'); expect(delivery.state).toBe('sent');
      const record = page.locator('.schedule-record').first();
      await page.getByRole('button', { name: '查看运行与跳过原因', exact: true }).click();
      await record.locator(':scope > summary').click();
      await expect(record).toHaveAttribute('data-record-id', occurrence.id); await expect(record).toContainText('执行成功');
      await page.getByRole('button', { name: '查看通知及失败队列', exact: true }).click();
      await record.locator(':scope > summary').click();
      await expect(record).toContainText('第 1 次 · 已送达');
      await expect(record).toContainText('America/Argentina/Buenos_Aires');
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
  const longChat = await privateChat(f, 'ou_alice', f.principal, 'oc_' + 'x'.repeat(40));
  const longDestination = await registerDestination(f.admin, longChat); await f.service.tick();
  try {
    await page.setViewportSize({ width: 1440, height: 1300 }); await login(page, f);
    const start = new Date(Date.now() - 86400000).toISOString();
    await page.getByLabel('计划名称', { exact: true }).fill('跨时区长名称计划：大西洋两岸的日报协调');
    await openScheduleTimeRules(page);
    await page.getByLabel('计划时区', { exact: true }).fill('America/Argentina/ComodRivadavia');
    await page.getByLabel('有效期开始', { exact: true }).fill(start);
    await page.getByLabel('计划目的地', { exact: true }).selectOption(longDestination);
    // 键盘：从计划名称开始按 Tab 能到「预览日报计划」，Enter 触发预览。
    await page.getByLabel('计划名称', { exact: true }).focus();
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement?.textContent?.trim() === '预览日报计划'); }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('计划预览')).toContainText('未来触发');
    // 换时区后，预览列的每条未来时间必须等于服务端 preview_schedule 的 nextTime 结果。
    await openScheduleTimeRules(page);
    await page.getByLabel('计划时区', { exact: true }).fill('Europe/Berlin');
    await page.getByRole('button', { name: '预览日报计划', exact: true }).click();
    await expect(page.getByLabel('计划预览')).toContainText('Europe/Berlin');
    const plan = { name: '跨时区长名称计划：大西洋两岸的日报协调', kind: 'personal', actor_id: f.principal, owner_id: f.principal, maintainer_id: f.principal,
      workflow: 'report.daily', parameters: {}, timezone: 'Europe/Berlin', cron: '0 9 * * *', start_at: Date.parse(start), enabled: true,
      misfire: 'skip', grace_ms: 60000, destination_id: longDestination, limits: { ...defaultLimits } };
    const server = (await f.admin('/api/management/query', 'POST', { operation: 'preview_schedule', target: { project_id: '101' }, arguments: { plan } })).value;
    const ui = (await page.getByLabel('计划预览').innerText()).split('\n').filter(line => line.includes('Europe/Berlin') && !line.startsWith('时区：') && !line.startsWith('时间窗口'));
    const expected = [];
    for (const at of server.future) expected.push(await page.evaluate(([ts, zone]) => new Date(ts).toLocaleString(undefined, { timeZone: zone }) + ' · ' + zone, [at, 'Europe/Berlin']));
    expect(ui).toEqual(expected);
    // 有效期结束后不再显示某个时间。
    await page.getByLabel('有效期结束（可留空）', { exact: true }).fill(new Date(Date.now() - 3600000).toISOString());
    await page.getByRole('button', { name: '预览日报计划', exact: true }).click();
    await expect(page.getByLabel('计划预览')).toContainText('无下一次触发');
    // 390px：执行时区与目的地一行能读全，页面不横向溢出。
    await openScheduleTimeRules(page);
    await page.getByLabel('计划时区', { exact: true }).fill('America/Argentina/ComodRivadavia');
    await page.setViewportSize({ width: 390, height: 900 });
    const context = page.locator('.schedule-context');
    await expect(context).toContainText('America/Argentina/ComodRivadavia');
    await expect(context).toContainText('oc_' + 'x'.repeat(40));
    expect(await context.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
