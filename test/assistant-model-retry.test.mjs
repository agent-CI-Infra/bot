import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, repositoryAssistant, inGroup, post, until } from './channel-fixture.mjs';
import { managementFixture, settled } from './management-fixture.mjs';

// A stalled or failed model request no longer ends an assistant's turn at once: it is retried up to five times (test
// helpers shorten the waits to milliseconds), and a turn that still fails keeps the reason for the console.
const say = (res, content) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const drop = res => res.socket.destroy();
const unavailable = res => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'overloaded' } })); };
const row = (f, receipt) => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?', receipt.value.operation_id);
const done = (f, receipt) => until(() => row(f, receipt), r => ['completed', 'failed'].includes(r?.state));
const sent = f => f.wire.sent.map(s => JSON.stringify(s.content));
async function group(t) { const f = await channelFixture(t); await repositoryAssistant(f); f.chat = await boundGroup(f); return f; }

test('a group turn whose model request gets no response is retried and still answers (#489 follow-up)', async t => {
  const f = await group(t); let calls = 0;
  f.modelState.respond = async (_body, res) => ++calls <= 2 ? drop(res) : say(res, '十个仓库的 Issue 汇总如下。');
  const receipt = await post(f.h, f.id, inGroup('汇总十个仓库的 Issue'));
  assert.equal((await done(f, receipt)).state, 'completed');
  assert.equal(calls, 3);
  await until(() => sent(f).some(s => s.includes('十个仓库的 Issue 汇总如下')));
  const turn = f.h.store.get('SELECT * FROM channel_service_turns');
  assert.equal(turn.state, 'completed'); assert.equal(turn.error_detail, null);
  assert.deepEqual(f.h.store.all("SELECT type FROM channel_service_events WHERE turn_id=? AND type LIKE 'model_%' ORDER BY sequence", turn.id).map(e => e.type),
    ['model_start', 'model_retry', 'model_retry', 'model_done']);
  assert.equal(f.h.store.get("SELECT count(*) n FROM model_requests WHERE state='transport_error'").n, 2);
});

test('a group turn fails only after five retries, and the console shows why (#489 follow-up)', async t => {
  const f = await group(t); let calls = 0;
  f.modelState.respond = async (_body, res) => { calls++; unavailable(res); };
  const receipt = await post(f.h, f.id, inGroup('最近一次 CI 为什么失败'));
  assert.equal((await done(f, receipt)).state, 'failed');
  assert.equal(calls, 6);
  const turn = f.h.store.get('SELECT * FROM channel_service_turns');
  assert.equal(turn.state, 'failed'); assert.equal(turn.error, 'model_http_503');
  assert.match(turn.error_detail, /返回 HTTP 503：overloaded（已自动重试 5 次仍失败）$/);
  assert.equal(f.h.store.get("SELECT count(*) n FROM channel_service_events WHERE turn_id=? AND type='model_retry'", turn.id).n, 5);
  const view = (await f.admin(`/api/channels/chats/${f.chat.id}/timeline`)).value.conversation.turns[0];
  assert.equal(view.error, 'model_http_503'); assert.equal(view.error_detail, turn.error_detail);
  // The group still learns that the assistant could not answer.
  await until(() => sent(f).some(s => s.includes('模型服务暂不可用')));
});

test('a management message drops the text a failed attempt streamed and answers from the retry (#489 follow-up)', async t => {
  const { admin, modelState } = await managementFixture(t); let calls = 0;
  const conversation = (await admin('/api/management/conversations', 'POST', { scope: 'project:101' })).value.conversation.id;
  modelState.respond = async (_body, res) => {
    // The first attempt streams part of an answer, then the connection drops.
    if (++calls === 1) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '半截回答' } }] }) + '\n\n'); setTimeout(() => drop(res), 20); return; }
    say(res, '完整回答');
  };
  const message = (await admin(`/api/management/conversations/${conversation}/messages`, 'POST', { source_message: 'retry-stream', content: '任务进展如何' })).value;
  const result = await settled(admin, conversation, message.id);
  assert.equal(result.messages.find(m => m.id === message.id).state, 'completed');
  const events = result.events.filter(e => e.message_id === message.id), types = events.map(e => e.type);
  assert.ok(types.indexOf('text') < types.indexOf('model_retry') && types.indexOf('model_retry') < types.indexOf('reply'), types.join(','));
  assert.deepEqual({ ...events.find(e => e.type === 'model_retry').data, delay_ms: 'n' }, { retry: 1, retries: 5, error: 'model_unavailable', delay_ms: 'n' });
  assert.equal(events.find(e => e.type === 'reply').data.text, '完整回答');
});

test('a management message that fails through every retry says why (#489 follow-up)', async t => {
  const { admin, modelState } = await managementFixture(t);
  const conversation = (await admin('/api/management/conversations', 'POST', { scope: 'project:101' })).value.conversation.id;
  modelState.failure = 503;
  const message = (await admin(`/api/management/conversations/${conversation}/messages`, 'POST', { source_message: 'retry-fail', content: '任务进展如何' })).value;
  const result = await settled(admin, conversation, message.id);
  assert.equal(result.messages.find(m => m.id === message.id).state, 'failed');
  const failure = result.events.find(e => e.message_id === message.id && e.type === 'error').data;
  assert.equal(failure.error, 'model_http_503'); assert.match(failure.detail, /HTTP 503：Fixture model failure（已自动重试 5 次仍失败）$/);
  assert.equal(result.events.filter(e => e.message_id === message.id && e.type === 'model_retry').length, 5);
});
