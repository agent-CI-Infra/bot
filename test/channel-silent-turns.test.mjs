import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, privateChat, boundGroup, repositoryAssistant, inGroup, envelope, post, until, finished } from './channel-fixture.mjs';

// Ending a turn without an answer (#489): turns that may stay silent offer stay_silent, and calling it sends nothing, even
// when the model also writes a placeholder such as "（无需回复）". Turns that must answer never end silently.
const answer = (res, message) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const say = (res, content) => answer(res, { role: 'assistant', content });
const call = (res, name, args = {}, content = null) => answer(res, { role: 'assistant', content, tool_calls: [{ id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const offered = body => body.tools.map(t => t.function.name);
const toolResults = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
// Every delivered message, whether posted to the chat or as a reply to one of its messages.
const sent = f => f.wire.sent.map(s => JSON.stringify(s.content));
const row = (f, receipt) => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?', receipt.value.operation_id);
const done = (f, receipt) => until(() => row(f, receipt), r => ['completed', 'failed'].includes(r?.state));
const ambient = (content, actor = 'ou_bob') => { const message = inGroup(content, actor); message.event.message.mentions = []; return message; };
const placeholder = '（这条消息是在闲聊午饭，与仓库无关，我就不插话了。）';
async function group(t, participation = 'all') {
  const f = await channelFixture(t); await repositoryAssistant(f); f.chat = await boundGroup(f);
  const binding = f.service.serviceBindings.get(f.chat.id);
  assert.equal((await f.admin(`/api/channels/chats/${f.chat.id}/service-binding`, 'PUT', { service_role_id: binding.service_role_id,
    scope: { kind: 'repositories', repositories: ['101'] }, participation, enabled: true, expected_revision: binding.revision })).status, 200);
  return f;
}
function gate(t) { let release; const wait = new Promise(r => { release = r; }); t.after(() => release()); return { wait, release }; }

test('a group message without an @ ends silently through stay_silent: the text written with it is never posted (#489)', async t => {
  const f = await group(t); const bodies = [];
  f.modelState.respond = async (body, res) => { bodies.push(body); return call(res, 'stay_silent', { reason: '群友在闲聊午饭' }, placeholder); };
  const lunch = await post(f.h, f.id, ambient('大家中午吃什么？'));
  assert.equal((await done(f, lunch)).state, 'completed');
  // One model request: the tool ends the turn at once, with nothing queued for the group.
  assert.equal(bodies.length, 1); assert.ok(offered(bodies[0]).includes('stay_silent'));
  assert.match(bodies[0].messages[0].content, /did not mention you/); assert.match(bodies[0].messages[0].content, /call stay_silent: it ends this turn and nothing is sent/);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_outbox WHERE source_event=?', lunch.value.operation_id).n, 0);
  await f.service.tick(); assert.deepEqual(sent(f).filter(s => s.includes('闲聊')), []);
  const turn = f.h.store.get('SELECT * FROM channel_service_turns');
  assert.equal(turn.state, 'completed');
  assert.deepEqual(f.h.store.all('SELECT type,name FROM channel_service_events WHERE turn_id=? AND type LIKE ?', turn.id, 'tool_%').map(e => [e.type, e.name]),
    [['tool_call', 'stay_silent'], ['tool_result', 'stay_silent']]);
  // The console says the assistant stayed silent on purpose and why; the reason is never sent.
  const view = (await f.admin(`/api/channels/chats/${f.chat.id}/timeline`)).value.conversation.turns[0];
  assert.equal(view.reply, ''); assert.equal(view.silent, true); assert.equal(view.silent_reason, '群友在闲聊午饭');
  // A message that @-mentions the assistant must be answered: the tool is not offered, and a call is refused.
  bodies.length = 0;
  f.modelState.respond = async (body, res) => { bodies.push(body); return bodies.length === 1 ? call(res, 'stay_silent') : say(res, '这是对 @ 的回答'); };
  const mention = await post(f.h, f.id, inGroup('帮我看看 PR'));
  assert.equal((await done(f, mention)).state, 'completed');
  assert.ok(!offered(bodies[0]).includes('stay_silent')); assert.doesNotMatch(bodies[0].messages[0].content, /stay_silent/);
  assert.deepEqual(toolResults(bodies[1]), [{ error: 'tool_not_allowed' }]);
  await until(() => sent(f).some(s => s.includes('这是对 @ 的回答')));
});

test('stay_silent is refused once a merged message mentions the assistant, and the turn answers it (#489)', async t => {
  const f = await group(t), held = gate(t); let executing = false; const bodies = [];
  f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '没有相关内容' }; };
  f.modelState.respond = async (body, res) => {
    bodies.push(body);
    if (bodies.length === 1) return call(res, 'start_own_task', { request: '看看群里在聊什么' });
    if (bodies.length === 2) return call(res, 'stay_silent', {}, '（无需回复）');
    return say(res, '王成照：最近一次失败是 lint。');
  };
  const chat = await post(f.h, f.id, ambient('今天天气怎么样'));
  await until(() => executing);
  const mention = await post(f.h, f.id, inGroup('最近一次失败是什么？', 'ou_alice')); assert.equal(row(f, mention).state, 'merged');
  held.release(); await done(f, chat); await done(f, mention);
  assert.equal(bodies.length, 3);
  assert.equal(toolResults(bodies[2]).at(-1).error, 'reply_required');
  const delivered = await until(() => sent(f).find(s => s.includes('最近一次失败是 lint')));
  assert.doesNotMatch(delivered, /无需回复/);
  const view = (await f.admin(`/api/channels/chats/${f.chat.id}/timeline`)).value.conversation.turns[0];
  assert.equal(view.silent, undefined); assert.match(view.reply, /最近一次失败是 lint/);
});

test('a group timer with nothing to report ends silently through stay_silent; its run is recorded as silent (#489)', async t => {
  const f = await group(t, 'mentions'); const bodies = [];
  f.modelState.respond = async (body, res) => { bodies.push(body); return call(res, 'stay_silent', { reason: '今天没有新的失败' }, '（今天没有需要报告的内容）'); };
  const schedule = (await f.admin(`/api/channels/chats/${f.chat.id}/schedules`, 'POST', { name: '巡检', prompt: '有新的失败才报告，没有就保持安静。', timezone: 'UTC', interval_minutes: 5 })).value.schedule;
  await f.admin(`/api/channels/schedules/${schedule.id}/run`, 'POST', {});
  const run = await until(() => f.h.store.get('SELECT * FROM channel_schedule_runs WHERE schedule_id=?', schedule.id), r => r && r.state !== 'running');
  assert.equal(run.state, 'silent', run.error); assert.equal(run.outbox_id, null);
  assert.equal(bodies.length, 1); assert.ok(offered(bodies[0]).includes('stay_silent'));
  assert.match(JSON.parse(bodies[0].messages[1].content).request, /请调用 stay_silent 结束，不要回复任何文字/);
  assert.match(bodies[0].messages[0].content, /started by one of this group's timers/);
  await f.service.tick(); assert.deepEqual(sent(f).filter(s => s.includes('巡检')), []);
});

test('only a private timer may end silently; a message from the person is always answered (#489)', async t => {
  const f = await channelFixture(t), chat = await privateChat(f); const bodies = [];
  f.modelState.respond = async (body, res) => { bodies.push(body); return call(res, 'stay_silent', { reason: '没有失败的任务' }, '（无需通知）'); };
  const schedule = (await f.admin(`/api/channels/chats/${chat.id}/schedules`, 'POST', { name: '每日汇总', prompt: '有失败的任务才告诉我。', timezone: 'UTC', interval_minutes: 60 })).value.schedule;
  await f.admin(`/api/channels/schedules/${schedule.id}/run`, 'POST', {});
  const run = await until(() => f.h.store.get('SELECT * FROM channel_schedule_runs WHERE schedule_id=?', schedule.id), r => r && r.state !== 'running');
  assert.equal(run.state, 'silent', run.error);
  assert.equal(bodies.length, 1); assert.ok(offered(bodies[0]).includes('stay_silent'));
  assert.match(bodies[0].messages[0].content, /sent by one of the user's timers/); assert.match(bodies[0].messages[0].content, /call stay_silent/);
  const reply = JSON.parse(f.h.store.get("SELECT data FROM management_events WHERE message_id=? AND type='reply'", run.message_id).data);
  assert.equal(reply.text, ''); assert.equal(reply.silent, true); assert.equal(reply.reason, '没有失败的任务');
  await f.service.tick(); assert.deepEqual(sent(f).filter(s => s.includes('每日汇总') || s.includes('无需通知')), []);
  // The person's own message: no stay_silent offered, a call is refused as an unknown tool and the assistant answers.
  bodies.length = 0;
  f.modelState.respond = async (body, res) => { bodies.push(body); return bodies.length === 1 ? call(res, 'stay_silent') : say(res, '你好，我在。'); };
  const hello = await post(f.h, f.id, envelope('你好'));
  await finished(f.h, hello.value.operation_id);
  assert.ok(!offered(bodies[0]).includes('stay_silent')); assert.doesNotMatch(bodies[0].messages[0].content, /stay_silent/);
  assert.deepEqual(toolResults(bodies[1]), [{ error: 'tool_not_allowed' }]);
  await until(() => sent(f).some(s => s.includes('你好，我在。')));
});
