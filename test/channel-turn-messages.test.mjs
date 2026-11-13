import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, repositoryAssistant, inGroup, envelope, post, until } from './channel-fixture.mjs';
import { AssistantComputer } from '../dist/service-roles/assistant-computers.js';

const say = (res, content) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const call = (res, name) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: 'step', type: 'function', function: { name, arguments: '{}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const incoming = body => body.messages.filter(m => m.role === 'user').map(m => { try { return JSON.parse(m.content); } catch { return {}; } }).filter(m => m.incoming_during_turn);
const row = (f, receipt) => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?', receipt.value.operation_id);
const done = (f, receipt) => until(() => row(f, receipt), r => ['completed', 'failed'].includes(r?.state));
const sent = f => f.wire.sent.map(s => JSON.stringify(s.content));
const indicator = (f, receipt, state) => until(() => f.h.store.get('SELECT state FROM channel_reactions WHERE source_event=?', receipt.value.operation_id), r => r?.state === state);
async function group(t) { const f = await channelFixture(t); await repositoryAssistant(f); f.chat = await boundGroup(f); return f; }
function gate(t) { let release; const wait = new Promise(r => { release = r; }); t.after(() => release()); return { wait, release }; }
const chunk = (res, delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
const streamEnd = res => { chunk(res, {}, 'stop'); res.end('data: [DONE]\n\n'); };
function observeOutput(f, signal, personal = false) {
  const target = personal ? f.service.management : f.service.serviceSessions, open = target.incomingMessages;
  target.incomingMessages = (...args) => {
    const feed = open(...args);
    return feed && { ...feed, pause: () => { feed.pause(); signal.release(); } };
  };
}

for (const personal of [false, true]) test(`${personal ? 'private' : 'group'} final output queues late messages without interrupting reasoning or output and without regeneration (#458)`, async t => {
  const f = personal ? await channelFixture(t) : await group(t), thinking = gate(t), output = gate(t), beginOutput = gate(t), endOutput = gate(t);
  const send = text => post(f.h, f.id, personal ? envelope(text) : inGroup(text));
  let calls = 0; observeOutput(f, output, personal);
  f.modelState.respond = async (body, res) => {
    calls++;
    if (calls > 1) { assert.ok(String(JSON.parse(body.messages[1].content).request).endsWith('思考期间的问题')); return say(res, '下一回合处理晚到的两个问题'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); chunk(res, { reasoning_content: '正在思考' }); thinking.release();
    await beginOutput.wait; chunk(res, { content: '原问题的' });
    await endOutput.wait; chunk(res, { content: '最终答案' }); streamEnd(res);
  };
  const initial = await send('原问题'); await thinking.wait;
  const duringThinking = await send('思考期间的问题'); assert.equal(row(f, duringThinking).state, 'merged'); assert.equal(calls, 1);
  beginOutput.release(); await output.wait;
  const outputEvent = personal ? envelope('输出期间的问题') : inGroup('输出期间的问题');
  const duringOutput = await post(f.h,f.id,outputEvent); assert.equal(row(f, duringOutput).state, 'queued'); assert.equal(calls, 1);
  assert.equal((await post(f.h,f.id,outputEvent)).value.duplicate, true);
  endOutput.release(); await done(f, initial); await done(f, duringThinking); await done(f, duringOutput);
  await until(() => sent(f).some(s => s.includes('原问题的最终答案')));
  assert.equal(calls, 2);
  assert.equal(f.h.store.get(`SELECT count(*) n FROM ${personal ? 'management_messages' : 'channel_service_turns'}`).n, 2);
});

test('a text preamble followed by a tool call resumes admission and incorporates messages in receipt order (#458)', async t => {
  const f = await group(t), output = gate(t), finishTool = gate(t), executing = gate(t), tool = gate(t); let calls = 0;
  observeOutput(f, output);
  f.service.serviceSessions.own.invoke = async () => { executing.release(); await tool.wait; return { conclusion: '工具完成' }; };
  f.modelState.respond = async (body, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); chunk(res, { content: '先核对一下' }); await finishTool.wait;
      chunk(res, { tool_calls: [{ index: 0, id: 'tool', type: 'function', function: { name: 'start_own_task', arguments: '{}' } }] }, 'tool_calls');
      return res.end('data: [DONE]\n\n');
    }
    assert.deepEqual(incoming(body)[0].messages.map(m => m.message_id), [older.event.message.message_id, newer.event.message.message_id]);
    return say(res, '自然的下一步已综合两个问题');
  };
  const initial = await post(f.h, f.id, inGroup('开始')); await output.wait;
  const older = inGroup('先到的问题'), a = await post(f.h, f.id, older); assert.equal(row(f, a).state, 'queued');
  finishTool.release(); await executing.wait;
  const newer = inGroup('后到的问题'), b = await post(f.h, f.id, newer); assert.equal(row(f, b).state, 'merged');
  tool.release(); await done(f, initial); await done(f, a); await done(f, b);
  assert.equal(calls, 2); assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n, 1);
  assert.equal(f.service.turnMessages.replyEvent(row(f, initial).message_id).message_id, newer.event.message.message_id);
});

test('an empty model answer closes admission at its finish marker before delayed usage or platform work (#458)', async t => {
  const f = await group(t), finished = gate(t), trailer = gate(t); let calls = 0;
  const binding = f.service.serviceBindings.get(f.chat.id);
  await f.admin(`/api/channels/chats/${f.chat.id}/service-binding`, 'PUT', { service_role_id: binding.service_role_id,
    scope: { kind:'repositories', repositories:['101'] }, participation:'all', enabled:true, expected_revision:binding.revision });
  observeOutput(f,finished);
  f.modelState.respond = async (_body,res) => {
    calls++;
    if (calls > 1)return say(res,'新问题在下一回合处理');
    res.writeHead(200,{'Content-Type':'text/event-stream'});chunk(res,{},'stop');
    await trailer.wait;res.end('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:0}})+'\n\ndata: [DONE]\n\n');
  };
  const quiet = inGroup('未提及且允许保持安静');quiet.event.message.mentions=[];
  const initial = await post(f.h,f.id,quiet);await finished.wait;
  const extra = await post(f.h,f.id,inGroup('结束之后的新问题'));
  assert.equal(row(f,extra).state,'queued');assert.equal(calls,1);trailer.release();
  await done(f,initial);await done(f,extra);assert.equal(calls,2);
});

test('verified self mentions stay distinct from ambient participation and same-name other targets (#458, #460)', async t => {
  const f = await group(t), held = gate(t); let executing = false, calls = 0;
  const binding = f.service.serviceBindings.get(f.chat.id);
  assert.equal((await f.admin(`/api/channels/chats/${f.chat.id}/service-binding`, 'PUT', { service_role_id: binding.service_role_id,
    scope: { kind: 'repositories', repositories: ['101'] }, participation: 'all', enabled: true, expected_revision: binding.revision })).status, 200);
  f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '核对完成' }; };
  f.modelState.respond = async (body, res) => {
    calls++; if (calls === 1) { assert.equal(JSON.parse(body.messages[1].content).context.current_message.is_direct_mention,true); return call(res,'start_own_task'); }
    const batch = incoming(body)[0];
    assert.deepEqual(batch.messages.map(m => m.is_direct_mention), [true,false,false]);
    assert.deepEqual(batch.messages.map(m => m.mentions), normalized);
    // Participation only hints; whether a message concerns the assistant is the model's call.
    assert.deepEqual(batch.messages.map(m => m.group_setting_invites_reply), [true,true,true]); return say(res,'按是否 @ 区分后回答');
  };
  const initial = await post(f.h,f.id,inGroup('开始')); await until(() => executing);
  const self = inGroup('直接呼叫'); self.event.message.mentions[0].name = 'SameName';
  const literal = inGroup(''); literal.event.message.mentions = []; literal.event.message.content = JSON.stringify({text:'@SameName 无真实提及'});
  const other = inGroup('提及其他人'); other.event.message.mentions[0] = {key:'@_user_1',id:{open_id:'ou_peer'},name:'SameName'};
  const normalized = [[{key:'@_user_1',actor_id:'ou_bot',name:'SameName',is_self:true}],[],[{key:'@_user_1',actor_id:'ou_peer',name:'SameName',is_self:false}]];
  const receipts = [];
  for (const [i,event] of [self,literal,other].entries()) {
    const receipt = await post(f.h,f.id,event); receipts.push(receipt);
    const source = row(f,receipt), payload = f.service.turnMessages.event(source);
    // The boundary accepts the normalized mention contract shared with the transport, never name-based addressing.
    payload.mentions = normalized[i];
    f.h.store.run('UPDATE channel_inbox SET payload=? WHERE id=?',f.h.store.secrets.seal(payload,'channel-event:'+source.id),source.id);
    assert.equal(source.state,'merged');
  }
  held.release(); await done(f,initial); for (const receipt of receipts)await done(f,receipt);
  assert.equal(calls,2);
  const view = (await f.admin(`/api/channels/chats/${f.chat.id}/timeline`)).value.conversation.turns[0];
  assert.deepEqual(view.incoming_messages.map(m => m.is_direct_mention),[true,false,false]);
});

test('the model byte budget leaves unseen inputs durable without imposing a turn message limit (#458)', async t => {
  const f = await group(t); clearInterval(f.service.timer);
  const feed = f.service.turnMessages.open(f.chat,'budget-turn',f.chat.id,'initial',{needsReply:()=>true,guard:(source,event)=>f.service.employees.currentMessage(f.chat,event)});
  const receipts = [];
  for (let i = 0;i < 3;i++) {
    const event = inGroup(String(i)+'x'.repeat(1000));
    receipts.push(await post(f.h,f.id,event));
  }
  assert.equal(feed.take(1800).content.messages.length,1);
  assert.equal(feed.take(1800).content.messages.length,1);
  feed.finish(); f.service.turnMessages.complete('budget-turn');
  assert.deepEqual(receipts.map(r=>row(f,r).state),['completed','completed','queued']);
  assert.deepEqual(f.service.turnMessages.list('budget-turn').map(m=>m.state),['answered','answered','released']);
});

test('messages during a tool are injected together at the next step with their facts, acknowledged and deduplicated (#458)', async t => {
  const f = await group(t), tool = gate(t); let executing = false;
  // Hold an actual tool, not a model request, to exercise receipt-time merging independently of the worker tick.
  f.service.serviceSessions.own.invoke = async () => { executing = true; await tool.wait; return { conclusion: '范围已核对' }; };
  let calls = 0;
  f.modelState.respond = async (body, res) => {
    calls++;
    if (calls === 1) return call(res, 'start_own_task');
    const additions = incoming(body); assert.equal(additions.length, 1);
    assert.deepEqual(additions[0].messages.map(m => m.sender_id), ['ou_bob', 'ou_alice', 'ou_alice']);
    assert.deepEqual(additions[0].messages.map(m => m.same_sender_as_request), [false, true, true]);
    assert.match(additions[0].messages[1].content, /算了不用查了/);
    assert.deepEqual(additions[0].messages.map(m => [m.is_direct_mention, m.group_setting_invites_reply]), [[true, true], [true, true], [false, false]]);
    assert.equal(additions[0].messages[2].content, '旁边的讨论');
    assert.match(additions[0].notice, /not necessarily addressed to you/);
    return say(res, 'Bob：范围已核对。Alice：已停止后续查询。');
  };
  const initial = await post(f.h, f.id, inGroup('查一下项目'));
  await until(() => executing);
  const secondEvent = inGroup('也看看我的问题', 'ou_bob'), second = await post(f.h, f.id, secondEvent);
  const cancel = await post(f.h, f.id, inGroup('算了不用查了', 'ou_alice'));
  const discussion = inGroup('旁边的讨论'); discussion.event.message.content = JSON.stringify({ text: '旁边的讨论' }); discussion.event.message.mentions = [];
  const reference = await post(f.h, f.id, discussion);
  for (const item of [second, cancel, reference]) assert.equal(row(f, item).state, 'merged');
  assert.equal((await post(f.h, f.id, { ...secondEvent, header: { ...secondEvent.header, event_id: 'redelivered' } })).value.duplicate, true);
  // In a mention-only group the @ messages show the processing indicator; the merged message without an @ is taken in silently.
  for (const item of [initial, second, cancel]) await indicator(f, item, 'active');
  assert.deepEqual(f.wire.state.reactionRequests.filter(r => r.method === 'POST').map(r => r.message).sort(),
    [initial, second, cancel].map(item => f.service.turnMessages.event(row(f, item)).message_id).sort());
  tool.release(); await done(f, initial); await done(f, second); await done(f, cancel);
  await until(() => sent(f).some(s => s.includes('已停止后续查询')));
  assert.equal(calls, 2); assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n, 1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_reactions').n, 3, 'only the @ messages get acknowledgements');
  // The final answer clears them together.
  for (const item of [initial, second, cancel]) await indicator(f, item, 'done');
  assert.deepEqual(f.wire.state.reactionRequests.filter(r => r.method === 'DELETE').map(r => r.message).sort(),
    [initial, second, cancel].map(item => f.service.turnMessages.event(row(f, item)).message_id).sort());
  const outbox = f.h.store.get("SELECT * FROM channel_outbox WHERE idempotency_key=?", initial.value.operation_id + ':business-result');
  assert.equal(f.h.store.secrets.open(outbox.payload, 'channel-outbox:' + outbox.id).delivery.reply_to, f.service.turnMessages.replyEvent(row(f, initial).message_id).message_id);
  const view = (await f.admin(`/api/channels/chats/${f.chat.id}/timeline`)).value.conversation.turns[0];
  assert.deepEqual(view.incoming_messages.map(m => [m.needs_reply, m.state]), [[true, 'answered'], [true, 'answered'], [false, 'answered']]);
});

for (const personal of [false, true]) test(`${personal ? 'private' : 'group'} merged questions keep their processing reaction through final delivery retries (#458)`, async t => {
  const f = personal ? await channelFixture(t) : await group(t), held = gate(t); let calls = 0, executing = false;
  const send = event => post(f.h, f.id, event), message = text => personal ? envelope(text) : inGroup(text);
  const own = personal ? f.service.management.own : f.service.serviceSessions.own;
  own.invoke = async () => { executing = true; await held.wait; return { conclusion: '核对完成' }; };
  f.modelState.respond = async (_body, res) => ++calls === 1 ? call(res, 'start_own_task') : say(res, '已回答补充问题');
  const initial = await send(message('开始')); await until(() => executing);
  const extraEvent = message('补充问题'), extra = await send(extraEvent); assert.equal(row(f, extra).state, 'merged');
  await indicator(f, extra, 'active');
  assert.equal((await send(extraEvent)).value.duplicate, true);
  f.wire.state.sendFailures = 1; held.release();
  const outbox = await until(() => f.h.store.get("SELECT * FROM channel_outbox WHERE source_event=? AND state='retry'", initial.value.operation_id));
  assert.equal(row(f, extra).state, 'completed');
  await f.service.reactions.tick(); assert.equal((await indicator(f, extra, 'active')).state, 'active');
  assert.deepEqual(f.wire.state.reactionRequests.filter(r => r.message === extraEvent.event.message.message_id).map(r => r.method), ['POST']);
  f.h.store.run('UPDATE channel_outbox SET next_attempt=0 WHERE id=?', outbox.id);
  await until(() => f.h.store.get('SELECT state FROM channel_outbox WHERE id=?', outbox.id), r => r.state === 'sent');
  await indicator(f, extra, 'done');
  assert.deepEqual(f.wire.state.reactionRequests.filter(r => r.message === extraEvent.event.message.message_id).map(r => r.method), ['POST', 'DELETE']);
  assert.equal(calls, 2);
});

test('a final answer never gains a model step for messages received during generation (#458)', async t => {
  const f = await group(t), held = gate(t); let calls = 0;
  f.modelState.respond = async (body, res) => {
    calls++;
    if (calls === 1) { await held.wait; return say(res, '原问题的最终回答'); }
    assert.ok(String(JSON.parse(body.messages[1].content).request).endsWith('补充问题下一回合处理'));
    assert.equal(incoming(body).length, 0);
    assert.equal(body.messages.some(m => m.role === 'assistant'), false);
    return say(res, '补充问题的新回合回答');
  };
  const initial = await post(f.h, f.id, inGroup('原问题')); await until(() => calls === 1);
  const extra = await post(f.h, f.id, inGroup('补充问题下一回合处理'));
  assert.equal(row(f, extra).state, 'merged');
  clearInterval(f.service.timer); held.release(); await done(f, initial); await f.service.drain();
  assert.equal(calls, 1); assert.equal(row(f, extra).state, 'queued');
  assert.equal(f.h.store.get('SELECT state FROM channel_turn_inputs').state, 'released');
  await f.service.tick(); await done(f, extra); await f.service.tick();
  assert.equal(calls, 2); assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n, 2);
  assert.ok(sent(f).findIndex(s => s.includes('原问题的最终回答')) < sent(f).findIndex(s => s.includes('补充问题的新回合回答')));
});

test('reference-only messages arriving during a final model request never require another request (#458)', async t => {
  const f = await group(t), held = gate(t); let calls = 0;
  f.modelState.respond = async (_body, res) => { calls++; await held.wait; say(res, '当前回答'); };
  const initial = await post(f.h, f.id, inGroup('请回复')); await until(() => calls === 1);
  const ambient = inGroup('天气很好'); ambient.event.message.mentions = []; ambient.event.message.content = JSON.stringify({ text: '天气很好' });
  const extra = await post(f.h, f.id, ambient); assert.equal(row(f, extra).state, 'merged'); held.release();
  await done(f, initial); assert.equal((await done(f, extra)).state, 'completed'); assert.equal(calls, 1);
});

test('private management messages join the natural next step and remain in subsequent history (#458)', async t => {
  const f = await channelFixture(t), held = gate(t); let calls = 0, executing = false;
  f.service.management.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '工具完成' }; };
  f.modelState.respond = async (body, res) => {
    calls++; if (calls === 1) return call(res, 'start_own_task');
    const [message] = incoming(body)[0].messages;
    assert.equal(message.content, '再看看第二个问题'); assert.equal(message.same_sender_as_request, true);
    assert.equal('is_direct_mention' in message, false, 'a private message carries no group mention facts');
    assert.match(body.messages[0].content, /In this private chat they come from the person you serve/);
    return say(res, '两个问题一起回答');
  };
  const initial = await post(f.h, f.id, envelope('第一个问题')); await until(() => executing);
  const e = envelope('再看看第二个问题'), extra = await post(f.h, f.id, e);
  assert.equal(row(f, extra).state, 'merged'); assert.equal((await post(f.h, f.id, e)).value.duplicate, true); held.release();
  await done(f, initial); await done(f, extra); await until(() => sent(f).some(s => s.includes('两个问题一起回答')));
  assert.equal(f.h.store.get('SELECT count(*) n FROM management_messages').n, 1); assert.equal(calls, 2);
  const outbox = f.h.store.get('SELECT * FROM channel_outbox WHERE idempotency_key=?', initial.value.operation_id + ':result');
  assert.equal(f.h.store.secrets.open(outbox.payload, 'channel-outbox:' + outbox.id).delivery.reply_to, e.event.message.message_id);
  f.modelState.respond = async (body, res) => {
    assert.equal(JSON.parse(body.messages[1].content).history.at(-1).incoming_messages[0].content, '再看看第二个问题'); say(res, '保留了补充问题的上下文');
  };
  await done(f, await post(f.h, f.id, envelope('接着刚才的问题')));
});

test('group timers absorb incoming questions and still publish one named timer result (#458)', async t => {
  const f = await group(t), held = gate(t); let calls = 0, executing = false;
  f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '巡检完成' }; };
  f.modelState.respond = async (body, res) => {
    calls++;
    assert.match(body.messages[0].content, /started by one of this group's timers/);
    if (calls === 1) return call(res, 'start_own_task');
    assert.ok(String(incoming(body)[0].messages[0].content).endsWith('也核对一下我的问题')); assert.equal('same_sender_as_request' in incoming(body)[0].messages[0], false);
    return say(res, '定时检查和群友问题均已核对');
  };
  const schedule = (await f.admin(`/api/channels/chats/${f.chat.id}/schedules`, 'POST', { name: '巡检', prompt: '检查项目', timezone: 'UTC', interval_minutes: 5 })).value.schedule;
  await f.admin(`/api/channels/schedules/${schedule.id}/run`, 'POST', {}); await until(() => executing);
  const extraEvent = inGroup('也核对一下我的问题'), extra = await post(f.h, f.id, extraEvent); assert.equal(row(f, extra).state, 'merged');
  await indicator(f, extra, 'active'); f.wire.state.sendFailures = 1; held.release();
  const run = await until(() => f.h.store.get('SELECT * FROM channel_schedule_runs WHERE schedule_id=?', schedule.id), r => r?.state === 'completed');
  await until(() => f.h.store.get('SELECT state FROM channel_outbox WHERE id=?', run.outbox_id), r => r.state === 'retry');
  await f.service.reactions.tick(); assert.equal((await indicator(f, extra, 'active')).state, 'active');
  f.h.store.run('UPDATE channel_outbox SET next_attempt=0 WHERE id=?', run.outbox_id);
  await done(f, extra); await until(() => sent(f).some(s => s.includes('定时检查和群友问题')));
  await indicator(f, extra, 'done');
  assert.deepEqual(f.wire.state.reactionRequests.filter(r => r.message === extraEvent.event.message.message_id).map(r => r.method), ['POST', 'DELETE']);
  const delivery = f.h.store.secrets.open(f.h.store.get('SELECT payload FROM channel_outbox WHERE id=?', run.outbox_id).payload, 'channel-outbox:' + run.outbox_id);
  assert.equal(delivery.delivery.reply_to, undefined); assert.match(JSON.stringify(delivery.delivery.content), /定时任务「巡检」/);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n, 1);
});

test('an active agent accepts more than 32 messages beyond two minutes without interrupting its tool (#458)', async t => {
  const f = await group(t), held = gate(t); let calls = 0, executing = false, clock = Date.now(); f.service.turnMessages.clock = () => clock;
  f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '工具完成' }; };
  f.modelState.respond = async (body, res) => {
    calls++; if (calls === 1) return call(res, 'start_own_task');
    assert.equal(incoming(body)[0].messages.length, 40); return say(res, '所有补充已在原回合处理');
  };
  const initial = await post(f.h, f.id, inGroup('开始')); await until(() => executing);
  for (let i = 0; i < 40; i++) {
    if (i === 1) clock += 10 * 60_000;
    assert.equal((await post(f.h, f.id, inGroup('问题 ' + i))).value.state, 'merged');
  }
  assert.equal(calls, 1, 'receiving messages never interrupts the active tool'); held.release();
  await done(f, initial); await until(() => sent(f).some(s => s.includes('所有补充')));
  assert.equal(calls, 2); assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n, 1);
});

test('a completed agent no longer receives messages while platform cleanup and posting wait (#458)', async t => {
  const f = await group(t), held = gate(t); let calls = 0, cleaning = false;
  const close = AssistantComputer.prototype.close;
  t.mock.method(AssistantComputer.prototype, 'close', async function (...args) {
    if (!cleaning) { cleaning = true; await held.wait; }
    return close.apply(this, args);
  });
  f.modelState.respond = async (_body, res) => { calls++; say(res, calls === 1 ? '已结束但尚未贴出的结果' : '下一个回合'); };
  const initial = await post(f.h, f.id, inGroup('开始')); await until(() => cleaning);
  assert.equal(f.h.store.get('SELECT state FROM channel_service_turns').state, 'completed');
  const extra = await post(f.h, f.id, inGroup('结束后到达'));
  assert.equal(row(f, extra).state, 'queued'); assert.equal(f.h.store.get('SELECT count(*) n FROM channel_turn_inputs').n, 0);
  held.release(); await done(f, initial); await done(f, extra); assert.equal(calls, 2);
});

test('stopping a turn returns its unanswered merged messages to a new turn, while duplicate webhooks stay deduplicated (#458)', async t => {
  const f = await group(t); let calls = 0;
  f.modelState.respond = async (body, res) => {
    calls++; if (calls === 1) return;
    assert.ok(String(JSON.parse(body.messages[1].content).request).endsWith('仍需处理的补充问题')); say(res, '新回合已接手');
  };
  const initial = await post(f.h, f.id, inGroup('会被停止')); await until(() => calls === 1);
  const extraEvent = inGroup('仍需处理的补充问题'), extra = await post(f.h, f.id, extraEvent);
  const turn = f.h.store.get('SELECT * FROM channel_service_turns');
  await f.admin(`/api/channels/chats/${f.chat.id}/service-turns/${turn.id}/stop`, 'POST', {});
  assert.equal((await done(f, initial)).state, 'failed'); assert.equal((await done(f, extra)).state, 'completed');
  assert.equal((await post(f.h, f.id, extraEvent)).value.duplicate, true); assert.equal(calls, 2);
  assert.equal(f.h.store.get('SELECT state FROM channel_turn_inputs WHERE turn_id=?', turn.id).state, 'released');
});

test('restart recovery preserves memberships and returns only required unanswered messages; a redelivered event creates no extra turn (#458)', async t => {
  const f = await group(t);
  // Persist an interrupted membership without an in-process model. This is the state loaded by a fresh process.
  const older = inGroup('重启后接手'); older.event.message.create_time = String(Date.now() - 3_600_000);
  const receipt = await post(f.h, f.id, older), source = row(f, receipt);
  const feed = f.service.turnMessages.open(f.chat, 'lost-turn', f.chat.id, 'lost-source', { needsReply: () => true, guard: () => {} });
  const event = f.service.turnMessages.event(source); event.created_at = Date.now();
  f.h.store.run('UPDATE channel_inbox SET payload=? WHERE id=?', f.h.store.secrets.seal(event, 'channel-event:' + source.id), source.id);
  assert.equal(f.service.turnMessages.merge(f.chat.id, row(f, receipt), true), true); feed.take(); feed.seal();
  await f.h.stop(); await f.h.start();
  assert.equal(row(f, receipt).state, 'queued'); assert.equal(f.h.store.get("SELECT state FROM channel_turn_inputs WHERE turn_id='lost-turn'").state, 'released');
  let calls = 0; f.modelState.respond = async (_body, res) => { calls++; say(res, '已从持久记录接手'); };
  assert.equal((await post(f.h, f.id, older)).value.duplicate, true); assert.equal((await done(f, receipt)).state, 'completed'); assert.equal(calls, 1);
});

test('restart resumes a durable final outbox without reopening completed merged messages (#458)', async t => {
  const f = await group(t), held = gate(t); let calls = 0, executing = false;
  f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '完成' }; };
  f.modelState.respond = async (_body, res) => { calls++; if(calls === 1)return call(res, 'start_own_task'); say(res, '重启后只投递一次'); };
  const initial = await post(f.h, f.id, inGroup('开始')); await until(() => executing);
  const extra = await post(f.h, f.id, inGroup('补充')); clearInterval(f.service.timer); held.release(); await done(f, initial);
  assert.equal(sent(f).some(s => s.includes('重启后只投递一次')), false);
  await f.h.stop(); await f.h.start();
  await until(() => sent(f).some(s => s.includes('重启后只投递一次')));
  assert.equal(row(f, extra).state, 'completed'); assert.equal(calls, 2); assert.equal(sent(f).filter(s => s.includes('重启后只投递一次')).length, 1);
});

test('a changed authorization fence refuses the old draft and recovers merged questions under the current fence (#458)', async t => {
  const f = await group(t), held = gate(t); let calls = 0;
  f.modelState.respond = async (_body, res) => { calls++; if (calls === 1) { await held.wait; say(res, '旧授权下的草稿'); } else say(res, '新授权下接手完成'); };
  const initial = await post(f.h, f.id, inGroup('原问题')); await until(() => calls === 1);
  const extra = await post(f.h, f.id, inGroup('补充问题')); f.h.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', f.chat.id); held.release();
  assert.equal((await done(f, initial)).state, 'failed'); assert.equal((await done(f, extra)).state, 'completed');
  assert.ok(!sent(f).some(s => s.includes('旧授权下的草稿'))); assert.equal(calls, 2);
});

test('queued messages accepted before a turn starts are claimed once and do not leak into recent history or separate turns (#458)', async t => {
  const f = await group(t); clearInterval(f.service.timer); let calls = 0;
  f.modelState.respond = async (body, res) => {
    calls++;
    assert.equal(JSON.parse(body.messages[1].content).context.recent_messages.some(m => String(m.content).includes('预先收到的第二个问题')), false);
    assert.ok(String(incoming(body)[0].messages[0].content).endsWith('预先收到的第二个问题')); say(res, '两个问题只答一遍');
  };
  const initial = await post(f.h, f.id, inGroup('第一个问题')), extra = await post(f.h, f.id, inGroup('预先收到的第二个问题'));
  await f.service.tick(); await done(f, initial); await f.service.tick();
  assert.equal(row(f, extra).state, 'completed'); assert.equal(calls, 1); assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n, 1);
});

for (const kind of ['sensitive', 'recalled']) test(`a ${kind} merged message is never injected or included in a final answer (#458)`, async t => {
  const f = await group(t), held = gate(t); let calls = 0, executing = false;
  f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '完成' }; };
  f.modelState.respond = async (body, res) => { calls++; assert.ok(!JSON.stringify(body).includes('must-stay-private')); return calls===1?call(res, 'start_own_task'):say(res,'原问题正常完成'); };
  const initial = await post(f.h, f.id, inGroup('开始')); await until(() => executing);
  const event = inGroup(kind === 'sensitive' ? 'password=must-stay-private' : '将被撤回的问题'), extra = await post(f.h, f.id, event);
  if (kind === 'recalled') await post(f.h, f.id, { header: { ...event.header, event_id: 'recall-' + event.header.event_id, event_type: 'im.message.recalled_v1' },
    event: { chat_id: 'oc_group', message_id: event.event.message.message_id, recall_time: String(Date.now()) } });
  held.release(); assert.equal((await done(f, initial)).state, 'completed'); assert.equal((await done(f, extra)).state, 'completed');
  assert.equal(calls, 2); assert.ok(!sent(f).some(s => s.includes('不应发出的草稿') || s.includes('must-stay-private')));
});

test('private management stop also returns its merged messages to a new management turn (#458)', async t => {
  const f = await channelFixture(t); let calls = 0;
  f.modelState.respond = async (_body, res) => { calls++; if (calls > 1) say(res, '私聊补充已接手'); };
  const initial = await post(f.h, f.id, envelope('稍后停止')); await until(() => calls === 1);
  const extra = await post(f.h, f.id, envelope('私聊补充问题')), message = row(f, initial);
  assert.equal(row(f, extra).state, 'merged');
  const stopped = await f.admin(`/api/management/conversations/${message.conversation_id}/messages/${message.message_id}/stop`, 'POST', {});
  assert.equal(stopped.status, 201, JSON.stringify(stopped.value));
  assert.equal((await done(f, initial)).state, 'failed'); assert.equal((await done(f, extra)).state, 'completed'); assert.equal(calls, 2);
});

test('a fence change after completion but before delivery returns undelivered merged inputs without replaying the old draft (#458)', async t => {
  const f = await group(t), held = gate(t); let calls = 0, executing = false;
  f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '完成' }; };
  f.modelState.respond = async (_body, res) => { calls++; if (calls === 1) return call(res, 'start_own_task'); say(res, calls < 3 ? '不能交付的旧回答' : '当前范围的新回答'); };
  const initial = await post(f.h, f.id, inGroup('开始')); await until(() => executing);
  const extra = await post(f.h, f.id, inGroup('需要最终送达的补充')); clearInterval(f.service.timer); held.release(); await done(f, initial);
  f.h.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', f.chat.id);
  await f.service.tick(); assert.equal(row(f, extra).state, 'queued');
  await f.service.tick(); await done(f, extra); await f.service.tick();
  assert.equal(calls, 3); assert.ok(!sent(f).some(s => s.includes('不能交付的旧回答'))); assert.ok(sent(f).some(s => s.includes('当前范围的新回答')));
});

async function participation(f, mode) {
  const binding = f.service.serviceBindings.get(f.chat.id);
  assert.equal((await f.admin(`/api/channels/chats/${f.chat.id}/service-binding`, 'PUT', { service_role_id: binding.service_role_id,
    scope: { kind: 'repositories', repositories: ['101'] }, participation: mode, enabled: true, expected_revision: binding.revision })).status, 200);
}
const toPeer = text => { const e = inGroup(text, 'ou_carol'); e.event.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_peer' }, name: 'Bob' }]; return e; };
for (const [answer, merged] of [['', 'peer'], ['CI 日志结论：测试超时', 'peer'], ['', 'mention']])
  test(`a merged message is the model's to judge: ${merged === 'peer' ? 'one to another member' : 'a verified mention'} with ${answer ? 'an answer' : 'an empty answer'} (#458)`, async t => {
    const f = await group(t), held = gate(t); let calls = 0, executing = false, batch;
    await participation(f, 'all');
    f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '日志已读' }; };
    f.modelState.respond = async (body, res) => {
      calls++; if (calls === 1) return call(res, 'start_own_task');
      if (calls === 2) batch = incoming(body)[0]; return say(res, answer);
    };
    const quiet = inGroup('大家看下这个 CI 日志'); quiet.event.message.mentions = [];
    const initial = await post(f.h, f.id, quiet); await until(() => executing);
    const extraEvent = merged === 'peer' ? toPeer('你明天来开会吗？') : inGroup('也看看我的问题', 'ou_bob'), extra = await post(f.h, f.id, extraEvent);
    held.release(); await done(f, initial); await done(f, extra);
    assert.match(batch.notice, /not necessarily addressed to you/);
    assert.deepEqual(batch.messages.map(m => [m.is_direct_mention, m.group_setting_invites_reply]), [[merged === 'mention', true]]);
    if (merged === 'mention') {
      // A verified mention needs an answer, exactly as the same message on its own would.
      assert.equal(row(f, initial).state, 'failed'); assert.equal(f.h.store.get('SELECT error FROM channel_service_turns').error, 'conversation_reply_invalid');
      return;
    }
    // The participation setting would have answered it, but the model decided: no failure, no extra turn.
    assert.equal(row(f, initial).state, 'completed'); assert.equal(row(f, extra).state, 'completed'); assert.equal(calls, 2);
    assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n, 1);
    if (!answer) { await f.service.drain(); assert.equal(f.wire.sent.length, 0, 'silence sends nothing, not a failure card'); return; }
    await until(() => sent(f).some(s => s.includes('测试超时')));
    // No merged message verifiably addressed the assistant, so the answer is not threaded under the message meant for someone else.
    assert.equal(f.wire.sent.at(-1).url.includes(extraEvent.event.message.message_id), false);
    const outbox = f.h.store.get('SELECT * FROM channel_outbox WHERE idempotency_key=?', initial.value.operation_id + ':business-result');
    assert.equal(f.h.store.secrets.open(outbox.payload, 'channel-outbox:' + outbox.id).delivery.reply_to, undefined);
  });

test('speakers are named from the directory first, then the member list; external members keep only their id; the assistant can list members (#458)', async t => {
  const f = await group(t); let calls = 0, first, second;
  f.wire.state.members = [{ member_id_type: 'open_id', member_id: 'ou_alice', tenant_key: 'actor-tenant', name: 'Alice' },
    { member_id_type: 'open_id', member_id: 'ou_carol', tenant_key: 'install-tenant', name: 'Carol（群成员名）' },
    { member_id_type: 'open_id', member_id: 'ou_guest', tenant_key: 'guest-tenant' }];
  f.wire.state.profileName = '卡罗尔';
  const request = inGroup('帮我查下 CI', 'ou_carol'); request.event.sender.tenant_key = 'install-tenant';
  const followup = inGroup('补充：只看 main 分支', 'ou_guest'); followup.event.sender.tenant_key = 'guest-tenant'; followup.event.message.mentions = [];
  Object.assign(followup.event.message, { root_id: request.event.message.message_id, parent_id: request.event.message.message_id });
  f.modelState.respond = async (body, res) => {
    calls++;
    if (calls === 1) { first = body; assert.equal((await post(f.h, f.id, followup)).value.state, 'merged'); return call(res, 'list_chat_members'); }
    second = body; return say(res, '卡罗尔：CI 已核对；关于 main 分支的补充也已看过。');
  };
  const receipt = await post(f.h, f.id, request); await done(f, receipt);
  const context = JSON.parse(first.messages[1].content).context;
  assert.deepEqual([context.current_message.sender_id, context.current_message.sender_name], ['ou_carol', '卡罗尔'], 'the directory name wins over the member list');
  assert.equal(context.recent_messages.find(m => m.sender_id === 'ou_alice').sender_name, 'Alice', 'outside the directory the member list names the sender');
  assert.match(first.messages[0].content, /tell people apart by sender_id/); assert.match(first.messages[0].content, /list_chat_members/);
  // Only the installation's own user is looked up in the directory; external members never are.
  assert.deepEqual(f.wire.state.profileRequests.map(url => decodeURIComponent(new URL(url).pathname.split('/').at(-1))), ['ou_carol']);
  const [merged] = incoming(second)[0].messages;
  assert.deepEqual([merged.sender_id, 'sender_name' in merged, merged.same_sender_as_request, merged.in_request_thread, merged.reply_to_message_id],
    ['ou_guest', false, false, true, request.event.message.message_id]);
  const listed = JSON.parse(second.messages.find(m => m.role === 'tool').content);
  assert.deepEqual(listed.members, [{ id: 'ou_alice', name: 'Alice', external: true }, { id: 'ou_carol', name: '卡罗尔' }, { id: 'ou_guest', external: true }]);
  assert.equal(listed.total, 3); assert.equal(listed.next_offset, null); assert.ok(listed.refreshed_at);
  // The cache answers again without another read within ten minutes; a query filters it.
  const reads = f.wire.state.audienceRequests.filter(url => !url.endsWith('/is_in_chat')).length;
  const roster = await f.service.members.members(f.chat);
  assert.equal(f.wire.state.audienceRequests.filter(url => !url.endsWith('/is_in_chat')).length, reads);
  assert.deepEqual(roster.members.filter(m => m.name?.includes('卡罗')).map(m => m.id), ['ou_carol']);
  const timeline = (await f.admin(`/api/channels/chats/${f.chat.id}/timeline`)).value, view = timeline.conversation.turns[0];
  assert.deepEqual(view.incoming_messages.map(m => [m.sender_id, m.sender_name]), [['ou_guest', undefined]]);
  // The console timeline reads the same cache, without a provider request of its own.
  const profiles = f.wire.state.profileRequests.length;
  assert.equal(timeline.messages.find(m => m.sender_id === 'ou_carol').sender_name, '卡罗尔'); assert.equal(f.wire.state.profileRequests.length, profiles);
  assert.ok(!JSON.stringify(f.h.store.all('SELECT * FROM channel_chat_rosters')).includes('Alice'), 'the cached member list is sealed');
});

test('each merged message allows one more progress message in the turn (#458)', async t => {
  const f = await group(t), held = gate(t); let calls = 0, executing = false, results;
  f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '完成' }; };
  const progress = (res, count) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
    tool_calls: Array.from({ length: count }, (_, i) => ({ id: 'p' + i, type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ text: '发现 ' + i }) } })) } }] })); };
  f.modelState.respond = async (body, res) => {
    calls++;
    if (calls === 1) return call(res, 'start_own_task');
    if (calls === 2) { assert.equal(incoming(body)[0].messages.length, 2); return progress(res, 13); }
    results = body.messages.filter(m => m.role === 'tool').slice(-13).map(m => JSON.parse(m.content)); return say(res, '结论');
  };
  const initial = await post(f.h, f.id, inGroup('开始')); await until(() => executing);
  await post(f.h, f.id, inGroup('补充一')); await post(f.h, f.id, inGroup('补充二')); held.release(); await done(f, initial);
  assert.deepEqual(results.slice(0, 12).map(r => r.sent), Array(12).fill(true));
  assert.deepEqual([results[11].remaining, results[12].error], [0, 'stage_message_limit']);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turn_messages').n, 12);
});

for(const personal of [false,true])test(`${personal?'private':'group'} recalling an already injected supplemental message refreshes only the active input`,async t=>{
  const f=personal?await channelFixture(t):await group(t),first=gate(t),allowFirst=gate(t),second=gate(t),allowSecond=gate(t);let calls=0;
  const target=personal?f.service.management:f.service.serviceSessions;
  target.own.invoke=async()=>({conclusion:'只读旁支已完成'});
  f.modelState.respond=async(body,res)=>{
    calls++;
    if(calls===1){first.release();await allowFirst.wait;return call(res,'start_own_task');}
    if(calls===2){assert.match(JSON.stringify(body),/supplement-to-recall/);second.release();await allowSecond.wait;return say(res,'依赖撤回补充的草稿');}
    assert.ok(!JSON.stringify(body).includes('supplement-to-recall'));
    assert.match(JSON.stringify(body),/recalled/);return say(res,'原问题正常完成');
  };
  const initial=await post(f.h,f.id,personal?envelope('原问题'):inGroup('原问题'));await first.wait;
  const event=personal?envelope('supplement-to-recall'):inGroup('supplement-to-recall'),extra=await post(f.h,f.id,event);
  allowFirst.release();await second.wait;
  await post(f.h,f.id,{header:{...event.header,event_id:'recall-'+event.header.event_id,event_type:'im.message.recalled_v1'},
    event:{chat_id:event.event.message.chat_id,message_id:event.event.message.message_id,recall_time:String(Date.now())}});
  allowSecond.release();assert.equal((await done(f,initial)).state,'completed');assert.equal((await done(f,extra)).state,'completed');
  assert.equal(calls,3);assert.ok(!sent(f).some(text=>text.includes('依赖撤回补充的草稿')));
});
