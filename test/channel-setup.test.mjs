import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, connector, credentials, until } from './channel-fixture.mjs';

const probe = (admin, id, revision = 1) => admin('/api/channels/feishu/probe', 'POST', { connector_id: id, expected_revision: revision });
test('global Feishu setup and credential checks require platform authority; personal setup exposes only app identifiers in scope', async t => {
  const f = await channelFixture(t), { admin, h, id, member } = f;
  await connector(admin, { tenant_id: 'github.com:20', app_id: 'cli_other' });
  const org = await member('org-configurator', { organization_ids: ['10'] });
  assert.equal((await org.client('/api/channels/connectors')).value.connectors.length, 1);
  assert.equal((await org.client('/api/channels/setup')).status, 403);
  assert.equal((await probe(org.client, id)).status, 403);
  assert.equal((await org.client('/api/channels/feishu/probe', 'POST', { app_id: 'cli_fixture', app_secret: credentials.app_secret })).status, 403);
  const personal = (await org.client('/api/channels/bindings')).value;
  assert.deepEqual(personal.applications, [{ id, app_id: 'cli_fixture', tenant_id: 'github.com:10' }]);
  assert.doesNotMatch(JSON.stringify(personal), /credential_ref|actor_tenants|installation_tenant|fixture-feishu|cli_other/);
  const ordinary = await member('no-project-access', {});
  assert.deepEqual((await ordinary.client('/api/channels/bindings')).value.applications, []);
  const global = await admin('/api/channels/setup');
  assert.equal(global.value.origin, 'https://console.example.test'); assert.equal(global.value.connectors.length, 2);
  await admin('/api/identity/tenant', 'POST', { tenant_id: 'github.com:10' });
  assert.equal((await admin('/api/channels/setup')).value.connectors.length, 1);
  assert.equal((await admin('/api/channels/bindings')).value.applications.length, 1);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_connectors').n, 2);
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
