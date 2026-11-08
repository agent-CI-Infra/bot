import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Store } from '../dist/storage/database.js';
import { resolveActor, invalidate, authorize } from '../dist/identity/authorization.js';
import { ManagementService } from '../dist/management/service.js';
import { ManagementAgent } from '../dist/management/agent.js';
import { WorkflowService } from '../dist/workflows/service.js';
import { RuleService } from '../dist/rules/service.js';
import { TaskCommands } from '../dist/tasks/commands.js';
import { ChannelService } from '../dist/channels/service.js';
import { ScheduleService } from '../dist/schedules/service.js';
import { Scheduler } from '../dist/schedules/worker.js';
import { defaultLimits } from '../dist/schedules/types.js';
import { nextTime, previewTimes, quietUntil } from '../dist/schedules/time.js';
import { HttpError, randomId } from '../dist/core/security.js';
import { channelFixture, envelope, post, finished, until, group, inGroup, bindFixture } from './channel-fixture.mjs';

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
async function fixture(t) {
  let now = Date.now(), worker;
  const f = await channelFixture(t, { schedules: { clock: () => now, automatic: false }, onSchedules: s => { worker = s; } });
  now = Date.now();
  f.worker = worker; f.advance = ms => { now += ms; }; f.now = () => now;
  f.actor = () => resolveActor(f.h.store, f.admin.cookie().split('=')[1], { project_id: '101' });
  f.destination = f.service.enqueue(f.actor(), f.service.adapter(f.service.connector(f.id)).normalize(envelope()), '101', 'fixture').operation_id;
  f.plan = override => ({ name: '项目日报', kind: 'personal', actor_id: f.principal, owner_id: f.principal, maintainer_id: f.principal,
    workflow: 'report.daily', parameters: {}, timezone: 'Asia/Shanghai', interval_ms: 60000, start_at: f.now() + 60000, enabled: true,
    misfire: 'skip', grace_ms: 60000, destination_id: f.destination, limits: { ...defaultLimits }, ...override });
  f.create = async (plan = f.plan()) => {
    const r = await command(f, 'schedule.register', { plan }); assert.equal(r.status, 201); assert.equal(r.value.state, 'succeeded', JSON.stringify(r.value)); return r.value.result.schedule;
  };
  return f;
}
function otherWorker(f, t, transport) {
  const store = new Store(f.h.database, f.h.key), management = new ManagementService(store, new WorkflowService(store, new RuleService(store)), new TaskCommands(store));
  const channels = new ChannelService(store, new ManagementAgent(store, management), { origin: 'https://console.example.test', fetch: f.wire.fetch });
  const service = new ScheduleService(store, management, channels, f.now), worker = new Scheduler(service, transport);
  t.after(async () => { await worker.close(); store.close(); }); return worker;
}
async function projectPlan(f, maintainer, owner = f.principal) {
  const service = randomId();
  f.h.store.run("INSERT INTO principals(id,kind,project_id,tenant_id,maintenance) VALUES(?,'service','101','github.com:10','project maintainers')", service);
  f.h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
    VALUES(?,?,'github.com:10','101','project','service',?,'explicit_delegation',?,'schedule','fixture approval',?)`, randomId(), service, JSON.stringify(['tasks.read', 'schedules.manage']), f.principal, f.now());
  await group(f.admin, f.id);
  const destination = f.service.enqueue(f.actor(), f.service.adapter(f.service.connector(f.id)).normalize(inGroup('/project 101 /destination')), '101', 'handover-group').operation_id;
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
test('user creates and previews a daily report, sees evidence, runs now and receives a persisted delivery', async t => {
  const f = await fixture(t);
  f.modelState.failure = 503;
  const registered = await post(f.h, f.id, envelope('/project 101 /destination'));
  assert.equal((await finished(f.h, registered.value.operation_id)).state, 'completed');
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
  assert.equal(f.requests.length, 0); assert.equal(deliveries[0].payload.report.model, 'deterministic_no_model');
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
  const actor = resolveActor(f.h.store, member.client.cookie().split('=')[1], { project_id: '101' });
  const destination = f.service.enqueue(actor, f.service.adapter(f.service.connector(f.id)).normalize(envelope('/project 101 /destination', { sender: { sender_id: { open_id: 'ou_member' } } })), '101', 'member').operation_id;
  const plan = f.plan({ actor_id: member.id, owner_id: member.id, maintainer_id: member.id, destination_id: destination });
  const saved = await command(f, 'schedule.register', { plan }, member.client); assert.equal(saved.value.state, 'succeeded');
  f.advance(60000); f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());
  assert.equal(f.h.store.get('SELECT state FROM notification_outbox').state, 'pending');
  f.h.store.run('DELETE FROM project_admin_assignments WHERE user_id=?', member.id);
  const before = f.wire.sent.length; await f.worker.tick();
  assert.equal(f.h.store.get('SELECT state FROM schedules').state, 'paused'); assert.equal(f.h.store.get('SELECT state FROM notification_outbox').state, 'blocked'); assert.equal(f.wire.sent.length, before);
});
test('private repository data cannot cross a public group scope, including a queued report after scope revocation', async t => {
  const f = await fixture(t); await group(f.admin, f.id);
  const event = f.service.adapter(f.service.connector(f.id)).normalize(inGroup('/project 101 /destination'));
  const destination = f.service.enqueue(f.actor(), event, '101', 'group').operation_id;
  await f.create(f.plan({ destination_id: destination })); f.advance(60000); f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());
  f.h.store.run('UPDATE installed_repositories SET private=1 WHERE repository_id=\'101\'');
  f.h.store.run("UPDATE channel_group_scopes SET sensitivity='public' WHERE project_id='101'");
  const before = f.wire.sent.length;
  const preview = await f.admin('/api/management/query', 'POST', { operation: 'preview_schedule', target, arguments: { plan: f.plan({ destination_id: destination }) } });
  assert.equal(preview.status, 403); assert.equal(preview.value.error, 'channel_group_scope_required');
  await f.worker.tick(); assert.equal(f.h.store.get('SELECT state FROM notification_outbox').state, 'blocked'); assert.equal(f.wire.sent.length, before);
});
test('project service uses explicit minimum capabilities, survives creator departure and pauses when delegation or maintainer is revoked', async t => {
  const f = await fixture(t), maintainer = await f.member('service-maintainer', { repository_ids: ['101'] });
  const service = randomId(), grant = randomId();
  f.h.store.run("INSERT INTO principals(id,kind,project_id,tenant_id,maintenance) VALUES(?,'service','101','github.com:10','project maintainers')", service);
  f.h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
    VALUES(?,?,'github.com:10','101','project','service',?,'explicit_delegation',?,'schedule','fixture approval',?)`, grant, service, JSON.stringify(['tasks.read', 'schedules.manage']), f.principal, f.now());
  f.h.store.run('UPDATE principals SET authorization_revision=9 WHERE id=?', service);
  await group(f.admin, f.id);
  const destination = f.service.enqueue(f.actor(), f.service.adapter(f.service.connector(f.id)).normalize(inGroup('/project 101 /destination')), '101', 'project-group').operation_id;
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
  const f = await fixture(t); await f.create(f.plan({ limits: { ...defaultLimits, retries: 1, notifications_per_minute: 1 } }));
  f.advance(60000); f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());
  const second = otherWorker(f, t, { send: async () => { throw new HttpError(503, 'channel_rate_limited'); } });
  const claim = second.claimNotification(); await second.send(claim);
  let row = f.h.store.get('SELECT * FROM notification_outbox'); assert.equal(row.state, 'retry'); assert.equal(row.attempts, 1); assert.ok(row.next_attempt > f.now());
  f.advance(2001); assert.equal(second.claimNotification(), null); assert.equal(f.h.store.get('SELECT last_error FROM notification_outbox').last_error, 'notification_rate_limited');
  f.advance(60000); const retry = second.claimNotification(); await second.send(retry); f.advance(60000); second.claimNotification();
  row = f.h.store.get('SELECT * FROM notification_outbox'); assert.equal(row.state, 'dead'); assert.equal(row.attempts, 2);
});
test('plan/project/tenant budgets and runtime limits stop new actions, retries do not reset usage', async t => {
  const f = await fixture(t); await f.create(f.plan({ limits: { ...defaultLimits, runs: 1 } })); f.advance(60000); await f.worker.tick();
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
  const f = await fixture(t), spec = { name: '失败与恢复', destination_id: f.destination, events: ['task.failed', 'ci.failed', 'ci.recovered', 'approval.waiting'], projects: ['101'], aggregate_ms: 60000, timezone: 'UTC', enabled: true };
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

test('controlled workflow contract dispatches a fake business handler once, preserves its run and enforces tool/model budgets', async t => {
  const f = await fixture(t); let dispatched = 0;
  for (const [scope, id] of [['project', '101'], ['tenant', 'github.com:10']]) f.h.store.run('INSERT INTO schedule_budgets VALUES(?,?,\'development\',?)', scope, id, JSON.stringify({ ...defaultLimits, model_calls: 1, cost_micros: 20 }));
  f.h.store.run("INSERT INTO workflows(repository_id,id,name,triggers,created_at,updated_at) VALUES('101','custom.fixture','Fixture','[]',?,?)", new Date().toISOString(), new Date().toISOString());
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
  const f = await fixture(t); const a = await f.create(), b = await f.create();
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

test('signed CI/approval mutations atomically publish supported events and daily reports query the real check evidence', async t => {
  const f = await fixture(t);
  const repo = { id: 101, full_name: 'agent-test-zone/admin-fixture-101', owner: { id: 10 } }, run = { id: 4321, run_attempt: 1, status: 'completed', conclusion: 'failure' };
  const send = async (id, conclusion) => f.h.hook(f.a.path, f.a.secret, id, { action: 'completed', repository: repo, workflow_run: { ...run, conclusion } }, { 'X-GitHub-Event': 'workflow_run' });
  assert.equal((await send('ci-success-first', 'success')).status, 200); assert.equal(f.h.store.get('SELECT count(*) n FROM schedule_events').n, 0);
  assert.equal((await send('ci-fail', 'failure')).status, 200); assert.equal((await send('ci-fail', 'failure')).value.duplicate, true);
  assert.equal((await send('ci-recovery', 'success')).status, 200);
  assert.deepEqual(f.h.store.all('SELECT type FROM schedule_events ORDER BY sequence').map(r => r.type), ['ci.failed', 'ci.recovered']);
  f.advance(60000); const report = f.worker.service.reports.render('101', f.now(), 'UTC');
  assert.ok(report.evidence.some(e => e.id.startsWith('delivery:') && e.kind === 'ci' && e.status === 'success')); assert.equal(report.counts['ci:success'], 1);
  f.h.store.run("INSERT INTO management_policies(tenant_id,approval_operations) VALUES('github.com:10','[\"schedule.register\"]')");
  const saved = await command(f, 'schedule.register', { plan: f.plan() }); assert.equal(saved.value.state, 'awaiting_approval');
  assert.equal(f.h.store.get("SELECT count(*) n FROM schedule_events WHERE type='approval.waiting'").n, 1);
});

test('a real worker process exits after its committed claim; replacement processes recover one run under competition', async t => {
  const f = await fixture(t); await f.create(); f.advance(60000);
  const source = `
    import {readFileSync} from 'node:fs';
    import {Store} from './dist/storage/database.js';
    import {ManagementService} from './dist/management/service.js';
    import {ManagementAgent} from './dist/management/agent.js';
    import {WorkflowService} from './dist/workflows/service.js';
    import {RuleService} from './dist/rules/service.js';
    import {TaskCommands} from './dist/tasks/commands.js';
    import {ChannelService} from './dist/channels/service.js';
    import {ScheduleService} from './dist/schedules/service.js';
    import {Scheduler} from './dist/schedules/worker.js';
    const input=JSON.parse(readFileSync(0,'utf8')),store=new Store(input.path,Buffer.from(input.key,'hex'));
    const management=new ManagementService(store,new WorkflowService(store,new RuleService(store)),new TaskCommands(store));
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
