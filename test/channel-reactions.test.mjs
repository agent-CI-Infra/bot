import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelReactions } from '../dist/channels/reactions.js';
import { FeishuAdapter, FEISHU_SCOPES } from '../dist/channels/feishu.js';
import { channelFixture, envelope, post, until, finished, inGroup, boundGroup, repositoryAssistant, scriptedModel, cardEvent, transport, credentials } from './channel-fixture.mjs';

const reaction = (f, id) => f.h.store.get('SELECT * FROM channel_reactions WHERE source_event=?', id);
const active = (f, id) => until(() => reaction(f, id), r => r?.state === 'active');
const cleared = (f, id) => until(() => reaction(f, id), r => r?.state === 'done');
const delivered = (f, id) => until(() => f.h.store.get('SELECT state FROM channel_outbox WHERE source_event=?', id), r => r?.state === 'sent');
const retryNow = (f, id) => f.h.store.run('UPDATE channel_reactions SET next_attempt=0 WHERE source_event=?', id);
function blockModel(t, f) {
  let release; f.modelState.gate = new Promise(r => { release = r; });
  const done = () => { f.modelState.gate = null; release(); };
  t.after(done); return done;
}

test('accepted private messages gain one inline reaction and lose it only after the reply is delivered', async t => {
  const f = await channelFixture(t), release = blockModel(t, f), data = envelope('查询任务进展');
  let stateAtRemoval;
  f.wire.state.reactionHandler = request => {
    if (request.method === 'DELETE') stateAtRemoval = f.h.store.get('SELECT state FROM channel_outbox WHERE source_event=?', id)?.state;
  };
  const started = performance.now(), receipt = await post(f.h, f.id, data), id = receipt.value.operation_id;
  assert.equal(receipt.value.state, 'queued'); assert.ok(performance.now() - started < 1000);
  await active(f, id); await until(() => f.requests.length);
  assert.deepEqual(f.wire.state.reactionRequests.map(r => [r.method, r.message, r.reaction_type]), [['POST', data.event.message.message_id, { emoji_type: 'Typing' }]]);
  assert.equal((await post(f.h, f.id, data)).value.duplicate, true);
  const duplicate = structuredClone(data); duplicate.header.event_id += '-redelivery';
  f.h.store.run("UPDATE channel_connectors SET transport='websocket' WHERE id=?", f.id);
  assert.equal(f.service.receiveLongConnection(f.id, duplicate).operation_id, id);
  f.h.store.run("UPDATE channel_connectors SET transport='http' WHERE id=?", f.id);
  assert.equal(f.wire.state.reactionRequests.length, 1);
  release(); await delivered(f, id); await cleared(f, id);
  assert.equal(stateAtRemoval, 'sent'); assert.equal(f.wire.state.reactions.length, 0);
  assert.equal(f.wire.state.reactionRequests.filter(r => r.method === 'POST').length, 1);
});

test('a slow reaction does not block the model or delivery and a late add is removed', async t => {
  let release = () => {}; t.after(() => release());
  const f = await channelFixture(t), gate = new Promise(r => { release = r; });
  f.wire.state.reactionHandler = async request => { if (request.method === 'POST') await gate; };
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  await until(() => f.wire.state.reactionRequests.some(r => r.method === 'POST'));
  await delivered(f, id); assert.equal((await finished(f.h, id)).state, 'completed');
  assert.equal(reaction(f, id).state, 'adding'); assert.ok(f.requests.length);
  release(); await cleared(f, id); assert.equal(f.wire.state.reactions.length, 0);
});

test('one slow reaction does not delay another messages indicator or cleanup', async t => {
  // Release mocked I/O before the fixture drains workers, including when an assertion fails.
  let release = () => {}; t.after(() => release());
  const f = await channelFixture(t), slow = envelope('/identity', { message: { chat_id: 'oc_slow_reaction' } });
  const gate = new Promise(r => { release = r; });
  f.wire.state.reactionHandler = async request => { if (request.method === 'POST' && request.message === slow.event.message.message_id) await gate; };
  const first = await post(f.h, f.id, slow), firstId = first.value.operation_id;
  await until(() => f.wire.state.reactionRequests.some(r => r.message === slow.event.message.message_id));
  const second = await post(f.h, f.id, envelope('/identity', { message: { chat_id: 'oc_fast_reaction' } })), secondId = second.value.operation_id;
  await delivered(f, secondId); await cleared(f, secondId);
  assert.equal(reaction(f, firstId).state, 'adding');
  release(); await cleared(f, firstId); assert.equal(f.wire.state.reactions.length, 0);
});

test('delivery retries keep the indicator until the same reply is actually sent', async t => {
  const f = await channelFixture(t), release = blockModel(t, f);
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  await active(f, id); f.wire.state.sendFailures = 1; release();
  const outbox = await until(() => f.h.store.get("SELECT * FROM channel_outbox WHERE source_event=? AND state='retry'", id));
  assert.equal((await finished(f.h, id)).state, 'completed');
  await f.service.reactions.tick(); assert.equal(reaction(f, id).state, 'active');
  assert.equal(f.wire.state.reactionRequests.filter(r => r.method === 'DELETE').length, 0);
  f.h.store.run('UPDATE channel_outbox SET next_attempt=0 WHERE id=?', outbox.id);
  await delivered(f, id); await cleared(f, id); assert.equal(f.wire.sent.length, 1);
});

test('a terminal delivery failure clears the indicator without claiming the reply was delivered', async t => {
  const f = await channelFixture(t), release = blockModel(t, f);
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  await active(f, id); f.wire.state.sendFailures = 100; release();
  await until(() => f.h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', id));
  await until(() => {
    f.h.store.run('UPDATE channel_outbox SET next_attempt=0 WHERE source_event=?', id);
    return f.h.store.get('SELECT state FROM channel_outbox WHERE source_event=?', id)?.state === 'failed';
  });
  await cleared(f, id); assert.equal(f.wire.sent.length, 0); assert.equal(f.wire.state.reactions.length, 0);
});

test('missing reaction permission is observable and never prevents an ordinary answer', async t => {
  const f = await channelFixture(t);
  f.wire.state.scopes = FEISHU_SCOPES.filter(s => s.scope !== 'im:message.reactions:write_only').map(s => ({ scope_name: s.scope, grant_status: 1, scope_type: 'tenant' }));
  const check = await f.admin('/api/channels/feishu/probe', 'POST', { connector_id: f.id, expected_revision: f.service.connector(f.id).revision });
  assert.deepEqual(check.value.scopes.missing, ['im:message.reactions:write_only']);
  f.wire.state.reactionHandler = request => request.method === 'POST' ? Response.json({ code: 99991672, msg: 'secret-must-not-be-returned' }, { status: 403 }) : undefined;
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  await delivered(f, id);
  const row = await until(() => reaction(f, id), r => r?.state === 'failed');
  assert.equal(row.last_error, 'channel_reaction_permission_required');
  const events = await f.admin('/api/channels/connectors/' + f.id + '/events');
  const event = events.value.operations.find(r => r.operation_id === id);
  assert.equal(event.reaction_error, row.last_error); assert.equal(event.reaction_state, 'failed');
  assert.doesNotMatch(JSON.stringify(events.value), /secret-must-not-be-returned|fixture-only-access-token/);
});

test('an uncertain add is reconciled without duplicating or removing other operators reactions', async t => {
  const f = await channelFixture(t), release = blockModel(t, f); let failed = false;
  f.wire.state.reactionHandler = request => {
    if (request.method === 'POST' && !failed) {
      failed = true;
      for (const [id, type, actor] of [['ours', 'app', 'cli_fixture'], ['human', 'user', 'ou_bob'], ['another-app', 'app', 'cli_other']])
        f.wire.state.reactions.push({ message: request.message, reaction_id: id, operator: { operator_type: type, operator_id: actor }, reaction_type: { emoji_type: 'Typing' } });
      throw new Error('connection closed after the add was accepted');
    }
  };
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  await until(() => reaction(f, id), r => r?.state === 'adding' && r.attempts === 1);
  retryNow(f, id); await active(f, id);
  assert.equal(reaction(f, id).reaction_id, 'ours');
  assert.equal(f.wire.state.reactionRequests.filter(r => r.method === 'POST').length, 1);
  release(); await cleared(f, id);
  assert.deepEqual(f.wire.state.reactions.map(r => r.reaction_id), ['human', 'another-app']);
});

for (const state of ['active', 'adding']) test(`restart recovers an interrupted ${state} reaction without rerunning its model turn`, async t => {
  const f = await channelFixture(t); f.service.close();
  const data = envelope('查询任务进展'), receipt = await post(f.h, f.id, data), id = receipt.value.operation_id;
  const worker = new ChannelReactions(f.h.store, (c, guard) => f.service.adapter(c, guard), e => f.service.source(e));
  await worker.tick(); assert.equal(reaction(f, id).state, 'active'); worker.close(); await worker.drain();
  f.h.store.run("UPDATE channel_inbox SET state='running' WHERE id=?", id);
  if (state === 'adding') f.h.store.run("UPDATE channel_reactions SET state='adding',reaction_id=NULL WHERE source_event=?", id);
  await f.h.stop(); await f.h.start();
  await cleared(f, id);
  assert.equal(f.h.store.get('SELECT error FROM channel_inbox WHERE id=?', id).error, 'interrupted_check_operation');
  assert.equal(f.requests.length, 0); assert.equal(f.wire.state.reactions.length, 0);
  assert.equal(f.wire.state.reactionRequests.filter(r => r.method === 'POST').length, 1);
});

test('queued ingress resumes its indicator and answer after a restart', async t => {
  const f = await channelFixture(t), release = blockModel(t, f); f.service.close();
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  assert.equal(reaction(f, id).state, 'pending');
  await f.h.stop(); await f.h.start(); await active(f, id);
  release(); await delivered(f, id); await cleared(f, id);
});

test('reaction deletion respects Retry-After and recovers from transient failures', async t => {
  const f = await channelFixture(t), release = blockModel(t, f); let failures = 0;
  f.wire.state.reactionHandler = request => {
    if (request.method === 'DELETE' && failures++ === 0) return Response.json({ code: 99991400 }, { status: 429, headers: { 'Retry-After': '3' } });
  };
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  await active(f, id); release(); await delivered(f, id);
  const row = await until(() => reaction(f, id), r => r?.state === 'removing' && r.attempts === 1);
  assert.ok(row.next_attempt > Date.now() + 2000); assert.equal(row.last_error, 'channel_rate_limited');
  await f.service.reactions.tick(); assert.equal(failures, 1);
  retryNow(f, id); await cleared(f, id); assert.equal(failures, 2);
});

test('a rate-limited add backs off, reconciles and retries without holding up the model', async t => {
  const f = await channelFixture(t), release = blockModel(t, f); let adds = 0;
  f.wire.state.reactionHandler = request => {
    if (request.method === 'POST' && adds++ === 0) return Response.json({ code: 99991400 }, { status: 429, headers: { 'Retry-After': '4' } });
  };
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  const row = await until(() => reaction(f, id), r => r?.state === 'adding' && r.attempts === 1);
  await until(() => f.requests.length); assert.ok(row.next_attempt > Date.now() + 3000);
  retryNow(f, id); await active(f, id); assert.equal(adds, 2);
  release(); await delivered(f, id); await cleared(f, id);
});

test('a model failure sends its failure receipt before clearing the indicator', async t => {
  const f = await channelFixture(t), release = blockModel(t, f);
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  await active(f, id); f.modelState.failure = 400; release();
  await delivered(f, id); await cleared(f, id);
  assert.equal(f.h.store.get('SELECT state FROM channel_inbox WHERE id=?', id).state, 'failed');
  assert.equal(f.wire.sent.length, 1);
});

test('a permanently rejected cleanup stays observable after a successful answer', async t => {
  const f = await channelFixture(t), release = blockModel(t, f);
  f.wire.state.reactionHandler = request => request.method === 'DELETE' ? Response.json({ code: 99991672 }, { status: 403 }) : undefined;
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  await active(f, id); release(); await delivered(f, id);
  const row = await until(() => reaction(f, id), r => r?.state === 'failed');
  assert.equal(row.last_error, 'channel_reaction_permission_required');
  assert.equal(f.wire.state.reactions.length, 1); assert.equal(f.wire.sent.length, 1);
});

test('a finished request during token exchange does not add a stale reaction', async t => {
  const f = await channelFixture(t); f.service.close(); let release;
  f.wire.state.authGate = new Promise(r => { release = r; }); t.after(() => release());
  const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
  const worker = new ChannelReactions(f.h.store, (c, guard) => f.service.adapter(c, guard), e => f.service.source(e));
  const work = worker.tick();
  await until(() => reaction(f, id)?.state === 'adding');
  f.h.store.run("UPDATE channel_inbox SET state='failed' WHERE id=?", id);
  release(); f.wire.state.authGate = null;
  await work; worker.close(); await worker.drain();
  assert.equal(reaction(f, id).state, 'done'); assert.equal(f.wire.state.reactionRequests.filter(r => r.method === 'POST').length, 0);
});

test('a refreshed connector can remove its own reaction but a replacement app cannot', async t => {
  for (const replace of [false, true]) await t.test(replace ? 'replacement app' : 'credential revision', async t => {
    const f = await channelFixture(t), release = blockModel(t, f);
    const receipt = await post(f.h, f.id, envelope('查询任务进展')), id = receipt.value.operation_id;
    await active(f, id);
    f.h.store.run('UPDATE channel_connectors SET revision=revision+1' + (replace ? ",app_id='cli_replacement'" : '') + ' WHERE id=?', f.id);
    release(); retryNow(f, id);
    if (replace) {
      await until(() => reaction(f, id), r => r?.state === 'failed');
      assert.equal(f.wire.state.reactionRequests.filter(r => r.method === 'DELETE').length, 0);
    } else { await cleared(f, id); assert.equal(f.wire.state.reactions.length, 0); }
  });
});

test('recalled messages clear their receipt and missing remote messages are already clean', async t => {
  const f = await channelFixture(t), release = blockModel(t, f), data = envelope('查询任务进展');
  const receipt = await post(f.h, f.id, data), id = receipt.value.operation_id; await active(f, id);
  f.wire.state.reactionHandler = request => request.method === 'DELETE' ? Response.json({ code: 231003 }, { status: 400 }) : undefined;
  const recall = { header: { ...data.header, event_id: data.header.event_id + '-recall', event_type: 'im.message.recalled_v1' },
    event: { chat_id: data.event.message.chat_id, message_id: data.event.message.message_id, recall_time: String(Date.now()) } };
  await post(f.h, f.id, recall); retryNow(f, id); await cleared(f, id); release();
});

test('quiet text/images, stale, bot and card events never receive an indicator', async t => {
  const f = await channelFixture(t);
  const quiet = inGroup('Ordinary discussion'); quiet.event.message.mentions = [];
  const quietImage=inGroup('');Object.assign(quietImage.event.message,{message_type:'image',content:'{"image_key":"img_quiet"}',mentions:[]});
  for (const data of [quiet, envelope('old', { message: { create_time: '1' } }), envelope('bot', { sender: { sender_type: 'app' } }),
    quietImage, cardEvent('obsolete-card')]) {
    const receipt = await post(f.h, f.id, data); assert.equal(receipt.status, 200); await finished(f.h, receipt.value.operation_id);
  }
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_reactions').n, 0);
  assert.equal(f.wire.state.reactionRequests.length, 0);
});

test('an actionable private image gets a processing indicator until its reply is delivered',async t=>{
  const f=await channelFixture(t);scriptedModel(f,['附件请求已记录。']);const release=blockModel(t,f);
  const data=envelope('',{message:{message_type:'image',content:'{"image_key":"img_actionable"}'}}),receipt=await post(f.h,f.id,data),id=receipt.value.operation_id;
  await active(f,id);release();await delivered(f,id);await cleared(f,id);
  assert.equal(f.wire.state.reactionRequests.filter(r=>r.method==='POST'&&r.message===data.event.message.message_id).length,1);
});

test('group assistant answers and deliberate silence both clear their original message indicator', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f); const chat = await boundGroup(f);
  f.h.store.run("UPDATE channel_service_bindings SET participation='all' WHERE chat_id=?", chat.id);
  for (const answer of ['群助手回复。', '']) {
    scriptedModel(f, [answer]); const release = blockModel(t, f), data = inGroup('这条消息需要回复吗？', 'ou_bob');
    data.event.message.mentions = [];
    const receipt = await post(f.h, f.id, data), id = receipt.value.operation_id;
    await active(f, id); release(); await finished(f.h, id); await cleared(f, id);
    assert.equal(f.h.store.get('SELECT count(*) n FROM channel_outbox WHERE source_event=?', id).n, answer ? 1 : 0);
  }
  assert.equal(f.wire.state.reactions.length, 0);
});

test('recovery pages through reactions and only adopts this apps processing emoji', async () => {
  const wire = transport(), adapter = new FeishuAdapter({ app_id: 'cli_fixture', application_type: 'enterprise' }, credentials, wire.fetch);
  wire.state.reactionHandler = request => {
    assert.equal(request.method, 'GET'); const url = new URL(request.url);
    assert.equal(request.message, 'message/with spaces'); assert.equal(url.searchParams.get('reaction_type'), 'Typing');
    const own = { operator: { operator_type: 'app', operator_id: 'cli_fixture' } };
    return Response.json({ code: 0, data: url.searchParams.has('page_token') ? {
      items: [{ ...own, reaction_id: 'correct', reaction_type: { emoji_type: 'Typing' } }], has_more: false
    } : { items: [{ ...own, reaction_id: 'wrong-emoji', reaction_type: { emoji_type: 'THUMBSUP' } },
      { operator: { operator_type: 'app', operator_id: 'other' }, reaction_id: 'wrong-app', reaction_type: { emoji_type: 'Typing' } }], has_more: true, page_token: 'next-page' } });
  };
  assert.equal(await adapter.findProcessingReaction('message/with spaces'), 'correct');
  assert.equal(wire.state.reactionRequests.length, 2);
  wire.state.reactionHandler = () => Response.json({ code: 0, data: { items: [], has_more: true, page_token: 'repeated' } });
  await assert.rejects(adapter.findProcessingReaction('another-message'), { code: 'channel_reaction_unavailable' });
});
