import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, repositoryAssistant, inGroup, envelope, post, until } from '../../../fixtures/channel-fixture.mjs';

// Scenarios per group working mode (participation): which messages show the processing indicator, which reach the model, and
// what the model is told about its mode. Feishu and the model are local protocol fixtures.
const say = (res, content) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); };
const call = (res, name) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: 'step', type: 'function', function: { name, arguments: '{}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); };
const incoming = body => body.messages.filter(m => m.role === 'user').map(m => { try { return JSON.parse(m.content); } catch { return {}; } }).filter(m => m.incoming_during_turn);
const row = (f, receipt) => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?', receipt.value.operation_id);
const done = (f, receipt) => until(() => row(f, receipt), r => ['completed', 'failed'].includes(r?.state));
const id = event => event.event.message.message_id;
const reacted = (f, event, method = 'POST') => f.wire.state.reactionRequests.some(r => r.method === method && r.message === id(event));
// A group message without an @: no mention and no @ placeholder in its text.
const chat = (text, actor = 'ou_alice') => { const e = inGroup(text, actor); e.event.message.mentions = []; e.event.message.content = JSON.stringify({ text }); return e; };
async function group(t, mode) {
  const f = await channelFixture(t); await repositoryAssistant(f); f.chat = await boundGroup(f);
  const binding = f.service.serviceBindings.get(f.chat.id);
  if (mode !== 'mentions') assert.equal((await f.admin(`/api/channels/chats/${f.chat.id}/service-binding`, 'PUT', {
    scope: { kind: 'repositories', repositories: ['101'] }, participation: mode, enabled: true, expected_revision: binding.revision })).status, 200);
  return f;
}
// Holds the turn in a tool so that later messages arrive while it runs.
function hold(t, f) {
  let release, running = false; const gate = new Promise(r => { release = r; }); t.after(() => release());
  f.service.serviceSessions.own.invoke = async () => { running = true; await gate; return { conclusion: '已查完' }; };
  return { running: () => running, release };
}

test('mention-only group: chat without an @ during a turn reaches the assistant without a processing indicator (#458)', async t => {
  const f = await group(t, 'mentions'), tool = hold(t, f); let calls = 0, first, second;
  f.modelState.respond = async (body, res) => { calls++; if (calls === 1) { first = body; return call(res, 'start_own_task'); } second = body; return say(res, '李雷：统计已完成。韩梅梅：PR #12 仍在等待检视。'); };
  const request = inGroup('接着查吧', 'ou_alice'), initial = await post(f.h, f.id, request);
  await until(() => tool.running());
  // The requester chats without an @ (the reported case), then someone else @-mentions the assistant.
  const weather = chat('今天天气怎么样'), cold = chat('早上好冷啊'), question = inGroup('顺便看下 PR #12', 'ou_bob');
  const receipts = [];
  for (const event of [weather, cold, question]) { const receipt = await post(f.h, f.id, event); receipts.push(receipt); assert.equal(row(f, receipt).state, 'merged'); }
  await until(() => reacted(f, question));
  tool.release(); await done(f, initial); for (const receipt of receipts) await done(f, receipt);
  assert.match(first.messages[0].content, /Working mode of this group: you answer only when someone @-mentions you\./);
  const batch = incoming(second)[0];
  assert.deepEqual(batch.messages.map(m => [m.content, m.is_direct_mention, m.group_setting_invites_reply, m.same_sender_as_request]),
    [['今天天气怎么样', false, false, true], ['早上好冷啊', false, false, true], ['@ou_bot 顺便看下 PR #12', true, true, false]]);
  // Indicators: the two calls only, cleared with the final answer; the chat never gets one.
  await until(() => reacted(f, request, 'DELETE') && reacted(f, question, 'DELETE'));
  assert.deepEqual(f.wire.state.reactionRequests.filter(r => r.method === 'POST').map(r => r.message).sort(), [id(request), id(question)].sort());
  for (const event of [weather, cold]) assert.equal(reacted(f, event), false);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_reactions').n, 2);
  // Everything was answered in the one turn; the chat does not start turns of its own.
  assert.equal(calls, 2); assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n, 1);
});

test('mention-only group: chat without an @ while the assistant is idle stays in the ledger only (#458)', async t => {
  const f = await group(t, 'mentions'); let calls = 0;
  f.modelState.respond = async (_body, res) => { calls++; say(res, 'unexpected'); };
  const receipt = await post(f.h, f.id, chat('今天天气怎么样'));
  assert.equal(receipt.value.state, 'completed'); await f.service.tick(); await f.service.reactions.tick();
  assert.equal(calls, 0); assert.equal(f.wire.state.reactionRequests.length, 0);
});

for (const mode of ['all', 'questions']) test(`${mode === 'all' ? 'all-messages' : 'questions'} group: only an @ gets a processing indicator, the assistant is told its mode (#458)`, async t => {
  const f = await group(t, mode), tool = hold(t, f); let calls = 0, first, second;
  f.modelState.respond = async (body, res) => { calls++; if (calls === 1) { first = body; return call(res, 'start_own_task'); } second = body; return say(res, '韩梅梅：CI 已恢复。'); };
  const start = chat('CI 怎么又挂了？'), initial = await post(f.h, f.id, start);
  await until(() => tool.running());
  const aside = chat('早上好冷啊', 'ou_carol'), call_ = inGroup('也帮我看下 CI 吧？', 'ou_bob');
  const receipts = [await post(f.h, f.id, aside), await post(f.h, f.id, call_)];
  tool.release(); await done(f, initial); for (const receipt of receipts) await done(f, receipt);
  assert.match(first.messages[0].content, mode === 'all' ? /Working mode of this group: you see every message, without an @\./
    : /Working mode of this group: besides messages that @-mention you, you see group messages that ask someone for something/);
  assert.match(first.messages[0].content, /This message did not mention you\./);
  // Both merged messages reach the model: whether to answer them is its call.
  assert.deepEqual(incoming(second)[0].messages.map(m => [m.is_direct_mention, m.group_setting_invites_reply]), [[false, mode === 'all'], [true, true]]);
  // Only the @ message is acknowledged, and its indicator is cleared with the answer; messages the assistant merely reads
  // in this mode are never marked, so the bot does not mark people's ongoing conversation.
  await until(() => reacted(f, call_, 'POST') && reacted(f, call_, 'DELETE'));
  assert.deepEqual(f.wire.state.reactionRequests.map(r => r.message).filter((m, i, all) => all.indexOf(m) === i), [id(call_)]);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_reactions').n, 1);
});

test('a private message still shows the processing indicator until its answer is delivered (#458)', async t => {
  const f = await channelFixture(t);
  f.modelState.respond = async (_body, res) => say(res, '已回答。');
  const event = envelope('帮我看看项目'), receipt = await post(f.h, f.id, event);
  await done(f, receipt);
  await until(() => reacted(f, event, 'POST') && reacted(f, event, 'DELETE'), Boolean, 20000);
});

// #534: the mode that answers questions judged a message by a question mark at its very end alone, so "这个怎么弄？谢谢" and
// "这个怎么办" got no reply at all. A question mark anywhere outside links and code now counts, and so does a narrow set of
// interrogatives and requests for help; ordinary statements and acknowledgements still never start a turn.
test('questions mode: a question mark anywhere in the message starts a real turn (#534)', async t => {
  const f = await group(t, 'questions'), requests = [];
  f.modelState.respond = async (body, res) => { requests.push(body); say(res, '先看 migrate 步骤的日志。'); };
  const receipt = await post(f.h, f.id, chat('这个怎么弄？谢谢'));
  await done(f, receipt);
  assert.equal(row(f, receipt).state, 'completed');
  // The turn really ran: the model was asked with this exact text and the answer was sent. The old early return at
  // service.ts:613 completed the row without either, which is why asserting only the inbox state stayed green.
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].messages[1].content).request, '这个怎么弄？谢谢');
  await until(() => f.wire.sent.some(sent => JSON.stringify(sent).includes('先看 migrate 步骤的日志。')));
});

test('questions mode: a question mark in the middle alone starts a real turn (#534)', async t => {
  const f = await group(t, 'questions'), requests = [];
  f.modelState.respond = async (body, res) => { requests.push(body); say(res, '这版可以，先跑一遍回归。'); };
  // No interrogative word and no sentence-final mark: the mark right there in the middle is the only thing that makes this
  // a question. Anchoring QUESTION back to the end leaves every other case green and turns this one red.
  const receipt = await post(f.h, f.id, chat('这版可行？谢谢'));
  await done(f, receipt);
  assert.equal(row(f, receipt).state, 'completed');
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].messages[1].content).request, '这版可行？谢谢');
  await until(() => f.wire.sent.some(sent => JSON.stringify(sent).includes('这版可以，先跑一遍回归。')));
});

test('questions mode: the sentence particle alone starts a real turn, a word containing it does not (#534)', async t => {
  const f = await group(t, 'questions'), requests = [];
  f.modelState.respond = async (body, res) => { requests.push(body); say(res, '可以发。'); };
  // "这版能发吗" asks with no question mark and no other interrogative: only the particle at the end makes it a question, so
  // turning PARTICLE off drops this case and leaves the others green. "吗啡" is a word that merely contains 吗.
  const asked = await post(f.h, f.id, chat('这版能发吗'));
  await done(f, asked);
  assert.equal(row(f, asked).state, 'completed');
  assert.deepEqual(requests.map(body => JSON.parse(body.messages[1].content).request), ['这版能发吗']);
  const word = await post(f.h, f.id, chat('吗啡'));
  await until(() => row(f, word)?.state === 'completed');
  await f.service.tick();
  assert.equal(requests.length, 1);
});

test('questions mode: a request for help without punctuation starts a real turn (#534)', async t => {
  const f = await group(t, 'questions'), requests = [];
  f.modelState.respond = async (body, res) => { requests.push(body); say(res, '先看 migrate 步骤的日志。'); };
  for (const text of ['这个怎么办', '报错了，帮我看下']) {
    const receipt = await post(f.h, f.id, chat(text));
    await done(f, receipt);
    assert.equal(row(f, receipt).state, 'completed', text);
  }
  assert.deepEqual(requests.map(body => JSON.parse(body.messages[1].content).request), ['这个怎么办', '报错了，帮我看下']);
  await until(() => f.wire.sent.filter(sent => JSON.stringify(sent).includes('先看 migrate 步骤的日志。')).length === 2);
});

test('questions mode: a message during a running turn is reported as one that would start a reply (#534)', async t => {
  const f = await group(t, 'questions'), tool = hold(t, f); let calls = 0, second;
  f.modelState.respond = async (body, res) => { calls++; if (calls === 1) return call(res, 'start_own_task'); second = body; return say(res, '收到。'); };
  const initial = await post(f.h, f.id, chat('这个怎么弄？'));
  await until(() => tool.running());
  const follow = await post(f.h, f.id, chat('报错了，帮我看下'));
  assert.equal(row(f, follow).state, 'merged');
  tool.release(); await done(f, initial); await done(f, follow);
  const batch = incoming(second)[0];
  assert.deepEqual(batch.messages.map(m => [m.content, m.group_setting_invites_reply]), [['报错了，帮我看下', true]]);
});

test('questions mode: a message waiting while a turn starts is merged as one that would start a reply (#534)', async t => {
  const f = await group(t, 'questions');
  let release; const gate = new Promise(r => { release = r; });
  // Hold the turn between claiming the chat and opening it, so the second message is still queued when the turn opens.
  f.service.renewal = () => gate;
  let calls = 0, second;
  f.modelState.respond = async (body, res) => { calls++; if (calls === 1) return call(res, 'start_own_task'); second = body; return say(res, '收到。'); };
  const initial = await post(f.h, f.id, chat('这个怎么弄？'));
  await until(() => f.service.business.has(f.chat.id));
  const follow = await post(f.h, f.id, chat('报错了，帮我看下'));
  assert.equal(row(f, follow).state, 'queued');
  release(); await done(f, initial); await done(f, follow);
  // needsReply (service.ts:609) sets this flag when the turn captures a message that was still queued. Reverting it to the
  // old end-anchored regex still merges the message but reports false, so the incoming batch is what covers that call site.
  const batch = incoming(second)[0];
  assert.deepEqual(batch.messages.map(m => [m.content, m.group_setting_invites_reply]), [['报错了，帮我看下', true]]);
});

test('questions mode: an ordinary statement stays in the ledger only (#534)', async t => {
  const f = await group(t, 'questions'); let calls = 0;
  f.modelState.respond = async (_body, res) => { calls++; say(res, 'unexpected'); };
  // A bare 呢/哪 is not a question, and a link or inline code must not count just because it contains "?".
  for (const text of ['今天天气不错', '收到', '好的', '报错了', '我还以为他走了呢', '哪怕只有一次机会也要试', '他在家呢很忙',
    '无论如何', '不管怎么样', '这就是为什么我们要先发版', '我看下日志再回复你',
    '文档在 https://example.com/?tab=readme 里', '文档在 example.com/docs?x=1 里', '日志里写着 `怎么启动`']) {
    const receipt = await post(f.h, f.id, chat(text));
    assert.equal(receipt.value.state, 'completed', text);
  }
  await f.service.tick(); await f.service.reactions.tick();
  assert.equal(calls, 0); assert.equal(f.wire.state.reactionRequests.length, 0);
});
