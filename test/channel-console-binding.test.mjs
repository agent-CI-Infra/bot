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
