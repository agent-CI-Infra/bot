import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { runAgent } from '../../../../dist/agent/runtime.js';
import { serviceHarnessTurn } from '../../../../dist/harness/service-session.js';
import { serviceRole, serviceRoleModel, managementAssistant, updateServiceRole } from '../../../../dist/service-roles/roles.js';
import { saveModelMetadata } from '../../../../dist/models/catalog.js';
import { staySilentTool } from '../../../../dist/service-roles/stay-silent.js';

// A service assistant's turn on Pi works as the native loop does (#1253): its answer streams, messages that arrive while it
// works join the turn, an edited request starts the turn again, and stay_silent ends it without a reply.
const piSkip = !existsSync('runner/node_modules/@earendil-works/pi-coding-agent/package.json') && process.env.BOT_REQUIRE_PI !== '1'
  ? 'Pi SDK not installed: npm ci --prefix runner --omit=dev --ignore-scripts' : false;
const lookup = { type: 'function', function: { name: 'lookup', description: 'Look up one fact.', parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } } };
const text = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('');
const users = body => body.messages.filter(m => m.role === 'user').map(text);
const toolResults = body => body.messages.filter(m => m.role === 'tool').map(text);
const json = (res, message, usage = { prompt_tokens: 10, completion_tokens: 5 }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { role: 'assistant' };
  if (message.content != null) delta.content = message.content;
  if (Array.isArray(message.tool_calls)) {
    delta.tool_calls = message.tool_calls.map((tc, index) => ({
      index, id: tc.id, type: tc.type || 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
};
const call = (res, name, args = {}) => json(res, { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + randomBytes(4).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
// An answer streamed in parts, as a provider sends it.
async function stream(res, parts) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const content of parts) { res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`); await new Promise(r => setTimeout(r, 60)); }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}
// The transport's side of messages arriving during a turn (src/channels/turn-messages.ts), recorded.
function arrivals() {
  const queue = [], log = []; let paused = false, injected = 0;
  return { queue, log, injected: () => injected, check() {}, seal() {}, finish() {}, release() {},
    pause() { paused = true; log.push('pause'); }, resume() { paused = false; log.push('resume'); }, refresh() { log.push('refresh'); },
    take() { if (paused || !queue.length) return undefined; const messages = queue.splice(0); injected += messages.length; log.push('take:' + messages.map(m => m.content).join('|'));
      return { content: { incoming_during_turn: true, messages }, direct: messages.some(m => m.direct) }; } };
}
async function piService(t, respond) {
  const root = mkdtempSync(join(tmpdir(), 'bot-service-turn-pi-')), store = new Store(':memory:', randomBytes(32)), manager = new LocalManager('101', root), bodies = [];
  const model = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); bodies.push(body); await respond(body, res, bodies.length); });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(async () => { await manager.recover(); model.closeAllConnections(); await new Promise(r => model.close(r)); store.close(); rmSync(root, { recursive: true, force: true }); });
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m',NULL,?,'fixture',?,'now')", 'http://127.0.0.1:' + model.address().port + '/v1', store.secrets.seal({ value: 'fixture-key' }, 'model:m'));
  saveModelMetadata(store, 'm', { interface_type: 'openai-chat-completions' });
  const before = serviceRole(store, managementAssistant);
  updateServiceRole(store, 'admin', managementAssistant, { expected_revision: before.revision, harness: 'pi', model_id: 'm' });
  const role = serviceRole(store, managementAssistant); await manager.call('PUT', '/v1/projects/101');
  const computer = { async sessionWorkspace(task, workspaceId, redactor, log) {
    const workspace = new Workspace(store, manager, { ...task, repository_id: '101', workspace_id: workspaceId, generation: 1 }, redactor, async () => {}, log, 'service_role_operations');
    await workspace.call('init', { type: 'workspace_init' }); return workspace; } };
  const run = (spec, control) => {
    const full = { store, task: { id: randomBytes(24).toString('hex'), kind: 'management.agent', repository_id: null, service_role_id: role.id, conversation_id: 'pi-turn', source_message: 'one' },
      redactor: new Redactor(), guard: async () => {}, system: 'Answer the service conversation.', model: serviceRoleModel(store, role.id), ...spec };
    return runAgent({ ...full, adapter: services => serviceHarnessTurn(full, services, role, computer, 'owner:' + randomBytes(4).toString('hex'), undefined, control) });
  };
  return { store, bodies, run };
}

test('a Pi service turn streams its answer, merges arriving messages after its prompt and between tool batches, and answers in text', { skip: piSkip, timeout: 90000 }, async t => {
  const incoming = arrivals(), deltas = [], merged = [];
  const f = await piService(t, async (_body, res, n) => n === 1 ? call(res, 'lookup', { q: 'status' }) : stream(res, ['第一段，', '第二段。']));
  incoming.queue.push({ content: '补充：只看 main' });
  const answer = await f.run({ prompt: 'What is the status?', tools: [lookup],
    execute: async name => { incoming.queue.push({ content: '@助手 还有 CI 吗', direct: true }); return { name, fact: 'green' }; } },
  { incoming, text: async delta => { deltas.push(delta); }, merged: batch => merged.push(batch.direct) });
  assert.equal(answer, '第一段，第二段。');
  assert.equal(f.bodies.length, 2);
  // No finish tool: the answer is the text the model writes, so it can stream.
  assert.deepEqual(f.bodies[0].tools.map(t => t.function.name), ['lookup']);
  // The message that arrived before the session joined right after the prompt, the one that arrived during the tool after its result.
  assert.match(users(f.bodies[0]).at(-2), /What is the status\?/);
  assert.match(users(f.bodies[0]).at(-1), /补充：只看 main/);
  assert.match(toolResults(f.bodies[1])[0], /green/);
  assert.match(users(f.bodies[1]).at(-1), /incoming_during_turn.*还有 CI 吗/);
  assert.deepEqual(merged, [false, true]);
  assert.equal(deltas.join(''), '第一段，第二段。'); assert.ok(deltas.length >= 2, 'the answer arrives in parts');
  // Merging closes while the answer is written and opens again after a response with tool calls, as natively.
  assert.ok(incoming.log.indexOf('resume') < incoming.log.findIndex(e => e.includes('还有 CI 吗')));
  assert.equal(incoming.log.at(-1), 'pause');
});

test('an edited request starts a Pi service turn again in a new session: nothing done on the old request counts', { skip: piSkip, timeout: 90000 }, async t => {
  const incoming = arrivals(); let version = 1, executed = 0;
  const f = await piService(t, async (_body, res, n) => {
    // The request is edited while the model works on it: first before its tool call, then before its answer.
    if (n === 1) { version = 2; return call(res, 'lookup', { q: 'old' }); }
    if (n === 2) { version = 3; return json(res, { role: 'assistant', content: 'answer to the second version' }); }
    return json(res, { role: 'assistant', content: 'answer to the edited request' });
  });
  const answer = await f.run({ prompt: 'original request', tools: [lookup], execute: async () => { executed++; return { fact: 'x' }; } },
    { incoming, source: { version: () => version, prompt: () => 'edited request v' + version, seen: 1 } });
  assert.equal(answer, 'answer to the edited request');
  assert.equal(executed, 0, 'a tool call made on the old request never runs');
  assert.equal(f.bodies.length, 3);
  assert.ok(users(f.bodies[1]).some(m => m.includes('edited request v2')) && !users(f.bodies[1]).some(m => m.includes('original request')), 'the new session starts from the edited request alone');
  assert.ok(users(f.bodies[2]).some(m => m.includes('edited request v3')) && !users(f.bodies[2]).some(m => m.includes('v2')));
  // Messages merged so far are offered again to each new session.
  assert.deepEqual(incoming.log.filter(e => e === 'refresh'), ['refresh', 'refresh']);
});

test('stay_silent ends a Pi service turn without a reply; a refused call is an observation and the turn goes on', { skip: piSkip, timeout: 90000 }, async t => {
  const answers = [{ error: 'reply_required', detail: 'A message in this turn is addressed to you.' }, { silent: true, reason: '闲聊' }], calls = [];
  const f = await piService(t, async (_body, res) => call(res, 'stay_silent', { reason: '闲聊' }));
  const answer = await f.run({ prompt: 'A message that did not mention you.', tools: [lookup, staySilentTool], execute: async () => ({ error: 'unexpected' }) },
    { silence: async args => { calls.push(args); return answers[calls.length - 1]; } });
  assert.equal(answer, '');
  assert.equal(f.bodies.length, 2, 'the accepted call ends the session at once');
  assert.deepEqual(f.bodies[0].tools.map(t => t.function.name), ['lookup', 'stay_silent']);
  assert.match(toolResults(f.bodies[1]).at(-1), /reply_required/);
  assert.deepEqual(calls, [{ reason: '闲聊' }, { reason: '闲聊' }]);
});

test('over the unified passthrough gateway a Pi service turn streams its answer and reports Pi\'s own retries', { skip: piSkip, timeout: 90000 }, async t => {
  const deltas = [], retries = [];
  const f = await piService(t, async (_body, res, n) => {
    if (n === 1) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Server overloaded', type: 'overloaded_error' } })); }
    return stream(res, ['透传', '回答']);
  });
  const answer = await f.run({ prompt: 'Answer over gateway.', tools: [lookup], execute: async () => ({}), onModelRetry: retry => { retries.push(retry); } },
    { text: async delta => { deltas.push(delta); } });
  assert.equal(answer, '透传回答');
  assert.equal(deltas.join(''), '透传回答');
  assert.equal(retries.length, 1); assert.equal(retries[0].retry, 1); assert.equal(retries[0].code, 'model_unavailable');
  // Streamed text reaches the conversation only; the session log keeps the model event that holds all of it.
  const logged = JSON.stringify(f.store.all('SELECT * FROM service_harness_events'));
  assert.ok(!logged.includes('text_delta'));
});

test('a long Pi service turn with many large tool results compacts its session instead of failing with agent_context_too_large', { skip: piSkip, timeout: 180000 }, async t => {
  let executed = 0, compactions = 0;
  // Usage as a provider reports it, so Pi compacts at its own threshold before the window is full.
  const usage = body => ({ prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4), completion_tokens: 20 });
  const f = await piService(t, async (body, res) => {
    if (text(body.messages[0] ?? {}).startsWith('You are a context summarization assistant')) {
      compactions++; return json(res, { role: 'assistant', content: '## Goal\nLook up 16 facts.\n## Progress\nFacts so far were looked up.' }, usage(body));
    }
    const message = executed < 16 ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + executed, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ q: 'fact ' + executed }) } }] }
      : { role: 'assistant', content: 'All 16 facts were looked up.' };
    json(res, message, usage(body));
  });
  // Each result is about 10k tokens: the turn needs about 160k, over the 128k window of the fixture model.
  const answer = await f.run({ prompt: 'Look up 16 facts one at a time.', tools: [lookup], execute: async (_name, args) => { executed++; return { q: args.q, fact: (args.q + ' ').repeat(6000).slice(0, 40000) }; } }, {});
  assert.equal(answer, 'All 16 facts were looked up.');
  assert.equal(executed, 16);
  assert.ok(compactions >= 1, 'Pi compacted the session at least once');
});
