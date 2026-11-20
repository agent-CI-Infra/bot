import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { Dispatcher } from '../../../../dist/dispatch/worker.js';
import { roleConfiguration, saveConfiguration } from '../../../../dist/roles/definition.js';

const alice = { type: 'User', login: 'alice', id: 5 };
const issue = { number: 5, state: 'open', title: 'Parser drops the last line', body: 'CRLF files lose their last line.', user: { id: 5, login: 'alice' }, labels: [] };
const head = 'a'.repeat(40);
const tasks = h => h.store.all('SELECT * FROM tasks ORDER BY created_at,rowid');
const events = h => h.store.all('SELECT * FROM dispatch_events ORDER BY created_at,rowid');

/** The Manager's tool call for a decision: create_task, continue_task or ignore_event (#815). */
function decisionCall(decision, id) {
  const [name, args] = decision.decision === 'create' ? ['create_task', { work: decision.option_ids, reason: decision.reason, ...(decision.brief ? { brief: decision.brief } : {}), ...(decision.writes ? { writes: decision.writes } : {}), ...(decision.basis ? { basis: decision.basis } : {}) }]
    : decision.decision === 'continue' ? ['continue_task', { task_id: String(decision.option_ids?.[0] ?? '').replace(/^continue:/, ''), reason: decision.reason }]
    : ['ignore_event', { reason: decision.reason }];
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
// A project with a Manager model served by a local fixture; `state.decide(input, round)` answers each dispatch call, or
// `state.message(body)` gives the whole assistant message (for a Manager that uses other tools first).
async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  saveConfiguration(h.store,'101',{expected_revision:roleConfiguration(h.store,'101').revision,enabled:true,roles:[{role_id:'manager',harness_ref:{id:'native'}}]},'fixture');
  const requests = [], state = { decide: null, status: 200 };
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    if (state.status !== 200) { res.writeHead(state.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture outage' } })); return; }
    const input = JSON.parse(body.messages[1].content), round = body.messages.filter(m => m.role === 'tool').length;
    // decide() answers in the shape of a decision; the Manager calls create_task, continue_task or ignore_event (#815).
    input.options = { create: input.work.create, continue: input.work.continue.map(task => ({ ...task, id: 'continue:' + task.task_id })) };
    const message = state.message ? state.message(body, input) : { role: 'assistant', content: null, tool_calls: [decisionCall(state.decide(input, round), 'call-' + round)] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 20, completion_tokens: 8 } }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
  const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Manager fixture', api_url: `http://127.0.0.1:${provider.address().port}/v1`, api_key: 'manager-fixture-key' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  // These tests are about the Manager's own decisions: the project has no standing rules (#815), so every event reaches it.
  const manager = (await admin('/api/repositories/101/manager')).value.manager;
  assert.equal((await admin('/api/repositories/101/manager', 'PUT', { expected_revision: manager.prompt.revision, standing_rules: [] })).status, 200);
  const dispatcher = new Dispatcher(h.store);
  const run = async () => { dispatcher.tick(); await dispatcher.idle(); };
  return { h, admin, a, requests, state, dispatcher, run };
}

const toolCall = (name, args, id) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

export { alice, issue, head, tasks, events, decisionCall, fixture, toolCall };
