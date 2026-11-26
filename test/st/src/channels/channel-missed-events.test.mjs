// #1399: a group @ message whose long-connection event was lost left no trace and was never answered. A failed event now leaves a
// failed inbox row and a log line, and bound groups sync their recent history, so a missed @ is answered late or, when too old,
// only recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boundGroup, channelFixture, credentials, envelope, inGroup, post, repositoryAssistant, scriptedModel, until } from '../../../fixtures/channel-fixture.mjs';
import { ChannelConnections, sdkLogger } from '../../../../dist/channels/connections.js';

const chatJob = (f, chat) => f.h.store.get("SELECT * FROM channel_sync_jobs WHERE chat_id=? AND container_type='chat'", chat.id);
const synced = (f, chat) => until(() => chatJob(f, chat), job => job?.state === 'complete');
/** A history item as Feishu lists it: a person's message that @-mentions the bot, sent `age` ms ago. */
const missed = (id, age, text = '部署状态如何？') => ({ message_id: id, msg_type: 'text', body: { content: JSON.stringify({ text: '@_user_1 ' + text }) },
  mentions: [{ key: '@_user_1', id: 'ou_bot', id_type: 'open_id', name: 'Fixture bot' }],
  sender: { id: 'ou_bob', id_type: 'open_id', sender_type: 'user', tenant_key: 'actor-tenant' }, create_time: String(Date.now() - age) });
/** Feishu's chat history from now on holds these items; threads are empty. */
const history = (f, items) => { f.wire.state.history = url => Response.json({ code: 0, data: { items: url.searchParams.get('container_id_type') === 'chat' ? items : [], has_more: false } }); };
const recovered = (f, id) => f.h.store.get('SELECT * FROM channel_inbox WHERE dedup_key=?', 'message:' + id);

test('a long-connection event whose handler throws leaves a failed inbox row and a log line, and its redelivery still goes through', async t => {
  const f = await channelFixture(t), { h, id, service } = f;
  h.store.run("UPDATE channel_connectors SET transport='websocket',application_type='enterprise',enabled=1 WHERE id=?", id);
  let dispatcher;
  const sockets = new ChannelConnections(service, () => ({ start: async ({ eventDispatcher }) => { dispatcher = eventDispatcher; }, close() {},
    getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }));
  t.after(() => sockets.close());
  sockets.reconcile();
  await until(() => dispatcher);
  const warnings = t.mock.method(console, 'warn', () => {});
  // A message that cannot be normalized: the connector no longer knows its bot (channel_bot_unavailable).
  h.store.run("UPDATE channel_connectors SET bot_open_id='' WHERE id=?", id);
  const event = inGroup('部署状态如何？');
  await assert.rejects(dispatcher.invoke(event, { needCheck: false }), { code: 'channel_bot_unavailable' });
  const row = h.store.get('SELECT * FROM channel_inbox WHERE dedup_key=?', 'failed:' + event.header.event_id);
  assert.equal(row.state, 'failed'); assert.equal(row.error, 'channel_bot_unavailable');
  // Identifiers only: the trace holds no more of the message than an inbox row does, and here none of its text.
  const trace = h.store.secrets.open(row.payload, 'channel-event:' + row.id);
  assert.deepEqual(trace, { kind: 'failed', event_type: 'im.message.receive_v1', event_id: event.header.event_id, message_id: event.event.message.message_id, chat_id: 'oc_group' });
  assert.doesNotMatch(JSON.stringify(trace), /部署状态/);
  assert.equal(h.store.get('SELECT last_error FROM channel_connectors WHERE id=?', id).last_error, 'channel_bot_unavailable');
  const line = warnings.mock.calls.map(call => String(call.arguments[0])).find(text => text.includes('long-connection event'));
  assert.match(line, /im\.message\.receive_v1 failed on connector [a-f0-9]+: channel_bot_unavailable/);
  assert.ok(line.includes(event.event.message.message_id)); assert.doesNotMatch(line, /部署状态/);
  // The same event failing again keeps one row; once the connector works, the redelivery is accepted, not taken as a duplicate.
  await assert.rejects(dispatcher.invoke(event, { needCheck: false }));
  assert.equal(h.store.get("SELECT count(*) n FROM channel_inbox WHERE state='failed'").n, 1);
  h.store.run("UPDATE channel_connectors SET bot_open_id='ou_bot' WHERE id=?", id);
  const accepted = await dispatcher.invoke(event, { needCheck: false });
  assert.equal(accepted.duplicate, undefined);
  assert.equal(recovered(f, event.event.message.message_id).id, accepted.operation_id);
});

test('SDK warnings and errors reach the log as redacted text, without objects or debug output', async t => {
  const f = await channelFixture(t), logger = sdkLogger(f.h.store, f.id);
  const warnings = t.mock.method(console, 'warn', () => {}), errors = t.mock.method(console, 'error', () => {}), debug = t.mock.method(console, 'log', () => {});
  logger.error('[ws]', 'invoke event failed', new Error('channel_message_invalid'), { config: { headers: { Authorization: 'Bearer fixture-request-token' } } });
  logger.warn('[ws]', 'connect config failed for secret ' + credentials.app_secret);
  logger.debug('[ws]', 'receive message, data: 部署状态如何？'); logger.info('[ws]', 'ws client ready'); logger.trace('[ws]', 'ping success');
  const error = String(errors.mock.calls[0].arguments[0]), warning = String(warnings.mock.calls[0].arguments[0]);
  assert.match(error, /^\[channels\] feishu sdk error on connector [a-f0-9]+: \[ws\] invoke event failed channel_message_invalid \[object\]$/);
  assert.doesNotMatch(error, /fixture-request-token|Authorization/);
  assert.match(warning, /^\[channels\] feishu sdk warn on connector/); assert.ok(!warning.includes(credentials.app_secret));
  assert.equal(errors.mock.callCount() + warnings.mock.callCount() + debug.mock.callCount(), 2);
});

test('a missed @ message found by the catch-up sync starts exactly one turn, says it is late, and is answered once', async t => {
  const f = await channelFixture(t), { h } = f;
  await repositoryAssistant(f);
  const chat = await boundGroup(f, ['101']);
  await synced(f, chat);
  scriptedModel(f, ['部署正常。']);
  history(f, [missed('om_missed', 60_000)]);
  t.mock.method(console, 'warn', () => {});
  f.service.catchUp();
  const row = await until(() => recovered(f, 'om_missed'), r => r?.state === 'completed');
  assert.equal(row.event_id, 'recovered:om_missed'); assert.equal(row.error, null);
  assert.equal(h.store.secrets.open(row.payload, 'channel-event:' + row.id).recovered, true);
  const reply = await until(() => f.wire.sent.find(sent => JSON.stringify(sent.content).includes('部署正常。')));
  assert.match(JSON.stringify(reply.content), /稍后同步时补收的，所以回复晚了/);
  assert.ok(f.wire.state.reactionRequests.some(request => request.method === 'POST' && request.message === 'om_missed'), 'the processing indicator, as for a live @');
  // Another catch-up sees the message again, and the live event arrives at last: neither starts a second turn.
  f.service.catchUp(); await synced(f, chat);
  const live = inGroup('部署状态如何？', 'ou_bob'); live.event.message.message_id = 'om_missed';
  assert.equal((await post(h, f.id, live)).value.duplicate, true);
  await f.service.drain();
  assert.equal(h.store.get("SELECT count(*) n FROM channel_inbox WHERE dedup_key='message:om_missed'").n, 1);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_service_turns WHERE chat_id=?', chat.id).n, 1);
  assert.equal(f.wire.sent.filter(sent => JSON.stringify(sent.content).includes('部署正常。')).length, 1);
});

test('a missed @ message too old to answer is stored in the ledger and recorded, but not answered', async t => {
  const f = await channelFixture(t), { h } = f;
  await repositoryAssistant(f);
  const chat = await boundGroup(f, ['101']);
  await synced(f, chat);
  history(f, [missed('om_old', 10 * 60_000), missed('om_ancient', 2 * 3600_000), missed('om_new', 5_000)]);
  t.mock.method(console, 'warn', () => {});
  f.service.catchUp(); await synced(f, chat);
  assert.ok(h.store.get('SELECT 1 FROM channel_messages WHERE chat_id=? AND message_id=?', chat.id, 'om_old'), 'stored in the local ledger');
  const row = recovered(f, 'om_old');
  assert.equal(row.state, 'completed'); assert.equal(row.error, 'channel_message_missed');
  // Older than an hour is history, younger than the grace period may still arrive live: neither is taken as missed.
  assert.equal(recovered(f, 'om_ancient'), undefined); assert.equal(recovered(f, 'om_new'), undefined);
  await f.service.drain();
  assert.equal(h.store.get('SELECT count(*) n FROM channel_service_turns WHERE chat_id=?', chat.id).n, 0);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_reactions').n, 0);
  assert.equal(f.wire.sent.length, 0);
});

test('a blocked event loop starts a catch-up at once and again when what was sent meanwhile is old enough; otherwise every minute', async t => {
  const f = await channelFixture(t);
  // A clock an hour ahead: its first tick is a block whatever the service's own timer did before. The ticks run synchronously,
  // so that timer cannot interleave with them.
  const catchUps = t.mock.method(f.service, 'catchUp', () => {}), base = Date.now() + 3600_000;
  const ticks = (from, to) => { for (let s = from; s <= to; s++) f.service.syncTick(base + s * 1000); return catchUps.mock.callCount(); };
  assert.equal(ticks(0, 0), 1, 'a tick an hour late: the loop was blocked');
  assert.equal(ticks(1, 29), 1);
  assert.equal(ticks(30, 30), 2, '30 s after the block, messages sent during it are old enough to count as missed');
  assert.equal(ticks(31, 89), 2);
  assert.equal(ticks(90, 90), 3, 'then every minute');
  assert.equal(ticks(91, 92), 3);
  assert.equal(ticks(100, 100), 4, 'eight seconds between ticks is a block too');
  assert.equal(ticks(101, 129), 4);
  assert.equal(ticks(130, 130), 5);
});

test('a catch-up reads bound groups again from just before the end they covered and keeps one completed range', async t => {
  const f = await channelFixture(t), { h } = f;
  await repositoryAssistant(f);
  const chat = await boundGroup(f, ['101']);
  const { generation, covered_until } = await synced(f, chat);
  f.service.catchUp();
  const job = chatJob(f, chat);
  assert.equal(job.generation, generation + 1);
  assert.equal(job.start_time, covered_until - 60, 'an incremental window, not the whole history again');
  // Repeated catch-ups keep one completed range per contiguous span instead of a row per run.
  await synced(f, chat); f.service.catchUp(); await synced(f, chat);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_sync_ranges WHERE job_id=?', job.id).n, 1);
  // An unbound chat is not part of the catch-up.
  await post(h, f.id, envelope('private', { message: { chat_id: 'oc_other', chat_type: 'group', mentions: [] } }));
  const other = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_other'");
  const before = (await synced(f, other)).generation;
  f.service.catchUp();
  assert.equal(chatJob(f, other).generation, before);
});
