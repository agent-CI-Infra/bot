import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { boardTask } from '../../../fixtures/board-fixtures.mjs';
import { emptyRepositoryFixture } from '../../../fixtures/empty-repository-helpers.mjs';
import { ObsoleteSweep, obsoleteAfterDays } from '../../../../dist/tasks/obsolete.js';

// #713: tasks in 待处理 that nobody needs to act on leave it by themselves: superseded by a newer task of the same work,
// on an Issue or PR that is closed or merged, or failed for a platform reason long ago with nothing since. A person's own
// pause, help requests and permission waits on an open object, and every wait the engine resumes by itself stay.
const now = Date.parse('2026-11-14T00:00:00.000Z'), daysAgo = days => new Date(now - days * 86400_000).toISOString();
const closedIssue = { issue: { state: 'closed' } }, closedPull = { pull_request: { state: 'closed' } }, openIssue = { issue: { state: 'open' } };
async function fixture(t) { const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); return { h, admin }; }
const task = (h, id) => h.store.get('SELECT * FROM tasks WHERE id=?', id);
const state = (h, id) => { const row = task(h, id); return [row.status, row.error_code]; };
const record = (h, id) => { const row = h.store.get("SELECT data FROM task_history WHERE task_id=? AND type='obsolete_dismissed'", id); return row ? JSON.parse(row.data) : null; };

test('#713 superseded work leaves 待处理 unless the newer task is the bot\'s own stop, and nothing the engine resumes is touched', async t => {
  const { h, admin } = await fixture(t);
  boardTask(h.store, 'old-failure', 7, 'review.pr', 'failed', { time: daysAgo(3), errorCode: 'agent_context_too_large' });
  boardTask(h.store, 'newer-review', 7, 'review.pr', 'succeeded', { time: daysAgo(2) });
  // The 401 waits of #711 on objects reviewed again since.
  boardTask(h.store, 'old-401', 8, 'review.issue', 'waiting_permission', { time: daysAgo(3), errorCode: 'github_permission_401', input: openIssue });
  boardTask(h.store, 'newer-queued', 8, 'review.issue', 'queued', { time: daysAgo(1), input: openIssue });
  // A newer task the bot stopped by itself (#655) does not take over.
  boardTask(h.store, 'kept-failure', 9, 'review.issue', 'failed', { time: daysAgo(3), errorCode: 'agent_context_too_large', input: openIssue });
  boardTask(h.store, 'auto-stopped', 9, 'review.issue', 'cancelled', { time: daysAgo(2), errorCode: 'object_closed_or_draft', input: openIssue });
  // Only the same kind supersedes: a development task does not replace a review.
  boardTask(h.store, 'other-kind', 10, 'review.issue', 'needs_help', { time: daysAgo(3), errorCode: 'manager_needs_help', input: openIssue });
  boardTask(h.store, 'development', 10, 'development.issue', 'running', { time: daysAgo(2), input: openIssue });
  // An older task that failed after the newer one finished is the board's newest by updated_at.
  boardTask(h.store, 'late-failure', 11, 'review.issue', 'failed', { time: daysAgo(3), errorCode: 'agent_context_too_large', input: openIssue });
  h.store.run("UPDATE tasks SET updated_at=? WHERE id='late-failure'", daysAgo(0.5));
  boardTask(h.store, 'took-over', 11, 'review.issue', 'succeeded', { time: daysAgo(2), input: openIssue });
  const issueStatus = async number => (await admin('/api/board/issues?repository_id=101&include_closed=1')).value.issues.find(i => i.number === number)?.status;
  assert.equal(await issueStatus(11), 'blocked');
  // Never touched, even with a newer task: a person's pause, and every wait the engine resumes by itself.
  for (const [index, status] of ['paused', 'waiting_environment', 'waiting_configuration', 'retry_wait', 'waiting_pr_head'].entries()) {
    boardTask(h.store, 'kept-' + status, 20 + index, 'review.issue', status, { time: daysAgo(30), errorCode: 'github_rate_limited', input: closedIssue });
    boardTask(h.store, 'newer-' + status, 20 + index, 'review.issue', 'succeeded', { time: daysAgo(1), input: closedIssue });
  }
  const moved = new ObsoleteSweep(h.store, { log: () => {} }).sweep({ now });
  // The oldest first; created at the same time, by id.
  assert.deepEqual(moved.map(d => [d.task.id, d.rule]), [['late-failure', 'superseded'], ['old-401', 'superseded'], ['old-failure', 'superseded']]);
  // The bot's own stop (#655) with the reason, so the issue no longer shows as blocked.
  assert.deepEqual(state(h, 'old-failure'), ['cancelled', 'obsolete_superseded']);
  assert.deepEqual(state(h, 'old-401'), ['cancelled', 'obsolete_superseded']);
  assert.deepEqual(record(h, 'old-401'), { rule: 'superseded', previous_status: 'waiting_permission', previous_error_code: 'github_permission_401',
    status: 'cancelled', code: 'obsolete_superseded', newer_task_id: 'newer-queued', newer_status: 'queued', newer_created_at: daysAgo(1) });
  assert.notEqual(await issueStatus(11), 'blocked');
  for (const id of ['kept-failure', 'other-kind', 'kept-paused', 'kept-waiting_environment', 'kept-waiting_configuration', 'kept-retry_wait', 'kept-waiting_pr_head'])
    assert.equal(record(h, id), null, id);
  assert.deepEqual(state(h, 'kept-paused'), ['paused', 'github_rate_limited']);
});

test('#713 a closed or merged object, or the closed object a follow-up came from, takes its waits out of 待处理; an open one keeps them', async t => {
  const { h } = await fixture(t);
  boardTask(h.store, 'closed-failure', 30, 'review.issue', 'failed', { time: daysAgo(1), errorCode: 'agent_context_too_large', input: closedIssue });
  boardTask(h.store, 'closed-help', 31, 'review.pr', 'needs_help', { time: daysAgo(1), errorCode: 'manager_needs_help', input: closedPull });
  boardTask(h.store, 'open-help', 32, 'review.pr', 'needs_help', { time: daysAgo(1), errorCode: 'manager_needs_help', input: { pull_request: { state: 'open' } } });
  boardTask(h.store, 'open-401', 33, 'review.issue', 'waiting_permission', { time: daysAgo(1), errorCode: 'github_permission_401', input: openIssue });
  boardTask(h.store, 'unknown-state', 34, 'review.issue', 'failed', { time: daysAgo(1), errorCode: 'agent_context_too_large' });
  // A follow-up of the review of PR #416, merged since, like production's 4964f627; and one two follow-ups away.
  boardTask(h.store, 'review-416', 416, 'review.pr', 'succeeded', { time: daysAgo(3), input: closedPull });
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,error_code,summary,source_task_id,created_at,updated_at) VALUES('follow-up','101','task.request','needs_help','manager_needs_help','follow-up','review-416',?,?)", daysAgo(2), daysAgo(1));
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,error_code,summary,source_task_id,created_at,updated_at) VALUES('follow-up-2','101','task.request','failed','repository_has_no_commit','again','follow-up',?,?)", daysAgo(1), daysAgo(1));
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,error_code,summary,created_at,updated_at) VALUES('request','101','task.request','needs_help','manager_needs_help','no object',?,?)", daysAgo(1), daysAgo(1));
  const moved = new ObsoleteSweep(h.store, { log: () => {} }).sweep({ now });
  assert.deepEqual(moved.map(d => d.task.id).sort(), ['closed-failure', 'closed-help', 'follow-up', 'follow-up-2']);
  assert.deepEqual(state(h, 'closed-help'), ['cancelled', 'obsolete_closed']);
  assert.deepEqual(record(h, 'follow-up'), { rule: 'closed', previous_status: 'needs_help', previous_error_code: 'manager_needs_help', status: 'cancelled',
    code: 'obsolete_closed', object: 'PR #416', github_state: 'closed', state_at: daysAgo(3), via_task_id: 'review-416' });
  assert.equal(record(h, 'follow-up-2').via_task_id, 'review-416');
  for (const id of ['open-help', 'open-401', 'unknown-state', 'request']) assert.equal(record(h, id), null, id);
});

test('#713 a platform failure older than the configured days with nothing since leaves 待处理; a recent one or a person\'s problem stays', async t => {
  const { h } = await fixture(t);
  for (const [index, [id, days, code]] of [['rate-limited', 8, 'github_rate_limited'], ['github-down', 30, 'github_unavailable'], ['crash-conflict', 9, 'tool_operation_conflict'],
    ['context', 10, 'agent_context_too_large'], ['model', 12, 'model_response_invalid'], ['recent', 6, 'github_rate_limited'], ['repository', 30, 'repository_has_no_commit'],
    ['refused', 30, 'github_permission_403']].entries())
    boardTask(h.store, id, 40 + index, 'review.issue', 'failed', { time: daysAgo(days), errorCode: code, input: openIssue });
  // Only failures expire: a permission wait on an open object stays however old it is.
  boardTask(h.store, 'old-401', 60, 'review.issue', 'waiting_permission', { time: daysAgo(30), errorCode: 'github_permission_401', input: openIssue });
  const sweep = new ObsoleteSweep(h.store, { log: () => {} });
  assert.deepEqual(sweep.sweep({ now }).map(d => d.task.id).sort(), ['context', 'crash-conflict', 'github-down', 'model', 'rate-limited']);
  assert.deepEqual(record(h, 'rate-limited'), { rule: 'expired', previous_status: 'failed', previous_error_code: 'github_rate_limited', status: 'cancelled',
    code: 'obsolete_expired', failed_at: daysAgo(8), age_days: 8, cause: 'external', error_code: 'github_rate_limited' });
  for (const id of ['recent', 'repository', 'refused', 'old-401']) assert.equal(record(h, id), null, id);
  // The number of days is configurable.
  assert.deepEqual(new ObsoleteSweep(h.store, { days: 5, log: () => {} }).sweep({ now }).map(d => d.task.id), ['recent']);
  assert.equal(obsoleteAfterDays({}), 7); assert.equal(obsoleteAfterDays({ BOT_OBSOLETE_FAILURE_DAYS: '3' }), 3);
  assert.equal(obsoleteAfterDays({ BOT_OBSOLETE_FAILURE_DAYS: 'soon' }), 7); assert.equal(obsoleteAfterDays({ BOT_OBSOLETE_FAILURE_DAYS: '0' }), 7);
});

test('#713 the sweep works in small batches, keeps the history, the result and the original failure, and the three counts agree', async t => {
  const { h, admin } = await fixture(t);
  for (let n = 1; n <= 5; n++) boardTask(h.store, 'expired-' + n, 70 + n, 'review.issue', 'failed', { time: daysAgo(10 + n), errorCode: 'github_rate_limited', input: openIssue, result: { summary: 'kept' } });
  boardTask(h.store, 'needs-person', 80, 'review.issue', 'needs_help', { time: daysAgo(1), errorCode: 'manager_needs_help', input: openIssue });
  boardTask(h.store, 'paused', 81, 'review.issue', 'paused', { time: daysAgo(40), input: openIssue });
  h.store.run("INSERT INTO task_logs(id,task_id,content,created_at) VALUES('fault-1','expired-1',?,?)", JSON.stringify({ type: 'fault', state: 'failed', code: 'github_rate_limited', detail: 'GitHub 流控' }), daysAgo(11));
  const counts = async () => {
    const blocked = (await admin('/api/board/issues?repository_id=101&include_closed=1')).value.counts.blocked;
    const inbox = (await admin('/api/tasks?attention=1')).value.tasks.map(row => row.id).sort();
    return { blocked, inbox, summary: (await admin('/api/tasks?summary=1')).value.summary.attention };
  };
  assert.deepEqual(await counts(), { blocked: 7, inbox: ['expired-1', 'expired-2', 'expired-3', 'expired-4', 'expired-5', 'needs-person', 'paused'], summary: 7 });
  const sweep = new ObsoleteSweep(h.store, { batch: 2, log: () => {} }), before = task(h, 'expired-5');
  // The oldest first, two at a time.
  assert.deepEqual(sweep.sweep({ now }).map(d => d.task.id), ['expired-5', 'expired-4']);
  assert.deepEqual(await counts(), { blocked: 5, inbox: ['expired-1', 'expired-2', 'expired-3', 'needs-person', 'paused'], summary: 5 });
  assert.deepEqual(sweep.sweep({ now }).map(d => d.task.id), ['expired-3', 'expired-2']);
  assert.deepEqual(sweep.sweep({ now }).map(d => d.task.id), ['expired-1']);
  assert.deepEqual(sweep.sweep({ now }), []);
  assert.deepEqual(await counts(), { blocked: 2, inbox: ['needs-person', 'paused'], summary: 2 });
  // Nothing is lost: the result, the original fault and the time of the last change stay; the move is in the timeline.
  const after = task(h, 'expired-5');
  assert.deepEqual([after.result, after.updated_at, after.input], [before.result, before.updated_at, before.input]);
  assert.ok(h.store.get("SELECT 1 FROM task_logs WHERE id='fault-1'"));
  const log = JSON.parse(h.store.get("SELECT content FROM task_logs WHERE task_id='expired-1' AND json_extract(content,'$.type')='obsolete'").content);
  assert.equal(log.detail, '11 天前的平台类失败，之后没有新的动静，已自动移出待处理；原状态 failed（github_rate_limited），可手动重试。');
  const detail = (await admin('/api/tasks/expired-1')).value.task;
  assert.deepEqual([detail.status, detail.error_code], ['cancelled', 'obsolete_expired']);
  assert.match(JSON.stringify(detail), /已自动移出待处理/);
});

test('#713 a task moved out of 待处理 can still be retried by hand as the state it left', async t => {
  const { h, admin } = await fixture(t);
  boardTask(h.store, 'old', 90, 'review.issue', 'failed', { time: daysAgo(20), errorCode: 'github_rate_limited', input: openIssue });
  boardTask(h.store, 'other-cancel', 91, 'review.issue', 'cancelled', { time: daysAgo(20), errorCode: 'object_closed_or_draft', input: openIssue });
  new ObsoleteSweep(h.store, { log: () => {} }).sweep({ now });
  assert.deepEqual(state(h, 'old'), ['cancelled', 'obsolete_expired']);
  const retried = await admin('/api/tasks/old/retry', 'POST', {});
  assert.equal(retried.value.ok, true, JSON.stringify(retried.value));
  const row = task(h, 'old');
  assert.deepEqual([row.status, row.error_code, row.phase, row.attempt], ['queued', null, 'prepare', 2]);
  // Another cancellation is still not retryable.
  assert.equal((await admin('/api/tasks/other-cancel/retry', 'POST', {})).status, 409);
});

test('#713 when a task of the same work starts, the older one waiting for a person leaves 待处理 at once', async t => {
  const h = await emptyRepositoryFixture(t);
  h.setBranch('ready');
  h.store.run("INSERT INTO tasks(id,repository_id,object_number,kind,status,error_code,summary,created_at,updated_at) VALUES('older','101',1,'review.issue','waiting_permission','github_permission_401','older','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z')");
  const started = await h.run();
  assert.equal(started.status, 'succeeded');
  assert.deepEqual(state(h, 'older'), ['cancelled', 'obsolete_superseded']);
  assert.equal(record(h, 'older').newer_task_id, h.taskId);
});
