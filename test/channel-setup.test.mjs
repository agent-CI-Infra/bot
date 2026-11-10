import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, connector, credentials, until, envelope, post, finished, group, directQuery } from './channel-fixture.mjs';
import { harness, setup } from './helpers.mjs';

const probe = (admin, id, revision = 1) => admin('/api/channels/feishu/probe', 'POST', { connector_id: id, expected_revision: revision });
test('global Feishu administration requires platform authority; public app discovery is independent of project grants and selected organization', async t => {
  const f = await channelFixture(t), { admin, h, id, member } = f;
  const other = await connector(admin, { app_id: 'cli_other' });
  const org = await member('org-configurator', { organization_ids: ['10'] });
  assert.equal((await org.client('/api/channels/connectors')).status, 403);
  assert.equal((await org.client('/api/channels/connectors/' + id, 'PATCH', { enabled: false, expected_revision: 1 })).status, 403);
  assert.equal((await org.client('/api/channels/connectors', 'POST', {})).status, 403);
  for (const suffix of ['outbox', 'events']) assert.equal((await org.client('/api/channels/connectors/' + id + '/' + suffix)).status, 403);
  assert.equal((await org.client('/api/channels/setup')).status, 403);
  assert.equal((await probe(org.client, id)).status, 403);
  assert.equal((await org.client('/api/channels/feishu/probe', 'POST', { app_id: 'cli_fixture', app_secret: credentials.app_secret })).status, 403);
  const personal = (await org.client('/api/channels/bindings')).value;
  assert.deepEqual(personal.applications, [{ id, app_id: 'cli_fixture' }, { id: other, app_id: 'cli_other' }]);
  assert.doesNotMatch(JSON.stringify(personal), /credential_ref|actor_tenants|installation_tenant|fixture-feishu|tenant_id/);
  const ordinary = await member('no-project-access', {});
  assert.deepEqual((await ordinary.client('/api/channels/bindings')).value.applications, personal.applications);
  const global = await admin('/api/channels/setup');
  assert.equal(global.value.origin, 'https://console.example.test'); assert.equal(global.value.connectors.length, 2);
  await admin('/api/identity/tenant', 'POST', { tenant_id: 'github.com:10' });
  assert.equal((await admin('/api/channels/setup')).value.connectors.length, 2);
  assert.equal((await admin('/api/channels/bindings')).value.applications.length, 2);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_connectors').n, 2);
  const receipt = h.store.get('SELECT id FROM channel_control_operations WHERE project_id IS NULL').id;
  assert.equal((await org.client('/api/channels/operations/' + receipt)).status, 403);
  assert.equal((await admin('/api/channels/operations/' + receipt)).status, 200);
});

test('an administrator can connect Feishu before any GitHub organization or project exists', async t => {
  const h = await harness(t), { admin } = await setup(h);
  assert.equal(h.store.get('SELECT count(*) n FROM tenants').n, 0);
  const id = await connector(admin);
  assert.equal((await admin('/api/channels/setup')).value.connectors[0].id, id);
  assert.equal((await admin('/api/channels/connectors/' + id, 'PATCH', { tenant_id: 'github.com:10', expected_revision: 1 })).value.error, 'unknown_field');
});

test('startup migrates organization connections without replacing credentials, bindings, group grants, destinations or receipts', async t => {
  const { h, id, service, admin } = await channelFixture(t);
  service.close();
  const event = service.adapter(service.connector(id)).normalize(envelope());
  service.bindings.begin(event);
  const actor = await service.actor(event, '101');
  service.enqueue(actor, event, '101', 'migration-destination');
  const granted = await group(admin, id); assert.equal(granted.status, 200);
  // Recreate the two legacy organization columns in this persisted fixture before a real restart.
  for (const table of ['channel_connectors', 'channel_control_operations'])
    h.store.db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'github.com:10'`);
  const tables = ['channel_connectors', 'channel_control_operations', 'channel_credentials', 'external_identities', 'channel_group_scopes', 'channel_bind_requests', 'channel_outbox', 'scoped_grants'];
  const snapshot = () => Object.fromEntries(tables.map(table => [table, h.store.all(`SELECT * FROM ${table}`).map(row => {
    if (['channel_connectors', 'channel_control_operations'].includes(table)) { const { tenant_id, ...rest } = row; return rest; }
    return row;
  })]));
  const before = snapshot();
  await h.stop(); await h.start();
  assert.deepEqual(snapshot(), before);
  for (const table of ['channel_connectors', 'channel_control_operations']) assert.ok(!h.store.all(`PRAGMA table_info(${table})`).some(c => c.name === 'tenant_id'));
  assert.equal((await admin('/api/channels/operations/' + granted.value.operation_id)).status, 200);
  assert.equal((await probe(admin, id)).status, 201);
  const r = await post(h, id, envelope(directQuery('201', 'foreign')));
  assert.equal((await finished(h, r.value.operation_id)).state, 'completed');
  await h.stop(); await h.start();
  assert.equal((await admin('/api/channels/setup')).value.connectors[0].id, id);
  assert.equal(h.store.get('PRAGMA integrity_check').integrity_check, 'ok');
});

test('Feishu probes use saved or ephemeral credentials, return safe bot facts and never claim event delivery', async t => {
  const { admin, id, wire, h } = await channelFixture(t);
  const checked = await probe(admin, id);
  assert.deepEqual(checked.value, { bot_open_id: 'ou_bot', name: 'Fixture bot', state: 'verified', event_delivery_verified: false });
  const preview = await admin('/api/channels/feishu/probe', 'POST', { app_id: 'cli_preview', app_secret: 'unsaved-preview-secret' });
  assert.equal(preview.status, 201); assert.equal(preview.value.bot_open_id, 'ou_bot');
  assert.equal(wire.state.authRequests.at(-1).app_id, 'cli_preview');
  assert.equal(h.store.get('SELECT count(*) n FROM channel_credentials').n, 1);
  assert.equal(h.store.get('SELECT last_received_at FROM channel_connectors WHERE id=?', id).last_received_at, null);
  wire.state.authCode = 10003;
  const rejected = await probe(admin, id); assert.equal(rejected.status, 502); assert.equal(rejected.value.error, 'channel_auth_failed');
  assert.doesNotMatch(JSON.stringify(rejected.value), /fixture-feishu-app-secret|fixture-only-access-token/);
  wire.state.authCode = 0; wire.state.botCode = 999;
  assert.equal((await probe(admin, id)).value.error, 'channel_bot_unavailable');
  wire.state.botCode = 0; wire.state.botOpenId = '';
  assert.equal((await probe(admin, id)).value.error, 'channel_bot_unavailable');
  assert.equal(wire.sent.length, 0);
});

test('credential probes reject stale revisions and recheck live configuration after asynchronous authentication', async t => {
  const { admin, id, wire, h } = await channelFixture(t);
  assert.equal((await probe(admin, id, 0)).value.error, 'channel_revision_conflict');
  assert.equal(wire.state.authRequests.length, 0);
  let release; wire.state.authGate = new Promise(r => { release = r; }); t.after(() => release());
  const pending = probe(admin, id);
  await until(() => wire.state.authStarted);
  assert.equal((await admin('/api/channels/connectors/' + id, 'PATCH', { expected_revision: 1, enabled: false })).status, 200);
  release();
  assert.equal((await pending).value.error, 'channel_revision_conflict');
  assert.equal(h.store.get('SELECT enabled FROM channel_connectors WHERE id=?', id).enabled, 0);
});

test('socket setup needs only an app secret; switching to HTTP requires signing keys and partial edits preserve saved secrets', async t => {
  const { admin, h } = await channelFixture(t);
  const id = await connector(admin, { app_id: 'cli_socket', transport: 'websocket', credentials: { app_secret: 'socket-secret' } });
  const edit = input => admin('/api/channels/connectors/' + id, 'PATCH', input);
  assert.equal((await edit({ expected_revision: 1, transport: 'http' })).value.error, 'channel_http_credentials_required');
  assert.equal(h.store.get('SELECT revision FROM channel_connectors WHERE id=?', id).revision, 1);
  assert.equal((await edit({ expected_revision: 1, transport: 'http', credentials: { verification_token: 'http-token', encrypt_key: 'http-key' } })).status, 200);
  assert.equal((await edit({ expected_revision: 2, credentials: { app_secret: 'rotated-secret' } })).status, 200);
  const c = h.store.get('SELECT * FROM channel_connectors WHERE id=?', id), row = h.store.get('SELECT * FROM channel_credentials WHERE id=?', c.credential_ref);
  assert.deepEqual(h.store.secrets.open(row.sealed, 'channel-credential:' + c.credential_ref), { app_secret: 'rotated-secret', verification_token: 'http-token', encrypt_key: 'http-key' });
  assert.equal((await edit({ expected_revision: 3, application_type: 'saas', transport: 'websocket' })).value.error, 'channel_transport_invalid');
  assert.doesNotMatch(JSON.stringify((await admin('/api/channels/setup')).value), /socket-secret|rotated-secret|http-token|http-key/);
});
