import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { harness, setup, account, repository } from './helpers.mjs';
import { configureDispatch, Dispatcher } from '../dist/dispatch/worker.js';
import { queueWebhook, enqueue } from '../dist/review/queue.js';
import { taskPermissions } from '../dist/tasks/configuration.js';
import { workPermissions } from '../dist/work/settings.js';
import { roleConfiguration, saveConfiguration } from '../dist/roles/definition.js';
import { managerDecision } from '../dist/dispatch/manager.js';
import { recordEvent, checkDecision, dispatchContext, applyDecision } from '../dist/dispatch/store.js';
import { TaskRecords } from '../dist/tasks/service.js';

// These tests ask the Manager for real: events wait for its model call instead of the rule decider other tests use.
configureDispatch(null);

const alice = { type: 'User', login: 'alice', id: 5 };
const issue = { number: 5, state: 'open', title: 'Parser drops the last line', body: 'CRLF files lose their last line.', user: { id: 5, login: 'alice' }, labels: [] };
const head = 'a'.repeat(40);
const tasks = h => h.store.all('SELECT * FROM tasks ORDER BY created_at,rowid');
const events = h => h.store.all('SELECT * FROM dispatch_events ORDER BY created_at,rowid');

// A project with a Manager model served by a local fixture; `state.decide(input, round)` answers each dispatch call, or
// `state.message(body)` gives the whole assistant message (for a Manager that uses other tools first).
async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const requests = [], state = { decide: null, status: 200 };
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    if (state.status !== 200) { res.writeHead(state.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture outage' } })); return; }
    const input = JSON.parse(body.messages[1].content), round = body.messages.filter(m => m.role === 'tool').length;
    const message = state.message ? state.message(body, input) : { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + round, type: 'function', function: { name: 'dispatch', arguments: JSON.stringify(state.decide(input, round)) } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 20, completion_tokens: 8 } }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
  const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Manager fixture', api_url: `http://127.0.0.1:${provider.address().port}/v1`, api_key: 'manager-fixture-key' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  const dispatcher = new Dispatcher(h.store);
  const run = async () => { dispatcher.tick(); await dispatcher.idle(); };
  return { h, admin, a, requests, state, dispatcher, run };
}

test('event dispatch reads the editable Manager role and honors permission revocation before applying a decision', async t => {
  const f = await fixture(t), save = values => saveConfiguration(f.h.store, '101', { expected_revision: roleConfiguration(f.h.store, '101').revision, enabled: true, roles: [{ role_id: 'manager', ...values }] }, 'fixture');
  save({ persona_prompt: 'My complete event and task coordination instructions.' });
  f.state.decide = () => {
    save({ permissions: { delegation: 'deny' } });
    return { decision: 'create', option_ids: [JSON.parse(f.requests[0].messages[1].content).options.create[0].id], reason: '这条已被收回权限的决策不能落地' };
  };
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'revoked-manager');
  await f.run();
  assert.ok(f.requests[0].messages[0].content.includes('My complete event and task coordination instructions.'));
  assert.ok(!f.requests[0].messages[0].content.includes('Coordinate only.'));
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
  assert.equal(task.kind, 'review.issue'); assert.equal(task.object_number, 5);
  assert.deepEqual(JSON.parse(task.input).manager, { event_id: event.id, reason: '新 Issue 需要检视', brief: { goal: '确认 CRLF 文件的问题', criteria: ['回复结论'] } });
  assert.equal(event.state, 'decided'); assert.equal(event.decision, 'create'); assert.equal(event.reason, '新 Issue 需要检视'); assert.equal(event.model, 'Manager fixture');
  assert.deepEqual(f.h.store.all('SELECT relation FROM task_events WHERE task_id=?', task.id).map(r => r.relation), ['created']);
  assert.ok(f.h.store.all('SELECT content FROM task_logs WHERE task_id=?', task.id).some(r => JSON.parse(r.content).type === 'dispatch'));
  // One bounded call: the fixed frame, the project's dispatch section and the offered options with their writes.
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].messages[0].content, /project Manager/); assert.match(f.requests[0].messages[0].content, /# Event dispatch/);
  const input = JSON.parse(f.requests[0].messages[1].content);
  assert.equal(input.event.type, 'issue.opened'); assert.equal(input.event.facts.object.title, issue.title);
  assert.deepEqual(input.options.create.find(o => o.work === 'review.issue').writes, ['reply', 'labels']);
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
  assert.equal(offered.options.continue[0].task_id, review); assert.equal(offered.related_tasks[0].id, review);
  // Once the review has published, the next comment has nothing to continue: the Manager may decide it needs nothing.
  f.h.store.run("UPDATE tasks SET status='succeeded'");
  f.state.decide = () => ({ decision: 'ignore', option_ids: [], reason: '只是致谢，不需要检视' });
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', comment(32, 'Thanks!'), 'comment-32'), 1);
  await f.run();
  assert.equal(tasks(f.h).length, 1);
  const list = await f.admin('/api/repositories/101/dispatch');
  assert.deepEqual(list.value.events.map(e => [e.type, e.decision, e.reason]), [['issue.updated', 'ignore', '只是致谢，不需要检视'], ['issue.updated', 'continue', '检视还没发布，补充进去']]);
});

test('a person\'s development label always reaches the Manager: it answers with a review, or develops to its own brief', async t => {
  const f = await fixture(t);
  await f.admin('/api/repositories/101/policy', 'PATCH', { development_enabled: true });
  // The published review left the start to a person: no request sentence, a claim in the Issue text.
  const result = { summary: 'The Issue reserves the fix for its author; a maintainer must decide.', requires_code_change: true, issue_requests_code: false,
    clarification_required: true, implementation_goal: '', request_quote: '', findings: [] }, now = new Date().toISOString();
  f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,result,object_number,created_at,updated_at) VALUES('rv','101','review.issue','succeeded','r','101:review.issue:5:opened','{}',?,5,?,?)", JSON.stringify(result), now, now);
  const labeled = { ...issue, labels: [{ name: 'bot-develop' }], assignees: [] }, label = delivery => queueWebhook(f.h.store, '101', 'issues', { action: 'labeled', label: { name: 'bot-develop' }, issue: labeled, sender: { ...alice, login: 'maintainer' } }, delivery);
  // Development does not fit yet: the Manager answers the label with a review instead of staying silent.
  f.state.decide = input => ({ decision: 'create', option_ids: ['review'], reason: '还缺维护者对实现范围的决定，先回复',
    brief: { goal: 'Answer the development label: say why development does not start and what a person can do.', criteria: ['Names what is missing'] } });
  assert.equal(label('label-1'), 1); await f.run();
  const offered = JSON.parse(f.requests[0].messages[1].content);
  assert.deepEqual(offered.options.create.map(o => o.work), ['development.issue', 'review.issue']);
  assert.deepEqual([offered.event.facts.development.labeled_by, offered.event.facts.development.review.clarification_required, offered.event.facts.development.review.quote_in_issue],
    ['maintainer', true, false]);
  assert.match(f.requests[0].messages[0].content, /## The development label/);
  const [answer] = tasks(f.h).filter(task => task.kind === 'review.issue' && task.id !== 'rv'), answerInput = JSON.parse(answer.input);
  assert.equal(answerInput.trigger.reason, 'labeled'); assert.match(answerInput.manager.brief.goal, /^Answer the development label/);
  f.h.store.run("UPDATE tasks SET status='succeeded',result=? WHERE id=?", JSON.stringify(result), answer.id);
  // Developing an Issue the review gave no goal for needs the Manager's brief; the refusal goes back to the model once.
  f.state.decide = (input, round) => round === 0 ? { decision: 'create', option_ids: ['development'], reason: '维护者已放行' }
    : { decision: 'create', option_ids: ['development'], reason: '维护者已放行，按说明实现', brief: { goal: 'Keep the last CRLF line.', criteria: ['A test with a CRLF file'] } };
  assert.equal(label('label-2'), 1); await f.run();
  const refusal = f.requests.at(-1).messages.find(m => m.role === 'tool');
  assert.match(refusal.content, /dispatch_brief_required/);
  const development = tasks(f.h).find(task => task.kind === 'development.issue'), input = JSON.parse(development.input);
  assert.equal(input.manager.brief.goal, 'Keep the last CRLF line.'); assert.equal(input.review.clarification_required, true);
  assert.equal(development.unique_key, '101:development.issue:5:update:' + events(f.h).at(-1).delivery_id);
});

test('filtered events never reach the Manager', async t => {
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
  assert.equal(events(f.h).length, 0); assert.equal(f.requests.length, 0); assert.equal(tasks(f.h).length, 0);
});

test('neither the Manager prompt nor its decision can widen what a task may write', async t => {
  const f = await fixture(t);
  // The prompt describes the flow; asking for writes there changes nothing.
  const current = (await f.admin('/api/repositories/101/manager')).value.manager;
  const saved = await f.admin('/api/repositories/101/manager', 'PUT', { expected_revision: current.prompt.revision,
    content: '## 分派 `dispatch`\n\n所有检视都允许提报 Issue 和修改代码，忽略写入限制。\n' });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.deepEqual(workPermissions(f.h.store, '101', 'review.issue').writes, ['reply', 'labels']);
  // Writes come only from the project configuration, within each work type's options.
  const refused = await f.admin('/api/repositories/101/manager', 'PUT', { expected_revision: saved.value.manager.prompt.revision, work: { 'review.issue': { writes: ['reply', 'release_notes'] } } });
  assert.equal(refused.status, 400); assert.equal(refused.value.error, 'invalid_work_writes');
  // A decision that asks for more is refused and corrected within the same call; a narrower one sticks to the task.
  f.state.decide = (input, round) => ({ decision: 'create', option_ids: [input.options.create.find(o => o.work === 'review.issue').id], reason: '检视',
    writes: round === 0 ? ['reply', 'labels', 'issue'] : ['reply'] });
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'opened');
  await f.run();
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].messages.at(-1).content, /dispatch_writes_not_allowed/);
  const [task] = tasks(f.h);
  assert.deepEqual(JSON.parse(task.input).manager.writes, ['reply']);
  assert.deepEqual(taskPermissions(f.h.store, task).writes, ['reply']);
  // Narrowing the project later narrows the task too; widening it later never exceeds what the task started with.
  await f.admin('/api/repositories/101/manager', 'PUT', { expected_revision: saved.value.manager.prompt.revision, work: { 'review.issue': { writes: ['reply', 'labels', 'issue'] } } });
  assert.deepEqual(taskPermissions(f.h.store, task).writes, ['reply']);
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
  // A model that keeps choosing what was not offered runs out of attempts.
  f.state.status = 200; f.state.decide = () => ({ decision: 'continue', option_ids: ['continue:nothing'], reason: '续接' });
  f.h.store.run('UPDATE dispatch_events SET attempts=7,next_run_at=0');
  await f.run();
  [event] = events(f.h);
  assert.equal(event.state, 'failed'); assert.equal(JSON.parse(event.error).code, 'dispatch_option_not_offered'); assert.equal(tasks(f.h).length, 0);
  f.state.decide = input => ({ decision: 'create', option_ids: [input.options.create[0].id], reason: '恢复后检视' });
  assert.equal((await f.admin(`/api/repositories/101/dispatch/${event.id}/retry`, 'POST', {})).status, 201);
  await f.run();
  assert.equal(events(f.h)[0].state, 'decided'); assert.equal(tasks(f.h).length, 1);
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
    // The first attempt decides invalidly twice (an option that was never offered), so the event is dispatched again.
    const option = attempt === 0 ? 'invented' : input.options.create.find(o => o.work === 'review.issue').id;
    return { role: 'assistant', content: null, tool_calls: [call('dispatch', { decision: 'create', option_ids: [option], reason: '已请作者补充信息，先检视' }, 'd' + step)] };
  };
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'manager-writes');
  await run();
  assert.equal(events(f.h)[0].state, 'pending'); assert.equal(tasks(f.h).length, 0);
  const first = f.requests.slice();
  // A normal agent turn: the Manager's own tools, then dispatch.
  assert.ok(['github_write', 'dispatch'].every(name => first[0].tools.some(tool => tool.function.name === name))); assert.equal(first[0].tool_choice, 'auto');
  const results = first[2].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.deepEqual(results.slice(0, 2).map(r => [r.html_url, r.status]), [['https://github.example/c/1', 201], [undefined, 200]]);
  assert.deepEqual(results[1].result, ['needs-info']);
  // No other repository: the tool takes no repository, and a path cannot name one.
  assert.deepEqual(results.slice(2).map(r => r.error), ['invalid_arguments', 'github_write_route_unsupported']);
  assert.equal(github.comments.length, 1); assert.match(github.comments[0].body, /^Thanks &#64;alice: which file loses its last line\?\n\n<!-- dept-bot-write:[a-f0-9]{24} -->$/);
  assert.deepEqual(github.labels, [{ labels: ['needs-info'] }]);
  // Dispatched again: the earlier writes are listed, the same keys answer from the ledger and GitHub sees nothing new.
  attempt = 1; f.h.store.run('UPDATE dispatch_events SET next_run_at=0'); const writes = github.requests.filter(r => !r.startsWith('GET')).length;
  await run();
  const retried = f.requests.slice(first.length), made = JSON.parse(retried[0].messages[1].content).github;
  assert.equal(made.repository, 'fixture/project-101');
  assert.deepEqual(made.writes_made.map(w => [w.key, w.method, w.path, w.state]), [['ask-author', 'POST', '/issues/5/comments', 'sent'], ['triage', 'POST', '/issues/5/labels', 'sent']]);
  assert.ok(retried[1].messages.filter(m => m.role === 'tool').slice(0, 2).every(m => JSON.parse(m.content).replayed === true));
  assert.equal(github.requests.filter(r => !r.startsWith('GET')).length, writes);
  assert.equal(events(f.h)[0].state, 'decided'); assert.equal(tasks(f.h)[0].kind, 'review.issue');
  // Every call is audited with who asked; the refused ones too.
  const ledger = f.h.store.all('SELECT * FROM github_writes ORDER BY rowid');
  assert.deepEqual(ledger.filter(row => row.state === 'sent').map(row => [row.key, row.status]), [['ask-author', 201], ['triage', 200]]);
  assert.ok(ledger.every(row => row.scope === 'dispatch:' + events(f.h)[0].id && JSON.parse(row.actor).role === 'manager' && row.repository_id === '101'));
  assert.equal(ledger.filter(row => row.state === 'refused').length, 2, 'the path naming another repository, once per attempt (a repository argument is invalid before any record)');
  assert.equal(f.h.store.get("SELECT count(*) n FROM audit WHERE user_id='role:manager' AND action='github.write.sent'").n, 2);
  // A Manager whose role only reads is not offered the tool.
  saveConfiguration(f.h.store, '101', { expected_revision: roleConfiguration(f.h.store, '101').revision, enabled: false, roles: [{ role_id: 'manager', permissions: { github_issues: 'read', github_pull_requests: 'read', github_contents: 'read' } }] }, 'fixture');
  f.state.message = null; f.state.decide = () => ({ decision: 'ignore', option_ids: [], reason: '无需处理' });
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue: { ...issue, number: 6 }, sender: alice }, 'read-only-manager');
  await run();
  assert.ok(!f.requests.at(-1).tools.some(tool => tool.function.name === 'github_write'));
  assert.ok(f.requests.at(-1).tools.some(tool => tool.function.name === 'github_read'));
});

test('upgrading moves workflows into the Manager and project configuration once, with a record', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await h.stop();
  // A database from before #207: a custom workflow, a PR review without push reviews and extra writes, console prompts.
  const db = new DatabaseSync(h.database), now = new Date().toISOString();
  db.exec(`CREATE TABLE workflows(repository_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,
    triggers TEXT NOT NULL DEFAULT '[]',prompt TEXT,permissions TEXT,model_id TEXT,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,trigger_list TEXT,PRIMARY KEY(repository_id,id))`);
  const insert = db.prepare('INSERT INTO workflows(repository_id,id,name,description,enabled,triggers,prompt,permissions,trigger_list,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('101', 'review.pr', '', '', 1, '[]', null, JSON.stringify({ writes: ['reply', 'labels', 'issue'] }), JSON.stringify([{ id: 'pull_request.opened' }, { id: 'comment.mention' }]), now, now);
  insert.run('101', 'custom.0123456789ab', 'Docs check', 'Checks documentation changes', 1, JSON.stringify([{ id: 'pull_request.labeled', label: 'docs' }]), 'Read the changed docs and reply.\n\n## 输出 `json`\n\nOne JSON object.', JSON.stringify({ writes: ['reply'] }), null, now, now);
  insert.run('101', 'release.observe', '', '', 1, '[]', 'Observe the release run carefully.', null, null, now, now);
  db.prepare("UPDATE policies SET rule_overrides=? WHERE repository_id='101'").run(JSON.stringify({ '.bot/rules/issue-review.md': 'Review issues briefly.' }));
  db.close();
  await h.start();
  assert.equal(h.store.hasTable('workflows'), false);
  const migration = h.store.get("SELECT * FROM manager_migrations WHERE repository_id='101'"), report = JSON.parse(migration.report), archive = JSON.parse(migration.archive);
  assert.equal(archive.workflows.length, 3); assert.equal(report.manager_revision, 1);
  assert.deepEqual(report.custom_workflows, [{ id: 'custom.0123456789ab', name: 'Docs check', enabled: true }]);
  const revision = h.store.get("SELECT * FROM manager_revisions WHERE repository_id='101' AND revision=1");
  assert.equal(revision.source, 'migration');
  for (const text of ['`dispatch`', '| PR 推送新提交 | 不运行 |', '`review.issue`', 'Review issues briefly.', '`release.observe`', 'Observe the release run carefully.', '`reply`', 'Docs check', 'Read the changed docs and reply.'])
    assert.ok(revision.content.includes(text), text);
  const policy = h.store.get("SELECT * FROM policies WHERE repository_id='101'");
  assert.equal(policy.review_pull_requests, 1); assert.equal(policy.review_pr_updates, 0); assert.equal(policy.review_pr_discussion, 0);
  assert.deepEqual(JSON.parse(policy.event_filters)['pull_request.labels'], ['docs']);
  assert.deepEqual(JSON.parse(policy.rule_overrides), { '.bot/rules/issue-review.md': 'Review issues briefly.' });
  const work = JSON.parse(policy.work_settings);
  // Filing an Issue is no longer a review write: it became github_write, governed by the role (#381).
  assert.deepEqual(work['review.pr'].writes, ['reply', 'labels']); assert.deepEqual(work.reply, { enabled: true, writes: ['reply'], events: ['pull_request.labeled'], version: 0 });
  // Each object work type is offered only on the events that used to start it.
  assert.deepEqual(work['review.pr'].events, ['pull_request.opened', 'pull_request.mention']);
  assert.deepEqual(work['review.issue'].events, ['issue.opened', 'issue.mention', 'issue.updated']);
  // A heading-like line in a migrated prompt stays text in its section, and the report says it was escaped.
  assert.ok(revision.content.includes('\\## 输出 `json`'));
  assert.deepEqual([...(await import('../dist/work/settings.js')).parseSections(revision.content).sections.keys()], ['dispatch', 'review.issue', 'release.observe', 'reply']);
  assert.ok(report.warnings.some(warning => warning.includes('Docs check')));
  const view = (await admin('/api/repositories/101/manager')).value.manager;
  assert.equal(view.migration.report.manager_revision, 1); assert.equal(view.work.find(w => w.id === 'reply').active, true);
  assert.equal(view.sections.find(s => s.id === 'review.issue').effective_source, 'console');
  const removed = await admin('/api/repositories/101/workflows');
  assert.equal(removed.status, 410); assert.equal(removed.value.error, 'workflows_removed');
  // Starting again does nothing more.
  await h.stop(); await h.start();
  assert.equal(h.store.get("SELECT count(*) n FROM manager_revisions WHERE repository_id='101'").n, 1);
});
