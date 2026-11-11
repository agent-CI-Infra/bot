import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { identityFixture } from './identity-fixture.mjs';
import { session } from '../dist/app/auth.js';
import { resolveActor, authorize, invalidate } from '../dist/identity/authorization.js';
import { ChannelConnections } from '../dist/channels/connections.js';
import { channelFixture, transport, connector, envelope, post, until, finished, bindFixture, directQuery, group, inGroup, cardEvent, cardToken, digest, credentials } from './channel-fixture.mjs';
import { managerSection } from './helpers.mjs';

test('Feishu verifies raw signatures, decryption and app/tenant before persisting all delivered messages independently of addressing', async t => {
  const { h, id, wire } = await channelFixture(t);
  assert.equal((await post(h, id, envelope(), { headers: { 'X-Lark-Signature': '0'.repeat(64) } })).status, 401);
  assert.equal((await post(h, id, envelope(), { timestamp: 1 })).status, 401);
  assert.equal((await post(h, id, envelope('', { header: { app_id: 'wrong' } }))).status, 403);
  assert.equal((await post(h, id, envelope('', { header: { tenant_key: 'wrong' } }))).status, 403);
  assert.equal((await post(h, id, envelope('', { sender: { tenant_key: '' } }))).status, 400);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_inbox').n, 0);
  for (const quiet of [envelope('loop', { sender: { sender_type: 'app' } }), envelope('all group messages', { message: { chat_id: 'oc_group', chat_type: 'group' } }), envelope('old', { message: { create_time: '1' } })]) {
    assert.equal((await post(h, id, quiet)).value.state, 'completed');
  }
  assert.equal(h.store.get('SELECT count(*) n FROM channel_messages').n, 3);
  const challenge = await post(h, id, { type: 'url_verification', challenge: 'fixture-challenge', token: credentials.verification_token }, { encrypted: true });
  assert.deepEqual(challenge.value, { challenge: 'fixture-challenge' });
  const data = envelope(directQuery()), result = await post(h, id, data, { encrypted: true });
  assert.equal(result.status, 200); assert.equal(result.value.state, 'queued');
  assert.equal(h.store.get('SELECT event_id FROM channel_inbox WHERE id=?', result.value.operation_id).event_id, data.header.event_id);
  assert.equal((await finished(h, result.value.operation_id)).state, 'completed');
  await until(() => wire.sent.length);
  assert.ok(!readFileSync(h.database).includes(Buffer.from(credentials.app_secret)));
  const publicData = JSON.stringify((await h.client()('/api/channels/connectors')).value);
  assert.doesNotMatch(publicData, /fixture-feishu|fixture-only-access-token/);
});

test('HTTP acknowledges a slow model promptly, duplicate events/messages execute a management write only once, and Web reads the same receipt', async t => {
  const f = await channelFixture(t), { h, id, admin, wire, modelState } = f;
  let release; modelState.gate = new Promise(r => { release = r; }); t.after(() => release());
  const data = envelope('/project 101 修改提示词'), start = performance.now(), result = await post(h, id, data);
  assert.ok(performance.now() - start < 1000);
  await until(() => f.requests.length);
  assert.equal(h.store.get('SELECT state FROM channel_inbox WHERE id=?', result.value.operation_id).state, 'submitted');
  assert.equal((await post(h, id, data)).value.duplicate, true);
  const retry = structuredClone(data); retry.header.event_id = 'new-envelope-id';
  assert.equal((await post(h, id, retry)).value.operation_id, result.value.operation_id);
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 0);
  modelState.gate = null; release();
  const row = await finished(h, result.value.operation_id); assert.equal(row.state, 'completed');
  const operations = h.store.all('SELECT * FROM management_commands WHERE channel=\'im\''); assert.equal(operations.length, 1);
  const op = operations[0], web = await admin('/api/management/commands/' + op.id);
  assert.equal(web.value.id, op.id); assert.equal(web.value.state, 'succeeded'); assert.equal(web.value.source_conversation, row.conversation_id);
  assert.equal(web.value.result.diff.after.prompt, 'Inspect evidence and cite the original logs.');
  const history = await admin('/api/management/conversations/' + row.conversation_id + '/events');
  assert.ok(history.value.events.some(e => e.type === 'tool_result' && e.data.result.id === op.id));
  await until(() => wire.sent.some(s => JSON.stringify(s.content).includes('已执行')));
  assert.equal((await post(h, id, data)).value.duplicate, true);
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 1);
});

test('dual-end binding supports optional browser-bound GitHub login; forwarding, wrong operator, expiry, replay and conflict do not grant access', async t => {
  const wire = transport(); let service;
  const f = await identityFixture(t, { channels: { origin: 'https://console.example.test', fetch: wire.fetch }, onChannels: s => { service = s; } });
  const { h, admin } = f, id = await connector(admin);
  const initial = await post(h, id, envelope('绑定')); await finished(h, initial.value.operation_id);
  const binding = h.store.get('SELECT * FROM channel_bind_requests');
  const data = h.store.secrets.open(h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', initial.value.operation_id).payload,
    'channel-outbox:' + h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', initial.value.operation_id).id);
  const challenge = /challenge=([a-f0-9]+)/.exec(JSON.stringify(data))[1];
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE provider='feishu'").n, 0);
  const started = await fetch(h.admin + '/auth/channels/start?challenge=' + challenge, { redirect: 'manual' });
  assert.equal(started.status, 303); assert.equal(started.headers.get('location'), '/#/identity/feishu?challenge=' + challenge);
  assert.equal(started.headers.getSetCookie().length, 0);
  const github = await fetch(h.admin + '/auth/github/start?channel_challenge=' + challenge, { redirect: 'manual' });
  const browserCookie = github.headers.getSetCookie()[0].split(';')[0];
  const auth = await fetch(github.headers.get('location'), { redirect: 'manual' }), callback = auth.headers.get('location');
  const forwarded = await fetch(callback, { redirect: 'manual' }); assert.match(forwarded.headers.get('location'), /invalid_oauth_state/);
  const verified = await fetch(callback, { redirect: 'manual', headers: { Cookie: browserCookie } }); assert.equal(verified.headers.get('location'), '/#/identity/feishu');
  const cookie = verified.headers.getSetCookie().find(s => s.startsWith('bot_session=')).split(';')[0];
  const pending = await (await fetch(h.admin + '/api/channels/bindings', { headers: { Cookie: cookie } })).json();
  assert.equal(pending.pending[0].open_id, 'ou_alice');
  assert.equal(pending.pending[0].account.id, h.store.get('SELECT principal_id FROM channel_bind_requests').principal_id);
  const confirmation = pending.pending[0].confirmation, principal = h.store.get('SELECT principal_id FROM channel_bind_requests').principal_id;
  const grantCount = h.store.get('SELECT count(*) n FROM scoped_grants').n;
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE provider='feishu'").n, 0);
  const wrong = await post(h, id, envelope('确认绑定 ' + confirmation, { sender: { sender_id: { open_id: 'ou_bob' } } }));
  assert.equal((await finished(h, wrong.value.operation_id)).error, 'binding_operator_mismatch');
  assert.equal(h.store.get('SELECT count(*) n FROM scoped_grants').n, grantCount);
  const good = await post(h, id, envelope('确认绑定 ' + confirmation)); assert.equal((await finished(h, good.value.operation_id)).state, 'completed');
  const identity = h.store.get("SELECT * FROM external_identities WHERE provider='feishu'"); assert.equal(identity.principal_id, principal);
  assert.equal(identity.connector, id + ':cli_fixture'); assert.equal(identity.external_tenant, 'actor-tenant');
  const replay = await post(h, id, envelope('确认绑定 ' + confirmation)); assert.equal((await finished(h, replay.value.operation_id)).error, 'binding_replayed');
  assert.equal(h.store.get('SELECT count(*) n FROM scoped_grants').n, grantCount);
  const event = service.adapter(service.connector(id)).normalize(envelope('绑定'));
  const expired = service.bindings.begin(event); h.store.run('UPDATE channel_bind_requests SET expires_at=0 WHERE challenge_hash=?', digest(expired.challenge));
  assert.throws(() => service.bindings.request(expired.challenge), /binding_expired/);
  // A second GitHub identity can prove itself but cannot take over Alice's existing mapping.
  f.state.id = 43; const other = await f.login(); const otherSession = session(h.store, other.result.principal_id, other.result.identity_id);
  const conflictGrants = h.store.get('SELECT count(*) n FROM scoped_grants').n;
  const conflict = service.bindings.begin(event); service.bindings.associateOAuth(conflict.challenge, 'other-state');
  await service.bindings.githubAuthenticated('other-state', otherSession.token);
  const confirm = service.bindings.pending(other.result.principal_id)[0].confirmation;
  await assert.rejects(service.bindings.confirm({ ...event, event_id: 'confirm-conflict' }, confirm), /external_identity_conflict/);
  assert.equal(h.store.get('SELECT count(*) n FROM scoped_grants').n, conflictGrants);
  assert.equal(h.store.get('SELECT principal_id FROM external_identities WHERE id=?', identity.id).principal_id, principal);
  assert.ok(binding.expires_at - Date.now() <= 300000);
  // A principal with no project grants can bind an identity; association still cannot authorize a query.
  f.state.id = 44; f.state.owner = false; f.state.admin = false;
  const unprivileged = await f.login(), unprivilegedSession = session(h.store, unprivileged.result.principal_id, unprivileged.result.identity_id);
  const unprivilegedEvent = { ...event, actor_tenant: 'external-tenant', actor_id: 'ou_unprivileged', event_id: 'unprivileged-start' };
  const noGrant = service.bindings.begin(unprivilegedEvent); service.bindings.associateOAuth(noGrant.challenge, 'no-grant-state');
  await service.bindings.githubAuthenticated('no-grant-state', unprivilegedSession.token);
  const noGrantCode = service.bindings.pending(unprivileged.result.principal_id)[0].confirmation, before = h.store.get('SELECT count(*) n FROM scoped_grants').n;
  await service.bindings.confirm({ ...unprivilegedEvent, event_id: 'unprivileged-confirm' }, noGrantCode);
  assert.equal(h.store.get('SELECT count(*) n FROM scoped_grants').n, before);
  const noPermission = await post(h, id, envelope(directQuery(), { sender: { tenant_key: 'external-tenant', sender_id: { open_id: 'ou_unprivileged' } } }));
  assert.equal((await finished(h, noPermission.value.operation_id)).error, 'capability_forbidden');
  const late = service.bindings.begin({ ...event, actor_id: 'ou_expired' }); service.bindings.associateOAuth(late.challenge, 'late-state');
  await service.bindings.githubAuthenticated('late-state', unprivilegedSession.token);
  const lateCode = service.bindings.pending(unprivileged.result.principal_id).find(p => p.open_id === 'ou_expired').confirmation;
  h.store.run('UPDATE channel_bind_requests SET expires_at=0 WHERE challenge_hash=?', digest(late.challenge));
  await assert.rejects(service.bindings.confirm({ ...event, actor_id: 'ou_expired', event_id: 'expired-confirm' }, lateCode), /binding_expired/);
  const racingEvent = { ...event, actor_id: 'ou_removed_during_proof' }, racing = service.bindings.begin(racingEvent);
  service.bindings.associateOAuth(racing.challenge, 'racing-state'); await service.bindings.githubAuthenticated('racing-state', unprivilegedSession.token);
  const racingCode = service.bindings.pending(unprivileged.result.principal_id).find(p => p.open_id === racingEvent.actor_id).confirmation;
  const confirming = service.bindings.confirm({ ...racingEvent, event_id: 'racing-confirm' }, racingCode);
  h.store.run('UPDATE channel_connectors SET enabled=0 WHERE id=?', id);
  await assert.rejects(confirming, /channel_connector_inactive/);
  assert.equal(h.store.get('SELECT count(*) n FROM external_identities WHERE external_actor=?', racingEvent.actor_id).n, 0);
});

test('local accounts bind without GitHub configuration and Feishu access follows only their effective project grants', async t => {
  const { h, id, service, member, admin } = await channelFixture(t);
  const local = await member('local-feishu', { repository_ids: ['101'] });
  assert.equal((await h.client()('/api/auth/github/status')).value.enabled, false);
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE principal_id=? AND provider='github'", local.id).n, 0);
  const event = service.adapter(service.connector(id)).normalize(envelope('/bind', { sender: { sender_id: { open_id: 'ou_local' } } }));
  const begun = service.bindings.begin(event), claim = { challenge: begun.challenge };
  const link = await fetch(h.admin + '/auth/channels/start?challenge=' + begun.challenge, { redirect: 'manual' });
  assert.equal(link.status, 303); assert.equal(link.headers.get('cache-control'), 'no-store');
  assert.equal(h.store.get('SELECT principal_id FROM channel_bind_requests WHERE challenge_hash=?', digest(begun.challenge)).principal_id, null);
  assert.equal((await h.client()('/api/channels/bindings/claim', 'POST', claim)).status, 401);
  assert.equal((await local.client('/api/channels/bindings/claim', 'POST', claim, { 'X-CSRF-Token': '' })).value.error, 'csrf_required');
  assert.equal((await local.client('/api/channels/bindings/claim', 'POST', { ...claim, principal_id: 'self-asserted-owner' })).value.error, 'unknown_field');
  const grants = h.store.get('SELECT count(*) n FROM scoped_grants').n;
  assert.deepEqual((await local.client('/api/channels/bindings/claim', 'POST', claim)).value, { state: 'pending_confirmation' });
  const pending = (await local.client('/api/channels/bindings')).value.pending[0];
  assert.equal(pending.account.id, local.id); assert.equal(pending.account.username, 'local-feishu');
  assert.equal((await local.client('/api/channels/bindings/claim', 'POST', claim)).value.error, 'binding_login_already_started');
  assert.equal((await h.client()('/api/channels/bindings')).status, 401);
  await service.bindings.confirm({ ...event, event_id: 'local-confirm' }, pending.confirmation);
  assert.equal(h.store.get("SELECT principal_id FROM external_identities WHERE provider='feishu' AND external_actor='ou_local'").principal_id, local.id);
  assert.equal(h.store.get('SELECT count(*) n FROM scoped_grants').n, grants);
  const message = project => envelope(directQuery(project, project === '101' ? 'blocked' : 'foreign'), { sender: { sender_id: { open_id: 'ou_local' } } });
  const allowed = await post(h, id, message('101'));
  assert.equal((await finished(h, allowed.value.operation_id)).state, 'completed');
  const denied = await post(h, id, message('201'));
  assert.equal((await finished(h, denied.value.operation_id)).error, 'capability_forbidden');
  assert.equal((await admin('/api/project-admin-assignments', 'PUT', { user_id: local.id, repository_ids: [], organization_ids: [] })).status, 200);
  const revokedAccess = await post(h, id, message('101'));
  assert.equal((await finished(h, revokedAccess.value.operation_id)).error, 'capability_forbidden');
  assert.equal(h.store.get("SELECT status FROM external_identities WHERE provider='feishu' AND external_actor='ou_local'").status, 'active');
  const unprivileged = await member('local-no-grants', { repository_ids: [] });
  const noGrantsEvent = { ...event, actor_id: 'ou_local_no_grants', event_id: 'no-grants-start' }, noGrants = service.bindings.begin(noGrantsEvent);
  await service.bindings.authenticate(noGrants.challenge, session(h.store, unprivileged.id).token);
  const code = service.bindings.pending(unprivileged.id)[0].confirmation;
  await service.bindings.confirm({ ...noGrantsEvent, event_id: 'no-grants-confirm' }, String(code));
  const blocked = await post(h, id, envelope(directQuery(), { sender: { sender_id: { open_id: 'ou_local_no_grants' } } }));
  assert.equal((await finished(h, blocked.value.operation_id)).error, 'capability_forbidden');
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE provider='github'").n, 0);
});

test('a private-chat authentication code binds in the console once, requires a session and CSRF, and never adds grants', async t => {
  const { h, id, admin, member, service } = await channelFixture(t);
  const local = await member('code-local', {}), other = await connector(admin, { app_id: 'cli_other' });
  const started = await post(h, id, envelope('/bind', { sender: { sender_id: { open_id: 'ou_code' } } }));
  assert.equal((await finished(h, started.value.operation_id)).state, 'completed');
  const outbox = h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', started.value.operation_id);
  const reply = JSON.stringify(h.store.secrets.open(outbox.payload, 'channel-outbox:' + outbox.id));
  const code = /FSB-[a-f0-9]{48}/.exec(reply)[0], challenge = /challenge=([a-f0-9]{48})/.exec(reply)[1];
  const route = '/api/channels/bindings/confirm', input = { code, connector_id: id };
  assert.doesNotMatch(JSON.stringify((await local.client('/api/channels/bindings')).value), new RegExp(code));
  assert.equal((await h.client()(route, 'POST', input)).status, 401);
  assert.equal((await local.client(route, 'POST', input, { 'X-CSRF-Token': '' })).value.error, 'csrf_required');
  assert.equal((await local.client(route, 'POST', { ...input, principal_id: 'self-asserted' })).value.error, 'unknown_field');
  assert.equal((await local.client(route, 'POST', { ...input, code: challenge })).value.error, 'binding_code_invalid');
  assert.equal((await local.client(route, 'POST', { ...input, connector_id: other })).value.error, 'binding_code_invalid');
  const grants = h.store.get('SELECT count(*) n FROM scoped_grants').n;
  const result = await local.client(route, 'POST', input);
  assert.equal(result.status, 201); assert.equal(result.value.state, 'bound'); assert.equal(result.value.principal_id, local.id);
  await local.client('/api/auth/me');
  assert.equal((await local.client(route, 'POST', input)).value.error, 'binding_replayed');
  assert.equal(h.store.get('SELECT count(*) n FROM scoped_grants').n, grants);
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE provider='github'").n, 0);
  const denied = await post(h, id, envelope(directQuery(), { sender: { sender_id: { open_id: 'ou_code' } } }));
  assert.equal((await finished(h, denied.value.operation_id)).error, 'capability_forbidden');
  const e = service.adapter(service.connector(id)).normalize(envelope('/bind', { sender: { sender_id: { open_id: 'ou_code' } } }));
  const conflict = service.bindings.begin(e);
  assert.equal((await admin(route, 'POST', { code: conflict.code, connector_id: id })).value.error, 'external_identity_conflict');
  const expired = service.bindings.begin({ ...e, actor_id: 'ou_expired_code' });
  h.store.run('UPDATE channel_bind_requests SET expires_at=0 WHERE code_hash=?', digest(expired.code));
  assert.equal((await local.client(route, 'POST', { code: expired.code, connector_id: id })).value.error, 'binding_expired');
  const legacy = service.bindings.begin({ ...e, actor_id: 'ou_legacy_code' });
  await service.bindings.authenticate(legacy.challenge, session(h.store, local.id).token);
  assert.equal((await local.client(route, 'POST', { code: legacy.code, connector_id: id })).value.error, 'binding_login_already_started');
});

test('console authentication codes fence concurrent accounts, revoked sessions, connector changes and group sources', async t => {
  const { h, id, service, member } = await channelFixture(t);
  const a = await member('code-race-a', {}), b = await member('code-race-b', {});
  const aSession = session(h.store, a.id), bSession = session(h.store, b.id);
  const e = service.adapter(service.connector(id)).normalize(envelope('/bind', { sender: { sender_id: { open_id: 'ou_code_race' } } }));
  assert.throws(() => service.bindings.begin({ ...e, chat_type: 'group' }), /binding_private_chat_required/);
  const racing = service.bindings.begin(e);
  const results = await Promise.allSettled([service.bindings.confirmCode(racing.code, id, aSession.token), service.bindings.confirmCode(racing.code, id, bSession.token)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_code_race'").n, 1);
  const revoked = service.bindings.begin({ ...e, actor_id: 'ou_revoked_code' });
  const pending = service.bindings.confirmCode(revoked.code, id, bSession.token);
  h.store.run('DELETE FROM sessions WHERE token_hash=?', digest(bSession.token));
  await assert.rejects(pending, /login_required/);
  const disabled = service.bindings.begin({ ...e, actor_id: 'ou_disabled_code' });
  const confirming = service.bindings.confirmCode(disabled.code, id, aSession.token);
  h.store.run('UPDATE channel_connectors SET enabled=0,revision=revision+1 WHERE id=?', id);
  await assert.rejects(confirming, /channel_connector_inactive|channel_revision_conflict/);
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor IN ('ou_revoked_code','ou_disabled_code')").n, 0);
});

test('platform binding claims fence concurrent accounts, revoked sessions and disabled connectors', async t => {
  const { h, id, service, member } = await channelFixture(t);
  const a = await member('claim-a', {}), b = await member('claim-b', {});
  const aSession = session(h.store, a.id), bSession = session(h.store, b.id);
  const event = service.adapter(service.connector(id)).normalize(envelope('/bind', { sender: { sender_id: { open_id: 'ou_claim' } } }));
  const begun = service.bindings.begin(event);
  const results = await Promise.allSettled([service.bindings.authenticate(begun.challenge, aSession.token), service.bindings.authenticate(begun.challenge, bSession.token)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_bind_requests WHERE principal_id IS NOT NULL').n, 1);
  const expired = service.bindings.begin({ ...event, actor_id: 'ou_expired_claim' });
  h.store.run('UPDATE channel_bind_requests SET expires_at=0 WHERE challenge_hash=?', digest(expired.challenge));
  await assert.rejects(service.bindings.authenticate(expired.challenge, aSession.token), /binding_expired/);
  const revoked = service.bindings.begin({ ...event, actor_id: 'ou_revoked_claim' });
  const authenticating = service.bindings.authenticate(revoked.challenge, bSession.token);
  h.store.run('DELETE FROM sessions WHERE token_hash=?', digest(bSession.token));
  await assert.rejects(authenticating, /login_required/);
  assert.equal(h.store.get('SELECT principal_id FROM channel_bind_requests WHERE challenge_hash=?', digest(revoked.challenge)).principal_id, null);
  const disabled = service.bindings.begin({ ...event, actor_id: 'ou_disabled_claim' });
  const pending = service.bindings.authenticate(disabled.challenge, aSession.token);
  h.store.run('UPDATE channel_connectors SET enabled=0 WHERE id=?', id);
  await assert.rejects(pending, /channel_connector_inactive/);
  assert.equal(h.store.get('SELECT principal_id FROM channel_bind_requests WHERE challenge_hash=?', digest(disabled.challenge)).principal_id, null);
});

test('the same open_id never crosses app or actor tenant, and adding a bot or self-asserting admin cannot authorize writes', async t => {
  const f = await channelFixture(t), { h, id, admin } = f;
  const second = await connector(admin, { app_id: 'cli_other' });
  for (const [connectorId, data] of [[second, envelope(directQuery(), { header: { app_id: 'cli_other' } })], [id, envelope(directQuery(), { sender: { tenant_key: 'other-tenant' } })]]) {
    const r = await post(h, connectorId, data); assert.equal((await finished(h, r.value.operation_id)).error, 'external_binding_required');
  }
  const noMember = await f.member('unprivileged-im', { repository_ids: [] }); bindFixture(h, id, noMember.id, 'ou_owner');
  const r = await post(h, id, envelope(directQuery(), { sender: { sender_id: { open_id: 'ou_owner' }, is_admin: true } }));
  assert.equal((await finished(h, r.value.operation_id)).error, 'capability_forbidden');
  const web = await noMember.client('/api/management/query', 'POST', { operation: 'get_task', target: { project_id: '101', task_id: 'blocked' }, arguments: {} });
  assert.equal(web.value.error, 'capability_forbidden');
  const forged = '/project 101 /query ' + JSON.stringify({ operation: 'list_tasks', target: { project_id: '101' }, arguments: {}, admin: true, tenant_id: 'github.com:20' });
  const attempt = await post(h, id, envelope(forged)); assert.equal((await finished(h, attempt.value.operation_id)).state, 'failed');
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 0);
});

test('one global connection serves authorized projects in different organizations without widening user or group permissions', async t => {
  const f = await channelFixture(t), { h, id, admin, service } = f;
  h.store.run("UPDATE installed_repositories SET owner_id='20',owner_login='second-fixture' WHERE repository_id='201'");
  const member = await f.member('multi-org-im', { repository_ids: ['101', '201'] });
  bindFixture(h, id, member.id, 'ou_multi');
  const send = (project, task) => post(h, id, envelope(directQuery(project, task), { sender: { sender_id: { open_id: 'ou_multi' } } }));
  for (const [project, task] of [['101', 'blocked'], ['201', 'foreign']]) {
    const r = await send(project, task); assert.equal((await finished(h, r.value.operation_id)).state, 'completed');
  }
  const denied = await send('102', 'blocked'); assert.equal((await finished(h, denied.value.operation_id)).error, 'capability_forbidden');
  const event = service.adapter(service.connector(id)).normalize(envelope(directQuery(), { sender: { sender_id: { open_id: 'ou_multi' } } }));
  const actor = await service.actor(event, '201');
  assert.equal(actor.tenant_id, 'github.com:20');
  assert.throws(() => authorize(actor, 'tasks.read', { project_id: '101' }), /tenant_forbidden/);
  const firstOrg = await f.member('first-org-config', { organization_ids: ['10'] });
  assert.equal((await group(firstOrg.client, id, { project_id: '201' })).status, 403);
  const secondOrg = await f.member('second-org-config', { organization_ids: ['20'] });
  const rejected = await post(h, id, inGroup(directQuery('201', 'foreign'), 'ou_multi'));
  assert.equal((await finished(h, rejected.value.operation_id)).error, 'channel_group_scope_required');
  const approved = await group(secondOrg.client, id, { project_id: '201' }); assert.equal(approved.status, 200);
  assert.equal((await secondOrg.client('/api/channels/operations/' + approved.value.operation_id)).status, 200);
  assert.equal((await firstOrg.client('/api/channels/operations/' + approved.value.operation_id)).status, 403);
  const accepted = await post(h, id, inGroup(directQuery('201', 'foreign'), 'ou_multi'));
  assert.equal((await finished(h, accepted.value.operation_id)).state, 'completed');
  const unapproved = await post(h, id, inGroup(directQuery('101', 'blocked'), 'ou_multi'));
  assert.equal((await finished(h, unapproved.value.operation_id)).error, 'channel_group_scope_required');
  const token = member.client.cookie().split('=')[1];
  const destination = service.enqueue(resolveActor(h.store, token, { project_id: '201' }), event, '201', 'multi-org-destination');
  const destinations = await member.client('/api/management/query', 'POST', { operation: 'list_schedule_destinations', target: { project_id: '201' }, arguments: {} });
  assert.ok(destinations.value.destinations.some(d => d.id === destination.operation_id));
  h.store.run('DELETE FROM project_admin_assignments WHERE user_id=? AND repository_id=?', member.id, '201');
  invalidate(h.store, member.id, 'test-project-revoked');
  const revoked = await send('201', 'foreign'); assert.equal((await finished(h, revoked.value.operation_id)).error, 'capability_forbidden');
  assert.equal((await admin('/api/channels/setup')).value.connectors.length, 1);
});

test('group scope rejects private facts, limits result fields, isolates each sender and invalidates on audience changes', async t => {
  const f = await channelFixture(t), { h, id, admin, wire, principal } = f;
  h.store.run("UPDATE installed_repositories SET private=1 WHERE repository_id='101'");
  const rejected = await post(h, id, inGroup(directQuery()));
  assert.equal((await finished(h, rejected.value.operation_id)).error, 'channel_group_scope_required');
  assert.equal(h.store.get('SELECT count(*) n FROM management_messages').n, 0);
  assert.equal((await group(admin, id, { sensitivity: 'public' })).status, 200);
  const publicOnly = await post(h, id, inGroup(directQuery())); assert.equal((await finished(h, publicOnly.value.operation_id)).error, 'channel_group_scope_required');
  assert.equal((await group(admin, id, { expected_revision: 1, fields: ['summary'] })).status, 200);
  const accepted = await post(h, id, inGroup(directQuery())); assert.equal((await finished(h, accepted.value.operation_id)).state, 'completed');
  await until(() => wire.sent.some(s => s.receive_id === 'ou_alice'));
  const publicReplies = wire.sent.filter(s => s.receive_id === 'oc_group');
  for (const reply of publicReplies) assert.doesNotMatch(JSON.stringify(reply.content), /Inspect task facts|Project computer is stopped|environment_not_ready|blocked|agent-test-zone/);
  assert.ok(wire.sent.some(s => s.receive_id === 'ou_alice' && JSON.stringify(s.content).includes('environment_not_ready')));
  bindFixture(h, id, principal, 'ou_bob');
  const bob = await post(h, id, inGroup(directQuery(), 'ou_bob')); await finished(h, bob.value.operation_id);
  const sessions = h.store.all('SELECT * FROM channel_sessions WHERE chat_id=\'oc_group\''); assert.equal(sessions.length, 2); assert.notEqual(sessions[0].conversation_id, sessions[1].conversation_id);
  const changed = envelope(); changed.header.event_type = 'im.chat.member.user.added_v1'; changed.event = { chat_id: 'oc_group' };
  assert.equal((await post(h, id, changed)).status, 200);
  assert.equal(h.store.get('SELECT audience_verified_until FROM channel_group_scopes').audience_verified_until, 0);
  const after = await post(h, id, inGroup(directQuery())); assert.equal((await finished(h, after.value.operation_id)).error, 'channel_group_scope_required');
  assert.equal((await group(admin, id, { expected_revision: 1 })).value.error, 'channel_revision_conflict');
});

test('natural requests use management while explicit linking retains owner, project and ordering checks', async t => {
  const f = await channelFixture(t), { h, id, admin, service, principal } = f;
  const plain = await post(h, id, envelope('看看当前任务')); await finished(h, plain.value.operation_id);
  assert.equal(h.store.get('SELECT count(*) n FROM management_messages').n, 1);
  const one = await post(h, id, envelope(directQuery())); const row = await finished(h, one.value.operation_id);
  const e = service.adapter(service.connector(id)).normalize(envelope()), actor = await service.actor(e, '101');
  const webConversation = (await admin('/api/management/conversations', 'POST', { scope: 'project:101' })).value.conversation.id;
  service.link(actor, e, '101', webConversation);
  assert.equal(h.store.get("SELECT conversation_id FROM channel_sessions WHERE project_id='101'").conversation_id, webConversation);
  const otherProject = (await admin('/api/management/conversations', 'POST', { scope: 'project:102' })).value.conversation.id;
  assert.throws(() => service.link(actor, e, '101', otherProject), /scope_forbidden|project_mismatch/);
  const member = await f.member('private-conversation', { repository_ids: ['101'] });
  const foreign = (await member.client('/api/management/conversations', 'POST', { scope: 'project:101' })).value.conversation.id;
  assert.throws(() => service.link(actor, e, '101', foreign), /conversation_not_found/);
  const older = envelope(directQuery(), { message: { create_time: String(Date.now() - 5000) } });
  const old = await post(h, id, older); assert.equal((await finished(h, old.value.operation_id)).error, 'channel_message_out_of_order');
  const mismatch = await post(h, id, envelope('/project 101 /query ' + JSON.stringify({ operation: 'get_task', target: { project_id: '201', task_id: 'foreign' }, arguments: {} })));
  assert.equal((await finished(h, mismatch.value.operation_id)).error, 'project_scope_mismatch');
  assert.equal(principal, (await admin('/api/auth/me')).value.id); assert.ok(row.conversation_id);
  const second = await connector(admin, { app_id: 'cli_same_message_id' }); bindFixture(h, second, principal, 'ou_alice', 'actor-tenant', 'cli_same_message_id');
  const e2 = service.adapter(service.connector(second)).normalize(envelope('link origin', { header: { app_id: 'cli_same_message_id' } }));
  service.link(await service.actor(e2, '101'), e2, '101', webConversation);
  const target = { project_id: '101', task_id: 'blocked' };
  for (const [connectorId, app] of [[id, 'cli_fixture'], [second, 'cli_same_message_id']]) {
    const request = '/project 101 /command ' + JSON.stringify({ operation: 'task.instructions', target, arguments: { instruction: 'From ' + app }, expected_revision: service.management.service.revision(target) });
    const r = await post(h, connectorId, envelope(request, { header: { app_id: app }, message: { message_id: 'same-provider-message-id' } }));
    const written = await finished(h, r.value.operation_id); assert.equal(written.state, 'completed'); assert.equal(written.conversation_id, webConversation);
  }
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 2);
});

test('cards revalidate actual clicker, message, operation version, expiry, replay, binding and current authorization', async t => {
  const f = await channelFixture(t), { h, id, wire, admin } = f;
  async function write() {
    const sentBefore = wire.sent.length;
    const target = { project_id: '101', task_id: 'blocked' }, revision = f.service.management.service.revision(target);
    const input = '/project 101 /command ' + JSON.stringify({ operation: 'task.instructions', target, arguments: { instruction: 'Inspect current logs.' }, expected_revision: revision });
    const r = await post(h, id, envelope(input)); await finished(h, r.value.operation_id);
    return until(() => wire.sent.slice(sentBefore).findLast(s => cardToken(s)), v => !!v);
  }
  const message = await write(), token = cardToken(message), remote = 'remote-' + (wire.sent.indexOf(message) + 1);
  const wrong = await post(h, id, cardEvent(token, remote, 'ou_bob')); assert.equal((await finished(h, wrong.value.operation_id)).error, 'channel_card_operator_mismatch');
  const changed = await post(h, id, cardEvent(token, 'unrelated-message')); assert.equal((await finished(h, changed.value.operation_id)).error, 'channel_card_message_mismatch');
  const valid = await post(h, id, cardEvent(token, remote)); assert.equal((await finished(h, valid.value.operation_id)).state, 'completed');
  await until(() => wire.sent.some(s => s.method === 'PATCH'));
  const replay = await post(h, id, cardEvent(token, remote)); assert.equal((await finished(h, replay.value.operation_id)).error, 'channel_card_stale');
  const second = await write(), token2 = cardToken(second), remote2 = 'remote-' + (wire.sent.indexOf(second) + 1);
  h.store.run('UPDATE channel_cards SET expires_at=0 WHERE token_hash=?', digest(token2));
  const expired = await post(h, id, cardEvent(token2, remote2)); assert.equal((await finished(h, expired.value.operation_id)).error, 'channel_card_stale');
  const third = await write(), token3 = cardToken(third), remote3 = 'remote-' + (wire.sent.indexOf(third) + 1);
  const op = h.store.get('SELECT operation_id FROM channel_cards WHERE token_hash=?', digest(token3)).operation_id;
  h.store.run("UPDATE management_commands SET state='failed' WHERE id=?", op);
  const stale = await post(h, id, cardEvent(token3, remote3)); assert.equal((await finished(h, stale.value.operation_id)).error, 'channel_card_stale');
  const identity = h.store.get("SELECT id FROM external_identities WHERE provider='feishu'");
  await admin('/api/identity/bindings/' + identity.id, 'DELETE', {});
  const unlinked = await post(h, id, envelope(directQuery())); assert.equal((await finished(h, unlinked.value.operation_id)).error, 'external_binding_required');
});

test('external members use binding, project and group authorization without an enterprise list, and cards retain actor enterprise isolation', async t => {
  const { h, id, wire, service, principal, admin } = await channelFixture(t);
  const external = content => envelope(content, { sender: { tenant_key: 'external-tenant' } });
  const unbound = await post(h, id, external(directQuery()));
  assert.equal((await finished(h, unbound.value.operation_id)).error, 'external_binding_required');
  const binding = await post(h, id, external('/bind'));
  assert.equal((await finished(h, binding.value.operation_id)).state, 'completed');
  bindFixture(h, id, principal, 'ou_alice', 'external-tenant');
  const query = await post(h, id, external(directQuery()));
  assert.equal((await finished(h, query.value.operation_id)).state, 'completed');
  const externalGroup = () => { const data = inGroup(directQuery()); data.event.sender.tenant_key = 'external-tenant'; return data; };
  const deniedGroup = await post(h, id, externalGroup());
  assert.equal((await finished(h, deniedGroup.value.operation_id)).error, 'channel_group_scope_required');
  await group(admin, id);
  const allowedGroup = await post(h, id, externalGroup());
  assert.equal((await finished(h, allowedGroup.value.operation_id)).state, 'completed');
  const target = { project_id: '101', task_id: 'blocked' }, revision = service.management.service.revision(target);
  const write = await post(h, id, external('/project 101 /command ' + JSON.stringify({ operation: 'task.instructions', target,
    arguments: { instruction: 'Inspect external member evidence.' }, expected_revision: revision })));
  assert.equal((await finished(h, write.value.operation_id)).state, 'completed');
  const message = await until(() => wire.sent.find(s => cardToken(s))), token = cardToken(message), remote = 'remote-' + (wire.sent.indexOf(message) + 1);
  // The same open_id bound to the same principal in another enterprise still cannot reuse this card.
  const wrongTenant = await post(h, id, cardEvent(token, remote));
  assert.equal((await finished(h, wrongTenant.value.operation_id)).error, 'channel_card_operator_mismatch');
  const click = cardEvent(token, remote); click.event.operator.tenant_key = 'external-tenant';
  const accepted = await post(h, id, click);
  assert.equal((await finished(h, accepted.value.operation_id)).state, 'completed');
  await until(() => wire.sent.some(s => s.method === 'PATCH' && s.url.endsWith('/' + remote)));
  assert.ok(h.store.all('SELECT actor_tenant FROM channel_sessions').every(row => row.actor_tenant === 'external-tenant'));
});

test('enterprise SDK accepts external member card callbacks, persists once and updates the original message', async t => {
  const { h, id, wire, service, principal } = await channelFixture(t);
  bindFixture(h, id, principal, 'ou_alice', 'external-tenant');
  const target = { project_id: '101', task_id: 'blocked' }, revision = service.management.service.revision(target);
  const result = await post(h, id, envelope('/project 101 /command ' + JSON.stringify({ operation: 'task.instructions', target,
    arguments: { instruction: 'Inspect current logs.' }, expected_revision: revision }), { sender: { tenant_key: 'external-tenant' } }));
  await finished(h, result.value.operation_id);
  const message = await until(() => wire.sent.find(s => cardToken(s))), remote = 'remote-' + (wire.sent.indexOf(message) + 1);
  h.store.run("UPDATE channel_connectors SET transport='websocket' WHERE id=?", id);
  let dispatcher;
  const sockets = new ChannelConnections(service, () => ({ start: async options => { dispatcher = options.eventDispatcher; }, close() {},
    getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }));
  t.after(() => sockets.close()); sockets.reconcile();
  const click = cardEvent(cardToken(message), remote); click.event.operator.tenant_key = 'external-tenant';
  const receipt = await dispatcher.invoke(click, { needCheck: false });
  assert.equal(receipt.state, 'queued');
  assert.equal((await dispatcher.invoke(click, { needCheck: false })).operation_id, receipt.operation_id);
  assert.equal((await finished(h, receipt.operation_id)).state, 'completed');
  await until(() => wire.sent.some(s => s.method === 'PATCH' && s.url.endsWith('/' + remote)));
  assert.equal(h.store.get('SELECT count(*) n FROM channel_inbox WHERE event_id=?', click.header.event_id).n, 1);
});

test('HTTP and enterprise SDK ingress share dedup; config CAS, outbox retries, current scope fences and registered notifications stay observable', async t => {
  const f = await channelFixture(t), { h, id, service, admin, wire } = f;
  assert.equal((await connector(admin, { app_id: 'cli_invalid_saas', application_type: 'saas', transport: 'websocket', enabled: false }).catch(e => ({ error: String(e) }))).error.includes('channel_transport_invalid'), true);
  const event = envelope(directQuery()), first = await post(h, id, event); await finished(h, first.value.operation_id);
  // Toggle the trusted fixture row without opening a real socket; the public config rejects SaaS long connections.
  h.store.run("UPDATE channel_connectors SET transport='websocket',application_type='enterprise' WHERE id=?", id);
  let dispatcher, closed = false;
  const sockets = new ChannelConnections(service, () => ({ start: async options => { dispatcher = options.eventDispatcher; }, close: () => { closed = true; },
    getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }));
  sockets.reconcile();
  assert.equal((await dispatcher.invoke(event, { needCheck: false })).duplicate, true);
  sockets.close(); assert.equal(closed, true);
  h.store.run("UPDATE channel_connectors SET transport='http',application_type='enterprise' WHERE id=?", id);
  assert.equal((await admin('/api/channels/connectors/' + id, 'PATCH', { expected_revision: 9, enabled: false })).value.error, 'channel_revision_conflict');
  // The first inbox can complete before its outbox; fault only the next message's send, not history sync or the prior reply.
  await until(() => h.store.get('SELECT state FROM channel_outbox WHERE source_event=?', first.value.operation_id)?.state, state => state === 'sent');
  wire.state.sendFailures = 1;
  const retry = await post(h, id, envelope('/identity')); await finished(h, retry.value.operation_id);
  const queued = await until(() => h.store.get("SELECT * FROM channel_outbox WHERE source_event=? AND state='retry'", retry.value.operation_id));
  assert.equal(queued.attempts, 1); assert.equal(queued.last_error, 'channel_delivery_rejected');
  h.store.run('UPDATE channel_outbox SET next_attempt=0 WHERE id=?', queued.id);
  await until(() => h.store.get('SELECT state FROM channel_outbox WHERE id=?', queued.id).state, s => s === 'sent');
  assert.equal(h.store.get('SELECT attempts FROM channel_outbox WHERE id=?', queued.id).attempts, 2);
  const e = service.adapter(service.connector(id)).normalize(envelope()), actor = await service.actor(e, '101');
  const registration = service.enqueue(actor, e, '101', 'fixture-notification'); assert.equal(registration.state, 'registered'); assert.equal(registration.sent, false);
  await service.tick(); assert.equal(h.store.get('SELECT state FROM channel_outbox WHERE id=?', registration.operation_id).state, 'registered');
  const uninstall = envelope(); uninstall.header.event_type = 'app.uninstalled'; uninstall.event = {};
  await post(h, id, uninstall);
  assert.throws(() => authorize(actor, 'tasks.read', { project_id: '101' }), /channel_connector_inactive/);
  assert.equal((await post(h, id, envelope(directQuery()))).value.error, 'channel_connector_inactive');
});

test('revocation while a model is waiting blocks new tools and queued group replies even when personal permission remains', async t => {
  const f = await channelFixture(t), { h, admin, service, id, modelState, wire } = f;
  await group(admin, id);
  let release; modelState.gate = new Promise(r => { release = r; }); t.after(() => release());
  const r = await post(h, id, inGroup('/project 101 修改提示词'));
  await until(() => f.requests.length);
  await group(admin, id, { expected_revision: 1, enabled: false, audience_verified_until: 0 });
  modelState.gate = null; release();
  assert.equal((await finished(h, r.value.operation_id)).state, 'failed');
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 0);
  const e = service.adapter(service.connector(id)).normalize(envelope());
  authorize(await service.actor(e, '101'), 'config.write', { project_id: '101' });
  assert.ok(wire.sent.every(s => !JSON.stringify(s.content).includes('Inspect evidence')));
});

test('IM approval and revision conflicts retain the shared business outcome; member revocation invalidates an old card', async t => {
  const f = await channelFixture(t), { h, admin, service, id, wire } = f;
  const target = { project_id: '101', workflow_id: 'review.issue' }, revision = service.management.service.revision(target);
  const submit = async (op, expected = revision, actor = 'ou_alice') => {
    const content = '/project 101 /command ' + JSON.stringify({ operation: op, target, arguments: { prompt: 'Approved future prompt.' }, expected_revision: expected });
    const r = await post(h, id, envelope(content, { sender: { sender_id: { open_id: actor } } })); return finished(h, r.value.operation_id);
  };
  const wrong = await submit('workflow.update', 'obsolete-revision');
  assert.equal(h.store.get('SELECT state FROM management_messages WHERE id=?', wrong.message_id).state, 'failed');
  const webConflict = await admin('/api/management/commands', 'POST', { operation: 'workflow.update', target, arguments: { prompt: 'Approved future prompt.' }, expected_revision: 'obsolete-revision', idempotency_key: 'web-conflict', source_conversation: 'web', source_message: 'web-conflict' });
  assert.equal(webConflict.value.error, 'management_revision_conflict');
  h.store.run("INSERT INTO management_policies(tenant_id,approval_operations) VALUES('github.com:10','[\"workflow.update\"]')");
  const pending = await submit('workflow.update'), op = h.store.get("SELECT * FROM management_commands WHERE channel='im'");
  assert.equal(op.state, 'awaiting_approval');
  assert.equal((await admin('/api/management/commands/' + op.id)).value.state, 'awaiting_approval');
  assert.notEqual((await managerSection(admin,'101','review.issue')), 'Approved future prompt.');
  const approved = await admin('/api/management/commands/' + op.id + '/approval', 'POST', { parameter_hash: op.parameter_hash, expected_revision: op.expected_revision, decision: 'approve' });
  assert.equal(approved.value.state, 'succeeded');
  assert.equal((await admin('/api/management/commands/' + op.id)).value.source_conversation, pending.conversation_id);
  const member = await f.member('revoked-card-member', { repository_ids: ['101'] });
  bindFixture(h, id, member.id, 'ou_member');
  const count = wire.sent.length; const memberOp = await submit('workflow.update', service.management.service.revision(target), 'ou_member');
  const outgoing = await until(() => wire.sent.slice(count).find(s => s.receive_id === 'oc_private' && cardToken(s)));
  const token = cardToken(outgoing), remote = 'remote-' + (wire.sent.indexOf(outgoing) + 1);
  await admin('/api/project-admin-assignments', 'PUT', { user_id: member.id, repository_ids: [] });
  const clicked = await post(h, id, cardEvent(token, remote, 'ou_member')); assert.equal((await finished(h, clicked.value.operation_id)).error, 'capability_forbidden');
  const message = await post(h, id, envelope(directQuery(), { sender: { sender_id: { open_id: 'ou_member' } } }));
  assert.equal((await finished(h, message.value.operation_id)).error, 'capability_forbidden');
  assert.ok(memberOp.conversation_id);
});

test('durable ingress survives restart and a retried write keeps its original conversation and operation', async t => {
  const f = await channelFixture(t), { h, id, service } = f;
  service.close();
  const data = envelope('/project 101 修改提示词'), accepted = await post(h, id, data);
  assert.equal(h.store.get('SELECT state FROM channel_inbox WHERE id=?', accepted.value.operation_id).state, 'queued');
  await h.stop(); await h.start();
  const completed = await finished(h, accepted.value.operation_id); assert.equal(completed.state, 'completed');
  const op = h.store.get("SELECT * FROM management_commands WHERE channel='im'");
  assert.equal(op.state, 'succeeded');
  assert.equal((await post(h, id, data)).value.operation_id, accepted.value.operation_id);
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 1);
  assert.equal(op.source_conversation, completed.conversation_id);
});

test('store apps persist verified v1 tickets and route one HTTP callback by installation tenant before using SaaS tokens', async t => {
  const f = await channelFixture(t), { h, admin, service, wire, principal } = f;
  const id = await connector(admin, { app_id: 'cli_store', application_type: 'saas' });
  const other = await connector(admin, { app_id: 'cli_store', application_type: 'saas', installation_tenant: 'second-install' });
  bindFixture(h, id, principal, 'ou_alice', 'actor-tenant', 'cli_store'); bindFixture(h, other, principal, 'ou_alice', 'actor-tenant', 'cli_store');
  const ticket = { ts: String(Date.now() / 1000), uuid: 'ticket-1', token: credentials.verification_token, type: 'event_callback', event: { type: 'app_ticket', app_id: 'cli_store', app_ticket: 'fixture-store-app-ticket' } };
  assert.equal((await post(h, id, ticket, { encrypted: true })).value.state, 'completed');
  assert.equal((await post(h, id, ticket)).value.duplicate, true);
  const data = envelope(directQuery(), { header: { app_id: 'cli_store', tenant_key: 'second-install' } });
  const r = await post(h, id, data); const row = await finished(h, r.value.operation_id);
  assert.equal(row.connector_id, other); assert.equal(row.state, 'completed');
  await until(() => wire.state.authRequests.some(a => a.tenant_key === 'second-install'));
  assert.ok(wire.state.authRequests.some(a => a.url.endsWith('/app_access_token') && a.app_id === 'cli_store'));
  const c = service.connector(other), secret = h.store.secrets.open(h.store.get('SELECT sealed FROM channel_credentials WHERE id=?', c.credential_ref).sealed, 'channel-credential:' + c.credential_ref);
  assert.equal(secret.app_ticket, 'fixture-store-app-ticket');
  assert.ok(!readFileSync(h.database).includes(Buffer.from('fixture-store-app-ticket')));
  const uninstall = { ...ticket, uuid: 'legacy-uninstall', event: { type: 'app_uninstalled', app_id: 'cli_store', tenant_key: 'install-tenant' } };
  await post(h, id, uninstall); assert.equal(h.store.get('SELECT enabled FROM channel_connectors WHERE id=?', id).enabled, 0);
  const next = await post(h, id, envelope(directQuery(), { header: { app_id: 'cli_store', tenant_key: 'second-install' } }));
  assert.equal((await finished(h, next.value.operation_id)).state, 'completed');
});

test('Web approval cannot resume an IM operation after its group scope is revoked', async t => {
  const f = await channelFixture(t), { h, id, admin, service } = f;
  await group(admin, id);
  h.store.run("INSERT INTO management_policies(tenant_id,approval_operations) VALUES('github.com:10','[\"workflow.update\"]')");
  const target = { project_id: '101', workflow_id: 'review.issue' };
  const message = '/project 101 /command ' + JSON.stringify({ operation: 'workflow.update', target, arguments: { prompt: 'Must remain unapplied.' }, expected_revision: service.management.service.revision(target) });
  const r = await post(h, id, inGroup(message)); await finished(h, r.value.operation_id);
  const op = h.store.get("SELECT * FROM management_commands WHERE channel='im'"); assert.equal(op.state, 'awaiting_approval');
  await group(admin, id, { expected_revision: 1, enabled: false, audience_verified_until: 0 });
  const approved = await admin('/api/management/commands/' + op.id + '/approval', 'POST', { parameter_hash: op.parameter_hash, expected_revision: op.expected_revision, decision: 'approve' });
  assert.equal(approved.value.state, 'failed'); assert.equal(approved.value.result.error, 'channel_group_scope_required');
  assert.notEqual((await managerSection(admin,'101','review.issue')), 'Must remain unapplied.');
});

test('the send fence rechecks group authorization after asynchronous token exchange', async t => {
  const f = await channelFixture(t), { h, id, admin, wire } = f;
  await group(admin, id, { fields: ['summary', 'status', 'operation', 'result'] });
  let release; wire.state.authGate = new Promise(r => { release = r; }); t.after(() => release());
  const r = await post(h, id, inGroup(directQuery())); await finished(h, r.value.operation_id);
  const sending = await until(() => h.store.get("SELECT * FROM channel_outbox WHERE source_event=? AND state='sending'", r.value.operation_id));
  await group(admin, id, { expected_revision: 1, enabled: false, audience_verified_until: 0 });
  wire.state.authGate = null; release();
  const failed = await until(() => h.store.get('SELECT * FROM channel_outbox WHERE id=?', sending.id), row => row.state === 'failed');
  assert.equal(failed.last_error, 'channel_group_scope_required'); assert.equal(wire.sent.length, 0);
});

test('deferred extensions retain the IM source guard across asynchronous steps before any external write', async t => {
  const f = await channelFixture(t), { h, id, admin, service } = f;
  await group(admin, id);
  h.store.run("INSERT INTO management_policies(tenant_id,approval_operations) VALUES('github.com:10','[\"knowledge.revise\"]')");
  let entered = false, release, writes = 0; const gate = new Promise(r => { release = r; }); t.after(() => release());
  service.management.service.extensions.delete('knowledge.revise'); // Replace the real adapter with an asynchronous failure fixture.
  service.management.service.register('knowledge.revise', { execute: async actor => {
    entered = true; await gate; service.management.service.scope(actor, '101', 'knowledge.write'); writes++; return { revised: true };
  }, reconcile: async () => null });
  const target = { project_id: '101' }, input = '/project 101 /command ' + JSON.stringify({ operation: 'knowledge.revise', target, arguments: { id: 'fixture-document', revision: 1, body: 'Safe revision.' }, expected_revision: service.management.service.revision(target) });
  const r = await post(h, id, inGroup(input)); await finished(h, r.value.operation_id);
  const op = h.store.get("SELECT * FROM management_commands WHERE channel='im'"); assert.equal(op.state, 'awaiting_approval');
  const approving = admin('/api/management/commands/' + op.id + '/approval', 'POST', { parameter_hash: op.parameter_hash, expected_revision: op.expected_revision, decision: 'approve' });
  await until(() => entered); await group(admin, id, { expected_revision: 1, enabled: false, audience_verified_until: 0 }); release();
  const result = await approving; assert.equal(writes, 0); assert.equal(result.value.state, 'unknown'); assert.equal(result.value.result.error, 'channel_group_scope_required');
});
