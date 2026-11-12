import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, privateChat, repositoryAssistant, scriptedModel, envelope, inGroup, post, until, finished } from './channel-fixture.mjs';
import { settled } from './management-fixture.mjs';
import { knowledgeActor } from './knowledge-fixture.mjs';
import { resolvePrincipalActor } from '../dist/identity/authorization.js';
import { bindingScope } from '../dist/channels/service-bindings.js';

// Progress messages of service roles (#435) and their turns without a step limit. Feishu and the model are local protocol fixtures.
const reply = (res, message) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const call = (res, name, args, id = 'call-' + name) => reply(res, { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const say = (res, content) => reply(res, { role: 'assistant', content });
const observations = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const sent = f => f.wire.sent.map(s => JSON.stringify(s.content));
const position = (f, text) => sent(f).findIndex(s => s.includes(text));
const inbox = (f, receipt) => until(() => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?', receipt.value.operation_id), r => r && ['completed', 'failed'].includes(r.state));
const progress = text => ['send_message', { text }];
async function group(t) {
  const f = await channelFixture(t); await repositoryAssistant(f);
  return { ...f, chat: await boundGroup(f) };
}
async function web(f, content) {
  const conversation = (await f.admin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const message = (await f.admin('/api/management/conversations/' + conversation + '/messages', 'POST', { source_message: 'web-' + Math.random(), content })).value;
  return { conversation, message, history: await settled(f.admin, conversation, message.id) };
}

test('a group assistant sends progress messages while it works, before its final answer; the console and local history keep them in order (#435)', async t => {
  const f = await group(t), { h, chat } = f;
  let release, first; const gate = new Promise(r => { release = r; });
  f.modelState.respond = async (body, res) => {
    const seen = observations(body);
    if (!seen.length) { first = body; return call(res, 'send_message', { text: '正在查询仓库，请稍等。' }); }
    if (seen.length === 1) { await gate; return call(res, 'send_message', { text: '找到 2 个相关 PR，正在整理。' }, 'call-second'); }
    return say(res, '结论：有 2 个相关 PR。');
  };
  const receipt = await post(h, f.id, inGroup('帮我看看相关 PR', 'ou_bob'));
  // The first progress message reaches the group while the turn still runs; no permission item or approval is involved.
  await until(() => position(f, '正在查询仓库') >= 0);
  assert.equal(h.store.get('SELECT state FROM channel_service_turns').state, 'running');
  assert.match(first.messages[0].content, /send_message/); assert.match(first.messages[0].content, /at most 10 per turn/);
  assert.match(first.tools.find(tool => tool.function.name === 'send_message').function.description, /At most 10 per turn.*attachments are sent only with your final answer/);
  release();
  assert.equal((await inbox(f, receipt)).state, 'completed');
  await until(() => position(f, '结论：有 2 个相关 PR') >= 0);
  assert.ok(position(f, '正在查询仓库') < position(f, '找到 2 个相关 PR') && position(f, '找到 2 个相关 PR') < position(f, '结论：有 2 个相关 PR'));
  // The model learns how many remain; the final answer is still the reply without tool calls.
  const results = observations(f.requests.at(-1));
  assert.deepEqual(results.map(r => [r.sent, r.sequence, r.remaining]), [[true, 1, 9], [true, 2, 8]]);
  assert.match(results[0].notice, /final answer is still sent automatically/);
  // The console shows them with the turn, in order; they enter the group's local history in the binding's scope.
  const view = (await f.admin('/api/channels/chats/' + chat.id + '/conversation')).value;
  assert.deepEqual(view.turns[0].messages.map(m => [m.sequence, m.text]), [[1, '正在查询仓库，请稍等。'], [2, '找到 2 个相关 PR，正在整理。']]);
  assert.deepEqual([view.turns[0].state, view.turns[0].reply, view.turns[0].can_stop, view.can_manage], ['completed', '结论：有 2 个相关 PR。', false, true]);
  const binding = h.store.get('SELECT id FROM channel_service_bindings WHERE chat_id=?', chat.id);
  const remote = 'remote-' + (position(f, '正在查询仓库') + 1);
  assert.equal(h.store.get('SELECT project_id FROM channel_message_scopes WHERE chat_id=? AND message_id=?', chat.id, remote).project_id, bindingScope(binding.id));
  assert.ok(!JSON.stringify(h.store.all('SELECT payload FROM channel_service_turn_messages')).includes('正在查询仓库'), 'progress messages are sealed at rest');
});

test('a turn sends at most ten progress messages: the eleventh is refused with remaining 0 and the turn still completes (#435)', async t => {
  const f = await group(t), { h } = f;
  scriptedModel(f, [...Array.from({ length: 11 }, (_, i) => progress('进展 ' + (i + 1) + ' 号')), done => '全部完成，第 11 条：' + done[10].error]);
  assert.equal((await inbox(f, await post(h, f.id, inGroup('做一件很长的事', 'ou_bob')))).state, 'completed');
  await until(() => position(f, '全部完成') >= 0);
  const results = observations(f.requests.at(-1));
  assert.deepEqual([results[9].sent, results[9].remaining], [true, 0]);
  assert.match(results[9].notice, /last progress message/);
  assert.deepEqual([results[10].error, results[10].sent, results[10].remaining], ['stage_message_limit', false, 0]);
  assert.match(results[10].detail, /final answer, which is still sent automatically/);
  assert.match(sent(f).at(-1), /全部完成，第 11 条：stage_message_limit/);
  assert.equal(sent(f).filter(s => /进展 \d+ 号/.test(s)).length, 10);
  assert.equal(position(f, '进展 11 号'), -1);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_service_turn_messages').n, 10);
});

test('a queued progress message is not sent once its source message is recalled; the turn stops without an answer (#435)', async t => {
  const f = await group(t), { h } = f;
  let release, started; const gate = new Promise(r => { release = r; }), waiting = new Promise(r => { started = r; });
  f.modelState.respond = async (body, res) => {
    if (!observations(body).length) return call(res, 'send_message', { text: 'Progress that must stay unsent' });
    started(); await gate; say(res, 'An answer that must stay unsent');
  };
  // The first delivery attempt fails transiently, so the progress message waits in the outbox for its retry.
  f.wire.state.sendFailures = 1;
  const source = inGroup('Look into this', 'ou_bob'), receipt = await post(h, f.id, source);
  await waiting;
  const queued = await until(() => h.store.get("SELECT * FROM channel_outbox WHERE idempotency_key LIKE '%:stage:1'"), row => row?.state === 'retry');
  await post(h, f.id, { header: { ...source.header, event_id: 'recall-' + source.header.event_id, event_type: 'im.message.recalled_v1' },
    event: { chat_id: 'oc_group', message_id: source.event.message.message_id, recall_time: String(Date.now()) } });
  release();
  assert.equal((await inbox(f, receipt)).state, 'failed');
  const refused = await until(() => h.store.get('SELECT * FROM channel_outbox WHERE id=?', queued.id), row => row.state === 'failed', 15000);
  assert.equal(refused.last_error, 'conversation_source_changed');
  assert.ok(!sent(f).some(s => s.includes('Progress that must stay unsent') || s.includes('An answer that must stay unsent')));
  assert.notEqual(h.store.get('SELECT state FROM channel_service_turns').state, 'completed');
});

test('whoever manages the binding stops a running group answer in the console; sent progress stays and the group is told (#435)', async t => {
  const f = await group(t), { h, chat } = f;
  let started; const waiting = new Promise(r => { started = r; });
  f.modelState.respond = async (body, res) => {
    if (!observations(body).length) return call(res, 'send_message', { text: '已开始处理。' });
    started(); await new Promise(() => {}); // Never answers: only the stop ends this turn.
  };
  const receipt = await post(h, f.id, inGroup('一件要停下来的事', 'ou_bob'));
  await waiting; await until(() => position(f, '已开始处理') >= 0);
  const turn = h.store.get('SELECT * FROM channel_service_turns'), path = '/api/channels/chats/' + chat.id + '/service-turns/' + turn.id + '/stop';
  // Someone holding config.write over the scope may read the conversation but not stop it: only the owner and its governors (#424).
  knowledgeActor(h.store, 'peer', '101', ['config.write', 'tasks.read', 'tasks.write']);
  const peer = resolvePrincipalActor(h.store, 'peer', null), peerView = f.service.conversationView(peer, chat.id);
  assert.deepEqual([peerView.can_manage, peerView.turns[0].can_stop], [false, false]);
  assert.throws(() => f.service.stopServiceTurn(peer, chat.id, turn.id), { code: 'channel_service_binding_forbidden' });
  const view = (await f.admin('/api/channels/chats/' + chat.id + '/conversation')).value;
  assert.deepEqual([view.turns[0].state, view.turns[0].can_stop], ['running', true]);
  const stopped = await f.admin(path, 'POST', {});
  assert.equal(stopped.status, 201, JSON.stringify(stopped.value)); assert.equal(stopped.value.state, 'stopped');
  const row = await inbox(f, receipt);
  assert.deepEqual([row.state, row.error], ['failed', 'conversation_stopped']);
  await until(() => position(f, '已在控制台停止') >= 0);
  assert.ok(position(f, '已开始处理') < position(f, '已在控制台停止'));
  assert.deepEqual({ ...h.store.get('SELECT state,error FROM channel_service_turns') }, { state: 'stopped', error: 'conversation_stopped' });
  // Stopping again changes nothing; the audit names who stopped it.
  assert.equal((await f.admin(path, 'POST', {})).value.state, 'stopped');
  assert.equal(h.store.get("SELECT count(*) n FROM audit WHERE action='channel.service_turn.stopped' AND resource_id=?", turn.id).n, 1);
  const after = (await f.admin('/api/channels/chats/' + chat.id + '/conversation')).value.turns[0];
  assert.deepEqual([after.state, after.can_stop, after.messages.map(m => m.text), after.reply], ['stopped', false, ['已开始处理。'], null]);
  assert.equal((await f.admin('/api/channels/chats/' + chat.id + '/service-turns/' + 'a'.repeat(48) + '/stop', 'POST', {})).value.error, 'conversation_turn_not_found');
});

test('the management assistant sends progress messages to a private chat and records them for the console; the result follows (#435)', async t => {
  const f = await channelFixture(t), { h } = f;
  scriptedModel(f, [progress('先查一下你能访问的项目。'), ['management_query', { operation: 'list_projects', target: {}, arguments: {} }], done => `共 ${done[1].projects.length} 个项目。`]);
  const receipt = await post(h, f.id, envelope('我能访问几个项目？'));
  const row = await finished(h, receipt.value.operation_id); assert.equal(row.state, 'completed', row.error);
  await until(() => position(f, '共 3 个项目') >= 0);
  assert.ok(position(f, '先查一下你能访问的项目') >= 0 && position(f, '先查一下你能访问的项目') < position(f, '共 3 个项目'));
  // A progress message is an event of its own, not an execution step.
  const events = h.store.all('SELECT type,data FROM management_events WHERE message_id=? ORDER BY sequence', row.message_id).map(e => ({ type: e.type, data: JSON.parse(e.data) }));
  assert.deepEqual(events.find(e => e.type === 'message').data, { text: '先查一下你能访问的项目。', sequence: 1, remaining: 9 });
  assert.deepEqual(events.filter(e => e.type === 'tool_call').map(e => e.data.name), ['management_query']);
  assert.ok(events.findIndex(e => e.type === 'message') < events.findIndex(e => e.type === 'reply'));
  const chat = h.store.get("SELECT id FROM channel_chats WHERE chat_id='oc_private'");
  const turn = (await f.admin('/api/channels/chats/' + chat.id + '/conversation')).value.turns[0];
  assert.deepEqual([turn.messages, turn.reply], [['先查一下你能访问的项目。'], '共 3 个项目。']);
  // The next round sees what it already told the person.
  scriptedModel(f, ['好的。']);
  assert.equal((await finished(h, (await post(h, f.id, envelope('谢谢'))).value.operation_id)).state, 'completed');
  assert.deepEqual(JSON.parse(f.requests.at(-1).messages[1].content).history.at(-1).progress_messages, ['先查一下你能访问的项目。']);
});

test('in a console conversation progress messages only enter the event stream, ten at most, and the turn completes (#435)', async t => {
  const f = await channelFixture(t), { h } = f;
  scriptedModel(f, [...Array.from({ length: 11 }, (_, i) => progress('第 ' + (i + 1) + ' 条进展')), '完成了。']);
  const outbox = h.store.get('SELECT count(*) n FROM channel_outbox').n;
  const { history } = await web(f, '做一件长时间的事');
  assert.equal(history.messages[0].state, 'completed');
  const messages = history.events.filter(e => e.type === 'message');
  assert.deepEqual(messages.map(e => [e.data.sequence, e.data.remaining]), Array.from({ length: 10 }, (_, i) => [i + 1, 9 - i]));
  assert.equal(history.events.find(e => e.type === 'reply').data.text, '完成了。');
  assert.ok(!history.events.some(e => e.data?.name === 'send_message'));
  assert.equal(observations(f.requests.at(-1))[10].error, 'stage_message_limit');
  assert.equal(h.store.get('SELECT count(*) n FROM channel_outbox').n, outbox);
  assert.match(f.requests[0].messages[0].content, /at most 10 per turn/);
});

test('group and private timers send their progress messages to the chat under the timer\'s name before the result (#435)', async t => {
  const f = await group(t), { chat } = f, own = await privateChat(f);
  const timer = async target => (await f.admin('/api/channels/chats/' + target.id + '/schedules', 'POST', { name: '巡检', prompt: '检查失败的任务。', timezone: 'Asia/Shanghai', cron: '0 9 * * *' })).value.schedule;
  const run = async (target, label) => {
    scriptedModel(f, [progress(label + '：开始巡检'), label + '：巡检完成']);
    const schedule = await timer(target);
    assert.equal((await f.admin('/api/channels/schedules/' + schedule.id + '/run', 'POST', {})).status, 201);
    const done = await until(() => f.h.store.get('SELECT * FROM channel_schedule_runs WHERE schedule_id=?', schedule.id), r => r && r.state !== 'running');
    assert.equal(done.state, 'completed', done.error);
    await until(() => position(f, label + '：巡检完成') >= 0);
    const cards = f.wire.sent.filter(s => s.receive_id === target.chat_id).map(s => JSON.stringify(s.content));
    const start = cards.findIndex(c => c.includes('定时任务「巡检」') && c.includes(label + '：开始巡检'));
    assert.ok(start >= 0 && start < cards.findIndex(c => c.includes(label + '：巡检完成')));
  };
  await run(chat, '群');
  await run(own, '私聊');
});

test('assistant turns and own tasks have no step limit: a long group answer, a long console answer and a long own task complete (#435)', async t => {
  const f = await group(t), { h } = f;
  const steps = n => Array.from({ length: n }, () => ['list_projects', {}]);
  scriptedModel(f, [...steps(20), '查了 20 次，完成。']);
  assert.equal((await inbox(f, await post(h, f.id, inGroup('反复查一查', 'ou_bob')))).state, 'completed');
  await until(() => position(f, '查了 20 次，完成') >= 0);
  // The management assistant: twenty steps in one answer, and an own task of twelve steps continued past its twentieth round.
  const query = ['management_query', { operation: 'list_projects', target: {}, arguments: {} }];
  scriptedModel(f, [...Array.from({ length: 20 }, () => query), '二十步后完成。']);
  assert.equal((await web(f, '查二十次')).history.events.find(e => e.type === 'reply').data.text, '二十步后完成。');
  let main;
  f.modelState.respond = async (body, res) => {
    const seen = observations(body);
    if (body.messages[0].content.includes('one of your own independent tasks')) {
      assert.ok(!body.tools.some(tool => tool.function.name === 'send_message'), 'an own task does not address people');
      return seen.length < 12 ? call(res, query[0], query[1], 'own-' + seen.length) : say(res, '独立任务查了 12 次。');
    }
    return main(body, res, seen);
  };
  main = (_, res, seen) => !seen.length ? call(res, 'start_own_task', { title: '长任务', instruction: '查 12 次' }) : say(res, '结论：' + seen[0].conclusion);
  const first = await web(f, '开一个长的独立任务');
  assert.match(first.history.events.find(e => e.type === 'reply').data.text, /独立任务查了 12 次/);
  const own = h.store.get('SELECT * FROM service_role_own_tasks');
  h.store.run('UPDATE service_role_own_tasks SET rounds=20 WHERE id=?', own.id);
  main = (_, res, seen) => !seen.length ? call(res, 'continue_own_task', { task_id: own.id, instruction: '再查一轮' }) : say(res, '第 21 轮：' + (seen[0].conclusion ?? seen[0].error));
  const conversation = first.conversation, message = (await f.admin('/api/management/conversations/' + conversation + '/messages', 'POST', { source_message: 'web-continue', content: '继续' })).value;
  const continued = await settled(f.admin, conversation, message.id);
  assert.match(continued.events.filter(e => e.type === 'reply').at(-1).data.text, /第 21 轮：独立任务查了 12 次/);
  assert.equal(h.store.get('SELECT rounds FROM service_role_own_tasks WHERE id=?', own.id).rounds, 21);
});
