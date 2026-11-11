import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, connector, credentials, until, envelope, post, finished, group, directQuery, bindFixture } from './channel-fixture.mjs';
import { harness, setup } from './helpers.mjs';

const probe = (admin, id, revision = 1) => admin('/api/channels/feishu/probe', 'POST', { connector_id: id, expected_revision: revision });
test('personal name discovery is owner-only, returns only the matched name and leaves identity proof and grants unchanged', async t => {
  const { h, id, admin, member, wire } = await channelFixture(t);
  await probe(admin, id);
  const local = await member('readable-name-user', {});
  bindFixture(h, id, local.id, 'ou_readable', 'install-tenant');
  const binding = (await local.client('/api/channels/bindings')).value.bindings[0];
  assert.equal(binding.app_name, 'Fixture bot'); assert.equal(binding.tenant_name, 'Fixture enterprise');
  assert.equal(binding.can_read_name, 1); assert.equal(wire.state.profileRequests.length, 0);
  const route = '/api/channels/bindings/' + binding.id + '/name';
  assert.equal((await admin(route, 'POST', {})).status, 404);
  assert.equal((await h.client()(route, 'POST', {})).status, 401);
  assert.equal((await local.client(route, 'POST', {}, { 'X-CSRF-Token': '' })).value.error, 'csrf_required');
  assert.equal((await local.client(route, 'POST', { open_id: 'ou_someone_else' })).value.error, 'unknown_field');
  assert.equal(wire.state.profileRequests.length, 0);
  const before = h.store.get('SELECT * FROM external_identities WHERE id=?', binding.id);
  const grants = JSON.stringify(h.store.all('SELECT * FROM scoped_grants ORDER BY id'));
  const refreshed = await local.client(route, 'POST', {});
  assert.equal(refreshed.status, 201);
  assert.deepEqual(refreshed.value, { id: binding.id, display_name: '张小明' });
  assert.doesNotMatch(JSON.stringify(refreshed.value), /must-not-expose|fixture-only|email|mobile/);
  assert.deepEqual({ ...h.store.get('SELECT * FROM external_identities WHERE id=?', binding.id) }, { ...before, display_name: '张小明' });
  assert.equal(JSON.stringify(h.store.all('SELECT * FROM scoped_grants ORDER BY id')), grants);
  wire.state.profileCode = 99991672;
  assert.equal((await local.client(route, 'POST', {})).value.error, 'channel_user_name_unavailable');
  wire.state.profileCode = 0; wire.state.profileName = '';
  assert.equal((await local.client(route, 'POST', {})).value.error, 'channel_user_name_unavailable');
  wire.state.profileName = 'Wrong person'; wire.state.profileOpenId = 'ou_wrong';
  assert.equal((await local.client(route, 'POST', {})).value.error, 'channel_user_name_unavailable');
  assert.equal(h.store.get('SELECT display_name FROM external_identities WHERE id=?', binding.id).display_name, '张小明');
  const requests = wire.state.profileRequests.length;
  await h.stop(); await h.start();
  assert.equal((await local.client('/api/channels/bindings')).value.bindings[0].display_name, '张小明');
  assert.equal(wire.state.profileRequests.length, requests);
});

test('name lookups never use another enterprise or a replaced app and do not disclose another user binding', async t => {
  const { admin, h, id, wire } = await channelFixture(t);
  const binding = (await admin('/api/channels/bindings')).value.bindings[0];
  assert.equal(binding.can_read_name, 0);
  const route = '/api/channels/bindings/' + binding.id + '/name';
  assert.equal((await admin(route, 'POST', {})).value.error, 'channel_user_name_unavailable');
  assert.equal(wire.state.profileRequests.length, 0);
  await admin('/api/channels/connectors/' + id, 'PATCH', { app_id: 'cli_replaced', bot_open_id: 'ou_replaced_bot', expected_revision: 1 });
  const after = (await admin('/api/channels/bindings')).value.bindings[0];
  assert.equal(after.app_name, null); assert.equal(after.tenant_name, null); assert.equal(after.can_read_name, 0);
  assert.equal((await admin(route, 'POST', {})).value.error, 'channel_connector_inactive');
  assert.equal(h.store.get('SELECT display_name FROM external_identities WHERE id=?', binding.id).display_name, 'ou_alice');
  assert.equal(wire.state.profileRequests.length, 0);
});

test('asynchronous name refresh rechecks revocation and the current connector revision before caching', async t => {
  for (const change of ['disable', 'revision', 'revoke']) await t.test(change, async t => {
    const { admin, h, id, wire, principal } = await channelFixture(t);
    bindFixture(h, id, principal, 'ou_profile_race', 'install-tenant');
    const binding = h.store.get("SELECT * FROM external_identities WHERE external_actor='ou_profile_race'");
    let release; wire.state.profileGate = new Promise(r => { release = r; }); t.after(() => release());
    const pending = admin('/api/channels/bindings/' + binding.id + '/name', 'POST', {});
    await until(() => wire.state.profileRequests.length);
    if (change === 'revoke') await admin('/api/identity/bindings/' + binding.id, 'DELETE', {});
    else await admin('/api/channels/connectors/' + id, 'PATCH', { enabled: change !== 'disable', expected_revision: 1 });
    release();
    const result = await pending;
    assert.ok(result.status >= 400);
    assert.match(result.value.error, /authorization_changed|external_binding_required|channel_connector_inactive|channel_configuration_changed/);
    assert.equal(h.store.get('SELECT display_name FROM external_identities WHERE id=?', binding.id).display_name, 'ou_profile_race');
  });
});

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
  assert.deepEqual(personal.applications, [{ id, app_id: 'cli_fixture' }, { id: other, app_id: 'cli_other' }].map(a => ({ ...a, app_name: '', tenant_name: '',
    chat_url: 'https://applink.feishu.cn/client/bot/open?appId=' + a.app_id })));
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

test('startup removes legacy organization and actor enterprise restrictions without replacing credentials, bindings, group grants, destinations or receipts', async t => {
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
  h.store.db.exec(`ALTER TABLE channel_connectors ADD COLUMN actor_tenants TEXT NOT NULL DEFAULT '["actor-tenant"]'`);
  const tables = ['channel_connectors', 'channel_control_operations', 'channel_credentials', 'external_identities', 'channel_group_scopes', 'channel_bind_requests', 'channel_outbox', 'scoped_grants'];
  const snapshot = () => Object.fromEntries(tables.map(table => [table, h.store.all(`SELECT * FROM ${table}`).map(row => {
    if (['channel_connectors', 'channel_control_operations'].includes(table)) { const { tenant_id, actor_tenants, ...rest } = row; return rest; }
    return row;
  })]));
  const before = snapshot();
  await h.stop(); await h.start();
  assert.deepEqual(snapshot(), before);
  for (const table of ['channel_connectors', 'channel_control_operations']) assert.ok(!h.store.all(`PRAGMA table_info(${table})`).some(c => c.name === 'tenant_id'));
  assert.ok(!h.store.all('PRAGMA table_info(channel_connectors)').some(c => c.name === 'actor_tenants'));
  const external = await post(h, id, envelope('/bind', { sender: { tenant_key: 'external-tenant' } }));
  assert.equal((await finished(h, external.value.operation_id)).state, 'completed');
  assert.equal((await admin('/api/channels/operations/' + granted.value.operation_id)).status, 200);
  assert.equal((await probe(admin, id)).status, 201);
  const r = await post(h, id, envelope(directQuery('201', 'foreign')));
  assert.equal((await finished(h, r.value.operation_id)).state, 'completed');
  await h.stop(); await h.start();
  assert.equal((await admin('/api/channels/setup')).value.connectors[0].id, id);
  assert.equal(h.store.get('PRAGMA integrity_check').integrity_check, 'ok');
});

test('upgrading legacy binding requests adds code discovery without invalidating existing links', async t => {
  const { admin, h, id, service } = await channelFixture(t);
  service.close();
  const e = service.adapter(service.connector(id)).normalize(envelope('/bind', { sender: { sender_id: { open_id: 'ou_legacy_migration' } } }));
  const binding = service.bindings.begin(e);
  const before = h.store.get('SELECT subject,expires_at FROM channel_bind_requests');
  h.store.db.exec('DROP INDEX channel_bind_code; ALTER TABLE channel_bind_requests DROP COLUMN code_hash');
  await h.stop(); await h.start();
  const after = h.store.get('SELECT subject,expires_at,code_hash FROM channel_bind_requests');
  assert.equal(after.subject, before.subject); assert.equal(after.expires_at, before.expires_at); assert.equal(after.code_hash, null);
  assert.equal((await admin('/api/channels/bindings/claim', 'POST', { challenge: binding.challenge })).status, 201);
  const pending = (await admin('/api/channels/bindings')).value.pending.find(p => p.open_id === 'ou_legacy_migration');
  const confirmed = await post(h, id, envelope('确认绑定 ' + pending.confirmation, { sender: { sender_id: { open_id: 'ou_legacy_migration' } } }));
  assert.equal((await finished(h, confirmed.value.operation_id)).state, 'completed');
});

test('Feishu probes use saved or ephemeral credentials, return safe bot facts and never claim event delivery', async t => {
  const { admin, id, wire, h } = await channelFixture(t);
  const checked = await probe(admin, id);
  assert.deepEqual(checked.value, { bot_open_id: 'ou_bot', name: 'Fixture bot', name_source: 'application', tenant_name: 'Fixture enterprise', revision: 1, state: 'verified', event_delivery_verified: false });
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

test('connection names are discovered, cached across restarts and refreshed without invalidating channel configuration', async t => {
  const { admin, h, wire, service } = await channelFixture(t);
  const id = await connector(admin, { app_id: 'cli_names', installation_tenant: undefined, bot_open_id: undefined });
  const read = () => ({ ...h.store.get('SELECT app_name,tenant_name,revision FROM channel_connectors WHERE id=?', id) });
  assert.deepEqual(read(), { app_name: 'Fixture bot', tenant_name: 'Fixture enterprise', revision: 1 });
  const requests = wire.state.authRequests.length;
  for (let i = 0; i < 2; i++) {
    const c = (await admin('/api/channels/setup')).value.connectors.find(c => c.id === id);
    assert.equal(c.app_name, 'Fixture bot'); assert.equal(c.tenant_name, 'Fixture enterprise');
  }
  assert.equal(wire.state.authRequests.length, requests);
  const event = service.adapter(service.connector(id)).normalize(envelope('/bind', { header: { app_id: 'cli_names' } }));
  wire.state.currentAppName = 'Renamed app'; wire.state.tenantName = 'Renamed enterprise';
  assert.equal((await probe(admin, id)).value.revision, 1);
  assert.deepEqual(read(), { app_name: 'Renamed app', tenant_name: 'Renamed enterprise', revision: 1 });
  const personal = (await admin('/api/channels/bindings')).value.applications.find(a => a.id === id);
  assert.equal(personal.app_name, 'Renamed app'); assert.equal(personal.tenant_name, 'Renamed enterprise');
  assert.doesNotMatch(JSON.stringify(personal), /must-not-return|credential|secret|installation_tenant/);
  wire.state.applicationCode = 99991672;
  const fallback = await probe(admin, id);
  assert.equal(fallback.value.app_error, 'channel_application_permission_required');
  assert.equal(fallback.value.name, 'Renamed app');
  assert.deepEqual(read(), { app_name: 'Renamed app', tenant_name: 'Renamed enterprise', revision: 1 });
  wire.state.applicationCode = 0; wire.state.applicationId = 'cli_wrong_source';
  assert.equal((await probe(admin, id)).value.error, 'channel_source_mismatch');
  assert.deepEqual(read(), { app_name: 'Renamed app', tenant_name: 'Renamed enterprise', revision: 1 });
  assert.equal(service.source(event).id, id);
  await h.stop(); await h.start();
  assert.deepEqual(read(), { app_name: 'Renamed app', tenant_name: 'Renamed enterprise', revision: 1 });
  // Legacy or bot-only metadata can advance even if current-application permissions have never been granted.
  const botOnly = await connector(admin, { app_id: 'cli_bot_only' });
  wire.state.applicationId = null; wire.state.applicationCode = 99991672;
  wire.state.appName = 'Bot-only original';
  assert.equal((await probe(admin, botOnly)).value.name, 'Bot-only original');
  wire.state.appName = 'Bot-only renamed';
  assert.equal((await probe(admin, botOnly)).value.name, 'Bot-only renamed');
  assert.equal(h.store.get('SELECT app_name_source FROM channel_connectors WHERE id=?', botOnly).app_name_source, 'bot');
});

test('missing display information preserves cached names; an installation mismatch never updates labels', async t => {
  const { admin, id, h, wire } = await channelFixture(t);
  assert.equal((await probe(admin, id)).status, 201);
  wire.state.appName = ''; wire.state.tenantCode = 1184001;
  const partial = await probe(admin, id);
  assert.equal(partial.status, 201); assert.equal(partial.value.tenant_error, 'channel_tenant_unavailable');
  const read = () => ({ ...h.store.get('SELECT app_name,tenant_name,revision FROM channel_connectors WHERE id=?', id) });
  const saved = { app_name: 'Fixture bot', tenant_name: 'Fixture enterprise', revision: 1 };
  assert.deepEqual(read(), saved);
  wire.state.tenantCode = 0; wire.state.tenantName = '';
  assert.equal((await probe(admin, id)).status, 201); assert.deepEqual(read(), saved);
  wire.state.installationTenant = 'other-installation'; wire.state.appName = 'Wrong app'; wire.state.tenantName = 'Wrong enterprise';
  assert.equal((await probe(admin, id)).value.error, 'channel_source_mismatch'); assert.deepEqual(read(), saved);
  const changed = await admin('/api/channels/connectors/' + id, 'PATCH', { app_id: 'cli_new', installation_tenant: 'other-installation', bot_open_id: 'ou_new', expected_revision: 1 });
  assert.equal(changed.status, 200);
  assert.deepEqual(read(), { app_name: '', tenant_name: '', revision: 2 });
});

test('a label refresh rechecks configuration after the enterprise lookup returns', async t => {
  const { admin, id, h, wire } = await channelFixture(t);
  let release; wire.state.tenantGate = new Promise(r => { release = r; }); t.after(() => release());
  const pending = probe(admin, id);
  await until(() => wire.state.tenantStarted);
  assert.equal((await admin('/api/channels/connectors/' + id, 'PATCH', { expected_revision: 1, enabled: false })).status, 200);
  release();
  assert.equal((await pending).value.error, 'channel_revision_conflict');
  assert.equal(h.store.get('SELECT app_name FROM channel_connectors WHERE id=?', id).app_name, '');
});

test('startup adds empty display fields to old connections without replacing their data', async t => {
  const { h, id, service } = await channelFixture(t);
  service.close();
  const credentials = h.store.all('SELECT * FROM channel_credentials');
  h.store.db.exec('ALTER TABLE channel_connectors DROP COLUMN app_name; ALTER TABLE channel_connectors DROP COLUMN tenant_name');
  const before = { ...h.store.get('SELECT * FROM channel_connectors WHERE id=?', id) };
  for (let i = 0; i < 2; i++) {
    await h.stop(); await h.start();
    const { app_name, tenant_name, ...after } = h.store.get('SELECT * FROM channel_connectors WHERE id=?', id);
    assert.equal(app_name, ''); assert.equal(tenant_name, ''); assert.deepEqual(after, before);
    assert.deepEqual(h.store.all('SELECT * FROM channel_credentials'), credentials);
  }
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

test('enterprise saves discover the bot from effective credentials and failed discovery leaves no partial configuration', async t => {
  const { admin, h, wire } = await channelFixture(t);
  wire.state.botOpenId = 'ou_discovered';
  const id = await connector(admin, { app_id: 'cli_auto', bot_open_id: undefined });
  const before = h.store.get('SELECT * FROM channel_connectors WHERE id=?', id);
  assert.equal(before.bot_open_id, 'ou_discovered');
  const edit = credentials => admin('/api/channels/connectors/' + id, 'PATCH', { expected_revision: 1, credentials });
  wire.state.authCode = 10003;
  assert.equal((await edit({ app_secret: 'invalid-secret' })).value.error, 'channel_auth_failed');
  assert.deepEqual(h.store.get('SELECT * FROM channel_connectors WHERE id=?', id), before);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_credentials').n, 2);
  wire.state.authCode = 0; wire.state.botOpenId = 'ou_rotated';
  assert.equal((await edit({ app_secret: 'valid-rotated-secret' })).status, 200);
  const after = h.store.get('SELECT * FROM channel_connectors WHERE id=?', id);
  assert.equal(after.bot_open_id, 'ou_rotated'); assert.equal(after.revision, 2);
  const stored = h.store.get('SELECT sealed FROM channel_credentials WHERE id=?', after.credential_ref);
  assert.equal(h.store.secrets.open(stored.sealed, 'channel-credential:' + after.credential_ref).app_secret, 'valid-rotated-secret');
});

test('automatic discovery rechecks the revision after asynchronous authentication before saving rotated credentials', async t => {
  const { admin, id, h, wire } = await channelFixture(t);
  let release; wire.state.authGate = new Promise(r => { release = r; }); t.after(() => release());
  const pending = admin('/api/channels/connectors/' + id, 'PATCH', { expected_revision: 1, app_id: 'cli_changed', credentials: { app_secret: 'pending-secret' } });
  await until(() => wire.state.authStarted);
  assert.equal((await admin('/api/channels/connectors/' + id, 'PATCH', { expected_revision: 1, enabled: false })).status, 200);
  release();
  assert.equal((await pending).value.error, 'channel_revision_conflict');
  assert.equal(h.store.get('SELECT count(*) n FROM channel_credentials').n, 1);
  assert.equal(h.store.get('SELECT revision,enabled FROM channel_connectors WHERE id=?', id).enabled, 0);
});

test('enterprise saves discover the installation without an actor enterprise list and reject failed or duplicate discovery atomically', async t => {
  const { admin, h, wire } = await channelFixture(t);
  const create = () => connector(admin, { app_id: 'cli_auto_tenant', installation_tenant: undefined, bot_open_id: undefined, actor_tenants: ['legacy-home-only'] });
  for (const [code, tenant] of [[1184001, 'install-tenant'], [0, '']]) {
    wire.state.tenantCode = code; wire.state.installationTenant = tenant;
    await assert.rejects(create(), /channel_tenant_unavailable/);
    assert.equal(h.store.get('SELECT count(*) n FROM channel_connectors').n, 1);
    assert.equal(h.store.get('SELECT count(*) n FROM channel_credentials').n, 1);
  }
  wire.state.installationTenant = 'discovered-installation';
  const id = await create(), c = h.store.get('SELECT * FROM channel_connectors WHERE id=?', id);
  assert.equal(c.installation_tenant, 'discovered-installation'); assert.equal(c.bot_open_id, 'ou_bot');
  assert.ok(!Object.hasOwn(c, 'actor_tenants'));
  const listed = (await admin('/api/channels/setup')).value.connectors.find(row => row.id === id);
  assert.ok(!Object.hasOwn(listed, 'actor_tenants'));
  await assert.rejects(create(), /channel_installation_conflict/);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_credentials').n, 2);
  const r = await post(h, id, envelope('/bind', { header: { app_id: 'cli_auto_tenant', tenant_key: 'discovered-installation' }, sender: { tenant_key: 'external-tenant' } }));
  assert.equal((await finished(h, r.value.operation_id)).state, 'completed');
});

test('store apps bootstrap without a bot ID, then persist discovery after a verified ticket and retain revision checks', async t => {
  const { admin, h, wire } = await channelFixture(t);
  const id = await connector(admin, { app_id: 'cli_auto_store', application_type: 'saas', bot_open_id: undefined });
  assert.equal(wire.state.authRequests.length, 0);
  assert.equal(h.store.get('SELECT bot_open_id FROM channel_connectors WHERE id=?', id).bot_open_id, '');
  const message = () => envelope('/bind', { header: { app_id: 'cli_auto_store' } });
  assert.equal((await post(h, id, message())).value.error, 'channel_bot_unavailable');
  assert.equal((await probe(admin, id)).value.error, 'channel_app_ticket_required');
  const ticket = { ts: String(Date.now() / 1000), uuid: 'auto-ticket', token: credentials.verification_token, type: 'event_callback',
    event: { type: 'app_ticket', app_id: 'cli_auto_store', app_ticket: 'fixture-store-ticket' } };
  assert.equal((await post(h, id, ticket, { encrypted: true })).value.state, 'completed');
  assert.equal((await probe(admin, id)).value.revision, 2);
  assert.equal(h.store.get('SELECT bot_open_id FROM channel_connectors WHERE id=?', id).bot_open_id, 'ou_bot');
  assert.equal((await probe(admin, id)).value.error, 'channel_revision_conflict');
  assert.equal((await probe(admin, id, 2)).value.revision, 2);
  assert.equal((await post(h, id, message())).value.state, 'queued');
  assert.ok(wire.state.authRequests.some(a => a.tenant_key === 'install-tenant'));
});
