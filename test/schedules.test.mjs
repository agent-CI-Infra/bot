import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Store } from '../dist/storage/database.js';
import { resolveActor, invalidate, authorize } from '../dist/identity/authorization.js';
import { ManagementService } from '../dist/management/service.js';
import { ManagementAgent } from '../dist/management/agent.js';
import { RuleService } from '../dist/rules/service.js';
import { TaskCommands } from '../dist/tasks/commands.js';
import { ChannelService } from '../dist/channels/service.js';
import { ScheduleService } from '../dist/schedules/service.js';
import { Scheduler } from '../dist/schedules/worker.js';
import { scheduleStorage } from '../dist/schedules/storage.js';
import { defaultLimits } from '../dist/schedules/types.js';
import { nextTime, previewTimes, quietUntil } from '../dist/schedules/time.js';
import { HttpError, randomId } from '../dist/core/security.js';
import { configureDispatch, ruleDecider } from '../dist/dispatch/worker.js';
import { channelFixture, envelope, post, finished, until, inGroup, bindFixture, privateChat, boundGroup, registerDestination } from './channel-fixture.mjs';

const target = { project_id: '101' };
const query = async (f, operation, args = {}, client = f.admin, project = '101') => {
  const r = await client('/api/management/query', 'POST', { operation, target: { project_id: project }, arguments: args });
  assert.equal(r.status, 201, JSON.stringify(r.value)); return r.value;
};
async function command(f, operation, args, client = f.admin, key = randomId()) {
  const { revision } = await query(f, 'list_schedules', {}, client);
  return client('/api/management/commands', 'POST', { operation, target, arguments: args, expected_revision: revision,
    idempotency_key: key, source_conversation: 'schedule-fixture', source_message: key });
}
async function fixture(t, timeOfDay) {
  let now = Date.now(), worker;
  const f = await channelFixture(t, { schedules: { clock: () => now, automatic: false }, onSchedules: s => { worker = s; } });
  now = Date.now();
  // Daily quota tests must keep their successive occurrences in the same UTC day.
  if (timeOfDay !== undefined) now = Math.floor(now / 86400000) * 86400000 + timeOfDay;
  f.worker = worker; f.advance = ms => { now += ms; }; f.now = () => now;
  f.actor = () => resolveActor(f.h.store, f.admin.cookie().split('=')[1], { project_id: '101' });
  f.destination = await registerDestination(f.admin, await privateChat(f));
  f.plan = override => ({ name: '项目日报', kind: 'personal', actor_id: f.principal, owner_id: f.principal, maintainer_id: f.principal,
    workflow: 'report.daily', parameters: {}, timezone: 'Asia/Shanghai', interval_ms: 60000, start_at: f.now() + 60000, enabled: true,
    misfire: 'skip', grace_ms: 60000, destination_id: f.destination, limits: { ...defaultLimits }, ...override });
  f.create = async (plan = f.plan()) => {
    const r = await command(f, 'schedule.register', { plan }); assert.equal(r.status, 201); assert.equal(r.value.state, 'succeeded', JSON.stringify(r.value)); return r.value.result.schedule;
  };
  return f;
}
function otherWorker(f, t, transport) {
  const store = new Store(f.h.database, f.h.key), management = new ManagementService(store, new RuleService(store), new TaskCommands(store));
  const channels = new ChannelService(store, new ManagementAgent(store, management), { origin: 'https://console.example.test', fetch: f.wire.fetch });
  const service = new ScheduleService(store, management, channels, f.now), worker = new Scheduler(service, transport);
  t.after(async () => { await worker.close(); store.close(); }); return worker;
}
/** A group bound by a maintainer who stays: its binding's authority belongs to that maintainer, not to a departing plan owner. */
async function keptGroup(f) {
  const keeper = await f.member('group-keeper-' + randomId().slice(0, 6), { repository_ids: ['101'] });
  bindFixture(f.h, f.id, keeper.id, 'ou_keeper'); f.wire.state.members.push({ member_id_type: 'open_id', member_id: 'ou_keeper', tenant_key: 'actor-tenant' });
  return boundGroup(f, ['101'], 'oc_group', keeper.client);
}
async function projectPlan(f, maintainer, owner = f.principal) {
  const service = randomId();
  f.h.store.run("INSERT INTO principals(id,kind,project_id,tenant_id,maintenance) VALUES(?,'service','101','github.com:10','project maintainers')", service);
  f.h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
    VALUES(?,?,'github.com:10','101','project','service',?,'explicit_delegation',?,'schedule','fixture approval',?)`, randomId(), service, JSON.stringify(['tasks.read', 'schedules.manage']), f.principal, f.now());
  const destination = await registerDestination(f.admin, await keptGroup(f));
  return f.plan({ kind: 'project', actor_id: service, maintainer_id: maintainer, owner_id: owner, destination_id: destination });
}
test('wall-clock preview chooses first DST fold, skips gaps, uses cron OR semantics and bounds misfires', () => {
  const plan = { timezone: 'America/New_York', cron: '30 1 * * *', start_at: 0 };
  assert.deepEqual(previewTimes(plan, Date.parse('2026-11-01T00:00Z'), 2).map(v => new Date(v).toISOString()), ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  assert.equal(new Date(nextTime(plan, Date.parse('2026-11-01T05:31Z'))).toISOString(), '2026-11-02T06:30:00.000Z');
  assert.equal(new Date(nextTime({ ...plan, cron: '30 2 * * *' }, Date.parse('2026-03-08T00:00Z'))).toISOString(), '2026-03-09T06:30:00.000Z');
  assert.equal(new Date(nextTime({ ...plan, timezone: 'UTC', cron: '0 9 1 * 1' }, Date.parse('2026-11-01T09:01Z'))).toISOString(), '2026-11-02T09:00:00.000Z');
  assert.throws(() => nextTime({ ...plan, cron: '* * * * * *' }, Date.now()), /invalid_schedule_cron/);
  assert.throws(() => nextTime({ ...plan, timezone: 'Moon/Base' }, Date.now()), /invalid_schedule_timezone/);
  assert.equal(new Date(quietUntil({ timezone: 'America/New_York', quiet_start: '22:00', quiet_end: '07:00' }, Date.parse('2026-11-01T04:00Z'))).toISOString(), '2026-11-01T12:00:00.000Z');
});
// #234 验收第 2 条：有效期必须和服务端算法一致。cron 与固定周期两条分支都以 end_at 为开区间上界，
// 而空窗口（end_at <= start_at）必须在校验层被拒，不能落成一个永远没有下次触发的计划。
test('nextTime excludes a trigger that lands exactly on end_at and rejects a window that ends before it starts', async t => {
  const base = { timezone: 'UTC', start_at: Date.parse('2026-11-01T00:00Z') };
  const cronPlan = { ...base, cron: '0 9 * * *' }, after = Date.parse('2026-11-01T10:00Z'), ninth = Date.parse('2026-11-02T09:00Z');
  assert.equal(nextTime({ ...cronPlan, end_at: ninth }, after), null);
  assert.equal(nextTime({ ...cronPlan, end_at: ninth + 1 }, after), ninth);
  const interval = { ...base, interval_ms: 3600000 }, halfway = Date.parse('2026-11-01T05:30Z'), six = Date.parse('2026-11-01T06:00Z');
  assert.equal(nextTime(interval, halfway), six);
  assert.equal(nextTime({ ...interval, end_at: six }, halfway), null);
  assert.equal(nextTime({ ...interval, end_at: six + 1 }, halfway), six);
  const f = await fixture(t);
  await assert.rejects(query(f, 'preview_schedule', { plan: f.plan({ interval_ms: undefined, cron: '0 9 * * *', end_at: f.now() }) }), /invalid_schedule_recurrence/);
});
test('user creates and previews a daily report, sees evidence, runs now and receives a persisted delivery', async t => {
  const f = await fixture(t);
  f.modelState.failure = 503;
  // Chat text no longer registers a destination; registration happens in the console (#312).
  const registeredBefore = f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE state='registered'").n;
  const typed = await post(f.h, f.id, envelope('/project 101 /destination')); await finished(f.h, typed.value.operation_id);
  assert.equal(f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE state='registered'").n, registeredBefore);
  const modelRequests = f.requests.length;
  const preview = await query(f, 'preview_schedule', { plan: f.plan({ cron: '0 9 * * *', interval_ms: undefined }) });
  assert.equal(preview.timezone, 'Asia/Shanghai'); assert.equal(preview.future.length, 5);
  assert.ok(preview.report.evidence.some(e => e.id === 'task:blocked'));
  assert.match(preview.report.text, /不能据此判定全部成功/); assert.match(preview.report.text, /仍未结束的任务：1/);
  const schedule = await f.create(), run = await command(f, 'schedule.run-now', { id: schedule.id, revision: 1 });
  assert.equal(run.value.state, 'succeeded');
  await f.worker.tick(); const occurrence = (await query(f, 'list_occurrences')).records[0];
  assert.equal(occurrence.state, 'succeeded'); assert.equal(occurrence.snapshot.plan.timezone, 'Asia/Shanghai');
  const deliveries = (await query(f, 'list_notification_deliveries')).records;
  assert.equal(deliveries[0].state, 'sent'); assert.equal(deliveries[0].attempts, 1); assert.ok(deliveries[0].remote_message_id);
  assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_business_runs').n, 1);
  assert.equal(f.requests.length, modelRequests); assert.equal(deliveries[0].payload.report.model, 'deterministic_no_model');
});
test('restart recovers an expired lease and two workers/replayed ticks create one occurrence and one business run', async t => {
  const f = await fixture(t); await f.create(); f.advance(60000); f.worker.produce();
  const claim = f.worker.claimOccurrence(); assert.ok(claim); const second = otherWorker(f, t);
  assert.equal(second.claimOccurrence(), null); f.advance(30001);
  const reclaimed = second.claimOccurrence(); assert.equal(reclaimed.id, claim.id); assert.equal(reclaimed.attempts, 2);
  second.dispatch(reclaimed); f.worker.dispatch(claim);
  await Promise.all([f.worker.tick(), second.tick(), f.worker.tick()]);
  assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_occurrences').n, 1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_business_runs').n, 1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM notification_outbox').n, 1);
  const row = f.h.store.get('SELECT * FROM schedule_occurrences'); assert.equal(row.attempts, 2); assert.equal(row.state, 'succeeded');
  // Close and reopen the real control plane against the same on-disk database.
  await f.h.stop(); await f.h.start();
  assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_business_runs').n, 1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM notification_outbox').n, 1);
});
test('misfire skips an unbounded history; once runs only one due instance, updates are versioned and started snapshots stay fixed', async t => {
  const f = await fixture(t), s = await f.create(); f.advance(86400000 * 5); await f.worker.tick();
  assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_occurrences').n, 1); assert.equal(f.h.store.get('SELECT state FROM schedule_occurrences').state, 'skipped');
  const current = (await query(f, 'list_schedules')).schedules[0]; assert.ok(current.next_at > f.now());
  const saved = await command(f, 'schedule.update', { id: s.id, revision: 1, plan: f.plan({ misfire: 'once', grace_ms: 86400000, timezone: 'UTC' }) }); assert.equal(saved.value.state, 'succeeded');
  const conflict = await command(f, 'schedule.update', { id: s.id, revision: 1, plan: f.plan() }); assert.equal(conflict.value.result.error, 'schedule_revision_conflict');
  f.advance(180000); f.worker.produce(); const claim = f.worker.claimOccurrence();
  assert.equal(JSON.parse(claim.snapshot).plan.timezone, 'UTC');
  const edit = await command(f, 'schedule.update', { id: s.id, revision: 2, plan: f.plan({ timezone: 'Europe/Berlin' }) }); assert.equal(edit.value.state, 'succeeded');
  f.worker.dispatch(claim); assert.equal(f.h.store.get('SELECT state FROM schedule_occurrences WHERE id=?', claim.id).state, 'succeeded');
  assert.equal(JSON.parse(f.h.store.get('SELECT snapshot FROM schedule_occurrences WHERE id=?', claim.id).snapshot).plan.timezone, 'UTC');
});
test('revoking a personal owner pauses the plan and blocks its queued notification before transport', async t => {
  const f = await fixture(t), member = await f.member('schedule-member', { repository_ids: ['101'] });
  bindFixture(f.h, f.id, member.id, 'ou_member');
  const destination = await registerDestination(member.client, await privateChat(f, 'ou_member', member.id, 'oc_member_private'));
  const plan = f.plan({ actor_id: member.id, owner_id: member.id, maintainer_id: member.id, destination_id: destination });
  const saved = await command(f, 'schedule.register', { plan }, member.client); assert.equal(saved.value.state, 'succeeded');
  f.advance(60000); f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());
  assert.equal(f.h.store.get('SELECT state FROM notification_outbox').state, 'pending');
  f.h.store.run('DELETE FROM project_admin_assignments WHERE user_id=?', member.id);
  const before = f.wire.sent.length; await f.worker.tick();
  assert.equal(f.h.store.get('SELECT state FROM schedules').state, 'paused'); assert.equal(f.h.store.get('SELECT state FROM notification_outbox').state, 'blocked'); assert.equal(f.wire.sent.length, before);
});
test('a group destination follows its binding: a queued report stops when the binding no longer reaches the project', async t => {
  const f = await fixture(t), chat = await boundGroup(f), destination = await registerDestination(f.admin, chat);
  const listed = await query(f, 'list_schedule_destinations');
  assert.deepEqual(listed.destinations.map(d => d.type).sort(), ['group', 'p2p']);
  // A preview may name a chat directly (#330); only saving registers it.
  const registered = f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE state='registered'").n;
  const chosen = await f.admin('/api/management/query', 'POST', { operation: 'preview_schedule', target, arguments: { plan: f.plan({ destination_id: 'chat:' + chat.id }) } });
  assert.equal(chosen.status, 201, JSON.stringify(chosen.value)); assert.equal(f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE state='registered'").n, registered);
  await f.create(f.plan({ destination_id: destination })); f.advance(60000); f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());
  // The maintainer narrows the group to another repository: project 101 is out of its scope now.
  const revision = f.h.store.get('SELECT revision FROM channel_service_bindings').revision;
  assert.equal((await f.admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['102'] }, enabled: true, expected_revision: revision })).status, 200);
  const before = f.wire.sent.length;
  const preview = await f.admin('/api/management/query', 'POST', { operation: 'preview_schedule', target, arguments: { plan: f.plan({ destination_id: destination }) } });
  assert.equal(preview.status, 403); assert.equal(preview.value.error, 'channel_service_scope_paused');
  await f.worker.tick(); assert.equal(f.h.store.get('SELECT state FROM notification_outbox').state, 'blocked'); assert.equal(f.wire.sent.length, before);
  assert.deepEqual((await query(f, 'list_schedule_destinations')).destinations.map(d => d.type), ['p2p']);
  // An owner who unbinds Feishu takes the private chat out of the choices, registered or not.
  f.h.store.run("UPDATE external_identities SET status='revoked' WHERE principal_id=?", f.principal);
  assert.deepEqual((await query(f, 'list_schedule_destinations')).destinations, []);
});
test('project service uses explicit minimum capabilities, survives creator departure and pauses when delegation or maintainer is revoked', async t => {
  const f = await fixture(t), maintainer = await f.member('service-maintainer', { repository_ids: ['101'] });
  const service = randomId(), grant = randomId();
  f.h.store.run("INSERT INTO principals(id,kind,project_id,tenant_id,maintenance) VALUES(?,'service','101','github.com:10','project maintainers')", service);
  f.h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
    VALUES(?,?,'github.com:10','101','project','service',?,'explicit_delegation',?,'schedule','fixture approval',?)`, grant, service, JSON.stringify(['tasks.read', 'schedules.manage']), f.principal, f.now());
  f.h.store.run('UPDATE principals SET authorization_revision=9 WHERE id=?', service);
  const destination = await registerDestination(f.admin, await keptGroup(f));
  const schedule = await f.create(f.plan({ kind: 'project', actor_id: service, maintainer_id: maintainer.id, destination_id: destination }));
  const audit = f.h.store.get("SELECT * FROM schedule_audit WHERE action='schedule.register'"); assert.equal(audit.initiator, f.principal); assert.equal(audit.actor_id, service); assert.equal(audit.authorization_revision, 9);
  const serviceActor = f.worker.service.actor(f.h.store.get('SELECT * FROM schedules'), schedule.spec);
  assert.throws(() => authorize(serviceActor, 'release.manage', { project_id: '101' }), /capability_forbidden/);
  f.h.store.run('UPDATE users SET active=0 WHERE id=?', f.principal); f.advance(60000); await f.worker.tick();
  assert.equal(f.h.store.get('SELECT state FROM schedule_occurrences').state, 'succeeded');
  f.h.store.run('UPDATE scoped_grants SET revoked_at=? WHERE id=?', f.now(), grant); invalidate(f.h.store, service, 'fixture revoke');
  await f.worker.tick(); assert.equal(f.h.store.get('SELECT state FROM schedules').state, 'paused');
});
test('an authorized administrator hands over a service plan after owner departure without changing its identity or capabilities', async t => {
  const f = await fixture(t), admin = await f.member('handover-admin', { role: 'super_admin' }), first = await f.member('first-maintainer', { repository_ids: ['101'] }), replacement = await f.member('replacement-maintainer', { repository_ids: ['101'] });
  const plan = await projectPlan(f, first.id), original = await f.create(plan), store = f.h.store;
  assert.equal((await admin.client('/api/users/' + f.principal, 'PATCH', { active: false })).status, 200);
  f.advance(60000); await f.worker.tick();
  assert.equal(store.get('SELECT state FROM schedules WHERE id=?', original.id).state, 'active');
  assert.equal(store.get('SELECT count(*) n FROM schedule_business_runs').n, 1);
  const preview = await query(f, 'preview_schedule', { plan, schedule_id: original.id }, admin.client); assert.equal(preview.plan.owner_id, f.principal);
  const noId = await admin.client('/api/management/query', 'POST', { operation: 'preview_schedule', target, arguments: { plan } }); assert.equal(noId.value.error, 'schedule_owner_required');
  const denied = await command(f, 'schedule.update', { id: original.id, revision: 1, plan: { ...plan, maintainer_id: replacement.id } }, first.client);
  assert.notEqual(denied.value.state, 'succeeded'); assert.equal(denied.value.result.error, 'capability_forbidden'); assert.equal(store.get('SELECT revision FROM schedules').revision, 1);
  assert.equal((await admin.client('/api/users/' + first.id, 'PATCH', { active: false })).status, 200);
  await f.worker.tick(); const paused = store.get('SELECT * FROM schedules'); assert.equal(paused.state, 'paused');
  assert.throws(() => f.worker.service.actor(paused, plan), /principal_inactive/);
  const invalid = await command(f, 'schedule.update', { id: original.id, revision: paused.revision, plan }, admin.client); assert.equal(invalid.value.result.error, 'schedule_maintainer_required');
  for (const patch of [{ owner_id: replacement.id }, { actor_id: randomId() }, { kind: 'personal' }]) {
    const rejected = await admin.client('/api/management/query', 'POST', { operation: 'preview_schedule', target, arguments: { plan: { ...plan, ...patch }, schedule_id: original.id } });
    assert.equal(rejected.value.error, 'schedule_identity_immutable');
  }
  const changed = await command(f, 'schedule.update', { id: original.id, revision: paused.revision, plan: { ...plan, maintainer_id: replacement.id } }, admin.client);
  assert.equal(changed.value.state, 'succeeded', JSON.stringify(changed.value)); const saved = changed.value.result.schedule;
  for (const key of ['creator_id', 'owner_id', 'actor_id', 'kind']) assert.equal(saved[key], original[key], key);
  assert.equal(saved.maintainer_id, replacement.id); assert.deepEqual(saved.grant_snapshot.capabilities, original.grant_snapshot.capabilities);
  assert.equal(store.get('SELECT capabilities FROM scoped_grants WHERE principal_id=?', plan.actor_id).capabilities, JSON.stringify(['tasks.read', 'schedules.manage']));
  f.advance(60000); await f.worker.tick(); assert.equal(store.get('SELECT count(*) n FROM schedule_business_runs').n, 2);
});
test('an existing owner who loses project permission remains an audit reference but cannot own a new project plan', async t => {
  const f = await fixture(t), owner = await f.member('historical-owner', { repository_ids: ['101'] }), first = await f.member('current-maintainer', { repository_ids: ['101'] }), next = await f.member('next-maintainer', { repository_ids: ['101'] });
  const plan = await projectPlan(f, first.id, owner.id), original = await f.create(plan);
  f.h.store.run('DELETE FROM project_admin_assignments WHERE user_id=?', owner.id);
  const nextPlan = { ...plan, maintainer_id: next.id };
  assert.equal((await query(f, 'preview_schedule', { plan: nextPlan, schedule_id: original.id })).plan.owner_id, owner.id);
  const saved = await command(f, 'schedule.update', { id: original.id, revision: 1, plan: nextPlan }); assert.equal(saved.value.state, 'succeeded');
  assert.equal(saved.value.result.schedule.owner_id, owner.id); assert.equal(saved.value.result.schedule.creator_id, original.creator_id);
  const invalid = await command(f, 'schedule.register', { plan: nextPlan }); assert.equal(invalid.value.result.error, 'schedule_owner_required');
  const disabled = await f.member('disabled-new-owner', { repository_ids: ['101'] }); await f.admin('/api/users/' + disabled.id, 'PATCH', { active: false });
  assert.equal((await command(f, 'schedule.register', { plan: { ...nextPlan, owner_id: disabled.id } })).value.result.error, 'schedule_owner_required');
  assert.equal((await command(f, 'schedule.register', { plan: { ...plan, owner_id: f.principal, maintainer_id: disabled.id } })).value.result.error, 'schedule_maintainer_required');
});
test('personal plans still require the current actor as owner and maintainer and cannot change identity', async t => {
  const f = await fixture(t), other = await f.member('personal-other', { repository_ids: ['101'] });
  for (const field of ['actor_id', 'owner_id', 'maintainer_id']) assert.equal((await command(f, 'schedule.register', { plan: f.plan({ [field]: other.id }) })).value.result.error, 'personal_schedule_identity_mismatch');
  const original = await f.create();
  for (const patch of [{ kind: 'project' }, { actor_id: other.id }, { owner_id: other.id }]) assert.equal((await command(f, 'schedule.update', { id: original.id, revision: 1, plan: { ...original.spec, ...patch } })).value.result.error, 'schedule_identity_immutable');
  assert.equal((await command(f, 'schedule.update', { id: original.id, revision: 1, plan: { ...original.spec, maintainer_id: other.id } })).value.result.error, 'personal_schedule_identity_mismatch');
  assert.equal(f.h.store.get('SELECT creator_id FROM schedules').creator_id, f.principal);
});
test('outbox timeout is unknown, crash recovery never blindly resends and reconciliation retains the logical key', async t => {
  const f = await fixture(t); await f.create(); f.advance(60000); f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());
  let sends = 0;
  const second = otherWorker(f, t, { send: async (_row, guard) => { guard(); sends++; throw new Error('connection lost after delivery'); }, reconcile: async (_row, guard) => { guard(); return 'reconciled-message'; } });
  const claim = second.claimNotification(); await second.send(claim);
  assert.equal(f.h.store.get('SELECT state FROM notification_outbox').state, 'unknown'); await second.tick(); assert.equal(sends, 1);
  const reconciled = await second.reconcile(claim.id); assert.equal(reconciled.state, 'sent');
  assert.equal(f.h.store.get('SELECT remote_message_id FROM notification_outbox').remote_message_id, 'reconciled-message');
  f.advance(60000); f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());
  const crashed = f.worker.claimNotification(); assert.ok(crashed); f.advance(60001); second.claimNotification();
  assert.equal(f.h.store.get('SELECT state FROM notification_outbox WHERE id=?', crashed.id).state, 'unknown');
});
test('429 backs off, attempts remain durable, retry budget dead-letters and rate limits defer transport', async t => {
  const f = await fixture(t);
  // Keep the first send and the 2001 ms retry in the same fixed minute bucket.
  f.advance(60000 - f.now() % 60000);
  await f.create(f.plan({ limits: { ...defaultLimits, retries: 1, notifications_per_minute: 1 } }));
  f.advance(60000); f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());
  const second = otherWorker(f, t, { send: async () => { throw new HttpError(503, 'channel_rate_limited'); } });
  const claim = second.claimNotification(); await second.send(claim);
  let row = f.h.store.get('SELECT * FROM notification_outbox'); assert.equal(row.state, 'retry'); assert.equal(row.attempts, 1); assert.ok(row.next_attempt > f.now());
  f.advance(2001); assert.equal(second.claimNotification(), null); assert.equal(f.h.store.get('SELECT last_error FROM notification_outbox').last_error, 'notification_rate_limited');
  f.advance(60000); const retry = second.claimNotification(); await second.send(retry); f.advance(60000); second.claimNotification();
  row = f.h.store.get('SELECT * FROM notification_outbox'); assert.equal(row.state, 'dead'); assert.equal(row.attempts, 2);
});
test('plan/project/tenant budgets and runtime limits stop new actions, retries do not reset usage', async t => {
  const f = await fixture(t, 12 * 3600000); await f.create(f.plan({ limits: { ...defaultLimits, runs: 1 } })); f.advance(60000); await f.worker.tick();
  f.advance(60000); await f.worker.tick(); const rows = f.h.store.all('SELECT state,reason FROM schedule_occurrences ORDER BY logical_at');
  assert.equal(rows[0].state, 'succeeded'); assert.equal(rows[1].state, 'budget_exhausted');
  assert.equal(f.h.store.get("SELECT runs FROM schedule_usage WHERE scope='schedule'").runs, 1);
  const schedule = (await query(f, 'list_schedules')).schedules[0];
  await command(f, 'schedule.update', { id: schedule.id, revision: schedule.revision, plan: f.plan({ limits: { ...defaultLimits, runtime_ms: 1 } }) });
  f.advance(60000); f.worker.produce(); const claim = f.worker.claimOccurrence(); f.advance(2); f.worker.dispatch(claim);
  assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_business_runs').n, 1);
});
test('transaction rollback cannot separate report completion from its notification and unregistered release remains unsupported', async t => {
  const f = await fixture(t); await f.create(); f.advance(60000); f.worker.produce(); const claim = f.worker.claimOccurrence();
  f.h.store.db.exec("CREATE TRIGGER fixture_reject_notification BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'fixture abort'); END");
  f.worker.dispatch(claim); assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_business_runs').n, 0); assert.equal(f.h.store.get('SELECT count(*) n FROM notification_outbox').n, 0);
  f.h.store.db.exec('DROP TRIGGER fixture_reject_notification');
  const s = await f.create(f.plan({ workflow: 'release.scheduled' })); const run = await command(f, 'schedule.run-now', { id: s.id, revision: 1 }); assert.equal(run.value.state, 'succeeded');
  await f.worker.tick(); assert.equal(f.h.store.get('SELECT state FROM schedule_occurrences WHERE schedule_id=?', s.id).state, 'unsupported');
  assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_business_runs').n, 0);
});
test('subscription aggregates a failure incident, links recovery, respects quiet hours and blocks old outbox after unsubscribe', async t => {
  const f = await fixture(t), spec = { name: '失败与恢复', destination_id: f.destination, events: ['task.failed', 'ci.failed', 'ci.recovered'], projects: ['101'], aggregate_ms: 60000, timezone: 'UTC', enabled: true };
  const saved = await command(f, 'notification.register', { subscription: spec }); assert.equal(saved.value.state, 'succeeded', JSON.stringify(saved)); const sub = saved.value.result.subscription;
  f.h.store.run("UPDATE tasks SET status='failed' WHERE id='blocked'"); f.worker.fanout();
  assert.equal(f.h.store.get('SELECT count(*) n FROM notification_outbox').n, 1);
  for (const [key, type] of [['ci1', 'ci.failed'], ['ci2', 'ci.failed'], ['ci3', 'ci.recovered']]) f.h.store.run('INSERT INTO schedule_events(event_key,project_id,type,incident,payload,created_at) VALUES(?,\'101\',?,\'ci:workflow_run:77\',?,?)', key, type, JSON.stringify({ run_id: 77 }), f.now());
  f.worker.fanout(); const notifications = f.h.store.all('SELECT * FROM notification_outbox ORDER BY created_at,id'); assert.equal(notifications.length, 3);
  const recovery = notifications.find(n => JSON.parse(n.payload).events[0].type === 'ci.recovered'); assert.ok(recovery.parent_id);
  const incident = notifications.find(n => JSON.parse(n.payload).events[0].type === 'ci.failed'); assert.equal(JSON.parse(incident.payload).events.length, 2);
  assert.equal((await command(f, 'subscription.delete', { id: sub.id, revision: sub.revision })).value.state, 'succeeded');
  const before = f.wire.sent.length; f.advance(60000); await f.worker.tick(); assert.equal(f.wire.sent.length, before); assert.equal(f.h.store.get("SELECT count(*) n FROM notification_outbox WHERE state='blocked'").n, 3);
});

test('a Manager check plan hands its occurrence to the Manager once; a task it starts is a read-only request run by the plan\'s identity', async t => {
  const f = await fixture(t);
  await f.admin('/api/repositories/101/policy', 'PATCH', { enabled: true });
  // The Manager starts the check, with the goal it read from the plan's instruction.
  configureDispatch(context => ({ decision: 'create', option_ids: [context.options[0].id], reason: '到期检查', brief: { goal: 'List open Issues without a label', criteria: ['Name each Issue'] } }));
  t.after(() => configureDispatch(ruleDecider));
  const plan = await f.create(f.plan({ name: '每周检查', workflow: 'manager.check', parameters: { instruction: 'List open Issues without a label.' } }));
  await command(f, 'schedule.run-now', { id: plan.id, revision: 1 });
  f.worker.produce(); const claim = f.worker.claimOccurrence(); f.worker.dispatch(claim); f.worker.dispatch(claim);
  const event = f.h.store.get("SELECT * FROM dispatch_events WHERE type='schedule.due'");
  assert.equal(JSON.parse(event.facts).instruction, 'List open Issues without a label.'); assert.equal(event.decision, 'create');
  const task = f.h.store.get('SELECT * FROM tasks WHERE id=?', JSON.parse(event.result).created[0]), requests = () => f.h.store.get("SELECT count(*) n FROM tasks WHERE unique_key LIKE '101:task.request:%'").n;
  assert.equal(JSON.parse(task.input).contract.goal, 'List open Issues without a label');
  assert.equal(f.h.store.get('SELECT principal_id FROM task_authorizations WHERE task_id=?', task.id).principal_id, f.principal);
  assert.equal(requests(), 1, 'one occurrence, one event, one task');
  // Handing the check over completes the occurrence, so the plan is not held up by the task it started.
  assert.equal(f.h.store.get('SELECT state FROM schedule_business_runs').state, 'succeeded');
  // The rule decider of other tests starts nothing for a scheduled check: only a Manager does.
  configureDispatch(ruleDecider);
  await command(f, 'schedule.run-now', { id: plan.id, revision: 1 });
  f.worker.produce(); const next = f.worker.claimOccurrence(); f.worker.dispatch(next);
  assert.equal(requests(), 1);
  assert.equal(f.h.store.get("SELECT decision FROM dispatch_events WHERE type='schedule.due' ORDER BY created_at DESC,rowid DESC LIMIT 1").decision, 'ignore');
});

test('controlled workflow contract dispatches a fake business handler once, preserves its run and enforces tool/model budgets', async t => {
  const f = await fixture(t); let dispatched = 0;
  for (const [scope, id] of [['project', '101'], ['tenant', 'github.com:10']]) f.h.store.run('INSERT INTO schedule_budgets VALUES(?,?,\'development\',?)', scope, id, JSON.stringify({ ...defaultLimits, model_calls: 1, cost_micros: 20 }));
  f.worker.service.register('custom.fixture', { capability: 'tasks.write', dispatch: (trigger, actor, guard) => {
    guard(); authorize(actor, 'tasks.write', { project_id: trigger.project_id }); dispatched++;
    f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,created_at,updated_at) VALUES(?,'101','task.request','queued','Controlled fixture',?,?,?)", trigger.run_id, trigger.occurrence_id, new Date().toISOString(), new Date().toISOString());
    return { run_id: trigger.run_id, state: 'queued' };
  } });
  const plan = await f.create(f.plan({ workflow: 'custom.fixture', limits: { ...defaultLimits, model_calls: 1, cost_micros: 20 } }));
  await command(f, 'schedule.run-now', { id: plan.id, revision: 1 });
  f.worker.produce(); const claim = f.worker.claimOccurrence(); f.worker.dispatch(claim); f.worker.dispatch(claim);
  assert.equal(dispatched, 1); assert.equal(f.h.store.get('SELECT state FROM schedule_business_runs').state, 'queued');
  assert.equal(f.h.store.get('SELECT count(*) n FROM tasks WHERE unique_key=?', claim.id).n, 1);
  assert.equal(f.h.store.get('SELECT state FROM schedule_occurrences WHERE id=?', claim.id).state, 'dispatched');
  await command(f, 'schedule.run-now', { id: plan.id, revision: 1 });
  assert.equal(f.worker.claimOccurrence(), null); // Accepted business work still owns the concurrency slot.
  const actor = f.worker.service.authorizeAction(claim.id, 'tasks.write', { model_calls: 1, cost_micros: 12 }); assert.equal(actor.principal_id, f.principal);
  assert.throws(() => f.worker.service.authorizeAction(claim.id, 'tasks.write', { model_calls: 1, cost_micros: 9 }), /schedule_budget_exhausted/);
  assert.equal(f.h.store.get("SELECT model_calls FROM schedule_usage WHERE scope='schedule'").model_calls, 1);
  assert.equal(f.h.store.get('SELECT state FROM schedule_business_runs').state, 'blocked');
  const pending = f.worker.claimOccurrence(); assert.ok(pending); f.worker.dispatch(pending);
  f.worker.service.settleRun(pending.id, 'succeeded', { evidence: 'fixture only' });
  assert.equal(f.h.store.get('SELECT state FROM schedule_business_runs WHERE occurrence_id=?', pending.id).state, 'succeeded');
  assert.throws(() => f.worker.service.authorizeAction(pending.id, 'tasks.write'), /schedule_business_run_finished/);
  assert.equal(f.h.store.get('SELECT state FROM schedule_business_runs WHERE occurrence_id=?', pending.id).state, 'succeeded');
});
test('project and tenant limits bound all plans; concurrency claims, installation revocation and authorization remain live', async t => {
  const f = await fixture(t, 12 * 3600000); const a = await f.create(), b = await f.create();
  f.h.store.run("INSERT INTO schedule_budgets VALUES('project','101','report',?)", JSON.stringify({ ...defaultLimits, concurrency: 1, runs: 1 }));
  f.advance(60000); f.worker.produce(); const first = f.worker.claimOccurrence(); assert.ok(first); assert.equal(f.worker.claimOccurrence(), null);
  f.worker.dispatch(first); const second = f.worker.claimOccurrence(); assert.ok(second); f.worker.dispatch(second);
  assert.equal(f.h.store.get("SELECT count(*) n FROM schedule_occurrences WHERE state='budget_exhausted'").n, 1);
  f.h.store.run('DELETE FROM schedule_budgets');
  f.h.store.run("INSERT INTO schedule_budgets VALUES('tenant','github.com:10','report',?)", JSON.stringify({ ...defaultLimits, runs: 1 }));
  f.advance(60000); f.worker.produce(); let claim; while ((claim = f.worker.claimOccurrence())) f.worker.dispatch(claim);
  assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_business_runs').n, 1);
  f.h.store.run("UPDATE installed_repositories SET installed=0 WHERE repository_id='101'"); await f.worker.tick();
  assert.equal(f.h.store.get("SELECT count(*) n FROM schedules WHERE state='paused'").n, 2);
  assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_business_runs').n, 1);
});
test('manual retry acknowledges unknown results, preserves attempts/idempotency and consumes a separate bounded allowance', async t => {
  const f = await fixture(t); await f.create(); f.advance(60000); f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());
  const worker = otherWorker(f, t, { send: async () => { throw new Error('unknown'); } });
  const first = worker.claimNotification(); await worker.send(first);
  assert.equal((await command(f, 'notification.retry', { id: first.id })).value.result.error, 'notification_duplicate_risk_acknowledgement_required');
  assert.equal((await command(f, 'notification.retry', { id: first.id, acknowledge_unknown: true })).value.state, 'succeeded');
  const retry = worker.claimNotification(); assert.equal(retry.id, first.id); assert.equal(retry.attempts, 2); assert.equal(retry.manual_retries, 1); await worker.send(retry);
  assert.equal((await command(f, 'notification.retry', { id: first.id, acknowledge_unknown: true })).value.result.error, 'notification_manual_retry_budget_exhausted');
  assert.equal(f.h.store.get('SELECT count(*) n FROM notification_outbox').n, 1);
});

test('signed CI mutations atomically publish supported events, daily reports query the real check evidence, and approval events are retired', async t => {
  const f = await fixture(t);
  const repo = { id: 101, full_name: 'agent-test-zone/admin-fixture-101', owner: { id: 10 } }, run = { id: 4321, run_attempt: 1, status: 'completed', conclusion: 'failure' };
  const send = async (id, conclusion) => f.h.hook(f.a.path, f.a.secret, id, { action: 'completed', repository: repo, workflow_run: { ...run, conclusion } }, { 'X-GitHub-Event': 'workflow_run' });
  assert.equal((await send('ci-success-first', 'success')).status, 200); assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_events').n, 0);
  assert.equal((await send('ci-fail', 'failure')).status, 200); assert.equal((await send('ci-fail', 'failure')).value.duplicate, true);
  assert.equal((await send('ci-recovery', 'success')).status, 200);
  assert.deepEqual(f.h.store.all('SELECT type FROM schedule_events ORDER BY sequence').map(r => r.type), ['ci.failed', 'ci.recovered']);
  f.advance(60000); const report = f.worker.service.reports.render('101', f.now(), 'UTC');
  assert.ok(report.evidence.some(e => e.id.startsWith('delivery:') && e.kind === 'ci' && e.status === 'success')); assert.equal(report.counts['ci:success'], 1);
  assert.ok(!report.evidence.some(e => e.kind === 'approval')); assert.ok(!report.text.includes('审批'));
  // A policy left by an older version holds nothing back, and no approval.waiting event exists any more.
  f.h.store.run("INSERT INTO management_policies(tenant_id,approval_operations) VALUES('github.com:10','[\"schedule.register\"]')");
  const saved = await command(f, 'schedule.register', { plan: f.plan() }); assert.equal(saved.value.state, 'succeeded', JSON.stringify(saved.value));
  assert.equal(f.h.store.get("SELECT count(*) n FROM schedule_events WHERE type='approval.waiting'").n, 0);
  assert.equal(f.h.store.get("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='schedule_approval_event'").n, 0);
  // Subscriptions saved by an older version drop the event; one left with nothing to watch pauses with a reason.
  const legacy = (id, events) => f.h.store.run(`INSERT INTO notification_subscriptions(id,tenant_id,project_id,principal_id,spec,revision,state,reason,event_cursor,created_at,updated_at)
    VALUES(?,'github.com:10','101',?,?,3,'active',NULL,0,?,?)`, id, f.principal, JSON.stringify({ name: id, destination_id: f.destination, events, projects: ['101'], aggregate_ms: 0, timezone: 'UTC', enabled: true }), f.now(), f.now());
  legacy('mixed', ['task.failed', 'approval.waiting']); legacy('approval-only', ['approval.waiting']); legacy('untouched', ['ci.failed']);
  scheduleStorage(f.h.store);
  const read = id => f.h.store.get('SELECT * FROM notification_subscriptions WHERE id=?', id);
  assert.deepEqual(JSON.parse(read('mixed').spec).events, ['task.failed']); assert.equal(read('mixed').state, 'active'); assert.equal(read('mixed').revision, 4);
  assert.deepEqual(JSON.parse(read('approval-only').spec).events, []); assert.equal(read('approval-only').state, 'paused');
  assert.equal(read('approval-only').reason, 'approval_event_retired'); assert.equal(read('approval-only').revision, 4);
  assert.equal(read('untouched').revision, 3);
});

test('a real worker process exits after its committed claim; replacement processes recover one run under competition', async t => {
  const f = await fixture(t); await f.create(); f.advance(60000);
  const source = `
    import {readFileSync} from 'node:fs';
    import {Store} from './dist/storage/database.js';
    import {ManagementService} from './dist/management/service.js';
    import {ManagementAgent} from './dist/management/agent.js';
    import {RuleService} from './dist/rules/service.js';
    import {TaskCommands} from './dist/tasks/commands.js';
    import {ChannelService} from './dist/channels/service.js';
    import {ScheduleService} from './dist/schedules/service.js';
    import {Scheduler} from './dist/schedules/worker.js';
    const input=JSON.parse(readFileSync(0,'utf8')),store=new Store(input.path,Buffer.from(input.key,'hex'));
    const management=new ManagementService(store,new RuleService(store),new TaskCommands(store));
    const channels=new ChannelService(store,new ManagementAgent(store,management));
    const worker=new Scheduler(new ScheduleService(store,management,channels,()=>input.now));
    worker.produce();const claim=worker.claimOccurrence();
    if(claim&&input.mode==='execute')worker.dispatch(claim);
    process.stdout.write(JSON.stringify({claim:claim?.id,attempt:claim?.attempts,occurrences:store.get('SELECT count(*) n FROM schedule_occurrences').n,runs:store.get('SELECT count(*) n FROM schedule_business_runs').n}));
    // Exit without worker.close or store.close: no lifecycle cleanup releases the committed lease.
    process.exit(0);
  `;
  const run = mode => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] }); let output = '', error = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { error += b; }); child.on('error', reject);
    child.on('close', code => { if (code !== 0) reject(new Error(error)); else resolve(JSON.parse(output)); });
    child.stdin.end(JSON.stringify({ path: f.h.database, key: f.h.key.toString('hex'), now: f.now(), mode }));
  });
  const crashed = await run('claim'); assert.ok(crashed.claim); assert.equal(crashed.runs, 0);
  assert.equal((await run('execute')).claim, undefined); f.advance(30001);
  const replacements = await Promise.all([run('execute'), run('execute')]);
  assert.equal(replacements.filter(r => r.claim).length, 1); assert.equal(replacements.find(r => r.claim).attempt, 2);
  assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_occurrences').n, 1); assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_business_runs').n, 1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM notification_outbox').n, 1);
});

test('delivery diagnostics use the historical occurrence, verify destinations and paginate only scoped records', async t => {
  const f = await fixture(t), plan = await f.create();
  f.advance(60000); f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence()); await f.worker.tick();
  const first = (await query(f, 'list_notification_deliveries')).records[0];
  assert.equal(first.origin.name, '项目日报'); assert.equal(first.origin.state, 'succeeded');
  assert.equal(first.destination.valid, true); assert.equal(first.destination.type, 'p2p');
  assert.equal(first.attempts_detail[0].state, 'sent'); assert.equal(first.payload.report.window.end, first.origin.logical_at);
  const changed = f.plan({ name: '之后修改的计划' });
  f.h.store.run('UPDATE schedules SET spec=? WHERE id=?', JSON.stringify(changed), plan.id);
  for (let i = 0; i < 20; i++) f.h.store.run(`INSERT INTO notification_outbox
    SELECT ?,tenant_id,project_id,destination_id,schedule_id,occurrence_id,subscription_id,subscription_revision,actor_id,authorization,
      ?,incident,parent_id,payload,state,attempts,manual_retries,next_attempt,lease,lease_until,last_error,remote_message_id,created_at,sent_at
    FROM notification_outbox WHERE id=?`, 'diagnostic-copy-' + i, 'diagnostic-key-' + i, first.id);
  const page = await query(f, 'list_notification_deliveries', { limit: 20 });
  const rest = await query(f, 'list_notification_deliveries', { limit: 20, offset: page.next_offset });
  assert.equal(page.records.length, 20); assert.equal(rest.records.length, 1); assert.equal(rest.next_offset, null);
  assert.equal(new Set([...page.records, ...rest.records].map(r => r.id)).size, 21);
  assert.ok(page.records.every(r => r.origin.name === '项目日报'));
  assert.equal((await query(f, 'list_notification_deliveries', {}, f.admin, '102')).records.length, 0);
  f.h.store.run("UPDATE channel_outbox SET state='blocked' WHERE id=?", f.destination);
  const invalid = (await query(f, 'list_notification_deliveries')).records[0];
  assert.equal(invalid.destination.valid, false); assert.ok(invalid.destination.reason);
  assert.equal(invalid.origin.name, '项目日报'); assert.equal(invalid.destination.chat_id, undefined);
  const user = await f.member('diagnostic-without-project');
  const denied = await user.client('/api/management/query', 'POST', { operation:'list_notification_deliveries', target, arguments:{} });
  assert.equal(denied.status, 403); assert.equal(denied.value.records, undefined);
});

test('event diagnostics retain saved observations and never label them with a newer subscription configuration', async t => {
  const f = await fixture(t), spec = { name:'失败事件窗口', destination_id:f.destination, events:['task.failed'], projects:['101'], aggregate_ms:60000, timezone:'UTC', enabled:true };
  const saved = await command(f, 'notification.register', { subscription:spec });
  f.h.store.run("UPDATE tasks SET status='failed' WHERE id='blocked'"); f.worker.fanout();
  const first = (await query(f, 'list_notification_deliveries')).records[0];
  assert.equal(first.origin.name, spec.name); assert.equal(first.origin.logical_at, undefined);
  assert.equal(first.payload.events[0].type, 'task.failed'); assert.equal(first.occurrence_id, null);
  await command(f, 'subscription.update', { id:saved.value.result.subscription.id, revision:1, subscription:{...spec,name:'之后的名称',timezone:'Asia/Shanghai'} });
  const changed = (await query(f, 'list_notification_deliveries')).records[0];
  assert.equal(changed.origin.name, null); assert.equal(changed.origin.timezone, null);
  assert.equal(changed.origin.revision, 1); assert.deepEqual(changed.payload.events, first.payload.events);
});

test('subscription preview uses the same quiet-hour parser across a DST fold and persists no trigger or delivery', async t => {
  const f = await fixture(t);
  f.advance(Date.parse('2026-11-01T05:55:00Z') - f.now());
  const spec = { name:'静默窗口',destination_id:f.destination,events:['task.failed'],projects:['101'],aggregate_ms:600000,timezone:'America/New_York',quiet_start:'01:00',quiet_end:'02:00',enabled:true };
  const counts = () => Object.fromEntries(['notification_subscriptions','notification_outbox','schedule_occurrences','schedule_events','schedule_audit','management_commands'].map(table=>[table,f.h.store.get(`SELECT count(*) n FROM ${table}`).n]));
  const before = counts(), preview = await query(f,'preview_subscription',{subscription:spec});
  assert.equal(preview.hypothetical,true); assert.equal(preview.event_received_at,f.now());
  assert.equal(preview.aggregation_ends_at,Date.parse('2026-11-01T06:05:00Z'));
  assert.equal(preview.first_send_at,Date.parse('2026-11-01T07:00:00Z'));
  assert.equal(preview.destination.type,'p2p'); assert.equal(preview.subscription.projects[0],'101');
  assert.equal((await query(f,'preview_subscription',{subscription:{...spec,enabled:false}})).first_send_at,null);
  assert.deepEqual(counts(),before);
});
test('subscription preview preserves save validation, project authority and owner-only edit information', async t => {
  const f = await fixture(t), spec = {name:'本人订阅',destination_id:f.destination,events:['ci.failed','ci.recovered'],projects:['101'],aggregate_ms:300000,timezone:'Asia/Shanghai',enabled:true};
  const saved = await command(f,'notification.register',{subscription:spec}); assert.equal(saved.value.state,'succeeded');
  assert.equal((await query(f,'list_subscriptions')).subscriptions[0].editable,true);
  assert.equal((await query(f,'list_subscriptions',{id:saved.value.result.subscription.id})).subscriptions[0].id,saved.value.result.subscription.id);
  assert.equal((await query(f,'list_subscriptions',{id:saved.value.result.subscription.id},f.admin,'102')).subscriptions.length,0);
  const observer = await f.member('subscription-observer',{repository_ids:['101']});
  assert.equal((await query(f,'list_subscriptions',{},observer.client)).subscriptions[0].editable,false);
  for (const change of [{projects:['101','102']},{quiet_start:'22:00'},{quiet_start:'22:00',quiet_end:'22:00'},{timezone:'Invalid/Zone'}]) {
    const result = await f.admin('/api/management/query','POST',{operation:'preview_subscription',target,arguments:{subscription:{...spec,...change}}});
    assert.equal(result.status,400,JSON.stringify(result.value));
  }
  const denied = await f.member('subscription-no-project');
  assert.equal((await denied.client('/api/management/query','POST',{operation:'preview_subscription',target,arguments:{subscription:spec}})).status,403);
  f.h.store.run("UPDATE channel_outbox SET state='blocked' WHERE id=?",f.destination);
  const invalid = await f.admin('/api/management/query','POST',{operation:'preview_subscription',target,arguments:{subscription:spec}});
  assert.equal(invalid.status,403); assert.equal(f.h.store.get('SELECT count(*) n FROM notification_subscriptions').n,1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM notification_outbox').n,0);
});

test('subscription preview authorizes a chosen private chat without registering it and saving reuses one registration', async t => {
  const f = await fixture(t), chat = await privateChat(f, undefined, undefined, 'oc_subscription_preview');
  const spec = {name:'Direct chat subscription',destination_id:'chat:'+chat.id,events:['task.failed'],projects:['101'],aggregate_ms:300000,timezone:'UTC',enabled:true};
  const registered = () => f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE state='registered'").n;
  const before = registered(), preview = await query(f,'preview_subscription',{subscription:spec});
  assert.equal(preview.destination.id,spec.destination_id); assert.equal(preview.destination.type,'p2p'); assert.equal(preview.destination.chat_id,chat.chat_id);
  assert.equal(registered(),before); assert.equal(f.h.store.get('SELECT count(*) n FROM notification_subscriptions').n,0);
  const saved = await command(f,'notification.register',{subscription:spec}); assert.equal(saved.value.state,'succeeded');
  const subscription = saved.value.result.subscription; assert.ok(!subscription.spec.destination_id.startsWith('chat:')); assert.equal(registered(),before+1);
  await query(f,'preview_subscription',{subscription:{...spec,destination_id:subscription.spec.destination_id}}); assert.equal(registered(),before+1);
  const again = await command(f,'subscription.update',{id:subscription.id,revision:1,subscription:{...spec,name:'Same chosen chat'}}); assert.equal(again.value.state,'succeeded'); assert.equal(registered(),before+1);
  const other = await f.member('foreign-subscription-owner',{repository_ids:['101']}), foreign = await privateChat(f,'ou_foreign_subscription',other.id,'oc_foreign_subscription');
  const denied = await f.admin('/api/management/query','POST',{operation:'preview_subscription',target,arguments:{subscription:{...spec,destination_id:'chat:'+foreign.id}}});
  assert.equal(denied.status,403); assert.equal(denied.value.error,'schedule_destination_unavailable'); assert.equal(registered(),before+1);
});
test('subscription group previews stop after binding revocation and create no destination or subscription', async t => {
  const f = await fixture(t), chat = await boundGroup(f,['101'],'oc_subscription_group');
  const spec = {name:'Scoped group events',destination_id:'chat:'+chat.id,events:['ci.failed'],projects:['101'],aggregate_ms:60000,timezone:'UTC',enabled:true};
  const registered = () => f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE state='registered'").n;
  const before = registered(), preview = await query(f,'preview_subscription',{subscription:spec}); assert.equal(preview.destination.type,'group'); assert.equal(registered(),before);
  f.h.store.run('UPDATE channel_service_bindings SET enabled=0,revision=revision+1 WHERE chat_id=?',chat.id);
  const denied = await f.admin('/api/management/query','POST',{operation:'preview_subscription',target,arguments:{subscription:spec}});
  assert.equal(denied.status,403); assert.equal(denied.value.error,'schedule_destination_unavailable'); assert.equal(registered(),before); assert.equal(f.h.store.get('SELECT count(*) n FROM notification_subscriptions').n,0);
});
