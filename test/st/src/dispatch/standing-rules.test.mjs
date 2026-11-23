// #815: standing rules settle routine events without a model call; the Manager registers rules and people edit them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { configureDispatch, Dispatcher } from '../../../../dist/dispatch/worker.js';
import { queueWebhook } from '../../../../dist/review/queue.js';
import { builtinRules } from '../../../../dist/dispatch/rules.js';
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
