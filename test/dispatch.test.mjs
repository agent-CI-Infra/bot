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

// These tests ask the Manager for real: events wait for its model call instead of the rule decider other tests use.
configureDispatch(null);

const alice = { type: 'User', login: 'alice', id: 5 };
const issue = { number: 5, state: 'open', title: 'Parser drops the last line', body: 'CRLF files lose their last line.', user: { id: 5, login: 'alice' }, labels: [] };
const head = 'a'.repeat(40);
const tasks = h => h.store.all('SELECT * FROM tasks ORDER BY created_at,rowid');
const events = h => h.store.all('SELECT * FROM dispatch_events ORDER BY created_at,rowid');

// A project with a Manager model served by a local fixture; `state.decide(input, round)` answers each dispatch call.
async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const requests = [], state = { decide: null, status: 200 };
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    if (state.status !== 200) { res.writeHead(state.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture outage' } })); return; }
    const input = JSON.parse(body.messages[1].content), round = body.messages.filter(m => m.role === 'tool').length;
    const message = { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + round, type: 'function', function: { name: 'dispatch', arguments: JSON.stringify(state.decide(input, round)) } }] };
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
  assert.match(f.requests[0].messages[0].content, /project Manager/); assert.match(f.requests[0].messages[0].content, /`dispatch`/);
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

test('a Manager that cannot be reached keeps the event pending, then failed for a person to retry', async t => {
  const f = await fixture(t);
  f.state.status = 503;
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'opened');
  await f.run();
  let [event] = events(f.h);
  assert.equal(event.state, 'pending'); assert.equal(event.attempts, 1); assert.equal(JSON.parse(event.error).code, 'model_http_503'); assert.ok(event.next_run_at > Date.now());
  f.h.store.run('UPDATE dispatch_events SET attempts=7,next_run_at=0');
  await f.run();
  [event] = events(f.h);
  assert.equal(event.state, 'failed'); assert.equal(tasks(f.h).length, 0);
  f.state.status = 200; f.state.decide = input => ({ decision: 'create', option_ids: [input.options.create[0].id], reason: '恢复后检视' });
  assert.equal((await f.admin(`/api/repositories/101/dispatch/${event.id}/retry`, 'POST', {})).status, 201);
  await f.run();
  assert.equal(events(f.h)[0].state, 'decided'); assert.equal(tasks(f.h).length, 1);
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
  insert.run('101', 'custom.0123456789ab', 'Docs check', 'Checks documentation changes', 1, JSON.stringify([{ id: 'pull_request.labeled', label: 'docs' }]), 'Read the changed docs and reply.', JSON.stringify({ writes: ['reply'] }), null, now, now);
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
  assert.deepEqual(work['review.pr'].writes, ['reply', 'labels', 'issue']); assert.deepEqual(work.reply, { enabled: true, writes: ['reply'], version: 0 });
  const view = (await admin('/api/repositories/101/manager')).value.manager;
  assert.equal(view.migration.report.manager_revision, 1); assert.equal(view.work.find(w => w.id === 'reply').active, true);
  assert.equal(view.sections.find(s => s.id === 'review.issue').effective_source, 'console');
  const removed = await admin('/api/repositories/101/workflows');
  assert.equal(removed.status, 410); assert.equal(removed.value.error, 'workflows_removed');
  // Starting again does nothing more.
  await h.stop(); await h.start();
  assert.equal(h.store.get("SELECT count(*) n FROM manager_revisions WHERE repository_id='101'").n, 1);
});
