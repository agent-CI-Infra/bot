import {TaskError} from '../../../../dist/agent/common.js';
import {registerDispatchHook} from '../../../../dist/dispatch/store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { configureDispatch, Dispatcher } from '../../../../dist/dispatch/worker.js';
import { queueWebhook, enqueue } from '../../../../dist/review/queue.js';
import { taskPermissions } from '../../../../dist/tasks/configuration.js';
import { roleConfiguration, saveConfiguration } from '../../../../dist/roles/definition.js';
import { managerDecision } from '../../../../dist/dispatch/manager.js';
import { recordEvent, checkDecision, dispatchContext, applyDecision } from '../../../../dist/dispatch/store.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { alice, issue, head, tasks, events, decisionCall, fixture, toolCall } from './dispatch-fixture.mjs';

// These tests ask the Manager for real: events wait for its model call instead of the rule decider other tests use.
configureDispatch(null);

test('event dispatch reads the editable Manager role and honors permission revocation before applying a decision', async t => {
  const f = await fixture(t), save = values => saveConfiguration(f.h.store, '101', { expected_revision: roleConfiguration(f.h.store, '101').revision, enabled: true, roles: [{ role_id: 'manager', ...values }] }, 'fixture');
  save({ persona_prompt: 'My complete event and task coordination instructions.' });
  f.state.decide = () => {
    save({ permissions: { delegation: 'deny' } });
    return { decision: 'create', option_ids: [JSON.parse(f.requests[0].messages[1].content).work.create[0].id], reason: '这条已被收回权限的决策不能落地' };
  };
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'revoked-manager');
  await f.run();
  assert.ok(f.requests[0].messages[0].content.includes('My complete event and task coordination instructions.'));
  assert.ok(!f.requests[0].messages[0].content.includes('Coordinate only.'));
  // #710: a replaced persona keeps the base rule, and the dispatch tools text limits writes on other people's objects.
  assert.ok(f.requests[0].messages[0].content.includes('an explicit request from its author or a maintainer in its body or comments is valid'));
  assert.ok(f.requests[0].messages[0].content.includes('For other metadata changes follow the authorized request and cite its source'));
  assert.equal(events(f.h)[0].state, 'pending');
  assert.equal(JSON.parse(events(f.h)[0].error).code, 'task_delegation_forbidden');
  assert.equal(tasks(f.h).length, 0);
  f.h.store.run('UPDATE dispatch_events SET next_run_at=0');
  await f.run();
  assert.equal(f.requests.length, 2, 'the Manager may still decide an event, but cannot assign another role');
  assert.equal(tasks(f.h).length,0);
});

test('an event reaches the Manager once; its decision creates the task with the reason, and deciding again never duplicates it', async t => {
  const f = await fixture(t);
  f.state.decide = input => ({ decision: 'create', option_ids: [input.options.create.find(o => o.work === 'review.issue').id], reason: '新 Issue 需要检视',
    brief: { goal: '确认 CRLF 文件的问题', criteria: ['回复结论'] } });
  assert.equal(queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'opened-1'), 1);
  // The same Issue opening again (a redelivery under another id) is the same event.
  assert.equal(queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'opened-2'), 0);
  assert.equal(tasks(f.h).length, 0, 'nothing runs before the Manager decides');
  await f.run();
  const [task] = tasks(f.h), [event] = events(f.h);
  assert.equal(task.kind, 'task.request'); assert.equal(task.object_number, 5);
  assert.equal(JSON.parse(task.input).executor_role, 'reviewer');
  assert.deepEqual(JSON.parse(task.input).manager, { event_id: event.id, reason: '新 Issue 需要检视', brief: { goal: '确认 CRLF 文件的问题', criteria: ['回复结论'] }, writes: ['review'] });
  assert.equal(event.state, 'decided'); assert.equal(event.decision, 'create'); assert.equal(event.reason, '新 Issue 需要检视'); assert.equal(event.model, 'Manager fixture');
  assert.deepEqual(f.h.store.all('SELECT relation FROM task_events WHERE task_id=?', task.id).map(r => r.relation), ['created']);
  assert.ok(f.h.store.all('SELECT content FROM task_logs WHERE task_id=?', task.id).some(r => JSON.parse(r.content).type === 'dispatch'));
  // One bounded call: the fixed frame, the project's dispatch section and the offered options with their writes.
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].messages[0].content, /project Manager/); assert.match(f.requests[0].messages[0].content, /# Event dispatch/);
  const input = JSON.parse(f.requests[0].messages[1].content);
  assert.equal(input.event.type, 'issue.opened'); assert.equal(input.event.facts.object.title, issue.title);
  assert.deepEqual(input.work.create.find(o => o.work === 'review.issue').writes, ['review']);
  assert.ok(!JSON.stringify(input).includes('"default"'), 'the Manager is never told what the old rules would do');
  // A restart that lost the decided state decides again: the task's own key refuses a second task.
  f.h.store.run("UPDATE dispatch_events SET state='dispatching',lease='lost',lease_until=0");
  const restarted = new Dispatcher(f.h.store); restarted.start(); await restarted.idle(); await restarted.close();
  assert.equal(tasks(f.h).length, 1); assert.equal(f.requests.length, 2);
  assert.deepEqual(JSON.parse(events(f.h)[0].result).declined, ['review']);
  // The task detail shows where it came from.
  const detail = await f.admin('/api/tasks/' + task.id + '/dispatch');
  assert.equal(detail.value.dispatch[0].reason, '新 Issue 需要检视'); assert.equal(detail.value.dispatch[0].relation, 'created');
});

test('dispatch preserves a long goal and all twelve long criteria in the task contract', async t => {
  const f = await fixture(t), brief = { goal: 'Complete goal: ' + 'g'.repeat(2200), criteria: Array.from({ length: 12 }, (_, i) => `Criterion ${i + 1}: ` + 'c'.repeat(600)) };
  assert.equal(recordEvent(f.h.store, { repositoryId: '101', key: 'complete-brief', type: 'schedule.due', source: 'schedule', summary: 'Scheduled verification', facts: {},
    options: [{ id: 'check', work: 'task.request', title: 'Check', spec: { type: 'request', key: 'complete-brief', request: 'Verify the complete contract', principal: null } }] }), 1);
  const event = events(f.h)[0], context = dispatchContext(f.h.store, event), decision = { decision: 'create', option_ids: ['check'], reason: 'Preserve the full contract', brief };
  assert.deepEqual(checkDecision(f.h.store, context, decision).brief, brief);
  const { created } = applyDecision(f.h.store, event, decision, null);
  assert.equal(created.length, 1);
  const task = tasks(f.h)[0], contract = new TaskRecords(f.h.store).get(task.id).contract;
  assert.equal(contract.goal, brief.goal); assert.deepEqual(contract.criteria, brief.criteria);
  assert.deepEqual(JSON.parse(task.input).manager.brief, brief);
  assert.deepEqual(JSON.parse(events(f.h)[0].brief), brief);
});

test('invalid brief criteria are rejected instead of silently dropped and the Manager can correct them', async t => {
  const f = await fixture(t);
  f.state.decide = (input, round) => ({ decision: 'create', option_ids: [input.options.create.find(o => o.work === 'review.issue').id], reason: 'Check every supplied criterion',
    brief: { goal: 'Verify the file', criteria: round === 0 ? ['Keep this criterion', 7] : ['Keep this criterion', 'Inspect the last line'] } });
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'repair-brief');
  await f.run();
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].messages.find(m => m.role === 'tool').content, /dispatch_brief_invalid/);
  assert.deepEqual(JSON.parse(tasks(f.h)[0].input).manager.brief.criteria, ['Keep this criterion', 'Inspect the last line']);
  const context = dispatchContext(f.h.store, events(f.h)[0]);
  for (const criteria of ['not an array', ['valid', '   '], ['valid', null], {}]) {
    assert.throws(() => checkDecision(f.h.store, context, { decision: 'create', option_ids: [context.options[0].id], reason: 'Reject invalid criteria', brief: { goal: 'Verify', criteria } }), { code: 'dispatch_brief_invalid' });
  }
});

test('a later event on the same Issue continues the running review; ignore leaves only the reason', async t => {
  const f = await fixture(t);
  const review = enqueue(f.h.store, '101', 'review.issue', 5, null, { issue }, 'opened');
  const comment = (id, body, extra = {}) => ({ action: 'created', issue, sender: alice, comment: { id, body, author_association: 'MEMBER', html_url: 'https://github.example/c/' + id }, ...extra });
  f.state.decide = input => input.options.continue.length
    ? { decision: 'continue', option_ids: [input.options.continue[0].id], reason: '检视还没发布，补充进去' }
    : { decision: 'ignore', option_ids: [], reason: '不需要处理' };
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', comment(31, 'Also CR-only files.'), 'comment-31'), 1);
  await f.run();
  const continued = f.h.store.get('SELECT * FROM tasks WHERE id=?', review), input = JSON.parse(continued.input);
  assert.equal(tasks(f.h).length, 1);
  assert.equal(input.merged_updates.length, 1); assert.equal(input.merged_updates[0].reason, 'comment');
  assert.equal(f.h.store.get('SELECT count(*) n FROM review_updates WHERE task_id=?', review).n, 1);
  assert.deepEqual(f.h.store.all('SELECT relation FROM task_events WHERE task_id=?', review).map(r => r.relation), ['continued']);
  const offered = JSON.parse(f.requests[0].messages[1].content);
  assert.equal(offered.work.continue[0].task_id, review); assert.equal(offered.related_tasks[0].id, review);
  // Once the review has published, the next comment has nothing to continue: the Manager may decide it needs nothing.
  f.h.store.run("UPDATE tasks SET status='succeeded'");
  f.state.decide = () => ({ decision: 'ignore', option_ids: [], reason: '只是致谢，不需要检视' });
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', comment(32, 'Thanks!'), 'comment-32'), 1);
  await f.run();
  assert.equal(tasks(f.h).length, 1);
  const list = await f.admin('/api/repositories/101/dispatch');
  assert.deepEqual(list.value.events.map(e => [e.type, e.decision, e.reason]), [['issue.updated', 'ignore', '只是致谢，不需要检视'], ['issue.updated', 'continue', '检视还没发布，补充进去']]);
});

test('the Manager\'s merge rule follows the project\'s auto-merge policy at each dispatch (#1170)', async t => {
  const f = await fixture(t);
  f.state.decide = () => ({ decision: 'ignore', option_ids: [], reason: 'fixture' });
  const system = () => f.requests.at(-1).messages[0].content;
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'merge-policy-1'); await f.run();
  assert.match(system(), /auto-merge policy is disallow/); assert.doesNotMatch(system(), /Never merge a pull request/);
  await f.admin('/api/repositories/101/policy', 'PATCH', { auto_merge_policy: 'allow_all' });
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue: { ...issue, number: 6 }, sender: alice }, 'merge-policy-2'); await f.run();
  assert.match(system(), /auto-merge policy is allow_all: you may merge any pull request, the bot's own included, when the repository's rules allow it/);
  assert.match(system(), /adds the pull request to the merge queue when its base branch requires one/);
});

test('filtered events never reach the Manager, and each keeps why', async t => {
  const f = await fixture(t);
  f.state.decide = () => assert.fail('the Manager must not be asked');
  const stranger = { type: 'User', login: 'mallory', id: 66 };
  // The bot's own comment, a stranger's comment and a draft pull request.
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', { action: 'created', issue, sender: { type: 'Bot', login: 'bot[bot]', id: 9 }, comment: { id: 41, body: '@bot done', author_association: 'NONE' } }, 'bot'), 0);
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', { action: 'created', issue, sender: stranger, comment: { id: 42, body: 'Please fix.', author_association: 'NONE' } }, 'stranger'), 0);
  assert.equal(queueWebhook(f.h.store, '101', 'pull_request', { action: 'opened', sender: alice, pull_request: { number: 7, state: 'open', draft: true, title: 'WIP', head: { sha: head }, user: { id: 5 } } }, 'draft'), 0);
  // Switched-off event kinds and work types are filtered the same way.
  await f.admin('/api/repositories/101/policy', 'PATCH', { review_issues: false });
  assert.equal(queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue: { ...issue, number: 6 }, sender: alice }, 'off'), 0);
  await f.admin('/api/repositories/101/policy', 'PATCH', { review_issues: true, review_enabled: false });
  assert.equal(queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue: { ...issue, number: 8 }, sender: alice }, 'review-off'), 0);
  await f.run();
  assert.equal(f.requests.length, 0); assert.equal(tasks(f.h).length, 0);
  // #815: each is a filtered record with its reason, so the console can say why nothing happened.
  assert.deepEqual(events(f.h).map(event => [event.state, event.decision, JSON.parse(event.result).filtered]),
    [['filtered', 'ignore', 'bot_own_content'], ['filtered', 'ignore', 'outsider_comment'], ['filtered', 'ignore', 'object_draft'], ['filtered', 'ignore', 'event_filter_off'], ['filtered', 'ignore', 'work_inactive']]);
  assert.match(events(f.h)[1].reason, /外人/); assert.match(events(f.h)[4].reason, /检视|上限/);
  // They are kept for 30 days, then pruned.
  const { pruneFiltered } = await import('../../../../dist/dispatch/store.js');
  assert.equal(pruneFiltered(f.h.store, Date.now() + 31 * 86400000), 5); assert.equal(events(f.h).length, 0);
});

test('a filtered event keeps the reason that actually stopped it', async t => {
  const f = await fixture(t);
  f.state.decide = () => assert.fail('the Manager must not be asked');
  const member = { type: 'User', login: 'maintainer', id: 7 }, draft = { number: 99, state: 'open', draft: true, title: 'WIP', head: { sha: head }, user: { id: 5 } };
  const prComment = (id, body) => ({ action: 'created', sender: member, issue: { number: 99, state: 'open', title: 'WIP', pull_request: {}, user: { id: 5 } },
    comment: { id, body, author_association: 'MEMBER' } });
  // A comment payload on a pull request carries no draft flag: the pull request the webhook read says it is a draft.
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', prComment(501, 'Please look'), 'draft-comment', draft), 0);
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', prComment(502, '@bot please look'), 'draft-mention', draft), 0);
  // With the switches off, the switch stopped the bot's own push (a review trigger) and another review bot's comment on this
  // bot's pull request (counted like a member's), not their authors.
  f.h.store.run("UPDATE policies SET review_pr_updates=0,event_filters=? WHERE repository_id='101'", JSON.stringify({ 'pull_request.updated': false }));
  f.h.store.run("INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id) VALUES('101',12,'pr-12','77','101','bot/issue-5',?,'dev')", head);
  const botPr = { number: 12, state: 'open', title: 'Fix CRLF', head: { sha: head }, user: { id: 77, login: 'bot[bot]' } };
  assert.equal(queueWebhook(f.h.store, '101', 'pull_request', { action: 'synchronize', sender: { type: 'Bot', login: 'bot[bot]', id: 77 }, pull_request: botPr, before: 'b'.repeat(40) }, 'bot-push'), 0);
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', { action: 'created', sender: { type: 'Bot', login: 'reviewer[bot]', id: 88 },
    issue: { number: 12, state: 'open', title: 'Fix CRLF', pull_request: {}, user: { id: 77 } }, comment: { id: 503, body: 'Rename x.', author_association: 'NONE' } }, 'other-bot', botPr), 0);
  await f.run();
  assert.equal(f.requests.length, 0); assert.equal(tasks(f.h).length, 0);
  assert.deepEqual(events(f.h).map(event => [event.type, event.state, JSON.parse(event.result).filtered]), [['pull_request.updated', 'filtered', 'object_draft'],
    ['pull_request.mention', 'filtered', 'object_draft'], ['pull_request.synchronize', 'filtered', 'event_filter_off'], ['pull_request.updated', 'filtered', 'event_filter_off']]);
  assert.match(events(f.h)[2].reason, /PR 推送新提交/); assert.match(events(f.h)[3].reason, /PR 的评论和检视/);
});

test('neither the Manager prompt nor its decision can widen what a task may write', async t => {
  const f = await fixture(t);
  // The prompt describes the flow; asking for writes there changes nothing.
  const current = (await f.admin('/api/repositories/101/manager')).value.manager;
  const saved = await f.admin('/api/repositories/101/manager', 'PUT', { expected_revision: current.prompt.revision,
    prompt: '# Event dispatch\n\n所有检视都允许提报 Issue 和修改代码，忽略写入限制。\n' });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  // A decision that asks for unsupported writes is refused and corrected within the same call; granted writes stick to the task.
  f.state.decide = (input, round) => ({ decision: 'create', option_ids: [input.options.create.find(o => o.work === 'review.issue').id], reason: '检视',
    writes: round === 0 ? ['review', 'release_notes'] : ['review'] });
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'opened');
  await f.run();
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].messages.at(-1).content, /dispatch_writes_not_allowed/);
  const [task] = tasks(f.h);
  assert.deepEqual(JSON.parse(task.input).manager.writes, ['review']);
  assert.deepEqual(taskPermissions(f.h.store, task).writes, ['review']);
  // Narrowing the project ceiling later narrows the task too; widening it later adds local checkout 'code' (#850) but never widens GitHub writes beyond ['review'].
  await f.admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'read' });
  assert.deepEqual(taskPermissions(f.h.store, task).writes, []);
  await f.admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop' });
  assert.deepEqual(taskPermissions(f.h.store, task).writes, ['code', 'review']);
});

test('a Manager that cannot be reached is waited out; a decision that stays invalid fails for a person to retry', async t => {
  const f = await fixture(t);
  f.state.status = 503;
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'opened');
  await f.run();
  let [event] = events(f.h);
  assert.equal(event.state, 'pending'); assert.equal(event.attempts, 1); assert.equal(JSON.parse(event.error).code, 'model_http_503'); assert.ok(event.next_run_at > Date.now());
  // An outage is not counted down: events wait for the model like tasks do.
  f.h.store.run('UPDATE dispatch_events SET attempts=20,next_run_at=0');
  await f.run();
  assert.equal(events(f.h)[0].state, 'pending');
  // Invalid decisions remain recoverable after the former eight-attempt cap.
  f.state.status = 200; f.state.decide = () => ({ decision: 'continue', option_ids: ['continue:nothing'], reason: '续接' });
  f.h.store.run('UPDATE dispatch_events SET attempts=7,next_run_at=0');
  await f.run();
  [event] = events(f.h);
  assert.equal(event.state, 'pending'); assert.equal(JSON.parse(event.error).code, 'dispatch_continuation_unavailable'); assert.equal(tasks(f.h).length, 0);
  f.state.decide = input => ({ decision: 'create', option_ids: [input.work.create[0].id], reason: '恢复后检视' });
  assert.equal((await f.admin(`/api/repositories/101/dispatch/${event.id}/retry`, 'POST', {})).status, 201);
  await f.run();
  assert.equal(events(f.h)[0].state, 'decided'); assert.equal(tasks(f.h).length, 1);
});

test('a failed dispatch reaches the Manager with recovery evidence even if rules or enabled work change', async t => {
  for (const change of ['matching rule', 'disabled work']) await t.test(change, async t => {
    const f = await fixture(t);
    f.state.decide = () => ({ decision: 'continue', option_ids: ['continue:nothing'], reason: '续接' });
    queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'spent');
    f.h.store.run('UPDATE dispatch_events SET attempts=7');
    await f.run();
    assert.equal(events(f.h)[0].state, 'pending', 'the failed eighth attempt remains recoverable');
    // Configuration changes must not hide the retained failure evidence from the Manager.
    if (change === 'matching rule') {
      const manager = (await f.admin('/api/repositories/101/manager')).value.manager;
      assert.equal((await f.admin('/api/repositories/101/manager', 'PUT', { expected_revision: manager.prompt.revision,
        standing_rules: [{ id: 'new-issues', event: 'issue.opened', action: 'create', work: 'review.issue', reason: '检视新 Issue' }] })).status, 200);
    } else {
      assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { review_enabled: false })).status, 200);
      const context = dispatchContext(f.h.store, events(f.h)[0]);
      assert.deepEqual([context.options.length, context.continuations.length], [0, 0]);
    }
    const asked = f.requests.length;
    f.state.decide = () => ({ decision: 'ignore', option_ids: [], reason: '已回应分派失败' });
    f.h.store.run('UPDATE dispatch_events SET next_run_at=0');
    await f.run();
    assert.equal(f.requests.length, asked + 1, 'the Manager gets the answer round');
    assert.equal(JSON.parse(f.requests[asked].messages[1].content).recovery.failures[0].attempt, 8);
    assert.deepEqual([events(f.h)[0].state, events(f.h)[0].decision, events(f.h)[0].rule, tasks(f.h).length], ['decided', 'ignore', null, 0]);
  });
});

test('events of one object are decided one at a time, so updates that arrive together join one review', async t => {
  const f = await fixture(t);
  f.state.decide = input => input.options.continue.length ? { decision: 'continue', option_ids: [input.options.continue[0].id], reason: '并入正在等的检视' }
    : { decision: 'create', option_ids: [input.options.create.find(o => o.work === 'review.issue').id], reason: '检视这次更新' };
  // A review with three inline comments arrives as several deliveries at once.
  for (const id of [51, 52, 53]) queueWebhook(f.h.store, '101', 'issue_comment', { action: 'created', issue, sender: alice, comment: { id, body: 'Note ' + id, author_association: 'MEMBER' } }, 'comment-' + id);
  for (let i = 0; i < 4; i++) await f.run();
  assert.deepEqual(events(f.h).map(e => e.decision), ['create', 'continue', 'continue']);
  assert.equal(tasks(f.h).length, 1); assert.equal(JSON.parse(tasks(f.h)[0].input).merged_updates.length, 2);
  // Closing the Issue ends what the Manager has not decided yet.
  f.state.decide = () => assert.fail('a closed object is not dispatched');
  queueWebhook(f.h.store, '101', 'issue_comment', { action: 'created', issue, sender: alice, comment: { id: 54, body: 'Late', author_association: 'MEMBER' } }, 'comment-54');
  queueWebhook(f.h.store, '101', 'issues', { action: 'closed', issue: { ...issue, state: 'closed' }, sender: alice }, 'closed');
  await f.run();
  assert.deepEqual([events(f.h).at(-1).decision, events(f.h).at(-1).reason], ['ignore', '对象已关闭或转为草稿，事件不再分派。']);
});

test('the Manager comments on and labels the event Issue before dispatching; it writes only there, and a retried dispatch repeats no write', async t => {
  const f = await fixture(t), github = { requests: [], comments: [], labels: [] };
  // The event's repository on a local GitHub: the bot account reads the repository and the Issue, and writes to it.
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://fixture').pathname, body = raw ? JSON.parse(raw) : null; github.requests.push(`${req.method} ${path}`);
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main' });
    if (path === '/repos/fixture/project-101/issues/5' && req.method === 'GET') return send({ ...issue, html_url: 'https://github.example/fixture/project-101/issues/5' });
    if (path === '/repos/fixture/project-101/issues/5/comments' && req.method === 'POST') { github.comments.push(body); return send({ id: 900 + github.comments.length, body: body.body, html_url: 'https://github.example/c/' + github.comments.length }, 201); }
    if (path === '/repos/fixture/project-101/issues/5/labels' && req.method === 'POST') { github.labels.push(body); return send(body.labels.map(name => ({ name }))); }
    send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const dispatcher = new Dispatcher(f.h.store, (store, context) => managerDecision(store, context, `http://127.0.0.1:${server.address().port}`));
  const run = async () => { dispatcher.tick(); await dispatcher.idle(); };
  const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  let attempt = 0;
  f.state.message = (body, input) => {
    const step = body.messages.filter(m => m.role === 'assistant').length;
    if (step === 0) return { role: 'assistant', content: null, tool_calls: [
      call('github_write', { method: 'POST', path: '/issues/5/comments', key: 'ask-author', body: { body: 'Thanks @alice: which file loses its last line?' } }, 'w1'),
      call('github_write', { method: 'POST', path: '/issues/5/labels', key: 'triage', body: { labels: ['needs-info'] } }, 'w2')] };
    if (step === 1) return { role: 'assistant', content: null, tool_calls: [
      call('github_write', { repository: 'fixture/other', method: 'POST', path: '/issues', key: 'elsewhere', body: { title: 'Elsewhere' } }, 'w3'),
      call('github_write', { method: 'POST', path: '/repos/fixture/other/issues', key: 'elsewhere-2', body: { title: 'Elsewhere' } }, 'w4')] };
    // The first attempt decides invalidly twice (an unknown work/role), so the event is dispatched again.
    const option = attempt === 0 ? 'invented' : input.options.create.find(o => o.work === 'review.issue').id;
    return { role: 'assistant', content: null, tool_calls: [call('create_task', { work: [option], reason: '已请作者补充信息，先检视' }, 'd' + step)] };
  };
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'manager-writes');
  await run();
  assert.equal(events(f.h)[0].state, 'pending'); assert.equal(tasks(f.h).length, 0);
  const first = f.requests.slice();
  // A normal agent turn: the Manager's own tools, then dispatch.
  assert.ok(['github_write', 'create_task', 'continue_task', 'ignore_event'].every(name => first[0].tools.some(tool => tool.function.name === name))); assert.equal(first[0].tool_choice, 'auto');
  const results = first[2].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.deepEqual(results.slice(0, 2).map(r => [r.html_url, r.status]), [['https://github.example/c/1', 201], [undefined, 200]]);
  assert.deepEqual(results[1].result, ['needs-info']);
  // No other repository: the tool takes no repository, and a path cannot name one.
  assert.deepEqual(results.slice(2).map(r => r.error), ['invalid_arguments', 'github_write_route_unsupported']);
  assert.equal(github.comments.length, 1); assert.match(github.comments[0].body, /^Thanks @alice: which file loses its last line\?\n\n<!-- dept-bot-write:[a-f0-9]{24} -->$/);
  assert.deepEqual(github.labels, [{ labels: ['needs-info'] }]);
  // Dispatched again: the earlier writes are listed, the same keys answer from the ledger and GitHub sees nothing new.
  attempt = 1; f.h.store.run('UPDATE dispatch_events SET next_run_at=0'); const writes = github.requests.filter(r => !r.startsWith('GET')).length;
  await run();
  const retried = f.requests.slice(first.length), made = JSON.parse(retried[0].messages[1].content).github;
  assert.equal(made.repository, 'fixture/project-101');
  assert.deepEqual(made.writes_made.map(w => [w.key, w.method, w.path, w.state]), [['ask-author', 'POST', '/issues/5/comments', 'sent'], ['triage', 'POST', '/issues/5/labels', 'sent']]);
  assert.ok(retried[1].messages.filter(m => m.role === 'tool').slice(0, 2).every(m => JSON.parse(m.content).replayed === true));
  assert.equal(github.requests.filter(r => !r.startsWith('GET')).length, writes);
  assert.equal(events(f.h)[0].state, 'decided'); assert.equal(tasks(f.h)[0].kind, 'task.request');
  // Every call is audited with who asked; the refused ones too.
  const ledger = f.h.store.all('SELECT * FROM github_writes ORDER BY rowid');
  assert.deepEqual(ledger.filter(row => row.state === 'sent').map(row => [row.key, row.status]), [['ask-author', 201], ['triage', 200]]);
  assert.ok(ledger.every(row => row.scope === 'dispatch:' + events(f.h)[0].id && JSON.parse(row.actor).role === 'manager' && row.repository_id === '101'));
  assert.equal(ledger.filter(row => row.state === 'refused').length, 2, 'the path naming another repository, once per attempt (a repository argument is invalid before any record)');
  assert.equal(f.h.store.get("SELECT count(*) n FROM audit WHERE user_id='role:manager' AND action='github.write.sent'").n, 2);
  // A Manager whose role only reads is not offered the tool.
  saveConfiguration(f.h.store, '101', { expected_revision: roleConfiguration(f.h.store, '101').revision, enabled: false, roles: [{ role_id: 'manager', permissions: { github_issues: 'read', github_pull_requests: 'read', github_contents: 'read', github_actions: 'read' } }] }, 'fixture');
  f.state.message = null; f.state.decide = () => ({ decision: 'ignore', option_ids: [], reason: '无需处理' });
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue: { ...issue, number: 6 }, sender: alice }, 'read-only-manager');
  await run();
  assert.ok(!f.requests.at(-1).tools.some(tool => tool.function.name === 'github_write'));
  assert.ok(f.requests.at(-1).tools.some(tool => tool.function.name === 'github_read'));
});

test('upgrading folds legacy work-type sections, task_models and standing rules into roles and Manager once (#1122)', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const mRev = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Reviewer override', api_url: 'http://127.0.0.1:9/v1', api_key: 'rev-key' })).value.model;
  await h.stop();
  const db = new DatabaseSync(h.database), now = new Date().toISOString();
  db.exec(`CREATE TABLE workflows(repository_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(repository_id,id))`);
  db.prepare('INSERT INTO workflows VALUES(?,?)').run('101', 'review.pr');
  db.prepare("DELETE FROM settings WHERE key='migration:1122:repo:101'").run();
  db.prepare('INSERT INTO manager_revisions VALUES(?,?,?,?,?,?,?,?)').run(
    '101', 1,
    '## 分派 `dispatch`\n\n# Event dispatch\n\nCustom dispatch note.\n\n## Issue 检视 `review.issue`\n\nReview issues briefly.\n\n## Issue 开发 `development`\n\nWrite a CRLF test first.\n\n## CI 观察 `release.observe`\n\nObserve the release run carefully.',
    JSON.stringify({ 'review.pr': { writes: ['reply', 'labels'] } }), '{}', 'console', null, now,
  );
  db.exec('CREATE TABLE IF NOT EXISTS manager_rules(repository_id TEXT NOT NULL,revision INTEGER NOT NULL,rules TEXT NOT NULL,PRIMARY KEY(repository_id,revision))');
  db.prepare('INSERT INTO manager_rules VALUES(?,?,?)').run(
    '101', 1, JSON.stringify([{ id: 'pr-open', event: 'pull_request.opened', action: 'create', work: 'review.pr', reason: '检视 PR' }]),
  );
  db.prepare('UPDATE policies SET work_settings=?,task_models=?,rule_overrides=? WHERE repository_id=?').run(
    JSON.stringify({ 'review.pr': { writes: ['reply'] } }),
    JSON.stringify({ 'review.pr': mRev.id }),
    JSON.stringify({ '.bot/rules/pr-review.md': 'Check diff anchors strictly.' }),
    '101',
  );
  db.close();
  await h.start();
  assert.equal(h.store.hasTable('workflows'), false);
  const roles = roleConfiguration(h.store, '101').roles;
  const reviewer = roles.find(r => r.role_id === 'reviewer'), dev = roles.find(r => r.role_id === 'dev');
  assert.match(reviewer.persona_prompt, /Review issues briefly\./);
  assert.match(reviewer.persona_prompt, /Check diff anchors strictly\./);
  assert.equal(reviewer.model_profile_ref?.model_id, mRev.id);
  assert.match(dev.persona_prompt, /Write a CRLF test first\./);
  const view = (await admin('/api/repositories/101/manager')).value.manager;
  assert.match(view.prompt.content, /Custom dispatch note\./);
  assert.match(view.prompt.content, /Observe the release run carefully\./);
  assert.equal(view.standing_rules.rules[0].role, 'reviewer');
  assert.deepEqual(view.standing_rules.rules[0].writes, ['review']);
  const policy = h.store.get("SELECT work_settings,task_models FROM policies WHERE repository_id='101'");
  assert.equal(policy.work_settings, '{}'); assert.equal(policy.task_models, '{}');
  const removed = await admin('/api/repositories/101/workflows');
  assert.equal(removed.status, 410); assert.equal(removed.value.error, 'workflows_removed');
  const revCount = h.store.get("SELECT count(*) n FROM manager_revisions WHERE repository_id='101'").n;
  await h.stop(); await h.start();
  assert.equal(h.store.get("SELECT count(*) n FROM manager_revisions WHERE repository_id='101'").n, revCount);
});

// #815: the Manager decides with create_task, continue_task or ignore_event; the control plane checks a creation when it is
// made, returns a refusal with its code and reason, and keeps it on the event.
const toolResults = body => body.messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });

test('work the project does not allow is shown with its reason; creating it is refused and kept, and the Manager chooses again', async t => {
  const f = await fixture(t);
  f.state.message = (body, input) => {
    const results = toolResults(body);
    if (!results.length) {
      // Development is blocked by default capability_ceiling = 'comment': listed with the reason, not hidden.
      assert.deepEqual(input.work.unavailable.map(work => [work.id, work.code]), [['development', 'capability_ceiling']]);
      assert.match(body.messages[0].content, /Restricted actions right now[\s\S]*development/);
      return toolCall('create_task', { work: ['development'], reason: '尝试直接开发', brief: { goal: 'Fix CRLF', criteria: ['Test CRLF'] } }, 'c1');
    }
    assert.equal(results[0].error, 'capability_ceiling'); assert.equal(results[0].created, false); assert.match(results[0].instruction, /Nothing was created/);
    return toolCall('create_task', { work: ['review'], reason: '上限不允许开发，改为检视' }, 'c2');
  };
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'refused-dev');
  await f.run();
  const event = events(f.h)[0];
  assert.equal(event.decision, 'create'); assert.equal(tasks(f.h).length, 1); assert.equal(tasks(f.h)[0].kind, 'task.request');
  assert.deepEqual(JSON.parse(event.refusals).map(r => [r.work, r.code, r.tool]), [['development.issue', 'capability_ceiling', 'create_task']]);
  // The dispatch detail shows the refusal.
  const detail = (await f.admin('/api/repositories/101/dispatch/' + event.id)).value;
  assert.equal(detail.event.refusals[0].code, 'capability_ceiling');
});

test('a development the object already has is refused with that task, and the Manager can answer the person and ignore the event', async t => {
  const f = await fixture(t);
  await f.admin('/api/repositories/101/policy', 'PATCH', { development_enabled: true });
  const now = new Date().toISOString();
  f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,object_number,created_at,updated_at) VALUES('dev-running','101','development.issue','running','dev','101:development.issue:5:update:old','{}',5,?,?)", now, now);
  let refusal = null;
  f.state.message = body => {
    const results = toolResults(body);
    if (!results.length) return toolCall('create_task', { work: ['development'], reason: '维护者加了开发标签', brief: { goal: 'Keep the last CRLF line.', criteria: ['A CRLF test'] } }, 'c1');
    refusal = results[0];
    return toolCall('ignore_event', { reason: '这个 Issue 已在开发中，不再新建' }, 'c2');
  };
  queueWebhook(f.h.store, '101', 'issues', { action: 'labeled', label: { name: 'bot-develop' }, sender: { ...alice, type: 'User' }, issue: { ...issue, labels: [{ name: 'bot-develop' }] } }, 'labeled-again');
  await f.run();
  assert.equal(refusal.error, 'development_active'); assert.equal(refusal.task_id, 'dev-running');
  const event = events(f.h).find(e => e.type === 'issue.labeled');
  assert.equal(event.decision, 'ignore'); assert.equal(tasks(f.h).length, 1);
  assert.deepEqual(JSON.parse(event.refusals).map(r => [r.code, r.task_id]), [['development_active', 'dev-running']]);
});

test('after three refusals the event is ignored with the refusals kept', async t => {
  const f = await fixture(t);
  f.state.message = () => toolCall('create_task', { work: ['development'], reason: '开发', brief: { goal: 'Fix CRLF', criteria: ['Test CRLF'] } }, 'c');
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'three-refusals');
  await f.run();
  const event = events(f.h)[0];
  assert.equal(f.requests.length, 3); assert.equal(event.state, 'decided'); assert.equal(event.decision, 'ignore'); assert.match(event.reason, /控制面拒绝/);
  assert.equal(JSON.parse(event.refusals).length, 3); assert.equal(tasks(f.h).length, 0);
});

test('dispatch survives more than eight invalid decisions, reports 3/6/9, and gives recovery evidence to the next Manager',async t=>{
 const f=await fixture(t);let declined=0;registerDispatchHook('retry-recovery-fixture',{created(){},declined(){declined++;}});
 f.state.decide=()=>({decision:'continue',option_ids:['continue:not-offered'],reason:'invalid fixture choice'});
 queueWebhook(f.h.store,'101','issues',{action:'opened',issue,sender:alice},'recovery-input');const event=events(f.h)[0];
 const options=JSON.parse(event.options);options[0].hook='retry-recovery-fixture';f.h.store.run('UPDATE dispatch_events SET options=? WHERE id=?',JSON.stringify(options),event.id);
 for(let i=1;i<=10;i++){
  f.h.store.run('UPDATE dispatch_events SET next_run_at=0 WHERE id=?',event.id);await f.run();
  const row=events(f.h)[0];assert.equal(row.state,'pending');assert.equal(row.attempts,i);assert.ok(row.next_run_at>Date.now());
 }
 assert.equal(declined,0,'a failed Manager call must not decline the owning work');assert.equal(tasks(f.h).length,0);
 const detail=(await f.admin('/api/repositories/101/dispatch/'+event.id)).value;
 assert.equal(detail.recovery.failures.length,8);assert.deepEqual(detail.recovery.reports.map(r=>r.attempt),[9,6,3]);assert.equal(detail.event.attempts,10);
 const older=(await f.admin('/api/repositories/101/dispatch/'+event.id+'?failure_before='+detail.recovery.next_before_attempt)).value;assert.deepEqual(older.recovery.failures.map(r=>r.attempt),[2,1]);assert.equal(older.recovery.next_before_attempt,null);assert.equal((await f.admin('/api/repositories/101/dispatch/'+event.id+'?failure_before=nope')).status,400);
 await f.dispatcher.close();const recovered=new Dispatcher(f.h.store);t.after(()=>recovered.close());
 f.state.decide=input=>{assert.equal(input.recovery.failures[0].attempt,10);assert.equal(input.recovery.failures[0].error.code,'dispatch_continuation_unavailable');return {decision:'ignore',option_ids:[],reason:'Manager chooses no work after reviewing current facts'};};
 f.h.store.run('UPDATE dispatch_events SET next_run_at=0 WHERE id=?',event.id);recovered.tick();await recovered.idle();
 assert.equal(events(f.h)[0].state,'decided');assert.equal(events(f.h)[0].decision,'ignore');assert.equal(declined,1,'only an actual Manager decision ends the owning work');
 assert.equal(f.h.store.get('SELECT count(*) n FROM dispatch_failures WHERE event_id=?',event.id).n,10);
});

test('explicit cancellation remains a terminal boundary rather than an automatic retry',async t=>{
 const f=await fixture(t);queueWebhook(f.h.store,'101','issues',{action:'opened',issue,sender:alice},'cancelled-dispatch');
 const dispatcher=new Dispatcher(f.h.store,async()=>{throw new TaskError('dispatch_cancelled','cancelled','Explicit stop');});t.after(()=>dispatcher.close());dispatcher.tick();await dispatcher.idle();
 const event=events(f.h)[0];assert.equal(event.state,'failed');assert.equal(event.attempts,1);assert.equal(JSON.parse(event.error).code,'dispatch_cancelled');
 f.h.store.run('UPDATE dispatch_events SET next_run_at=0');dispatcher.tick();await dispatcher.idle();assert.equal(events(f.h)[0].attempts,1);assert.equal(tasks(f.h).length,0);
 const retry=await f.admin('/api/repositories/101/dispatch/'+event.id+'/retry','POST',{});assert.equal(retry.status,409);assert.equal(events(f.h)[0].state,'failed');assert.equal(JSON.parse(events(f.h)[0].error).code,'dispatch_cancelled');assert.equal(f.h.store.get('SELECT count(*) n FROM dispatch_retries WHERE event_id=?',event.id).n,0);
 for(const error of [{code:'dispatch_cancelled'},{code:'operator_stopped',terminal:true}]){f.h.store.run('UPDATE dispatch_events SET error=? WHERE id=?',JSON.stringify(error),event.id);assert.equal((await f.admin('/api/repositories/101/dispatch/'+event.id+'/retry','POST',{})).status,409);assert.equal(events(f.h)[0].state,'failed');}
});

test('first dispatch context never claims that prior attempts failed',async t=>{
 const {dispatchRecovery}=await import('../../../../dist/dispatch/store.js'),f=await fixture(t);queueWebhook(f.h.store,'101','issues',{action:'opened',issue,sender:alice},'no-prior-fault');
 const event=events(f.h)[0];assert.equal(dispatchRecovery(f.h.store,'101',event.id),null);
});

test('retried historical answer-round event exposes legacy evidence through recovery without a last-chance prompt',async t=>{
 const f=await fixture(t);queueWebhook(f.h.store,'101','issues',{action:'opened',issue,sender:alice},'legacy-answer');const event=events(f.h)[0];
 f.h.store.run("UPDATE dispatch_events SET state='failed',answer_round=1,attempts=8,error=? WHERE id=?",JSON.stringify({code:'legacy_fault',detail:'original legacy failure'}),event.id);
 assert.equal((await f.admin('/api/repositories/101/dispatch/'+event.id+'/retry','POST',{})).status,201);
 f.state.decide=input=>{assert.equal(input.previous_failures,undefined);assert.equal(input.recovery.legacy_failure.error.code,'legacy_fault');assert.equal(input.recovery.legacy_failure.previous_attempts,8);return {decision:'ignore',option_ids:[],reason:'Manager chooses after inspecting historical evidence'};};
 await f.run();assert.equal(events(f.h)[0].state,'decided');assert.ok(!f.requests.at(-1).messages[0].content.includes('Deciding this event failed several times before'));
});

// #1123: 「你能干什么」 on GitHub is answered from the project's own Manager prompt; a mention carries no fixed capability
// projection from settings, which a customized prompt could contradict.
test('a mention reaches the Manager without a fixed capabilities projection', async t => {
  const f = await fixture(t);
  f.state.decide = () => ({ decision: 'ignore', reason: '已回答' });
  queueWebhook(f.h.store, '101', 'issue_comment', { action: 'created', issue, sender: alice,
    comment: { id: 77, body: '@bot 你能干什么？', author_association: 'CONTRIBUTOR', html_url: 'https://github.example/c/77', user: { login: 'alice' } } }, 'cap-mention');
  await f.run();
  const input = JSON.parse(f.requests.at(-1).messages[1].content);
  assert.equal(input.event.type, 'issue.mention');
  assert.equal(input.capabilities, undefined);
  assert.doesNotMatch(f.requests.at(-1).messages[0].content, /`capabilities` in the event/);
});
