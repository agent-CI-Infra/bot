import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { server } from './fixtures/agent-server.mjs';
import { harness, setup, account, repository } from './helpers.mjs';
import { configureDispatch, Dispatcher } from '../dist/dispatch/worker.js';
import { queueWebhook } from '../dist/review/queue.js';
import { recordEvent } from '../dist/dispatch/store.js';

configureDispatch(null);

test('the Docker model fixture serves checked Manager decisions and preserves task tools', async t => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(base + '/fixture/config', { method: 'POST', body: JSON.stringify({ model_key: 'dispatch-fixture-key' }) });
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: base + '/model', api_key: 'dispatch-fixture-key', model_name: 'manager-model' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id, review_enabled: true, development_enabled: true });
  const dispatcher = new Dispatcher(h.store), run = async () => { dispatcher.tick(); await dispatcher.idle(); };
  const issue = { number: 1, state: 'open', title: 'Fix addition', body: 'Fix add to sum both numbers.' }, sender = { id: 700, login: 'maintainer', type: 'User' };
  queueWebhook(h.store, '101', 'issues', { action: 'opened', issue, sender }, 'fixture-opened');
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 0);
  await run();
  const review = h.store.get('SELECT * FROM tasks'); assert.equal(review.kind, 'review.issue');
  const comment = (id, body) => queueWebhook(h.store, '101', 'issue_comment', { action: 'created', issue, sender, comment: { id, body, author_association: 'MEMBER' } }, 'fixture-comment-' + id);
  comment(31, 'Also explain numeric inputs.'); await run();
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 1);
  assert.equal(JSON.parse(h.store.get('SELECT input FROM tasks').input).merged_updates.length, 1);
  h.store.run("UPDATE tasks SET status='succeeded'");
  comment(32, 'Thanks!'); await run();
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 1);
  // The fixture selects work ids from offered options, including a later development option with an arbitrary id.
  recordEvent(h.store, { repositoryId: '101', key: 'fixture-published', type: 'review.published', source: 'review', summary: 'Review published', object: { type: 'issue', number: 1 },
    facts: { review: { requires_code_change: true, quote_in_issue: true }, development: { assignees: [] } },
    options: [{ id: 'offered-development', work: 'development.issue', title: 'Develop', spec: { type: 'object', kind: 'development.issue', number: 1, head: null, input: { review: { implementation_goal: 'Fix addition' } }, delivery: 'fixture-published' } }] });
  await run();
  assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.issue'").n, 1);
  recordEvent(h.store, { repositoryId: '101', key: 'fixture-no-code', type: 'review.published', source: 'review', summary: 'No requested change', object: { type: 'issue', number: 2 },
    facts: { review: { requires_code_change: false, quote_in_issue: false }, development: { assignees: [] } },
    options: [{ id: 'declined-development', work: 'development.issue', title: 'Develop', spec: { type: 'object', kind: 'development.issue', number: 2, head: null, input: {}, delivery: null } }] });
  await run();
  const events = h.store.all('SELECT * FROM dispatch_events ORDER BY created_at,rowid');
  assert.deepEqual(events.map(e => [e.state, e.decision, e.model]), ['create', 'continue', 'ignore', 'create', 'ignore'].map(decision => ['decided', decision, 'manager-model']));
  assert.deepEqual(JSON.parse(events[3].result).created.length, 1);
  const state = await (await fetch(base + '/fixture/state')).json();
  assert.equal(state.dispatches.length, 5);
  for (const { options, decision } of state.dispatches) {
    const offered = decision.decision === 'continue' ? options.continue : options.create;
    assert.ok(decision.option_ids.every(id => offered.some(option => option.id === id)));
  }
  for (const mode of ['review', 'development']) {
    const response = await fetch(base + '/model/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer dispatch-fixture-key' }, body: JSON.stringify({
      model: 'task-model', messages: [{ role: 'user', content: JSON.stringify({ repository: 'fixture/project-101', object: { number: 1, body_excerpt: issue.body }, mode }) }]
    }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.tool_calls[0].function.name, mode === 'review' ? 'read_file' : 'write_file');
  }
  const messages = [{ role: 'user', content: JSON.stringify({ candidate: { id: 'candidate', evidence: [{ source: 'task_log:proof' }] }, policy: { test_command: 'node --test' } }) }];
  const acceptance = async () => {
    const response = await fetch(base + '/model/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer dispatch-fixture-key' }, body: JSON.stringify({
      model: 'qa-model', tools: [{ function: { name: 'submit_acceptance' } }], messages
    }) });
    assert.equal(response.status, 200);
    return (await response.json()).choices[0].message.tool_calls[0];
  };
  for (const [name, result] of [['read_file', { content: 'export const add = (a, b) => a + b;' }], ['read_evidence', { chunk: 'original proof' }], ['run_command', { exit_code: 0 }]]) {
    const call = await acceptance(); assert.equal(call.function.name, name);
    messages.push({ role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  }
  const verdict = await acceptance(); assert.equal(verdict.function.name, 'submit_acceptance');
  assert.equal(JSON.parse(verdict.function.arguments).outcome, 'pass');
  messages.at(-1).content = JSON.stringify({ exit_code: 1 });
  assert.equal(JSON.parse((await acceptance()).function.arguments).outcome, 'return', 'failed verification cannot receive a passing verdict');
});
