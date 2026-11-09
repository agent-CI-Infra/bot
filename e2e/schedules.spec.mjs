import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomId } from '../dist/core/security.js';
import { channelFixture, envelope, post, finished, group, inGroup } from '../test/channel-fixture.mjs';

async function environment() {
  let now = Date.now(), worker;
  const f = await channelFixture(undefined, { schedules: { automatic: false, clock: () => now }, onSchedules: s => { worker = s; } });
  now = Date.now(); f.worker = worker; f.advance = ms => { now += ms; };
  const result = await post(f.h, f.id, envelope('/project 101 /destination')); await finished(f.h, result.value.operation_id);
  f.destination = f.h.store.get("SELECT id FROM channel_outbox WHERE state='registered'").id;
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
test('user group destination rejects private project content at preview and before delivery', async ({ page }) => {
  test.setTimeout(90000); const f = await environment(); mkdirSync('.tmp/schedules-166', { recursive: true });
  try {
    await group(f.admin, f.id);
    const registered = await post(f.h, f.id, inGroup('/project 101 /destination')); await finished(f.h, registered.value.operation_id); await f.service.tick();
    const groupDestination = f.h.store.all("SELECT * FROM channel_outbox WHERE state='registered'").find(r => f.h.store.secrets.open(r.payload, 'channel-outbox:' + r.id).event.chat_type === 'group').id;
    await login(page, f); await page.getByLabel('计划目的地', { exact: true }).selectOption(groupDestination);
    await page.getByRole('button', { name: '保存计划', exact: true }).click(); await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1);
    const plan = (await read(f, 'list_schedules')).schedules[0];
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id); await page.getByRole('button', { name: '立即运行一次', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedule_occurrences').n).toBe(1); f.worker.dispatch(f.worker.claimOccurrence());
    f.h.store.run("UPDATE installed_repositories SET private=1 WHERE repository_id='101'"); f.h.store.run("UPDATE channel_group_scopes SET sensitivity='public' WHERE project_id='101'");
    await page.getByLabel('编辑计划', { exact: true }).selectOption(plan.id); await page.getByRole('button', { name: '预览日报计划', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'channel_group_scope_required' })).toBeVisible();
    const before = f.wire.sent.length; await f.worker.tick(); const delivery = f.h.store.get('SELECT id,state,last_error FROM notification_outbox');
    expect(delivery.state).toBe('blocked'); expect(f.wire.sent.length).toBe(before);
    await page.screenshot({ path: '.tmp/schedules-166/group-private-rejected.png', fullPage: true });
    writeFileSync('.tmp/schedules-166/group-scope-evidence.json', JSON.stringify({ delivery, sends_before: before, sends_after: f.wire.sent.length, preview_error: 'channel_group_scope_required' }, null, 2));
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
    await group(f.admin, f.id);
    const registered = await post(f.h, f.id, inGroup('/project 101 /destination')); await finished(f.h, registered.value.operation_id);
    const destination = f.h.store.all("SELECT * FROM channel_outbox WHERE state='registered'").find(r => f.h.store.secrets.open(r.payload, 'channel-outbox:' + r.id).event.chat_type === 'group').id;
    await login(page, f); await page.getByLabel('执行身份类型', { exact: true }).selectOption('project');
    await page.getByLabel('项目服务身份', { exact: true }).selectOption(service); await page.getByLabel('项目维护人', { exact: true }).selectOption(f.principal);
    await page.getByLabel('计划目的地', { exact: true }).selectOption(destination); await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT count(*) n FROM schedules').n).toBe(1); const original = (await read(f, 'list_schedules')).schedules[0];
    expect((await successor.client('/api/users/' + f.principal, 'PATCH', { active: false })).status).toBe(200); await f.worker.tick();
    expect(f.h.store.get('SELECT state FROM schedules').state).toBe('paused');
    await page.context().clearCookies(); await page.reload(); await login(page, f, 'handover-admin-browser', successor.password);
    await page.getByLabel('编辑计划', { exact: true }).selectOption(original.id); await page.getByLabel('项目维护人', { exact: true }).selectOption(maintainer.id);
    await page.getByRole('button', { name: '预览日报计划', exact: true }).click(); await expect(page.getByLabel('计划预览')).toContainText('Asia/Shanghai');
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => f.h.store.get('SELECT maintainer_id FROM schedules').maintainer_id).toBe(maintainer.id);
    const saved = f.h.store.get('SELECT * FROM schedules'); expect(saved.owner_id).toBe(original.owner_id); expect(saved.creator_id).toBe(original.creator_id); expect(saved.actor_id).toBe(service);
    expect(JSON.parse(saved.grant_snapshot).capabilities).toEqual(original.grant_snapshot.capabilities);
    expect(f.h.store.get('SELECT capabilities FROM scoped_grants WHERE principal_id=?', service).capabilities).toBe(capabilities);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
