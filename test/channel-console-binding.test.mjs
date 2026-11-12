import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, connector, envelope, inGroup, post, finished, digest } from './channel-fixture.mjs';

// #236: the console issues one binding string for the chosen bot, and the private-chat message carrying it completes the
// binding in one step. Nothing is bound before that message, and a consumed code cannot bind twice.
const dm = (content, actor = 'ou_console', chat = 'oc_console') =>
  envelope(content, { sender: { sender_id: { open_id: actor } }, message: { chat_id: chat } });

test('the console issues a binding string that the private-chat message completes in one step', async t => {
  const { h, id, admin } = await channelFixture(t);
  const identities = () => h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_console'").n;
  const grants = () => h.store.get('SELECT count(*) n FROM scoped_grants').n;
  const issuedResponse = await admin('/api/channels/bindings/issue', 'POST', { connector_id: id });
  const issued = issuedResponse.value;
  assert.match(issued.code, /^FSB-/);
  assert.ok(issued.expires_at - Date.now() <= 300000);
  // A code that has not been proved in a private chat is not a pending confirmation in the console.
  assert.deepEqual((await admin('/api/channels/bindings')).value.pending, []);
  assert.equal(identities(), 0);
  const startGrants = grants();

  const unknown = await finished(h, (await post(h, id, dm('绑定 FSB-0000000000'))).value.operation_id);
  assert.equal(unknown.error, 'binding_code_invalid');
  const group = await finished(h, (await post(h, id, inGroup('绑定 ' + issued.code, 'ou_console'))).value.operation_id);
  assert.equal(group.error, 'binding_private_chat_required');
  assert.equal(identities(), 0);

  // An expired code is refused before any identity is minted, and the console can issue another one.
  const expired = (await admin('/api/channels/bindings/issue', 'POST', { connector_id: id })).value;
  h.store.run('UPDATE channel_bind_requests SET expires_at=0 WHERE code_hash=?', digest(expired.code));
  const late = await finished(h, (await post(h, id, dm('绑定 ' + expired.code))).value.operation_id);
  assert.equal(late.error, 'binding_expired');
  assert.equal(identities(), 0);

  // One private-chat message with the console-issued code is the proof; the web session that issued it is the account.
  // Issuing this string retired the earlier unused ones, so the message below carries the newest one.
  const fresh = (await admin('/api/channels/bindings/issue', 'POST', { connector_id: id })).value;
  const bound = await finished(h, (await post(h, id, dm('绑定 ' + fresh.code))).value.operation_id);
  assert.equal(bound.state, 'completed');
  const identity = h.store.get("SELECT * FROM external_identities WHERE external_actor='ou_console'");
  assert.equal(identity.connector, id + ':cli_fixture');
  assert.equal(identity.external_tenant, 'actor-tenant');
  // Binding adds no project authority and the code is spent.
  assert.equal(grants(), startGrants);
  assert.equal(h.store.get('SELECT consumed_at IS NOT NULL c FROM channel_bind_requests WHERE code_hash=?', digest(fresh.code)).c, 1);
  const replay = await finished(h, (await post(h, id, dm('绑定 ' + fresh.code))).value.operation_id);
  assert.equal(replay.error, 'binding_replayed');
  assert.equal(identities(), 1);

  // A private-chat message that is not a binding string never reaches the binding path.
  const plain = await finished(h, (await post(h, id, dm('绑定'))).value.operation_id);
  assert.equal(plain.state, 'completed');
});

test('a new string from the console retires the previous unused one', async t => {
  const { h, id, admin } = await channelFixture(t);
  const identities = () => h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_console'").n;
  const first = (await admin('/api/channels/bindings/issue', 'POST', { connector_id: id })).value;
  const second = (await admin('/api/channels/bindings/issue', 'POST', { connector_id: id })).value;
  // The older message may still sit in the chat, so sending it must not bind: only the newest string can complete.
  const old = await finished(h, (await post(h, id, dm('绑定 ' + first.code))).value.operation_id);
  assert.equal(old.error, 'binding_superseded');
  assert.equal(identities(), 0);
  assert.ok(h.store.get('SELECT superseded_at FROM channel_bind_requests WHERE code_hash=?', digest(first.code)).superseded_at);
  const fresh = await finished(h, (await post(h, id, dm('绑定 ' + second.code))).value.operation_id);
  assert.equal(fresh.state, 'completed');
  assert.equal(identities(), 1);
});

test('a real string issued for one connector is refused when another connector carries it', async t => {
  const { h, id, admin } = await channelFixture(t);
  const other = await connector(admin, { app_id: 'cli_other', installation_tenant: 'install-other', bot_open_id: 'ou_bot_other' });
  const issued = (await admin('/api/channels/bindings/issue', 'POST', { connector_id: other })).value;
  // The row exists, so this reaches the connector check instead of the unknown-code branch, and the attempt spends nothing.
  const wrong = await finished(h, (await post(h, id, dm('绑定 ' + issued.code))).value.operation_id);
  assert.equal(wrong.error, 'binding_code_invalid');
  assert.equal(h.store.get('SELECT consumed_at FROM channel_bind_requests WHERE code_hash=?', digest(issued.code)).consumed_at, null);
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_console'").n, 0);
  // The string belongs to the connector it was issued for, so the same message on that bot completes the binding.
  assert.equal(h.store.get('SELECT connector_id FROM channel_bind_requests WHERE code_hash=?', digest(issued.code)).connector_id, other);
});

const status = (client, id) => client('/api/channels/bindings/requests/' + id);
const event = (f, actor, chat, overrides = {}) => f.service.adapter(f.service.connector(f.id)).normalize(
  envelope('binding proof', { sender: { sender_id: { open_id: actor } }, message: { chat_id: chat }, ...overrides }));

test('the owner reads only this request result, including a reactivated identity without another record', async t => {
  const f = await channelFixture(t), { admin, h, id } = f;
  const original = h.store.get("SELECT id FROM external_identities WHERE external_actor='ou_alice'");
  assert.equal((await admin('/api/identity/bindings/' + original.id, 'DELETE', {})).status, 200);
  await admin('/api/auth/me'); // The page refreshes its session authorization after unlinking.
  const issued = (await admin('/api/channels/bindings/issue', 'POST', { connector_id: id })).value;
  assert.match(issued.request_id, /^[a-f0-9]{64}$/);
  const pending = await status(admin, issued.request_id);
  assert.deepEqual(Object.keys(pending.value).sort(), ['expires_at', 'request_id', 'state']);
  assert.equal(pending.value.state, 'pending');
  assert.doesNotMatch(JSON.stringify(pending.value), /FSB-|code_hash|session_ref|subject|credentials/);
  const other = await f.member('other-request-reader', { repository_ids: ['101'] });
  assert.equal((await status(other.client, issued.request_id)).status, 404);
  const grants = h.store.get('SELECT count(*) n FROM scoped_grants').n;
  await f.service.bindings.redeem(issued.code, event(f, 'ou_alice', 'oc_reactivated'));
  assert.equal(h.store.get('SELECT count(*) n FROM external_identities').n, 1);
  assert.deepEqual((await status(admin, issued.request_id)).value, {
    request_id: issued.request_id, expires_at: issued.expires_at, state: 'completed', identity_id: original.id });
  h.store.run('UPDATE channel_bind_requests SET expires_at=0 WHERE challenge_hash=?', issued.request_id);
  assert.equal((await status(admin, issued.request_id)).value.state, 'completed', 'a late read still proves a completed binding');
  assert.equal(h.store.get('SELECT count(*) n FROM scoped_grants').n, grants);
  await admin('/api/auth/me');
  assert.equal((await admin('/api/identity/bindings/' + original.id, 'DELETE', {})).status, 200);
  await admin('/api/auth/me');
  assert.equal((await status(admin, issued.request_id)).value.state, 'revoked');
});

test('request reads identify expiration, regeneration, connector replacement and a revoked issuing session', async t => {
  const f = await channelFixture(t), { admin, h, id } = f;
  const issue = async () => (await admin('/api/channels/bindings/issue', 'POST', { connector_id: id })).value;
  const first = await issue(), next = await issue();
  assert.equal((await status(admin, first.request_id)).value.state, 'superseded');
  h.store.run('UPDATE channel_bind_requests SET expires_at=0 WHERE challenge_hash=?', next.request_id);
  assert.equal((await status(admin, next.request_id)).value.state, 'expired');
  const disabled = await issue();
  h.store.run('UPDATE channel_connectors SET enabled=0,revision=revision+1 WHERE id=?', id);
  assert.equal((await status(admin, disabled.request_id)).value.state, 'invalidated');
  h.store.run('UPDATE channel_connectors SET enabled=1,revision=revision+1 WHERE id=?', id);
  assert.equal((await status(admin, disabled.request_id)).value.state, 'invalidated', 'reenabling does not revive an old string');
  await assert.rejects(() => f.service.bindings.redeem(disabled.code, event(f, 'ou_disabled', 'oc_disabled')), /binding_code_invalid/);
  const replaced = await issue();
  h.store.run("UPDATE channel_connectors SET app_id='cli_replaced' WHERE id=?", id);
  assert.equal((await status(admin, replaced.request_id)).value.state, 'invalidated');
  await assert.rejects(() => f.service.bindings.redeem(replaced.code,
    event(f, 'ou_replaced', 'oc_replaced', { header: { app_id: 'cli_replaced' } })), /binding_code_invalid/);
  h.store.run("UPDATE channel_connectors SET app_id='cli_fixture' WHERE id=?", id);
  const signedOut = await issue(), secondSession = h.client();
  await secondSession('/api/auth/login', 'POST', { username: 'administrator', password: f.password });
  await admin('/api/auth/logout', 'POST', {});
  assert.equal((await status(secondSession, signedOut.request_id)).value.state, 'invalidated');
});

test('two senders redeeming one console string cannot overwrite the winning proof', async t => {
  const f = await channelFixture(t), issued = (await f.admin('/api/channels/bindings/issue', 'POST', { connector_id: f.id })).value;
  const before = f.h.store.get('SELECT count(*) n FROM external_identities').n;
  const results = await Promise.allSettled([
    f.service.bindings.redeem(issued.code, event(f, 'ou_first', 'oc_first')),
    f.service.bindings.redeem(issued.code, event(f, 'ou_second', 'oc_second')),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM external_identities').n, before + 1);
  assert.equal((await status(f.admin, issued.request_id)).value.state, 'completed');
});

test('regenerating during proof verification retires the earlier sender before it can bind', async t => {
  const f = await channelFixture(t), bindings = f.service.bindings;
  const first = (await f.admin('/api/channels/bindings/issue', 'POST', { connector_id: f.id })).value;
  const begin = bindings.identities.beginVerifiedExternalBinding.bind(bindings.identities);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  bindings.identities.beginVerifiedExternalBinding = async (...args) => { const result = await begin(...args); entered(); await gate; return result; };
  const old = bindings.redeem(first.code, event(f, 'ou_outdated', 'oc_outdated'));
  const rejected = assert.rejects(old, /binding_superseded/);
  await started;
  const next = (await f.admin('/api/channels/bindings/issue', 'POST', { connector_id: f.id })).value;
  release(); await rejected;
  assert.equal(f.h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_outdated'").n, 0);
  bindings.identities.beginVerifiedExternalBinding = begin;
  await bindings.redeem(next.code, event(f, 'ou_current', 'oc_current'));
  assert.equal((await status(f.admin, next.request_id)).value.state, 'completed');
});

test('a committed identity remains provable if recording the channel receipt is interrupted', async t => {
  const f = await channelFixture(t), bindings = f.service.bindings;
  const issued = (await f.admin('/api/channels/bindings/issue', 'POST', { connector_id: f.id })).value;
  const complete = bindings.identities.completeExternalBinding.bind(bindings.identities);
  bindings.identities.completeExternalBinding = async (...args) => { await complete(...args); throw new Error('fixture_after_identity_commit'); };
  await assert.rejects(() => bindings.redeem(issued.code, event(f, 'ou_committed', 'oc_committed')), /fixture_after_identity_commit/);
  assert.equal(f.h.store.get('SELECT identity_id FROM channel_bind_requests WHERE challenge_hash=?', issued.request_id).identity_id, null);
  const identity = f.h.store.get("SELECT id FROM external_identities WHERE external_actor='ou_committed'");
  const read = await status(f.admin, issued.request_id);
  assert.equal(read.value.state, 'completed'); assert.equal(read.value.identity_id, identity.id);
  assert.equal(f.h.store.get('SELECT identity_id FROM channel_bind_requests WHERE challenge_hash=?', issued.request_id).identity_id, null, 'status reconciliation stays read-only');
});
