// The fixture provider answers in the gateway's chat format; Pi's model requests go through the control plane.
process.env.BOT_HARNESS_MODEL_TRANSPORT = 'gateway';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelFixture, repositoryAssistant, boundGroup, privateChat, envelope, inGroup, post, until } from '../../../fixtures/channel-fixture.mjs';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';

// The management assistant and group assistants on Pi (#1253) work their turns as the native loop does: the console shows
// the answer as it is written, the group's context is the native one, merged messages join the turn and stay_silent ends it.
const piSkip = !existsSync('runner/node_modules/@earendil-works/pi-coding-agent/package.json') && process.env.BOT_REQUIRE_PI !== '1'
  ? 'Pi SDK not installed: npm ci --prefix runner --omit=dev --ignore-scripts' : false;
const answer = (res, message) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const say = (res, content) => answer(res, { role: 'assistant', content });
const call = (res, name, args = {}) => answer(res, { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
async function stream(res, parts) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const content of parts) { res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`); await new Promise(r => setTimeout(r, 60)); }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const text = m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join('');
const users = body => body.messages.filter(m => m.role === 'user').map(text);
const toolResults = body => body.messages.filter(m => m.role === 'tool').map(text);
const sent = f => f.wire.sent.map(s => JSON.stringify(s.content));
const row = (f, receipt) => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?', receipt.value.operation_id);
const done = (f, receipt) => until(() => row(f, receipt), r => ['completed', 'failed'].includes(r?.state), 60000);
const ambient = (content, actor = 'ou_bob') => { const message = inGroup(content, actor); message.event.message.mentions = []; return message; };
// A management message once it has ended; a Pi turn first starts its session on the computer.
const settled = (f, conversation, message) => until(async () => (await f.admin('/api/management/conversations/' + conversation + '/events')).value,
  value => value.messages?.some(m => m.id === message && !['pending', 'running'].includes(m.state)), 60000);
function gate(t) { let release; const wait = new Promise(r => { release = r; }); t.after(() => release()); return { wait, release }; }

// Each conversation owner's computer is a workspace of a local project computer running this checkout's runner and Pi SDK.
// f.computerCalls records when a turn starts taking its computer early (#1254) and when its Pi session takes it.
function piComputers(t, f) {
  const root = mkdtempSync(join(tmpdir(), 'bot-pi-assistants-')), manager = new LocalManager('101', root), store = f.h.store;
  t.after(async () => { await manager.recover(); rmSync(root, { recursive: true, force: true }); });
  f.computerCalls = [];
  const computer = () => ({ egress: true, async close() {}, async execute() { return { error: 'computer_not_configured' }; }, warm() { f.computerCalls.push('warm'); },
    async sessionWorkspace(task, workspaceId, redactor, log) {
      f.computerCalls.push('session');
      const workspace = new Workspace(store, manager, { ...task, repository_id: '101', workspace_id: workspaceId, generation: 1 }, redactor, async () => {}, log, 'service_role_operations');
      await workspace.call('init', { type: 'workspace_init' }); return workspace;
    } });
  f.service.management.service.assistants = { turn: computer, available: () => false, resolve() {}, start() {}, async close() {} };
  return manager.call('PUT', '/v1/projects/101');
}
async function piManagement(t, f) {
  await piComputers(t, f);
  const role = (await f.admin('/api/service-roles')).value.service_roles.find(r => r.id === 'management-assistant');
  assert.equal((await f.admin('/api/service-roles/management-assistant', 'PATCH', { expected_revision: role.revision, harness: 'pi' })).status, 200);
}
async function piGroup(t) {
  const f = await channelFixture(t); await repositoryAssistant(f); f.chat = await boundGroup(f); await piComputers(t, f);
  const binding = f.service.serviceBindings.get(f.chat.id);
  const saved = await f.admin(`/api/channels/chats/${f.chat.id}/service-binding`, 'PUT', {
    scope: { kind: 'repositories', repositories: ['101'] }, participation: 'all', harness: 'pi', enabled: true, expected_revision: binding.revision });
  assert.equal(saved.status, 200); assert.equal(f.service.serviceBindings.get(f.chat.id).harness, 'pi');
  return f;
}

test('the console shows a Pi management turn\'s answer as it is written, after its tool steps (#1253)', { skip: piSkip, timeout: 120000 }, async t => {
  const f = await channelFixture(t); await piManagement(t, f); const bodies = [];
  f.modelState.respond = async (body, res) => {
    bodies.push(body);
    if (bodies.length === 1) return call(res, 'management_query', { operation: 'get_task', target: { project_id: '101', task_id: 'blocked' }, arguments: {} });
    return stream(res, ['任务在等待', '项目电脑。']);
  };
  const conversation = (await f.admin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const message = (await f.admin('/api/management/conversations/' + conversation + '/messages', 'POST', { source_message: 'pi-console', content: '那个任务怎么了？' })).value;
  const events = (await settled(f, conversation, message.id)).events.filter(e => e.message_id === message.id);
  assert.deepEqual(events.filter(e => e.type === 'error'), []);
  // The context is the native one, and the answer is text: no finish tool.
  assert.equal(JSON.parse(users(bodies[0])[0]).request, '那个任务怎么了？');
  assert.ok(!bodies[0].tools.some(tool => tool.function.name === 'finish'));
  const types = events.map(e => e.type), deltas = events.filter(e => e.type === 'text');
  assert.ok(deltas.length >= 2 && deltas.every(e => e.data.provisional === true));
  assert.equal(deltas.map(e => e.data.delta).join(''), '任务在等待项目电脑。');
  assert.ok(types.indexOf('tool_result') < types.indexOf('text') && types.lastIndexOf('text') < types.indexOf('reply'));
  assert.equal(events.find(e => e.type === 'reply').data.text, '任务在等待项目电脑。');
  // The computer is taken as the turn starts, before the request is put together and the session needs it (#1254).
  assert.deepEqual(f.computerCalls, ['warm', 'session']);
});

test('a Pi group turn starts from the native context and ends silently through stay_silent (#1253, #489)', { skip: piSkip, timeout: 120000 }, async t => {
  const f = await piGroup(t), bodies = [];
  f.modelState.respond = async (body, res) => { bodies.push(body); return call(res, 'stay_silent', { reason: '群友在闲聊午饭' }); };
  const lunch = await post(f.h, f.id, ambient('大家中午吃什么？'));
  assert.equal((await done(f, lunch)).state, 'completed');
  assert.equal(bodies.length, 1);
  const seed = JSON.parse(users(bodies[0])[0]);
  assert.match(seed.request, /大家中午吃什么？/); assert.equal(seed.context.bot_identity.open_id, 'ou_bot');
  assert.equal(seed.context.current_message.is_direct_mention, false); assert.ok(Array.isArray(seed.context.recent_messages));
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_outbox WHERE source_event=?', lunch.value.operation_id).n, 0);
  const turn = f.h.store.get('SELECT * FROM channel_service_turns');
  assert.deepEqual(f.h.store.all('SELECT type,name FROM channel_service_events WHERE turn_id=? AND type LIKE ?', turn.id, 'tool_%').map(e => [e.type, e.name]),
    [['tool_call', 'stay_silent'], ['tool_result', 'stay_silent']]);
  const view = (await f.admin(`/api/channels/chats/${f.chat.id}/timeline`)).value.conversation.turns[0];
  assert.equal(view.reply, ''); assert.equal(view.silent, true); assert.equal(view.silent_reason, '群友在闲聊午饭');
  assert.deepEqual(f.computerCalls, ['warm', 'session'], 'the group computer is taken as the turn starts (#1254)');
});

test('a mention merged into a Pi group turn joins after the tool batch, refuses stay_silent and is answered (#1253, #458)', { skip: piSkip, timeout: 120000 }, async t => {
  const f = await piGroup(t), held = gate(t), bodies = []; let executing = false;
  f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '没有相关内容' }; };
  f.modelState.respond = async (body, res) => {
    bodies.push(body);
    if (bodies.length === 1) return call(res, 'start_own_task', { title: '群聊', instruction: '看看群里在聊什么' });
    if (bodies.length === 2) return call(res, 'stay_silent', {});
    return say(res, '王成照：最近一次失败是 lint。');
  };
  const chat = await post(f.h, f.id, ambient('今天天气怎么样'));
  await until(() => executing || f.h.store.get("SELECT state,error FROM channel_service_turns WHERE state<>'running'"), undefined, 60000);
  assert.ok(executing, JSON.stringify(f.h.store.all('SELECT state,error,error_detail FROM channel_service_turns')));
  const mention = await post(f.h, f.id, inGroup('最近一次失败是什么？', 'ou_alice')); assert.equal(row(f, mention).state, 'merged');
  held.release(); await done(f, chat); await done(f, mention);
  assert.equal(bodies.length, 3);
  assert.match(users(bodies[1]).at(-1), /incoming_during_turn/); assert.match(users(bodies[1]).at(-1), /最近一次失败是什么/);
  assert.match(toolResults(bodies[2]).at(-1), /reply_required/);
  const delivered = await until(() => sent(f).find(s => s.includes('最近一次失败是 lint')));
  assert.ok(delivered);
  const turn = f.h.store.get('SELECT * FROM channel_service_turns ORDER BY created_at LIMIT 1');
  assert.deepEqual(f.h.store.all('SELECT type,name FROM channel_service_events WHERE turn_id=? AND type LIKE ?', turn.id, 'tool_%').map(e => [e.type, e.name]),
    [['tool_call', 'start_own_task'], ['tool_result', 'start_own_task'], ['tool_call', 'stay_silent'], ['tool_error', 'stay_silent']]);
  const view = (await f.admin(`/api/channels/chats/${f.chat.id}/timeline`)).value.conversation.turns[0];
  assert.equal(view.silent, undefined); assert.match(view.reply, /最近一次失败是 lint/);
});

for (const personal of [false, true]) test(`an edit during a Pi ${personal ? 'private chat' : 'group'} turn starts it again from the current source; the late answer is never sent (#1253)`, { skip: piSkip, timeout: 120000 }, async t => {
  const f = personal ? await channelFixture(t) : await piGroup(t);
  if (personal) await piManagement(t, f);
  const waiting = gate(t), release = gate(t), early = '引用 old-source-unique 的早期回答'; let calls = 0, last;
  f.modelState.respond = async (body, res) => {
    calls++;
    if (calls === 1) return say(res, early);
    if (calls === 2) { waiting.release(); await release.wait; return say(res, '依赖旧正文的迟到回答'); }
    last = body; return say(res, '基于当前原文完成');
  };
  const send = content => post(f.h, f.id, personal ? envelope(content) : inGroup(content));
  const first = await send('old-source-unique'); assert.equal((await done(f, first)).state, 'completed');
  const event = f.service.turnMessages.event(row(f, first));
  await until(() => sent(f).some(s => s.includes('old-source-unique')));
  const next = await send('现在继续'); await waiting.wait;
  f.service.ledger.accept({ ...event, content: 'new-source-unique', raw_content: JSON.stringify({ text: 'new-source-unique' }), updated_at: Date.now() + 1 });
  release.release(); assert.equal((await done(f, next)).state, 'completed');
  assert.equal(calls, 3);
  // The new session starts from the edited source alone: neither the old text nor the answer written on it.
  const seen = JSON.stringify(last);
  assert.ok(!seen.includes('依赖旧正文的迟到回答')); assert.match(seen, /new-source-unique/); assert.match(seen, /edited/);
  if (personal) assert.ok(!seen.includes('old-source-unique'), seen);
  else assert.equal(JSON.parse(users(last)[0]).context.recent_messages.find(m => m.message_id === event.message_id).content, 'new-source-unique');
  await until(() => sent(f).some(s => s.includes('基于当前原文完成')));
  assert.ok(!sent(f).some(s => s.includes('依赖旧正文的迟到回答')));
});

test('a private timer on Pi with nothing to report ends silently; nothing is sent (#1253, #489)', { skip: piSkip, timeout: 120000 }, async t => {
  const f = await channelFixture(t), chat = await privateChat(f); await piManagement(t, f); const bodies = [];
  f.modelState.respond = async (body, res) => { bodies.push(body); return call(res, 'stay_silent', { reason: '没有失败的任务' }); };
  const schedule = (await f.admin(`/api/channels/chats/${chat.id}/schedules`, 'POST', { name: '每日汇总', prompt: '有失败的任务才告诉我。', timezone: 'UTC', interval_minutes: 60 })).value.schedule;
  await f.admin(`/api/channels/schedules/${schedule.id}/run`, 'POST', {});
  const run = await until(() => f.h.store.get('SELECT * FROM channel_schedule_runs WHERE schedule_id=?', schedule.id), r => r && r.state !== 'running', 60000);
  assert.equal(run.state, 'silent', run.error);
  assert.equal(bodies.length, 1); assert.ok(bodies[0].tools.some(tool => tool.function.name === 'stay_silent'));
  const reply = JSON.parse(f.h.store.get("SELECT data FROM management_events WHERE message_id=? AND type='reply'", run.message_id).data);
  assert.equal(reply.text, ''); assert.equal(reply.silent, true); assert.equal(reply.reason, '没有失败的任务');
  await f.service.tick(); assert.deepEqual(sent(f).filter(s => s.includes('每日汇总') || s.includes('没有失败')), []);
});
