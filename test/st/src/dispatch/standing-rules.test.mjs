// #815: standing rules settle routine events without a model call; the Manager registers rules and people edit them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { configureDispatch, Dispatcher } from '../../../../dist/dispatch/worker.js';
import { queueWebhook } from '../../../../dist/review/queue.js';
import { builtinRules } from '../../../../dist/dispatch/rules.js';
import { readDispatchThread } from '../../../../dist/dispatch/store.js';
import { setGrant } from '../../../../dist/tasks/grants.js';
import { captureTaskConfiguration } from '../../../../dist/tasks/configuration.js';
import { executeTaskSubscriptionTool, taskEventSubscriptionsDetail } from '../../../../dist/tasks/event-subscriptions.js';
import { scriptedRoles, scriptedHarnesses } from '../../../fixtures/scripted-roles.mjs';

configureDispatch(null);

const alice = { type: 'User', login: 'alice', id: 5 }, head = 'a'.repeat(40);
const issue = { number: 5, state: 'open', title: 'Parser drops the last line', body: 'CRLF files lose their last line.', user: { id: 5, login: 'alice' }, labels: [] };
const pull = { number: 7, state: 'open', title: 'Fix the parser', body: 'Fixes #5', draft: false, user: { id: 5, login: 'alice' }, head: { sha: head, ref: 'fix' }, base: { ref: 'main' } };
const call = (name, args, id) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  // The Manager decides in process here; on the default Pi backend it needs a project computer (#1068).
  scriptedRoles(h.store, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const requests = [], state = { message: null };
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    const message = state.message ? state.message(body) : call('ignore_event', { reason: 'Manager 看过了' }, 'm' + requests.length);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 20, completion_tokens: 8 } }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
  const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Manager fixture', api_url: `http://127.0.0.1:${provider.address().port}/v1`, api_key: 'manager-fixture-key' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  const dispatcher = new Dispatcher(h.store), run = async () => { dispatcher.tick(); await dispatcher.idle(); };
  const last = () => h.store.get('SELECT * FROM dispatch_events ORDER BY created_at DESC,rowid DESC LIMIT 1');
  const manager = async () => (await admin('/api/repositories/101/manager')).value.manager;
  return { h, admin, requests, state, run, last, manager };
}

// #1256: where an event Manager turn runs follows its backend. The in-process driver decides without a project runtime;
// a backend that runs in the project computer waits for one, and no model is called meanwhile.
test('an event Manager on a project-computer backend waits for the project runtime; an in-process backend needs none', async t => {
  const f = await fixture(t);
  const mention = id => queueWebhook(f.h.store, '101', 'issue_comment', { action: 'created', issue, sender: { ...alice, login: 'maria', id: 9 }, comment: { id, body: '@bot please look', author_association: 'MEMBER' } }, 'mention-' + id);
  mention(41); await f.run();
  assert.deepEqual([f.last().decision, f.last().model, f.requests.length], ['ignore', 'Manager fixture', 1]);
  f.h.store.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify({ enabled: false, harnesses: { ...scriptedHarnesses(), manager: 'pi' } }), 'roles:101');
  mention(42); await f.run();
  const event = f.last();
  assert.deepEqual([event.state, JSON.parse(event.error).code, f.requests.length], ['pending', 'harness_environment_required', 1]);
});

test('with the built-in rules routine Issue and PR events are dispatched without a model call; the others reach the Manager', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.manager()).standing_rules, { revision: 0, source: 'builtin', rules: builtinRules });
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'opened'); await f.run();
  let event = f.last();
  assert.deepEqual([event.decision, event.model, JSON.parse(event.rule)], ['create', null, { id: 'issue-opened', revision: 0 }]);
  assert.equal(f.requests.length, 0, 'no model call');
  const review = f.h.store.get("SELECT * FROM tasks WHERE kind='task.request'"); assert.ok(review);
  assert.equal(JSON.parse(review.input).executor_role, 'reviewer');
  // An update joins the review while it still works on the Issue.
  const comment = (id, body) => queueWebhook(f.h.store, '101', 'issue_comment', { action: 'created', issue, sender: { ...alice, login: 'maria', id: 9 }, comment: { id, body, author_association: 'MEMBER' } }, 'comment-' + id);
  comment(31, 'The file was saved on Windows.'); await f.run();
  event = f.last(); assert.deepEqual([event.decision, JSON.parse(event.rule).id], ['continue', 'issue-update']); assert.equal(f.requests.length, 0);
  // Once that review has finished, whether an update needs another round is the Manager's call (a thank-you does not).
  f.h.store.run("UPDATE tasks SET status='succeeded' WHERE id=?", review.id);
  comment(32, 'Thanks!'); await f.run();
  event = f.last(); assert.equal(event.rule, null); assert.equal(f.requests.length, 1); assert.equal(event.model, 'Manager fixture');
  // A mention always reaches the Manager: it may ask for work no rule decides, development included.
  queueWebhook(f.h.store, '101', 'issue_comment', { action: 'created', issue, sender: { ...alice, login: 'maria', id: 9 }, comment: { id: 33, body: '@bot please develop this', author_association: 'MEMBER' } }, 'mention');
  await f.run(); assert.equal(f.last().rule, null); assert.equal(f.requests.length, 2);
  // A pull request is reviewed by rule, and a push joins that review.
  queueWebhook(f.h.store, '101', 'pull_request', { action: 'opened', pull_request: pull, sender: alice }, 'pr-opened'); await f.run();
  assert.equal(JSON.parse(f.last().rule).id, 'pull-request-opened');
  queueWebhook(f.h.store, '101', 'pull_request', { action: 'synchronize', before: head, pull_request: { ...pull, head: { sha: 'b'.repeat(40), ref: 'fix' } }, sender: alice }, 'pr-push'); await f.run();
  event = f.last(); assert.deepEqual([event.decision, JSON.parse(event.rule).id], ['continue', 'pull-request-push']);
  assert.equal(f.requests.length, 2, 'the pull request events needed no model call');
  // The dispatch record names the rule.
  assert.deepEqual((await f.admin('/api/repositories/101/dispatch/' + event.id)).value.event.rule, { id: 'pull-request-push', revision: 0 });
});

test('the Manager registers a rule and the next event like it follows the rule; the rule is a new Manager revision', async t => {
  const f = await fixture(t);
  const current = await f.manager();
  await f.admin('/api/repositories/101/manager', 'PUT', { expected_revision: current.prompt.revision, events: { 'issue.labels': ['question'] } });
  const before = (await f.manager()).prompt.revision;
  f.state.message = body => {
    const done = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    if (!done.length) {
      assert.ok(body.tools.some(tool => tool.function.name === 'register_rule'));
      return call('register_rule', { id: 'question-label', event: 'issue.labeled', action: 'continue_or_create', work: 'review.issue', when: { labels_any: ['question'] }, reason: '常设规则：问题标签交给 Issue 检视。' }, 'r1');
    }
    assert.equal(done[0].saved, true, JSON.stringify(done[0])); assert.equal(done[0].revision, before + 1);
    return call('create_task', { work: ['review'], reason: '有人问了问题，检视回答' }, 'r2');
  };
  const labeled = delivery => queueWebhook(f.h.store, '101', 'issues', { action: 'labeled', label: { name: 'question' }, issue: { ...issue, labels: [{ name: 'question' }] }, sender: { ...alice } }, delivery);
  labeled('label-1'); await f.run();
  assert.equal(f.last().decision, 'create'); assert.equal(f.requests.length, 2);
  const saved = (await f.manager()).standing_rules;
  assert.equal(saved.source, 'saved'); assert.equal(saved.revision, before + 1);
  assert.deepEqual(saved.rules.at(-1), { id: 'question-label', event: 'issue.labeled', action: 'continue_or_create', role: 'reviewer', writes: ['review'], reason: '常设规则：问题标签交给 Issue 检视。', when: { labels_any: ['question'] } });
  assert.deepEqual(saved.rules.slice(0, builtinRules.length), builtinRules, 'registering starts from the rules in force');
  assert.ok(f.h.store.get("SELECT 1 FROM audit WHERE action='manager.rule' AND repository_id='101'"));
  f.state.message = () => assert.fail('the rule decides this one');
  labeled('label-2'); await f.run();
  assert.deepEqual([f.last().decision, JSON.parse(f.last().rule)], ['continue', { id: 'question-label', revision: before + 1 }]);
});

test('rules are checked and saved whole with the Manager revision; none sends every event to the Manager', async t => {
  const f = await fixture(t);
  const put = async rules => f.admin('/api/repositories/101/manager', 'PUT', { expected_revision: (await f.manager()).prompt.revision, standing_rules: rules });
  const base = { id: 'x', event: 'issue.opened', action: 'create', work: 'review.issue', reason: '检视' };
  for (const [rules, code] of [[[{ ...base, work: 'development.issue' }], 'standing_rule_development'], [[{ ...base, event: 'issue.closed' }], 'invalid_standing_rules'],
    [[base, base], 'invalid_standing_rules'], [[{ ...base, action: 'merge' }], 'invalid_standing_rules'], [[{ ...base, work: undefined }], 'invalid_standing_rules'], [[{ ...base, reason: ' ' }], 'invalid_standing_rules']]) {
    const response = await put(rules); assert.equal(response.status, 400, JSON.stringify(rules)); assert.equal(response.value.error, code);
  }
  assert.equal((await f.manager()).standing_rules.source, 'builtin');
  assert.equal((await put([])).status, 200);
  assert.deepEqual((await f.manager()).standing_rules.rules, []);
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'opened'); await f.run();
  assert.equal(f.last().rule, null); assert.equal(f.requests.length, 1);
  // A disabled rule is kept but does not apply.
  assert.equal((await put([{ ...base, id: 'off', enabled: false }])).status, 200);
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue: { ...issue, number: 6 }, sender: alice }, 'opened-6'); await f.run();
  assert.equal(f.last().rule, null); assert.equal(f.requests.length, 2);
});

test('continue_or_create creates the work when nothing can be continued; labels_none keeps a rule off labeled objects', async t => {
  const f = await fixture(t);
  // A push to a pull request no review covers: the built-in push rule reviews the new head.
  queueWebhook(f.h.store, '101', 'pull_request', { action: 'synchronize', before: head, pull_request: { ...pull, number: 8, head: { sha: 'c'.repeat(40), ref: 'fix' } }, sender: alice }, 'lone-push');
  await f.run();
  let event = f.last();
  assert.deepEqual([event.decision, JSON.parse(event.rule).id, f.requests.length], ['create', 'pull-request-push', 0]);
  assert.ok(f.h.store.get("SELECT 1 FROM tasks WHERE kind='task.request' AND object_number=8 AND head_sha=?", 'c'.repeat(40)));
  // A rule for Issues without `wontfix` (compared without case): such an Issue goes to the Manager, another is settled by it.
  const manager = await f.manager();
  assert.equal((await f.admin('/api/repositories/101/manager', 'PUT', { expected_revision: manager.prompt.revision, standing_rules: [{ id: 'issues', event: 'issue.opened',
    action: 'create', work: 'review.issue', when: { labels_none: ['wontfix'] }, reason: '常设规则：没有 wontfix 的新 Issue 交给检视。' }] })).status, 200);
  const revision = (await f.manager()).standing_rules.revision;
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue: { ...issue, number: 11, labels: [{ name: 'WontFix' }] }, sender: alice }, 'labeled-issue'); await f.run();
  event = f.last(); assert.equal(event.rule, null); assert.equal(f.requests.length, 1);
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue: { ...issue, number: 12 }, sender: alice }, 'plain-issue'); await f.run();
  event = f.last(); assert.deepEqual([event.decision, JSON.parse(event.rule)], ['create', { id: 'issues', revision }]); assert.equal(f.requests.length, 1);
});

test('standing rules never hijack PR/Issue events into another object\'s active event_subscriptions task, while Manager can still wake it cleanly (#1409)', async t => {
  const f = await fixture(t);
  await f.admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop', development_enabled: true });
  const now = '2026-11-27T06:00:00.000Z';
  const sha1314 = '1'.repeat(40), sha1445 = '4'.repeat(40), sha1446 = '6'.repeat(40), sha1448 = '8'.repeat(40);

  // Seed PR #1314 active waiting_event task holding an active event_subscriptions row (production repro #1409).
  f.h.store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,object_number,head_sha,attempt,created_at,updated_at)
     VALUES('t-1314','101','task.request','waiting_event','model','PR #1314 task waiting on event',?,1314,?,1,?,?)`,
    JSON.stringify({ generic: true, target: { type: 'pr', number: 1314, ref: sha1314 }, round: 1 }),
    sha1314,
    now,
    now,
  );
  setGrant(f.h.store, { id: 't-1314', repository_id: '101' }, ['pull_request'], 'role:manager', null);
  captureTaskConfiguration(f.h.store, 't-1314');
  const subRes = executeTaskSubscriptionTool(f.h.store, f.h.store.get("SELECT * FROM tasks WHERE id='t-1314'"), 'subscribe_event', {
    events: ['workflow_run'],
    workflow: 'ci.yml',
    note: 'Waiting for CI workflow on PR #1314',
    timeout_seconds: 1800,
    release_slot: false,
  });
  assert.equal(subRes.subscribed, true);

  // Seed PR #1445 with only a finished review (same condition as openJiuwen-ai/sciencediscovery#1445).
  f.h.store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,object_number,head_sha,attempt,created_at,updated_at)
     VALUES('rev-1445','101','task.request','succeeded','done','PR #1445 finished review',?,1445,?,1,?,?)`,
    JSON.stringify({ generic: true, target: { type: 'pr', number: 1445, ref: sha1445 }, round: 1 }),
    sha1445,
    now,
    now,
  );
  setGrant(f.h.store, { id: 'rev-1445', repository_id: '101' }, ['review'], 'role:manager', null);
  captureTaskConfiguration(f.h.store, 'rev-1445');

  // 1) PR #1445 receives pull_request_review (pull_request.updated): built-in pull-request-update (continue_active)
  //    must NOT hijack t-1314; the event reaches PR #1445's Object Manager with explicit match/object tags in work.continue.
  let managerSeenInput = null;
  f.state.message = body => {
    managerSeenInput = JSON.parse(body.messages[1].content);
    return call('ignore_event', { reason: 'PR #1445 评论无需操作，且与 PR #1314 订阅无关' }, 'm-1445');
  };
  const pr1445 = { ...pull, number: 1445, title: 'PR #1445', head: { sha: sha1445, ref: 'feat/1445' } };
  queueWebhook(f.h.store, '101', 'pull_request_review', {
    action: 'submitted',
    sender: { type: 'User', login: 'zhaozhaozz', id: 22 },
    pull_request: pr1445,
    review: { id: 8801, state: 'commented', body: '请核对边界条件', author_association: 'MEMBER', user: { id: 22, login: 'zhaozhaozz' } },
  }, 'repro-1445-review');
  await f.run();
  let ev = f.last();
  assert.equal(ev.rule, null, 'pull-request-update rule must not fire across PRs');
  assert.equal(ev.decision, 'ignore');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    managerSeenInput.work.continue.map(c => ({ task_id: c.task_id, match: c.match, object_type: c.object_type, object_number: c.object_number })),
    [
      { task_id: 'rev-1445', match: 'object', object_type: 'pr', object_number: 1445 },
      { task_id: 't-1314', match: 'subscription', object_type: 'pr', object_number: 1314 },
    ],
  );
  assert.equal(managerSeenInput.pending_subscriptions?.length, 1);
  assert.equal(f.h.store.get("SELECT status FROM tasks WHERE id='t-1314'").status, 'waiting_event');
  assert.equal(f.h.store.get("SELECT count(*) AS n FROM review_updates WHERE task_id='t-1314'").n, 0);

  // 2) PR #1446 (no tasks) receives pull_request.synchronize: built-in pull-request-push (continue_or_create)
  //    must NOT hijack t-1314 and must create a fresh reviewer task for PR #1446 with zero model calls.
  const pr1446 = { ...pull, number: 1446, title: 'PR #1446', head: { sha: sha1446, ref: 'feat/1446' } };
  queueWebhook(f.h.store, '101', 'pull_request', {
    action: 'synchronize',
    before: head,
    pull_request: pr1446,
    sender: alice,
  }, 'repro-1446-push');
  await f.run();
  ev = f.last();
  assert.deepEqual([ev.decision, JSON.parse(ev.rule).id, f.requests.length], ['create', 'pull-request-push', 1]);
  assert.ok(f.h.store.get("SELECT 1 FROM tasks WHERE object_number=1446 AND head_sha=?", sha1446));
  assert.equal(f.h.store.get("SELECT status FROM tasks WHERE id='t-1314'").status, 'waiting_event');

  // 3) Issue #1447 (no active tasks) receives issue.updated: built-in issue-update (continue_active)
  //    must NOT hijack t-1314; the event reaches Issue #1447's Object Manager.
  f.state.message = () => call('ignore_event', { reason: 'Issue #1447 评论无需处理' }, 'm-1447');
  queueWebhook(f.h.store, '101', 'issue_comment', {
    action: 'created',
    sender: { type: 'User', login: 'zhaozhaozz', id: 22 },
    issue: { ...issue, number: 1447, title: 'Issue #1447' },
    comment: { id: 8802, body: '补充复现步骤', author_association: 'MEMBER', user: { id: 22, login: 'zhaozhaozz' } },
  }, 'repro-1447-comment');
  await f.run();
  ev = f.last();
  assert.equal(ev.rule, null);
  assert.equal(ev.decision, 'ignore');
  assert.equal(f.requests.length, 2);
  assert.equal(f.h.store.get("SELECT status FROM tasks WHERE id='t-1314'").status, 'waiting_event');

  // 4) Positive path: an ignore standing rule still defers to Object Manager while active subscriptions exist,
  //    and Object Manager can explicitly continue_task('t-1314') from pending_subscriptions without contaminating t-1314.
  const mgr = await f.manager();
  const savedRules = await f.admin('/api/repositories/101/manager', 'PUT', {
    expected_revision: mgr.prompt.revision,
    standing_rules: [
      ...builtinRules,
      { id: 'ignore-labeled', event: 'pull_request.labeled', action: 'ignore', reason: '常设规则：默认忽略标签事件。' },
    ],
  });
  assert.equal(savedRules.status, 200);
  await f.admin('/api/repositories/101/manager', 'PUT', {
    expected_revision: (await f.manager()).prompt.revision,
    events: { 'pull_request.labels': ['ci-ready'] },
  });

  f.state.message = body => {
    const payload = JSON.parse(body.messages[1].content);
    const sub = payload.pending_subscriptions.find(s => s.task_id === 't-1314');
    assert.ok(sub, 'Manager receives pending_subscriptions even when an ignore standing rule matched');
    const cont = payload.work.continue.find(c => c.task_id === 't-1314');
    assert.equal(cont?.match, 'subscription');
    return call('continue_task', { task_id: 't-1314', reason: '标签信号命中 PR #1314 订阅，唤醒任务核查' }, 'm-wake-1314');
  };
  const pr1448 = { ...pull, number: 1448, title: 'PR #1448', head: { sha: sha1448, ref: 'feat/1448' }, labels: [{ name: 'ci-ready' }] };
  queueWebhook(f.h.store, '101', 'pull_request', {
    action: 'labeled',
    label: { name: 'ci-ready' },
    pull_request: pr1448,
    sender: alice,
  }, 'repro-1448-labeled');
  await f.run();
  ev = f.last();
  assert.equal(ev.rule, null);
  assert.equal(ev.decision, 'continue');
  assert.equal(f.requests.length, 3);

  const woken1314 = f.h.store.get("SELECT * FROM tasks WHERE id='t-1314'");
  assert.equal(woken1314.status, 'queued');
  assert.equal(woken1314.head_sha, sha1314);
  const wokenInput = JSON.parse(woken1314.input);
  assert.deepEqual(wokenInput.target, { type: 'pr', number: 1314, ref: sha1314 });
  assert.equal(wokenInput.move_to_sha, undefined);
  assert.equal(wokenInput.merged_updates, undefined);
  assert.equal(wokenInput.event_wakeups?.length, 1);
  assert.equal(wokenInput.event_wakeups[0].wake_reason, 'manager_assigned');
  assert.equal(taskEventSubscriptionsDetail(f.h.store, 't-1314')[0].state, 'matched');
  assert.equal(f.h.store.get("SELECT count(*) AS n FROM review_updates WHERE task_id='t-1314'").n, 0);
  assert.equal(readDispatchThread(f.h.store, ev.thread_key, '101').active_task_id, null);
});
