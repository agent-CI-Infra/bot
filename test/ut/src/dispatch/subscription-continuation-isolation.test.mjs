// #1409: Same-object continuations (`match: 'object'`) vs cross-object event_subscriptions candidates (`match: 'subscription'`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import {
  applyDecision,
  continuations,
  dispatchContext,
  readDispatchThread,
  recordEvent,
} from '../../../../dist/dispatch/store.js';
import { ruleDecision } from '../../../../dist/dispatch/rules.js';
import { ruleDecider } from '../../../../dist/dispatch/worker.js';
import { queueWebhook } from '../../../../dist/review/queue.js';
import { setGrant } from '../../../../dist/tasks/grants.js';
import { captureTaskConfiguration } from '../../../../dist/tasks/configuration.js';
import { executeTaskSubscriptionTool, resolveSubscriptionsByManager, taskEventSubscriptionsDetail } from '../../../../dist/tasks/event-subscriptions.js';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';

const SHA_1314 = '1'.repeat(40);
const SHA_1445 = '4'.repeat(40);
const SHA_1445_PUSH = '5'.repeat(40);

function createFixture(t) {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  const now = '2026-11-27T06:00:00.000Z';
  store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture', 'bot_account', null, store.secrets.seal({ token: 'gh-tok' }, 'account:a'), now);
  store.run("INSERT INTO repositories VALUES('101','openJiuwen-ai/sciencediscovery','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', 'http://127.0.0.1:9/v1', 'fixture', store.secrets.seal({ value: 'k' }, 'model:m'), now);
  store.run("INSERT INTO policies(repository_id,model_id,enabled,review_enabled,development_enabled,capability_ceiling) VALUES('101','m',1,1,1,'develop')");
  scriptedRoles(store, '101');

  const seedTask = (id, {
    kind = 'task.request',
    status = 'waiting_event',
    objectNumber = 1314,
    target = { type: 'pr', number: 1314, ref: SHA_1314 },
    headSha = SHA_1314,
    writes = ['pull_request'],
    summary = `Task ${id}`,
  } = {}) => {
    const input = { generic: kind === 'task.request', target, round: 1 };
    store.run(
      `INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,object_number,head_sha,attempt,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`,
      id, '101', kind, status, 'model', summary, JSON.stringify(input), objectNumber, headSha, now, now,
    );
    if (writes.length) setGrant(store, { id, repository_id: '101' }, writes, 'role:manager', null);
    captureTaskConfiguration(store, id);
    return store.get('SELECT * FROM tasks WHERE id=?', id);
  };

  const subscribe = (task, args) => {
    const out = executeTaskSubscriptionTool(store, task, 'subscribe_event', { release_slot: false, timeout_seconds: 1800, ...args });
    assert.equal(out.subscribed, true, JSON.stringify(out));
    return out.subscription;
  };

  return { store, now, seedTask, subscribe };
}

test('continuations distinguishes same-object tasks from cross-object subscription candidates and deduplicates multi-subscription tasks', t => {
  const { store, seedTask, subscribe } = createFixture(t);
  const subTask = seedTask('t-1314', {
    status: 'waiting_event',
    objectNumber: 1314,
    target: { type: 'pr', number: 1314, ref: SHA_1314 },
    summary: 'PR #1314 waiting on CI',
  });
  subscribe(subTask, { events: ['workflow_run'], workflow: 'ci.yml', note: 'wait ci' });
  subscribe(subTask, { events: ['check_suite'], head_sha: SHA_1314.slice(0, 12), note: 'wait checks' });

  const review1445 = seedTask('rev-1445', {
    status: 'succeeded',
    objectNumber: 1445,
    target: { type: 'pr', number: 1445, ref: SHA_1445 },
    headSha: SHA_1445,
    writes: ['review'],
    summary: 'Finished review on PR #1445',
  });
  assert.ok(review1445);

  const pr1445 = { number: 1445, state: 'open', draft: false, title: 'Unrelated PR #1445', head: { sha: SHA_1445, ref: 'feat/1445' }, base: { ref: 'main' }, user: { id: 5, login: 'alice' } };
  assert.equal(queueWebhook(store, '101', 'pull_request_review', {
    action: 'submitted',
    sender: { type: 'User', login: 'zhaozhaozz', id: 22 },
    pull_request: pr1445,
    review: { id: 7001, state: 'commented', body: 'Look at this edge case.', author_association: 'MEMBER', user: { id: 22, login: 'zhaozhaozz' } },
  }, 'deliv-1445-review'), 1);

  const ev1445 = store.get("SELECT * FROM dispatch_events WHERE delivery_id='deliv-1445-review'");
  const cont1445 = continuations(store, ev1445);
  assert.deepEqual(
    cont1445.map(c => ({ task_id: c.task_id, match: c.match, object_type: c.object_type, object_number: c.object_number })),
    [
      { task_id: 'rev-1445', match: 'object', object_type: 'pr', object_number: 1445 },
      { task_id: 't-1314', match: 'subscription', object_type: 'pr', object_number: 1314 },
    ],
  );

  // When an event arrives on PR #1314 itself, t-1314 is a same-object continuation (not duplicated as a subscription candidate).
  const pr1314 = { number: 1314, state: 'open', draft: false, title: 'PR #1314', head: { sha: SHA_1314, ref: 'bot/issue-1314' }, base: { ref: 'main' }, user: { id: 9, login: 'bot' } };
  assert.equal(queueWebhook(store, '101', 'pull_request_review', {
    action: 'submitted',
    sender: { type: 'User', login: 'zhaozhaozz', id: 22 },
    pull_request: pr1314,
    review: { id: 7002, state: 'commented', body: 'Same PR comment.', author_association: 'MEMBER', user: { id: 22, login: 'zhaozhaozz' } },
  }, 'deliv-1314-review'), 1);

  const ev1314 = store.get("SELECT * FROM dispatch_events WHERE delivery_id='deliv-1314-review'");
  const cont1314 = continuations(store, ev1314);
  assert.deepEqual(
    cont1314.map(c => ({ task_id: c.task_id, match: c.match, object_type: c.object_type, object_number: c.object_number })),
    [{ task_id: 't-1314', match: 'object', object_type: 'pr', object_number: 1314 }],
  );

  // subscription.check on an open bot PR only exposes active subscription tasks (never an unsubscribed dormant pr_opened task).
  seedTask('dormant-900', {
    status: 'pr_opened',
    objectNumber: 900,
    target: { type: 'pr', number: 900, ref: SHA_1445 },
    headSha: SHA_1445,
    writes: ['pull_request'],
    summary: 'Dormant bot PR #900',
  });
  store.run("INSERT INTO bot_pull_requests VALUES('101',900,'pr-900','999','101','bot/issue-900',?,'dormant-900',0)", SHA_1445);
  assert.equal(recordEvent(store, {
    repositoryId: '101',
    key: 'subscription.check:deliv-sub-900',
    type: 'subscription.check',
    source: 'github',
    summary: '订阅事件核对：workflow_run.completed',
    facts: { webhook_event: 'workflow_run', action: 'completed' },
    object: { type: 'pr', number: 900 },
    delivery: 'deliv-sub-900',
    options: [],
  }), 1);
  const evSubCheck = store.get("SELECT * FROM dispatch_events WHERE delivery_id='deliv-sub-900'");
  assert.deepEqual(
    continuations(store, evSubCheck).map(c => ({ task_id: c.task_id, match: c.match })),
    [{ task_id: 't-1314', match: 'subscription' }],
  );
});

test('standing rules, option.unless_continued, and ruleDecider never match cross-object subscription candidates', t => {
  const { store, seedTask, subscribe } = createFixture(t);
  const subTask = seedTask('t-1314', {
    status: 'waiting_event',
    objectNumber: 1314,
    target: { type: 'pr', number: 1314, ref: SHA_1314 },
  });
  subscribe(subTask, { events: ['workflow_run'], note: 'waiting on CI for PR #1314' });

  // 1) PR #1445 has only a succeeded review; pull_request.updated must NOT hit pull-request-update (continue_active).
  seedTask('rev-1445', {
    status: 'succeeded',
    objectNumber: 1445,
    target: { type: 'pr', number: 1445, ref: SHA_1445 },
    headSha: SHA_1445,
    writes: ['review'],
  });
  const pr1445 = { number: 1445, state: 'open', draft: false, title: 'PR #1445', head: { sha: SHA_1445, ref: 'feat/1445' }, base: { ref: 'main' }, user: { id: 5, login: 'alice' } };
  queueWebhook(store, '101', 'pull_request_review', {
    action: 'submitted',
    sender: { type: 'User', login: 'zhaozhaozz', id: 22 },
    pull_request: pr1445,
    review: { id: 7010, state: 'commented', body: 'Review note', author_association: 'MEMBER', user: { id: 22, login: 'zhaozhaozz' } },
  }, 'deliv-1445-upd');
  const ctxUpd = dispatchContext(store, store.get("SELECT * FROM dispatch_events WHERE delivery_id='deliv-1445-upd'"));
  assert.equal(ruleDecision(store, ctxUpd, () => true), null, 'continue_active ignores cross-object subscription and leaves succeeded review to Manager');

  // Also verify explicit `action: "continue"` rule never matches subscription-only continuations on an object with no tasks.
  store.run(
    'INSERT INTO manager_rules(repository_id,revision,rules) VALUES(?,?,?)',
    '101',
    1,
    JSON.stringify([
      { id: 'strict-continue', event: 'issue.updated', action: 'continue', reason: '常设规则：仅续接同对象任务。' },
      { id: 'pr-push', event: 'pull_request.synchronize', action: 'continue_or_create', role: 'reviewer', writes: ['review'], reason: '常设规则：PR 新推送续接或新建检视。' },
    ]),
  );

  // 2) Issue #1447 with no tasks: `action: 'continue'` returns null; ruleDecider creates default review instead of continuing t-1314.
  const issue1447 = { number: 1447, state: 'open', title: 'Issue #1447', body: 'Bug report', user: { id: 5, login: 'alice' }, labels: [] };
  queueWebhook(store, '101', 'issue_comment', {
    action: 'created',
    sender: { type: 'User', login: 'zhaozhaozz', id: 22 },
    issue: issue1447,
    comment: { id: 8001, body: 'Additional details', author_association: 'MEMBER', user: { id: 22, login: 'zhaozhaozz' } },
  }, 'deliv-1447-comment');
  const ctxIssue = dispatchContext(store, store.get("SELECT * FROM dispatch_events WHERE delivery_id='deliv-1447-comment'"));
  assert.deepEqual(ctxIssue.continuations.map(c => [c.task_id, c.match]), [['t-1314', 'subscription']]);
  assert.equal(ruleDecision(store, ctxIssue, () => true), null, 'continue rule must not match cross-object subscription');
  const legacyIssueDecision = ruleDecider(ctxIssue);
  assert.equal(legacyIssueDecision.decision, 'create', 'ruleDecider must not hijack cross-object subscription');

  // 3) PR #1446 with no tasks receives pull_request.synchronize: option.unless_continued must NOT be suppressed,
  //    continue_or_create must create a new reviewer task, and ruleDecider must create review instead of continuing t-1314.
  const pr1446 = { number: 1446, state: 'open', draft: false, title: 'PR #1446', head: { sha: SHA_1445_PUSH, ref: 'feat/1446' }, base: { ref: 'main' }, user: { id: 5, login: 'alice' } };
  queueWebhook(store, '101', 'pull_request', {
    action: 'synchronize',
    before: SHA_1445,
    sender: { type: 'User', login: 'alice', id: 5 },
    pull_request: pr1446,
  }, 'deliv-1446-push');
  const ctxPush = dispatchContext(store, store.get("SELECT * FROM dispatch_events WHERE delivery_id='deliv-1446-push'"));
  assert.ok(ctxPush.options.some(o => o.id === 'review' && o.unless_continued === true), 'unless_continued review option stays offered when only subscription continuations exist');
  const pushRuleDecision = ruleDecision(store, ctxPush, () => true);
  assert.equal(pushRuleDecision?.decision, 'create');
  assert.equal(pushRuleDecision?.role, 'reviewer');
  assert.deepEqual(pushRuleDecision?.writes, ['review']);
  const legacyPushDecision = ruleDecider(ctxPush);
  assert.equal(legacyPushDecision.decision, 'create');
  assert.deepEqual(legacyPushDecision.option_ids, ['review']);
});

test('cross-object subscription continuation wakes the subscribed task without polluting its target, revision, review_updates, bot_pr_requests, or source thread active_task_id', t => {
  const { store, seedTask, subscribe } = createFixture(t);
  const subTask = seedTask('t-1314', {
    status: 'waiting_event',
    objectNumber: 1314,
    target: { type: 'pr', number: 1314, ref: SHA_1314 },
    headSha: SHA_1314,
    writes: ['pull_request'],
    summary: 'Bot PR #1314 waiting on companion PR #1445',
  });
  store.run("INSERT INTO bot_pull_requests VALUES('101',1314,'pr-1314','999','101','bot/issue-1314',?,'t-1314',0)", SHA_1314);
  subscribe(subTask, { events: ['issue_comment'], note: 'Wait for companion PR #1445 comment signal' });

  // Also register PR #1445 as a bot PR so the webhook merge carries a `revision_request` AND `head` SHA from PR #1445.
  store.run("INSERT INTO bot_pull_requests VALUES('101',1445,'pr-1445','999','101','bot/issue-1445',?,'other-task-1445',0)", SHA_1445);
  const pr1445 = {
    number: 1445,
    state: 'open',
    draft: false,
    title: 'Companion PR #1445',
    head: { sha: SHA_1445_PUSH, ref: 'bot/issue-1445' },
    base: { ref: 'main' },
    user: { id: 999, login: 'bot', type: 'Bot' },
  };
  assert.equal(queueWebhook(store, '101', 'issue_comment', {
    action: 'created',
    sender: { type: 'User', login: 'zhaozhaozz', id: 22 },
    issue: { number: 1445, state: 'open', title: pr1445.title, pull_request: {}, user: { id: 999 } },
    comment: { id: 9901, body: 'Ready for #1314 to proceed.', author_association: 'MEMBER', html_url: 'https://github.invalid/pull/1445#c9901', user: { id: 22, login: 'zhaozhaozz' } },
  }, 'deliv-1445-wake', pr1445), 1);

  // Seed conflict suppression on PR #1445 right before applyDecision to prove cross-object wakeup skips recordBotPrDispatchOutcome.
  store.run(
    `INSERT OR REPLACE INTO bot_pr_states(repository_id,number,state,draft,head_sha,conflict_suppressed_head_sha,patrol_status,updated_at)
     VALUES('101',1445,'open',0,?,?,'suppressed_dirty','2026-11-27T06:00:00.000Z')`,
    SHA_1445,
    SHA_1445,
  );

  const ev1445 = store.get("SELECT * FROM dispatch_events WHERE delivery_id='deliv-1445-wake'");
  const ctx = dispatchContext(store, ev1445);
  const subOpt = ctx.continuations.find(c => c.task_id === 't-1314');
  assert.equal(subOpt?.match, 'subscription');
  assert.equal(subOpt?.object_type, 'pr');
  assert.equal(subOpt?.object_number, 1314);

  const applied = applyDecision(store, ev1445, {
    decision: 'continue',
    option_ids: ['continue:t-1314'],
    reason: 'PR #1445 评论命中 PR #1314 等待的订阅信号，唤醒任务继续执行。',
    model: 'fixture-manager',
    seen: ctx.continuations.map(c => c.id),
  }, null);
  assert.deepEqual(applied.continued, ['t-1314']);

  // 1) Task #1314 was properly woken via subscription and received event_wakeups + dispatch log.
  const woken = store.get("SELECT * FROM tasks WHERE id='t-1314'");
  assert.equal(woken.status, 'queued');
  assert.equal(woken.head_sha, SHA_1314, 'task head_sha remains PR #1314');
  const wokenInput = JSON.parse(woken.input);
  assert.equal(wokenInput.event_wakeups?.length, 1);
  assert.equal(wokenInput.event_wakeups[0].wake_reason, 'manager_assigned');
  const subs = taskEventSubscriptionsDetail(store, 't-1314');
  assert.equal(subs[0].state, 'matched');
  assert.equal(subs[0].wake_reason, 'manager_assigned');

  const logs = store.all("SELECT content FROM task_logs WHERE task_id='t-1314'").map(r => JSON.parse(r.content));
  assert.ok(logs.some(entry => entry.type === 'dispatch' && entry.relation === 'continued' && entry.match === 'subscription'));

  // 2) Zero cross-object contamination on PR #1314's task input, review_updates, bot_pr_requests, or PR #1445's thread active_task_id.
  assert.deepEqual(wokenInput.target, { type: 'pr', number: 1314, ref: SHA_1314 }, 'target.ref must not be overwritten with PR #1445 head SHA');
  assert.equal(wokenInput.move_to_sha, undefined, 'move_to_sha must not be set from PR #1445');
  assert.equal(wokenInput.revision, undefined, 'revision requests from PR #1445 must not be written into PR #1314');
  assert.equal(wokenInput.merged_updates, undefined, 'merged_updates must not absorb PR #1445 merge trigger');
  assert.equal(wokenInput.wake_events, undefined, 'wake_events must not absorb PR #1445 event');
  assert.equal(store.get("SELECT count(*) AS n FROM review_updates WHERE task_id='t-1314'").n, 0);
  assert.equal(store.get('SELECT count(*) AS n FROM bot_pr_requests').n, 0);
  const thread1445 = readDispatchThread(store, ev1445.thread_key, '101');
  assert.equal(thread1445.active_task_id, null, 'PR #1445 thread active_task_id must not be hijacked by PR #1314 task');
  assert.deepEqual(thread1445.messages.at(-1)?.continued, ['t-1314']);
  const state1445 = store.get("SELECT conflict_suppressed_head_sha, patrol_status FROM bot_pr_states WHERE repository_id='101' AND number=1445");
  assert.equal(state1445?.conflict_suppressed_head_sha, SHA_1445, 'cross-object wakeup must not clear source PR conflict suppression');
  assert.equal(state1445?.patrol_status, 'suppressed_dirty');
});

test('resolveSubscriptionsByManager ignores synthetic control-plane facts.event (bot_pr_patrol) and matches pull_request subscription cleanly', t => {
  const { store, seedTask, subscribe } = createFixture(t);
  const task = seedTask('t-multi-sub', {
    status: 'waiting_event',
    objectNumber: 1500,
    target: { type: 'pr', number: 1500, ref: SHA_1314 },
    headSha: SHA_1314,
  });
  // Register an older `issues` subscription first, then a `pull_request` subscription.
  const issueSub = subscribe(task, { events: ['issues'], note: 'wait for linked issue' });
  const prSub = subscribe(task, { events: ['pull_request'], note: 'wait for PR #1500 patrol/update' });

  assert.equal(recordEvent(store, {
    repositoryId: '101',
    key: 'bot-pr-patrol:1500:1',
    type: 'pull_request.patrol',
    source: 'control_plane',
    summary: '内部巡检：PR #1500',
    facts: { event: 'bot_pr_patrol', action: 'patrol', pr_number: 1500 },
    object: { type: 'pr', number: 1500 },
    options: [],
  }), 1);
  const patrolEvent = store.get("SELECT * FROM dispatch_events WHERE event_key='bot-pr-patrol:1500:1'");
  assert.equal(resolveSubscriptionsByManager(store, 't-multi-sub', patrolEvent, '巡检信号命中 PR 订阅'), true);

  const afterPatrol = new Map(taskEventSubscriptionsDetail(store, 't-multi-sub').map(s => [s.id, s]));
  assert.equal(afterPatrol.get(prSub.id)?.state, 'matched', 'pull_request subscription must match pull_request.patrol');
  assert.equal(afterPatrol.get(prSub.id)?.wake_reason, 'manager_assigned');
  assert.equal(afterPatrol.get(issueSub.id)?.state, 'active', 'older unrelated issues subscription must remain active');

  // Also verify a GitHub issue_comment on a PR falls back to `dispatchEvent.type` (`pull_request`) when no `issue_comment` subscription exists,
  // and prefers `issue_comment` when both `issue_comment` and `pull_request` subscriptions are active.
  const prSub2 = subscribe(task, { events: ['pull_request'], note: 'wait for PR update' });
  const prCommentEvent = {
    id: 'ev-gh-pr-comment',
    repository_id: '101',
    type: 'pull_request.updated',
    source: 'github',
    summary: '更新：PR #1500',
    delivery_id: 'deliv-pr-comment-1',
    facts: JSON.stringify({ event: 'issue_comment', action: 'created' }),
  };
  assert.equal(resolveSubscriptionsByManager(store, 't-multi-sub', prCommentEvent, 'PR 评论命中 PR 订阅'), true);
  const afterPrComment = new Map(taskEventSubscriptionsDetail(store, 't-multi-sub').map(s => [s.id, s]));
  assert.equal(afterPrComment.get(prSub2.id)?.state, 'matched');
  assert.equal(afterPrComment.get(issueSub.id)?.state, 'active');

  const commentSub = subscribe(task, { events: ['issue_comment'], note: 'wait for specific comment' });
  const prSub3 = subscribe(task, { events: ['pull_request'], note: 'wait for PR event' });
  assert.equal(resolveSubscriptionsByManager(store, 't-multi-sub', prCommentEvent, 'PR 评论优先命中 issue_comment 订阅'), true);
  const afterCommentPrefer = new Map(taskEventSubscriptionsDetail(store, 't-multi-sub').map(s => [s.id, s]));
  assert.equal(afterCommentPrefer.get(commentSub.id)?.state, 'matched');
  assert.equal(afterCommentPrefer.get(prSub3.id)?.state, 'active');
});
