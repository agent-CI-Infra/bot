import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../dist/storage/database.js';
import { ChannelLedger } from '../dist/channels/ledger.js';
import { ChannelHistorySync } from '../dist/channels/history-sync.js';
import { ChannelHistoryError, ChannelRateLimitError } from '../dist/channels/feishu.js';
import { channelFixture, envelope, post, finished, credentials, until } from './channel-fixture.mjs';
import { ChannelConnections } from '../dist/channels/connections.js';
import { WSClient } from '@larksuiteoapi/node-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const event = (overrides = {}) => ({ provider: 'feishu', connector_id: 'connector', connector_revision: 1, app_id: 'app', installation_tenant: 'tenant',
  actor_tenant: 'tenant', actor_id: 'alice', chat_id: 'group', chat_type: 'group', kind: 'message', event_id: 'event', message_id: 'm1',
  thread_id: '', content: 'first', created_at: Date.now(), ...overrides });
const message = (id, time = Date.now(), extras = {}) => ({ message_id: id, sender_id: 'alice', sender_tenant: 'tenant', sender_type: 'user', message_type: 'text',
  created_at: time, updated_at: time, content: id, raw_content: JSON.stringify({ text: id }), parent_id: '', root_id: '', thread_id: '', deleted: false, ...extras });
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 1)), ledger = new ChannelLedger(store);
  t.after(() => store.close());
  store.run(`INSERT INTO channel_connectors(id,provider,app_id,installation_tenant,bot_open_id,application_type,transport,credential_ref,enabled,revision,created_at)
    VALUES('connector','feishu','app','tenant','bot','enterprise','http','secret',1,1,0)`);
  const chat = ledger.chat(event()); return { store, ledger, chat };
}

test('ledger has a stable installation/chat key across speakers, threads, projects, dates and connector revisions; chats and tenants stay isolated', t => {
  const { store, ledger, chat } = fixture(t);
  for (let i = 0; i < 140; i++) ledger.accept(event({ message_id: 'message-' + i, actor_id: 'user-' + i % 3,
    connector_revision: i + 2, thread_id: 'thread-' + i % 2, created_at: 1000 + i * 86400000 }));
  assert.equal(store.get('SELECT count(*) n FROM channel_chats').n, 1);
  assert.equal(store.get('SELECT count(*) n FROM channel_messages').n, 140);
  assert.equal(ledger.chat(event({ connector_id: 'rotated' })).id, chat.id);
  assert.notEqual(ledger.chat(event({ chat_id: 'dm', chat_type: 'p2p' })).id, chat.id);
  assert.notEqual(ledger.chat(event({ installation_tenant: 'other' })).id, chat.id);
});

test('live edit and recall win over delayed history, recalls received before originals stay tombstoned and summaries are invalidated', t => {
  const { store, ledger, chat } = fixture(t);
  ledger.merge(chat, message('m', 10), 'history');
  store.run('INSERT INTO channel_chat_summaries VALUES(?,1,1,10,?, ?,?)', chat.id, 'm', '[]', 'sealed-placeholder');
  ledger.merge(chat, message('m', 10, { updated_at: 30, content: 'edited' }), 'live');
  assert.equal(store.get('SELECT count(*) n FROM channel_chat_summaries').n, 0);
  ledger.merge(chat, message('m', 10, { updated_at: 20, content: 'old' }), 'history');
  assert.equal(ledger.query(chat.id).messages[0].content, 'edited');
  ledger.merge(chat, message('m', 10, { updated_at: 40, deleted: true }), 'live');
  ledger.merge(chat, message('m', 10, { updated_at: 90 }), 'history');
  ledger.merge(chat, message('not-yet-seen', 50, { deleted: true, sender_id: '', sender_tenant: '' }), 'live');
  ledger.merge(chat, message('not-yet-seen', 30, { sender_id: 'original-sender', thread_id: 'thread' }), 'history');
  const recalled = store.get("SELECT * FROM channel_messages WHERE message_id='not-yet-seen'");
  assert.equal(recalled.sender_id, 'original-sender'); assert.equal(recalled.created_at, 30); assert.equal(recalled.thread_id, 'thread');
  const payload = store.secrets.open(recalled.payload, 'channel-message:' + chat.id + ':not-yet-seen');
  assert.equal(payload.content, ''); assert.equal(payload.raw_content, ''); assert.equal(payload.deleted, true);
  assert.ok(ledger.query(chat.id).messages.every(m => m.deleted && !m.resources));
  assert.equal(ledger.query(chat.id).messages[0].content, '[消息已撤回]');
});

test('history walks every chat and thread page without replaying instructions; cursor and fixed boundary survive a worker restart', async t => {
  const { store, ledger, chat } = fixture(t), calls = [];
  const adapter = () => ({ history: async job => {
    calls.push({ ...job });
    if (job.container_type === 'thread') return { items: [message('thread-reply', 99, { thread_id: 'thread', parent_id: 'root' })], has_more: false, page_token: '' };
    const page = Number(job.page_token || 0), items = Array.from({ length: 50 }, (_, n) => message('m' + (page * 50 + n), page * 50 + n + 1,
      n === 0 && page === 0 ? { thread_id: 'thread', content: '/project 101 create task' } : {}));
    return { items, has_more: page < 2, page_token: String(page + 1) };
  } });
  await new ChannelHistorySync(store, ledger, adapter).tick();
  const checkpoint = store.get("SELECT * FROM channel_sync_jobs WHERE container_type='chat'");
  assert.equal(checkpoint.page_token, '1'); assert.equal(checkpoint.pages, 1);
  const restarted = new ChannelHistorySync(store, ledger, adapter);
  await restarted.tick(); await restarted.tick();
  assert.equal(store.get('SELECT count(*) n FROM channel_messages').n, 151);
  assert.equal(store.get('SELECT count(*) n FROM channel_inbox').n, 0);
  assert.equal(store.get('SELECT count(*) n FROM tasks').n, 0);
  assert.equal(store.get('SELECT count(*) n FROM channel_outbox').n, 0);
  assert.ok(calls.filter(c => c.container_type === 'chat').every(c => c.end_time === checkpoint.end_time && c.start_time === 0));
  assert.equal(ledger.diagnostics(chat.id).sync_state, 'visible_range_complete');
  assert.ok(ledger.diagnostics(chat.id).gaps.some(g => g.reason === 'thread_time_boundary_unsupported'));
});

test('page content and cursor commit atomically; a failed cursor write rolls back message and thread discovery', async t => {
  const { store, ledger, chat } = fixture(t);
  store.db.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE OF page_token ON channel_sync_jobs WHEN NEW.page_token='next' BEGIN SELECT RAISE(ABORT,'fixture crash'); END");
  const sync = new ChannelHistorySync(store, ledger, () => ({ history: async () => ({ items: [message('page', 1, { thread_id: 'thread' })], has_more: true, page_token: 'next' }) }));
  await sync.tick();
  assert.equal(ledger.query(chat.id).messages.length, 0);
  assert.equal(store.get('SELECT count(*) n FROM channel_sync_jobs').n, 1);
  assert.equal(store.get('SELECT page_token FROM channel_sync_jobs').page_token, '');
  assert.equal(store.get('SELECT count(*) n FROM channel_sync_cursors').n, 0);
  store.db.exec('DROP TRIGGER reject_cursor'); store.run('UPDATE channel_sync_jobs SET next_attempt=0');
  await sync.tick();
  assert.equal(ledger.query(chat.id).messages.length, 1);
  assert.equal(store.get("SELECT page_token FROM channel_sync_jobs WHERE container_type='chat'").page_token, 'next');
});

test('expired leases recover after a crash; active leases cannot be stolen by another worker', async t => {
  const { store, ledger } = fixture(t);
  let calls = 0;
  const sync = new ChannelHistorySync(store, ledger, () => ({ history: async () => { calls++; return { items: [], has_more: false, page_token: '' }; } }));
  store.run("UPDATE channel_sync_jobs SET state='running',lease_token='crashed',lease_until=?", Date.now() + 60000);
  await sync.tick(); assert.equal(calls, 0);
  store.run('UPDATE channel_sync_jobs SET lease_until=0');
  await sync.tick(); assert.equal(calls, 1);
  assert.equal(store.get('SELECT state FROM channel_sync_jobs').state, 'complete');
});

test('database reopen preserves the exact cursor, boundary, messages and expired lease instead of starting over', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-history-restart-')), path = join(directory, 'state.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 1);
  let store = new Store(path, key), ledger = new ChannelLedger(store);
  store.run(`INSERT INTO channel_connectors(id,provider,app_id,installation_tenant,bot_open_id,application_type,transport,credential_ref,enabled,revision,created_at)
    VALUES('connector','feishu','app','tenant','bot','enterprise','http','secret',1,1,0)`);
  const chat = ledger.chat(event());
  await new ChannelHistorySync(store, ledger, () => ({ history: async () => ({ items: [message('before-crash')], has_more: true, page_token: 'persisted' }) })).tick();
  const original = store.get('SELECT * FROM channel_sync_jobs');
  store.run("UPDATE channel_sync_jobs SET state='running',lease_token='crash',lease_until=1"); store.close();
  store = new Store(path, key); ledger = new ChannelLedger(store); t.after(() => store.close());
  await new ChannelHistorySync(store, ledger, () => ({ history: async job => {
    assert.equal(job.page_token, 'persisted'); assert.equal(job.end_time, original.end_time);
    return { items: [message('before-crash'), message('after-restart')], has_more: false, page_token: '' };
  } })).tick();
  assert.equal(ledger.query(chat.id).messages.length, 2);
  assert.equal(store.get('SELECT pages FROM channel_sync_jobs').pages, 2);
});

test('429 honors Retry-After, transient failures retry, permanent visibility errors remain blocked without false coverage', async t => {
  const { store, ledger, chat } = fixture(t);
  let failure = new ChannelRateLimitError(7000), calls = 0;
  const sync = new ChannelHistorySync(store, ledger, () => ({ history: async () => { calls++; if (failure) throw failure; return { items: [], has_more: false, page_token: '' }; } }));
  const now = Date.now(); await sync.tick();
  let job = store.get('SELECT * FROM channel_sync_jobs');
  assert.equal(job.state, 'retry'); assert.ok(job.next_attempt >= now + 7000); assert.equal(job.covered_until, 0);
  await sync.tick(); assert.equal(calls, 1);
  failure = new Error('network'); store.run('UPDATE channel_sync_jobs SET next_attempt=0'); await sync.tick();
  assert.equal(store.get('SELECT state FROM channel_sync_jobs').state, 'retry');
  failure = new ChannelHistoryError('channel_thread_invisible', true); store.run('UPDATE channel_sync_jobs SET next_attempt=0'); await sync.tick();
  assert.equal(ledger.diagnostics(chat.id).sync_state, 'blocked');
  assert.equal(ledger.diagnostics(chat.id).coverage[0].to, 0);
  failure = null; await sync.tick(); assert.equal(calls, 3);
  ledger.resync(chat.id); await sync.tick(); assert.equal(calls, 4);
});

test('repeated and cycling pagination tokens stop the job instead of looping or importing a suspect page', async t => {
  for (const sequence of [['x', 'x'], ['x', 'y', 'x'], ['']]) {
    const { store, ledger, chat } = fixture(t); let n = 0;
    const sync = new ChannelHistorySync(store, ledger, () => ({ history: async () => ({ items: [message('m' + n)], has_more: true, page_token: sequence[n++] }) }));
    for (let i = 0; i < sequence.length + 1; i++) await sync.tick();
    assert.equal(store.get('SELECT last_error FROM channel_sync_jobs').last_error, 'channel_history_cursor_stalled');
    assert.equal(ledger.query(chat.id).messages.length, sequence.length - 1);
    assert.equal(n, sequence.length);
  }
});

test('a removed bot or changed connector while HTTP is in flight cannot commit a page or advance coverage', async t => {
  const { store, ledger, chat } = fixture(t);
  const sync = new ChannelHistorySync(store, ledger, () => ({ history: async () => {
    ledger.accept(event({ kind: 'bot_removed' }));
    return { items: [message('late')], has_more: false, page_token: '' };
  } }));
  await sync.tick();
  assert.equal(ledger.query(chat.id).messages.length, 0);
  assert.equal(store.get('SELECT state FROM channel_sync_jobs').state, 'paused');
  assert.equal(ledger.diagnostics(chat.id).sync_state, 'removed');
});

test('local pagination searches decrypted safe text and metadata, hides sensitive payloads, preserves gaps and cleans derived state', t => {
  const { store, ledger, chat } = fixture(t);
  for (let i = 1; i <= 130; i++) ledger.merge(chat, message('m' + String(i).padStart(3, '0'), i, { content: i % 2 ? 'old decision' : 'discussion', sender_id: i % 2 ? 'alice' : 'bob', parent_id: 'root' }), 'history');
  ledger.merge(chat, message('secret', 131, { content: '确认绑定 fixture-confirmation', raw_content: JSON.stringify({ text: '确认绑定 fixture-confirmation' }) }), 'live');
  ledger.merge(chat, message('key', 132, { content: 'password: fixture-password', raw_content: '{"password":"fixture-password"}' }), 'live');
  const first = ledger.query(chat.id, { limit: 50 }), second = ledger.query(chat.id, { limit: 50, cursor: first.next_cursor });
  assert.equal(first.messages.length, 50); assert.equal(second.messages[0].message_id, 'm051');
  assert.throws(() => ledger.query(chat.id, { keyword: 'decision', cursor: first.next_cursor }), /invalid_pagination/);
  assert.equal(ledger.query(chat.id, { keyword: 'decision', from: 100, to: 130, sender_id: 'alice', reply_to: 'root' }).messages.length, 15);
  assert.equal(ledger.query(chat.id, { message_id: 'secret' }).messages[0].sensitive, true);
  assert.doesNotMatch(JSON.stringify(ledger.query(chat.id, { from: 131 })), /fixture-confirmation|fixture-password/);
  assert.equal(ledger.query(chat.id, { keyword: 'fixture-password' }).messages.length, 0);
  assert.ok(ledger.query(chat.id).gaps.length);
  const revision = store.get('SELECT revision FROM channel_chats WHERE id=?', chat.id).revision;
  ledger.cleanup(chat.id, 100, revision);
  assert.equal(ledger.query(chat.id).messages[0].created_at, 100);
  const current = store.get('SELECT * FROM channel_chats WHERE id=?', chat.id);
  assert.equal(ledger.merge(current, message('m001', 1), 'history'), false);
  assert.ok(ledger.query(chat.id).gaps.some(g => g.reason === 'retention'));
});

test('explicit cleanup during an awaited history page fences that page and later full-resync pages', async t => {
  const { store, ledger, chat } = fixture(t); let release, requested, calls = 0;
  ledger.merge(chat, message('old', 10), 'live');
  const waiting = new Promise(r => { requested = r; });
  const response = new Promise(r => { release = r; });
  const sync = new ChannelHistorySync(store, ledger, () => ({ history: async () => {
    if (++calls === 1) { requested(); await response; }
    return { items: [message('old-' + calls, 20), message('retained-' + calls, 120)], has_more: calls === 1, page_token: calls === 1 ? 'second-page' : '' };
  } }));
  const work = sync.tick(); await waiting;
  ledger.cleanup(chat.id, 100, store.get('SELECT revision FROM channel_chats WHERE id=?', chat.id).revision);
  release(); await work; await sync.tick();
  assert.equal(calls, 2); assert.equal(store.get('SELECT state FROM channel_sync_jobs').state, 'complete');
  assert.deepEqual(ledger.query(chat.id).messages.map(m => m.message_id), ['retained-1', 'retained-2']);
  assert.equal(store.get('SELECT count(*) n FROM channel_messages WHERE created_at<100').n, 0);
});

test('HTTP and SDK commit inbox, non-text/quiet/bot messages and sync discovery before ACK; a database error rolls everything back', async t => {
  const { h, id, service, wire } = await channelFixture(t);
  const attachment = envelope('', { message: { message_type: 'image', content: '{"image_key":"img_fixture"}', chat_type: 'group', chat_id: 'oc_media' } });
  const receipt = await post(h, id, attachment);
  assert.equal(receipt.status, 200); assert.equal(receipt.value.state, 'completed');
  const chat = h.store.get("SELECT id FROM channel_chats WHERE chat_id='oc_media'");
  assert.equal(h.store.get('SELECT message_type FROM channel_messages WHERE chat_id=?', chat.id).message_type, 'image');
  assert.equal(h.store.get('SELECT count(*) n FROM channel_sync_jobs WHERE chat_id=?', chat.id).n, 1);
  assert.equal(wire.sent.length, 0);
  h.store.db.exec("CREATE TRIGGER ledger_disk_full BEFORE INSERT ON channel_messages BEGIN SELECT RAISE(ABORT,'fixture disk full'); END");
  const before = h.store.get('SELECT count(*) n FROM channel_inbox').n;
  const failed = await post(h, id, envelope('not-committed'));
  assert.ok(failed.status >= 500); assert.equal(h.store.get('SELECT count(*) n FROM channel_inbox').n, before);
  h.store.run("UPDATE channel_connectors SET transport='websocket' WHERE id=?", id);
  let dispatcher;
  const sockets = new ChannelConnections(service, () => ({ start: async options => { dispatcher = options.eventDispatcher; }, close() {}, getConnectionStatus: () => ({ state: 'connected' }) }));
  t.after(() => sockets.close()); sockets.reconcile();
  await assert.rejects(dispatcher.invoke(envelope('not-acked'), { needCheck: false }), /fixture disk full/);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_inbox').n, before);
  h.store.db.exec('DROP TRIGGER ledger_disk_full');
  const accepted = await dispatcher.invoke(envelope('', { message: { message_type: 'file', content: '{"file_key":"file_fixture"}' } }), { needCheck: false });
  assert.equal(accepted.state, 'completed');
});

test('official history protocol uses max pages and thread containers; queries make zero provider requests including on misses', async t => {
  const { h, id, service, wire, admin } = await channelFixture(t);
  service.close();
  const e = envelope('local only', { message: { chat_type: 'group', chat_id: 'oc_history', thread_id: 'omt_thread' } });
  await post(h, id, e);
  const chat = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_history'");
  const job = h.store.get("SELECT * FROM channel_sync_jobs WHERE chat_id=? AND container_type='chat'", chat.id);
  const plainReply = service.adapter(service.connector(id)).normalize(envelope('ordinary reply', { message: { root_id: 'om_root', parent_id: 'om_parent' } }));
  assert.equal(plainReply.root_id, 'om_root'); assert.equal(plainReply.thread_id, '');
  const rich = service.adapter(service.connector(id)).normalize(envelope('', { message: { message_type: 'post', content: '{"zh_cn":{"title":"Decision","content":[[{"tag":"text","text":"Use the approved plan"}]]}}' } }));
  assert.equal(rich.content, 'Decision\nUse the approved plan');
  const long = 'complete text '.repeat(2000);
  assert.equal(service.adapter(service.connector(id)).normalize(envelope(long)).content, long);
  await service.adapter(service.connector(id)).history(job);
  const request = new URL(wire.state.historyRequests[0]);
  assert.equal(request.searchParams.get('page_size'), '50'); assert.equal(request.searchParams.get('sort_type'), 'ByCreateTimeAsc');
  assert.equal(Number(request.searchParams.get('end_time')), job.end_time);
  const thread = h.store.get("SELECT * FROM channel_sync_jobs WHERE chat_id=? AND container_type='thread'", chat.id);
  await service.adapter(service.connector(id)).history(thread);
  const threadRequest = new URL(wire.state.historyRequests[1]);
  assert.equal(threadRequest.searchParams.get('container_id_type'), 'thread'); assert.equal(threadRequest.searchParams.has('end_time'), false);
  const count = wire.state.authStarted;
  assert.equal((await admin(`/api/channels/chats/${chat.id}/messages?keyword=local`)).value.messages.length, 1);
  assert.equal((await admin(`/api/channels/chats/${chat.id}/messages?message_id=missing`)).value.messages.length, 0);
  assert.equal(wire.state.authStarted, count);
  assert.equal(wire.state.historyRequests.length, 2);
  assert.equal((await admin('/api/channels/chats?connector_id=' + id)).value.chats.length, 1);
});

test('official SDK frame ACK is 500 on transaction failure and 200 only after ledger and inbox are committed', async t => {
  const { h, id, service } = await channelFixture(t); service.close();
  h.store.run("UPDATE channel_connectors SET transport='websocket' WHERE id=?", id);
  let sdk; const replies = [];
  const sockets = new ChannelConnections(service, options => {
    sdk = new WSClient(options);
    sdk.start = async args => { sdk.eventDispatcher = args.eventDispatcher; };
    sdk.sendMessage = data => replies.push(JSON.parse(new TextDecoder().decode(data.payload)));
    return sdk;
  }); t.after(() => sockets.close()); sockets.reconcile();
  const e = envelope('persist-before-ack', { message: { chat_type: 'group' } });
  const frame = { headers: Object.entries({ message_id: 'frame-1', sum: '1', seq: '0', type: 'event', trace_id: 'trace-fixture' }).map(([key, value]) => ({ key, value })),
    payload: new TextEncoder().encode(JSON.stringify(e)) };
  h.store.db.exec("CREATE TRIGGER frame_disk_full BEFORE INSERT ON channel_messages BEGIN SELECT RAISE(ABORT,'fixture disk full'); END");
  await sdk.handleEventData(frame);
  assert.equal(replies[0].code, 500); assert.equal(h.store.get('SELECT count(*) n FROM channel_inbox').n, 0);
  h.store.db.exec('DROP TRIGGER frame_disk_full');
  await sdk.handleEventData(frame);
  assert.equal(replies[1].code, 200); assert.equal(h.store.get('SELECT count(*) n FROM channel_inbox').n, 1);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_messages').n, 1);
});

test('bot join starts only local recording and visible-history work; project access alone cannot read a chat', async t => {
  const { h, id, service, wire, admin, member, requests } = await channelFixture(t);
  service.historySync.close();
  const before = h.store.get('SELECT count(*) n FROM scoped_grants').n;
  const joined = envelope(); joined.header.event_type = 'im.chat.member.bot.added_v1'; joined.event = { chat_id: 'oc_joined' };
  const receipt = await post(h, id, joined);
  assert.equal(receipt.status, 200);
  const chat = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_joined'");
  assert.equal(h.store.get('SELECT state FROM channel_sync_jobs WHERE chat_id=?', chat.id).state, 'pending');
  await finished(h, receipt.value.operation_id);
  await until(() => wire.sent.length > 0);
  assert.equal(requests.length, 0);
  assert.equal(h.store.get('SELECT count(*) n FROM scoped_grants').n, before);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_group_scopes').n, 0);
  assert.ok(JSON.stringify(wire.sent[0].content).includes('另行启用'));
  const user = await member('history-project-reader', { repository_ids: ['101'] });
  assert.equal((await user.client('/api/channels/chats')).status, 403);
  assert.equal((await user.client(`/api/channels/chats/${chat.id}/messages`)).status, 403);
  assert.equal((await user.client(`/api/channels/chats/${chat.id}/sync`, 'POST', {})).status, 403);
  assert.equal((await admin(`/api/channels/chats/${chat.id}/messages`)).status, 200);
});
