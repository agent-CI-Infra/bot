import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, privateChat, repositoryAssistant, envelope, inGroup, post, until, finished } from '../../../fixtures/channel-fixture.mjs';
import { settled } from '../../../fixtures/management-fixture.mjs';

const reply = (res, message) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
};
const say = (res, content) => reply(res, { role: 'assistant', content });
const call = (res, name, args, id = 'call-' + name) => reply(res, {
  role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const observations = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const incoming = body => body.messages.filter(m => m.role === 'user').map(m => { try { return JSON.parse(m.content); } catch { return {}; } }).filter(m => m.incoming_during_turn);
const inboxRow = (f, receipt) => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?', receipt.value.operation_id);
const done = (f, receipt) => until(() => inboxRow(f, receipt), r => ['completed', 'failed'].includes(r?.state));
function gate(t) { let release; const wait = new Promise(r => { release = r; }); t.after(() => release()); return { wait, release }; }
async function group(t) { const f = await channelFixture(t); await repositoryAssistant(f); f.chat = await boundGroup(f); return f; }

const sampleCard = {
  header: { title: '核对摘要', template: 'blue' },
  elements: [{ tag: 'markdown', content: '**状态**：全部正常' }],
};

test('group and private turns expose complete parent_id/reply_to_message_id/root_id/thread_id and never auto-attach reply_to (#1385)', async t => {
  // 1) Group chat: message inside a thread + merged reply from another user in a second thread; no explicit target -> main stream
  const f = await group(t), held = gate(t);
  let calls = 0, executing = false, firstContext, mergedBatch;
  f.service.serviceSessions.own.invoke = async () => { executing = true; await held.wait; return { conclusion: '核对完成' }; };
  f.modelState.respond = async (body, res) => {
    calls++;
    if (calls === 1) {
      firstContext = JSON.parse(body.messages[1].content).context;
      assert.match(body.messages[0].content, /never automatically attaches your replies/i);
      assert.ok(body.tools.some(tool => tool.function.name === 'set_reply_target'));
      return call(res, 'start_own_task', { title: '核对', instruction: '检查状态' });
    }
    if (calls === 2) {
      mergedBatch = incoming(body)[0];
      return call(res, 'send_message', { text: '中途同步给全群' });
    }
    return say(res, '汇总结论：两个问题都已核对。');
  };

  // Seed thread roots in ledger
  const rootA = inGroup('话题A起点', 'ou_alice');
  rootA.event.message.mentions = [];
  rootA.event.message.thread_id = 'omt_alpha';
  await post(f.h, f.id, rootA);

  const reqA = inGroup('帮我看下话题A', 'ou_alice');
  Object.assign(reqA.event.message, {
    parent_id: rootA.event.message.message_id,
    root_id: rootA.event.message.message_id,
    thread_id: 'omt_alpha',
  });
  const receiptA = await post(f.h, f.id, reqA);
  await until(() => executing);

  const rootB = inGroup('话题B起点', 'ou_bob');
  rootB.event.message.mentions = [];
  rootB.event.message.thread_id = 'omt_beta';
  await post(f.h, f.id, rootB);

  const reqB = inGroup('也看下话题B', 'ou_bob');
  Object.assign(reqB.event.message, {
    parent_id: rootB.event.message.message_id,
    root_id: rootB.event.message.message_id,
    thread_id: 'omt_beta',
  });
  const receiptB = await post(f.h, f.id, reqB);
  assert.equal(inboxRow(f, receiptB).state, 'merged');

  held.release();
  assert.equal((await done(f, receiptA)).state, 'completed');
  assert.equal((await done(f, receiptB)).state, 'completed');
  await until(() => f.wire.sent.length >= 2);

  // current_message carries complete source relations
  assert.equal(firstContext.current_message.message_id, reqA.event.message.message_id);
  assert.equal(firstContext.current_message.parent_id, rootA.event.message.message_id);
  assert.equal(firstContext.current_message.reply_to_message_id, rootA.event.message.message_id);
  assert.equal(firstContext.current_message.root_id, rootA.event.message.message_id);
  assert.equal(firstContext.current_message.thread_id, 'omt_alpha');

  // incoming_during_turn carries complete source relations
  const merged = mergedBatch.messages.find(m => m.message_id === reqB.event.message.message_id);
  assert.ok(merged);
  assert.equal(merged.parent_id, rootB.event.message.message_id);
  assert.equal(merged.reply_to_message_id, rootB.event.message.message_id);
  assert.equal(merged.root_id, rootB.event.message.message_id);
  assert.equal(merged.thread_id, 'omt_beta');

  // Neither progress message nor final reply auto-attached reply_to or reply_in_thread
  for (const s of f.wire.sent) {
    assert.ok(s.url.endsWith('/im/v1/messages?receive_id_type=chat_id'), `expected main stream post, got ${s.url}`);
    assert.equal(s.reply_in_thread, undefined);
  }
  // Recorded bot messages in local ledger also keep empty parent_id/root_id/thread_id
  const botRows = f.h.store.all("SELECT parent_id, root_id, thread_id FROM channel_messages WHERE chat_id=? AND sender_type='app'", f.chat.id);
  assert.equal(botRows.length, 2);
  for (const r of botRows) assert.deepEqual({ parent_id: r.parent_id, root_id: r.root_id, thread_id: r.thread_id }, { parent_id: '', root_id: '', thread_id: '' });

  // 2) Private chat: message_source, incoming_during_turn and history expose complete source relations; no auto-attach
  const pf = await channelFixture(t), pHeld = gate(t);
  let pCalls = 0, pExecuting = false, dmFirstCtx, dmMergedBatch, dmNextCtx;
  pf.service.management.own.invoke = async () => { pExecuting = true; await pHeld.wait; return { conclusion: '私聊核对完成' }; };
  pf.modelState.respond = async (body, res) => {
    pCalls++;
    if (pCalls === 1) {
      dmFirstCtx = JSON.parse(body.messages[1].content);
      return call(res, 'start_own_task', { title: '私聊核对', instruction: '查项目' });
    }
    if (pCalls === 2) {
      dmMergedBatch = incoming(body)[0];
      return say(res, '私聊第一轮汇总回复');
    }
    dmNextCtx = JSON.parse(body.messages[1].content);
    return say(res, '私聊第二轮回复');
  };

  const dmRoot = envelope('私聊起点', { message: { create_time: String(Date.now() - 3600000), thread_id: 'omt_dm_1' } });
  await post(pf.h, pf.id, dmRoot);
  const dmReq = envelope('私聊话题提问', {
    message: { parent_id: dmRoot.event.message.message_id, root_id: dmRoot.event.message.message_id, thread_id: 'omt_dm_1' },
  });
  const dmR1 = await post(pf.h, pf.id, dmReq);
  await until(() => pExecuting);

  const dmExtra = envelope('私聊中途补充', {
    message: { parent_id: dmReq.event.message.message_id, root_id: dmRoot.event.message.message_id, thread_id: 'omt_dm_1' },
  });
  const dmR2 = await post(pf.h, pf.id, dmExtra);
  assert.equal(inboxRow(pf, dmR2).state, 'merged');
  pHeld.release();
  assert.equal((await done(pf, dmR1)).state, 'completed');
  assert.equal((await done(pf, dmR2)).state, 'completed');
  await until(() => pf.wire.sent.length >= 1);

  assert.deepEqual(dmFirstCtx.message_source, {
    kind: 'feishu_private_chat',
    chat_name: null,
    message_id: dmReq.event.message.message_id,
    parent_id: dmRoot.event.message.message_id,
    reply_to_message_id: dmRoot.event.message.message_id,
    root_id: dmRoot.event.message.message_id,
    thread_id: 'omt_dm_1',
  });
  assert.equal(dmMergedBatch.messages[0].message_id, dmExtra.event.message.message_id);
  assert.equal(dmMergedBatch.messages[0].parent_id, dmReq.event.message.message_id);
  assert.equal(dmMergedBatch.messages[0].reply_to_message_id, dmReq.event.message.message_id);
  assert.equal(dmMergedBatch.messages[0].root_id, dmRoot.event.message.message_id);
  assert.equal(dmMergedBatch.messages[0].thread_id, 'omt_dm_1');
  assert.equal(dmMergedBatch.messages[0].in_request_thread, true);
  assert.ok(pf.wire.sent[0].url.endsWith('/im/v1/messages?receive_id_type=chat_id'), 'private reply must not auto-attach');

  // Next private turn sees full source fields on history.request and history.incoming_messages
  const dmFollow = envelope('再跟进一下');
  assert.equal((await done(pf, await post(pf.h, pf.id, dmFollow))).state, 'completed');
  const histRound = dmNextCtx.history.at(-1);
  assert.equal(histRound.request.message_id, dmReq.event.message.message_id);
  assert.equal(histRound.request.parent_id, dmRoot.event.message.message_id);
  assert.equal(histRound.request.reply_to_message_id, dmRoot.event.message.message_id);
  assert.equal(histRound.request.root_id, dmRoot.event.message.message_id);
  assert.equal(histRound.request.thread_id, 'omt_dm_1');
  assert.equal(histRound.incoming_messages[0].message_id, dmExtra.event.message.message_id);
  assert.equal(histRound.incoming_messages[0].thread_id, 'omt_dm_1');
});

test('group assistant explicitly targets messages and threads via send_message, set_reply_target, clear, and set_feishu_card shortcut; replay preserves target (#1385)', async t => {
  const f = await group(t);
  const msgA = inGroup('Alice 的主消息', 'ou_alice');
  msgA.event.message.mentions = [];
  await post(f.h, f.id, msgA);
  const msgB = inGroup('Bob 的话题根消息', 'ou_bob');
  msgB.event.message.mentions = [];
  msgB.event.message.thread_id = 'omt_topic_b';
  await post(f.h, f.id, msgB);

  const req = inGroup('分别回复 Alice 和话题 B，最终发卡片到话题 B', 'ou_alice');
  const stepResults = [];
  f.modelState.respond = async (body, res) => {
    const obs = observations(body);
    if (obs.length === 0) return call(res, 'send_message', { text: '给 Alice 的引用回复', reply_to_message_id: msgA.event.message.message_id });
    if (obs.length === 1) return call(res, 'send_message', { text: '发进话题 B 的进展', thread_id: 'omt_topic_b' });
    if (obs.length === 2) return call(res, 'set_reply_target', { reply_to_message_id: msgA.event.message.message_id, reply_in_thread: true });
    if (obs.length === 3) return call(res, 'set_reply_target', { clear: true });
    if (obs.length === 4) return call(res, 'set_feishu_card', { card: sampleCard, thread_id: 'omt_topic_b' });
    stepResults.push(...obs);
    return say(res, '卡片汇总已发至话题 B。');
  };

  const receipt = await post(f.h, f.id, req);
  assert.equal((await done(f, receipt)).state, 'completed');
  await until(() => f.wire.sent.length >= 3);

  assert.equal(stepResults[0].sent, true);
  assert.deepEqual(stepResults[0].reply_target, { reply_to_message_id: msgA.event.message.message_id, reply_in_thread: false });
  assert.equal(stepResults[1].sent, true);
  assert.deepEqual(stepResults[1].reply_target, { reply_to_message_id: msgB.event.message.message_id, reply_in_thread: true, thread_id: 'omt_topic_b' });
  assert.equal(stepResults[2].set, true);
  assert.deepEqual(stepResults[2].reply_target, { reply_to_message_id: msgA.event.message.message_id, reply_in_thread: true });
  assert.equal(stepResults[3].cleared, true);
  assert.equal(stepResults[3].reply_target, null);
  assert.equal(stepResults[4].staged, true);
  assert.deepEqual(stepResults[4].reply_target, { reply_to_message_id: msgB.event.message.message_id, reply_in_thread: true, thread_id: 'omt_topic_b' });

  // Wire delivery assertions
  const [sent1, sent2, sent3] = f.wire.sent;
  assert.ok(sent1.url.endsWith('/' + msgA.event.message.message_id + '/reply'));
  assert.equal(sent1.reply_in_thread, false);
  assert.ok(sent2.url.endsWith('/' + msgB.event.message.message_id + '/reply'));
  assert.equal(sent2.reply_in_thread, true);
  assert.ok(sent3.url.endsWith('/' + msgB.event.message.message_id + '/reply'));
  assert.equal(sent3.reply_in_thread, true);
  assert.equal(sent3.msg_type, 'interactive');
  assert.equal(sent3.content.schema, '2.0');

  // Recorded ledger metadata matches explicit reply targets
  const botRows = f.h.store.all("SELECT message_id, parent_id, root_id, thread_id FROM channel_messages WHERE chat_id=? AND sender_type='app' ORDER BY created_at, message_id", f.chat.id);
  assert.equal(botRows[0].parent_id, msgA.event.message.message_id);
  assert.equal(botRows[0].thread_id, '');
  assert.equal(botRows[1].parent_id, msgB.event.message.message_id);
  assert.equal(botRows[1].thread_id, 'omt_topic_b');
  assert.equal(botRows[2].parent_id, msgB.event.message.message_id);
  assert.equal(botRows[2].thread_id, 'omt_topic_b');

  // Replaying the completed group turn returns the persisted reply_target
  const binding = f.service.serviceBindings.active(f.chat.id);
  const replayed = await f.service.serviceSessions.run({
    chat: f.chat, binding, source_message: receipt.value.operation_id, request: 'replay', allowSilence: false,
  });
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.reply_target, { reply_to: msgB.event.message.message_id, reply_in_thread: true, thread_id: 'omt_topic_b' });
});

test('private chat supports explicit reply targets via send_message, set_reply_target and set_feishu_card; web console omits reply target tools (#1385)', async t => {
  const f = await channelFixture(t);
  await privateChat(f);

  const dm1 = envelope('第一条待引用私聊');
  f.modelState.respond = async (_body, res) => say(res, '收到第一条');
  assert.equal((await finished(f.h, (await post(f.h, f.id, dm1)).value.operation_id)).state, 'completed');
  await until(() => f.wire.sent.length >= 1);
  assert.ok(f.wire.sent[0].url.endsWith('/im/v1/messages?receive_id_type=chat_id'));

  const dm2 = envelope('请引用第一条发进度并设置最终回复目标');
  f.modelState.respond = async (body, res) => {
    const obs = observations(body);
    if (obs.length === 0) return call(res, 'send_message', { text: '引用第一条的私聊进度', reply_to_message_id: dm1.event.message.message_id });
    if (obs.length === 1) return call(res, 'set_reply_target', { reply_to_message_id: dm1.event.message.message_id, reply_in_thread: true });
    return say(res, '引用第一条的私聊最终回复');
  };
  const r2 = await post(f.h, f.id, dm2);
  assert.equal((await finished(f.h, r2.value.operation_id)).state, 'completed');
  await until(() => f.wire.sent.length >= 3);

  assert.ok(f.wire.sent[1].url.endsWith('/' + dm1.event.message.message_id + '/reply'));
  assert.equal(f.wire.sent[1].reply_in_thread, false);
  assert.ok(f.wire.sent[2].url.endsWith('/' + dm1.event.message.message_id + '/reply'));
  assert.equal(f.wire.sent[2].reply_in_thread, true);

  // Card shortcut in private chat
  const dm3 = envelope('发卡片引用第一条');
  f.modelState.respond = async (body, res) => {
    const obs = observations(body);
    if (obs.length === 0) return call(res, 'set_feishu_card', { card: sampleCard, reply_to_message_id: dm1.event.message.message_id });
    return say(res, '私聊卡片已发');
  };
  const r3 = await post(f.h, f.id, dm3);
  assert.equal((await finished(f.h, r3.value.operation_id)).state, 'completed');
  await until(() => f.wire.sent.length >= 4);
  assert.ok(f.wire.sent[3].url.endsWith('/' + dm1.event.message.message_id + '/reply'));
  assert.equal(f.wire.sent[3].reply_in_thread, false);
  assert.equal(f.wire.sent[3].msg_type, 'interactive');

  // Web console does not offer set_reply_target and rejects reply target fields on send_message
  let webTools = [], webSendObs;
  f.modelState.respond = async (body, res) => {
    webTools = body.tools.map(tool => tool.function.name);
    const obs = observations(body);
    if (obs.length === 0) return call(res, 'send_message', { text: '网页进度', reply_to_message_id: dm1.event.message.message_id });
    webSendObs = obs[0];
    return say(res, '网页完成');
  };
  const conv = (await f.admin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const webMsg = (await f.admin(`/api/management/conversations/${conv}/messages`, 'POST', { source_message: 'web-no-reply-target', content: '网页测试' })).value;
  await settled(f.admin, conv, webMsg.id);
  assert.ok(!webTools.includes('set_reply_target'));
  assert.equal(webSendObs.error, 'invalid_arguments');
});

test('invalid, cross-chat, recalled, synthetic and conflicting reply targets return actionable errors and allow model recovery (#1385)', async t => {
  const f = await group(t);
  // Seed a foreign chat message so cross-chat targeting can be verified
  const foreign = inGroup('外群消息', 'ou_bob');
  foreign.event.message.chat_id = 'oc_other_group';
  foreign.event.message.mentions = [];
  foreign.event.message.thread_id = 'omt_other_group';
  await post(f.h, f.id, foreign);

  // Seed a recalled message and a thread message in this group
  const recalled = inGroup('稍后撤回', 'ou_bob');
  recalled.event.message.mentions = [];
  await post(f.h, f.id, recalled);
  await post(f.h, f.id, {
    header: { ...recalled.header, event_id: 'recall-' + recalled.header.event_id, event_type: 'im.message.recalled_v1' },
    event: { chat_id: 'oc_group', message_id: recalled.event.message.message_id, recall_time: String(Date.now()) },
  });
  const threadMsg = inGroup('话题内消息', 'ou_bob');
  threadMsg.event.message.mentions = [];
  threadMsg.event.message.thread_id = 'omt_local';
  await post(f.h, f.id, threadMsg);
  const mainMsg = inGroup('普通主消息', 'ou_bob');
  mainMsg.event.message.mentions = [];
  await post(f.h, f.id, mainMsg);

  const req = inGroup('测试各种非法目标', 'ou_alice');
  let recordedObs = [];
  f.modelState.respond = async (body, res) => {
    const obs = observations(body);
    if (obs.length === 0) return call(res, 'set_reply_target', { reply_to_message_id: foreign.event.message.message_id });
    if (obs.length === 1) return call(res, 'set_reply_target', { thread_id: 'omt_other_group' });
    if (obs.length === 2) return call(res, 'set_reply_target', { reply_to_message_id: recalled.event.message.message_id });
    if (obs.length === 3) return call(res, 'set_reply_target', { reply_to_message_id: 'card-act-synthetic-1' });
    if (obs.length === 4) return call(res, 'set_reply_target', { reply_to_message_id: mainMsg.event.message.message_id, thread_id: 'omt_local' });
    if (obs.length === 5) return call(res, 'send_message', { text: '冲突参数', thread_id: 'omt_local', reply_in_thread: false });
    if (obs.length === 6) return call(res, 'set_reply_target', { reply_to_message_id: mainMsg.event.message.message_id });
    recordedObs = obs;
    return say(res, '修正后成功回复主消息');
  };

  const receipt = await post(f.h, f.id, req);
  assert.equal((await done(f, receipt)).state, 'completed');
  await until(() => f.wire.sent.length >= 1);

  assert.deepEqual(recordedObs.slice(0, 6).map(o => o.error), [
    'reply_target_not_found',
    'reply_target_not_found',
    'reply_target_unavailable',
    'invalid_reply_target',
    'reply_target_conflict',
    'reply_target_conflict',
  ]);
  assert.equal(recordedObs[6].set, true);
  assert.equal(f.wire.sent.length, 1, 'rejected send_message never queued an outbox row');
  assert.ok(f.wire.sent[0].url.endsWith('/' + mainMsg.event.message.message_id + '/reply'));
  assert.equal(f.wire.sent[0].reply_in_thread, false);
});

test('group and private timer turns refuse set_reply_target and reply target fields on set_feishu_card (#1367, #1385)', async t => {
  const f = await group(t), dm = await privateChat(f);
  const runTimer = async (target, kind) => {
    let offeredTools = [], obs1, obs2;
    f.modelState.respond = async (body, res) => {
      const obs = observations(body);
      if (obs.length === 0) {
        offeredTools = body.tools.map(tool => tool.function.name);
        return call(res, 'set_reply_target', { reply_to_message_id: 'om_any' });
      }
      if (obs.length === 1) {
        obs1 = obs[0];
        return call(res, 'set_feishu_card', { card: sampleCard, thread_id: 'omt_any' });
      }
      obs2 = obs[1];
      return say(res, `${kind}定时完成`);
    };
    const schedule = (await f.admin(`/api/channels/chats/${target.id}/schedules`, 'POST', {
      name: '静默核对', prompt: '汇总现状', timezone: 'Asia/Shanghai', cron: '0 9 * * *',
    })).value.schedule;
    const before = f.wire.sent.length;
    assert.equal((await f.admin(`/api/channels/schedules/${schedule.id}/run`, 'POST', {})).status, 201);
    const run = await until(() => f.h.store.get('SELECT * FROM channel_schedule_runs WHERE schedule_id=?', schedule.id), r => r && r.state !== 'running');
    assert.equal(run.state, 'completed', run.error);
    await until(() => f.wire.sent.length > before);
    assert.ok(!offeredTools.includes('set_reply_target'));
    assert.ok(!offeredTools.includes('send_message'));
    assert.equal(obs1.error, 'tool_not_allowed');
    assert.equal(obs2.error, 'invalid_arguments');
    assert.ok(f.wire.sent.at(-1).url.endsWith('/im/v1/messages?receive_id_type=chat_id'));
  };
  await runTimer(f.chat, '群');
  await runTimer(dm, '私聊');
});
