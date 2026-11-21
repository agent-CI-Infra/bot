import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../../../../dist/core/security.js';
import { TaskError } from '../../../../dist/agent/common.js';
import { channelFixture, privateChat, scriptedModel } from '../../../fixtures/channel-fixture.mjs';

// A scheduled timer must not become permanently paused because of one passing fault (#533 §5.3). The run fails, the timer
// stays active and retries with backoff; only a withdrawn authority or unusable configuration pauses it.

const timer = (client, chat, input = {}) => client('/api/channels/chats/' + chat.id + '/schedules', 'POST',
  { name: '每日汇总', prompt: '汇总失败的任务；没有异常就保持沉默。', timezone: 'Asia/Shanghai', interval_minutes: 5, ...input });
const runs = (f, id) => f.h.store.all('SELECT * FROM channel_schedule_runs WHERE schedule_id=? ORDER BY created_at,rowid', id);
const row = (f, id) => f.h.store.get('SELECT * FROM channel_schedules WHERE id=?', id);
const failWith = (f, error) => { f.service.schedules.execute = async () => { throw error; }; };
const realExecute = f => { delete f.service.schedules.execute; };

/** A fixture whose timer clock the test controls, with one 5-minute interval timer created on it. */
async function clocked(t) {
  const f = await channelFixture(t), chat = await privateChat(f), now = { value: Date.now() };
  f.service.schedules.clock = () => now.value;
  const created = await timer(f.admin, chat);
  assert.equal(created.status, 201, JSON.stringify(created.value));
  return { f, chat, now, schedule: created.value.schedule };
}

async function fire(f, now, at) {
  now.value = at;
  await f.service.schedules.tick();
  await f.service.schedules.drain();
}

test('a passing 403 keeps the timer active, fails only that run and backs off 1 then 2 minutes; it recovers (#533)', async t => {
  const { f, now, schedule } = await clocked(t);
  failWith(f, new HttpError(403, 'conversation_role_authority_changed'));
  await fire(f, now, schedule.next_at);
  let current = row(f, schedule.id);
  assert.equal(current.state, 'active'); assert.equal(current.reason, null);
  assert.equal(current.next_at, now.value + 60000, 'the first retry comes one minute later, not at the next five-minute occurrence');
  const first = runs(f, schedule.id).at(-1);
  assert.deepEqual({ state: first.state, error: first.error, trigger: first.trigger },
    { state: 'failed', error: 'conversation_role_authority_changed', trigger: 'timer' });
  // The retry actually fires: it fails again and the ladder doubles; the timer is still the same active row.
  const retryAt = current.next_at;
  await fire(f, now, retryAt);
  current = row(f, schedule.id);
  assert.equal(current.state, 'active');
  assert.equal(current.next_at, now.value + 120000);
  assert.equal(runs(f, schedule.id).filter(run => run.state === 'failed').length, 2);
  assert.equal(runs(f, schedule.id).at(-1).logical_key, 'timer:' + retryAt);
  // Once the passing fault is over the next attempt runs the real turn and finishes normally; the timer never paused.
  realExecute(f);
  scriptedModel(f, ['恢复后的汇报：一切正常。']);
  await fire(f, now, current.next_at);
  const recovered = runs(f, schedule.id).at(-1);
  assert.equal(recovered.state, 'completed', recovered.error);
  current = row(f, schedule.id);
  assert.equal(current.state, 'active'); assert.equal(current.reason, null);
  assert.ok(current.next_at > now.value);
});

test('waiting_configuration is a passing fault too: the timer retries instead of pausing (#533)', async t => {
  const { f, now, schedule } = await clocked(t);
  failWith(f, new TaskError('model_configuration_changed', 'waiting_configuration', '模型配置正在更新'));
  await fire(f, now, schedule.next_at);
  const current = row(f, schedule.id);
  assert.equal(current.state, 'active'); assert.equal(current.reason, null);
  assert.equal(current.next_at, now.value + 60000);
  const failed = runs(f, schedule.id).at(-1);
  assert.deepEqual([failed.state, failed.error], ['failed', 'model_configuration_changed']);
  // A manual run failing the same way fails only that run and does not move the timer's own plan.
  const planned = current.next_at;
  assert.equal((await f.admin('/api/channels/schedules/' + schedule.id + '/run', 'POST', {})).status, 201);
  await f.service.schedules.drain();
  assert.equal(runs(f, schedule.id).at(-1).trigger, 'manual');
  assert.equal(runs(f, schedule.id).at(-1).state, 'failed');
  assert.deepEqual([row(f, schedule.id).state, row(f, schedule.id).next_at], ['active', planned], 'a manual run never rewrites the schedule');
});

test('a withdrawn authority still pauses the timer with its reason, including a revoked role grant (#533)', async t => {
  const { f, now, schedule } = await clocked(t);
  failWith(f, new HttpError(403, 'external_binding_required'));
  await fire(f, now, schedule.next_at);
  assert.deepEqual([row(f, schedule.id).state, row(f, schedule.id).reason, row(f, schedule.id).next_at], ['paused', 'external_binding_required', null]);
  assert.equal(runs(f, schedule.id).at(-1).state, 'failed');
  // A TaskError carries waiting_configuration for a really revoked grant as well; a revocation code stays terminal.
  const resumed = await f.admin('/api/channels/schedules/' + schedule.id, 'PATCH', { expected_revision: row(f, schedule.id).revision, enabled: true });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.value));
  failWith(f, new TaskError('role_authority_revoked', 'waiting_configuration', '角色分派权限已拒绝'));
  await fire(f, now, row(f, schedule.id).next_at);
  assert.deepEqual([row(f, schedule.id).state, row(f, schedule.id).reason, row(f, schedule.id).next_at], ['paused', 'role_authority_revoked', null]);
  // A business refusal is neither: it fails the one run and leaves the timer alone.
  const again = await f.admin('/api/channels/schedules/' + schedule.id, 'PATCH', { expected_revision: row(f, schedule.id).revision, enabled: true });
  assert.equal(again.status, 200, JSON.stringify(again.value));
  failWith(f, new HttpError(409, 'channel_schedule_changed'));
  await fire(f, now, row(f, schedule.id).next_at);
  assert.equal(row(f, schedule.id).state, 'active');
});

test('only withdrawal pauses and only passing faults retry, by code not by HTTP class (#533)', async () => {
  const { transient, withdrawn } = await import('../../../../dist/channels/schedules.js');
  const passing = [
    new HttpError(403, 'conversation_role_authority_changed'),
    new HttpError(403, 'task_result_authority_changed'),
    new HttpError(408, 'request_timeout'),
    new HttpError(429, 'github_rate_limited'),
    new HttpError(502, 'github_unavailable'),
    new TaskError('model_configuration_changed', 'waiting_configuration', '模型配置正在更新'),
    new TaskError('model_authentication_failed', 'waiting_configuration', '模型拒绝认证'),
    new TaskError('github_unavailable', 'retry_wait', 'GitHub 暂时不可用'),
  ];
  for (const error of passing) assert.deepEqual([transient(error), withdrawn(error)], [true, false], error.code);
  const withdrawnErrors = [
    new HttpError(403, 'external_binding_required'),
    new HttpError(403, 'principal_inactive'),
    new HttpError(403, 'channel_service_binding_disabled'),
    new HttpError(403, 'channel_schedule_forbidden'),
    new HttpError(403, 'capability_forbidden'),
    new TaskError('role_authority_revoked', 'waiting_configuration', '角色分派权限已拒绝'),
  ];
  for (const error of withdrawnErrors) assert.deepEqual([transient(error), withdrawn(error)], [false, true], error.code);
  for (const error of [new HttpError(409, 'channel_schedule_changed'), new HttpError(404, 'channel_schedule_not_found'), new Error('boom')])
    assert.deepEqual([transient(error), withdrawn(error)], [false, false], error.code ?? error.message);
});
