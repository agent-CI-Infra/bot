import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { identityFixture } from './identity-fixture.mjs';
import { session } from '../dist/app/auth.js';
import { resolveActor, authorize, invalidate, narrowActor, resolvePrincipalActor } from '../dist/identity/authorization.js';
import { ChannelConnections } from '../dist/channels/connections.js';
import { channelFixture, transport, connector, envelope, post, until, finished, bindFixture, inGroup, cardEvent, cardToken, digest, credentials, scriptedModel, managementOutcome, privateChat, boundGroup, registerDestination, repositoryAssistant } from './channel-fixture.mjs';

// Private chats are the management assistant and groups are their bound service role (#312): no message text is a command.
const read = (project = '101', task = 'blocked') => ['management_query', { operation: 'get_task', target: { project_id: project, task_id: task }, arguments: {} }];
const readNamed = (done, context) => { const m = /(\d+)\/(\w+)/.exec(String(context.request)); return read(m[1], m[2]); };
const ask = (project = '101', task = 'blocked') => `看看 ${project}/${task} 任务的进展`;
const noProjects = '当前账户没有可访问的项目';
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
  const data = envelope(ask()), result = await post(h, id, data, { encrypted: true });
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
  const data = envelope('修改 Issue 检视的提示词'), start = performance.now(), result = await post(h, id, data);
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
  const verified = await fetch(callback, { redirect: 'manual', headers: { Cookie: browserCookie } }); assert.equal(verified.headers.get('location'), '/?github_auth=1#/identity/feishu');
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
  const noPermission = await post(h, id, envelope(ask(), { sender: { tenant_key: 'external-tenant', sender_id: { open_id: 'ou_unprivileged' } } }));
  assert.equal((await finished(h, noPermission.value.operation_id)).state, 'completed');
  await until(() => wire.sent.some(s => JSON.stringify(s.content).includes(noProjects)));
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 0);
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
  const f = await channelFixture(t), { h, id, service, member, admin } = f;
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
  scriptedModel(f, [readNamed, '已读取任务事实。']);
  const message = project => envelope(ask(project, project === '101' ? 'blocked' : 'foreign'), { sender: { sender_id: { open_id: 'ou_local' } } });
  const allowed = await post(h, id, message('101'));
  assert.equal((await finished(h, allowed.value.operation_id)).state, 'completed');
  const denied = await post(h, id, message('201')); await finished(h, denied.value.operation_id);
  assert.equal(managementOutcome(h, denied.value.operation_id).error, 'capability_forbidden');
  assert.equal((await admin('/api/project-admin-assignments', 'PUT', { user_id: local.id, repository_ids: [], organization_ids: [] })).status, 200);
  const revokedAccess = await post(h, id, message('101'));
  assert.equal((await finished(h, revokedAccess.value.operation_id)).state, 'completed'); assert.equal(managementOutcome(h, revokedAccess.value.operation_id).error, null);
  await until(() => f.wire.sent.some(s => JSON.stringify(s.content).includes(noProjects)));
  assert.equal(h.store.get("SELECT status FROM external_identities WHERE provider='feishu' AND external_actor='ou_local'").status, 'active');
  const unprivileged = await member('local-no-grants', { repository_ids: [] });
  const noGrantsEvent = { ...event, actor_id: 'ou_local_no_grants', event_id: 'no-grants-start' }, noGrants = service.bindings.begin(noGrantsEvent);
  await service.bindings.authenticate(noGrants.challenge, session(h.store, unprivileged.id).token);
  const code = service.bindings.pending(unprivileged.id)[0].confirmation;
  await service.bindings.confirm({ ...noGrantsEvent, event_id: 'no-grants-confirm' }, String(code));
  const blocked = await post(h, id, envelope(ask(), { sender: { sender_id: { open_id: 'ou_local_no_grants' } }, message: { chat_id: 'oc_no_grants' } }));
  assert.equal((await finished(h, blocked.value.operation_id)).state, 'completed'); assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 0);
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
  const denied = await post(h, id, envelope(ask(), { sender: { sender_id: { open_id: 'ou_code' } } }));
  assert.equal((await finished(h, denied.value.operation_id)).state, 'completed'); assert.equal(managementOutcome(h, denied.value.operation_id).message, 'completed');
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
  for (const [connectorId, data] of [[second, envelope(ask(), { header: { app_id: 'cli_other' } })], [id, envelope(ask(), { sender: { tenant_key: 'other-tenant' } })]]) {
    const r = await post(h, connectorId, data); assert.equal((await finished(h, r.value.operation_id)).error, 'external_binding_required');
  }
  const noMember = await f.member('unprivileged-im', { repository_ids: [] }); bindFixture(h, id, noMember.id, 'ou_owner');
  const r = await post(h, id, envelope(ask(), { sender: { sender_id: { open_id: 'ou_owner' }, is_admin: true } }));
  assert.equal((await finished(h, r.value.operation_id)).state, 'completed');
  await until(() => f.wire.sent.some(s => JSON.stringify(s.content).includes(noProjects)));
  const web = await noMember.client('/api/management/query', 'POST', { operation: 'get_task', target: { project_id: '101', task_id: 'blocked' }, arguments: {} });
  assert.equal(web.value.error, 'capability_forbidden');
  // Old structured syntax is plain text now: it neither runs the embedded query nor lends its fields any authority.
  const forged = '/project 101 /query ' + JSON.stringify({ operation: 'list_tasks', target: { project_id: '101' }, arguments: {}, admin: true, tenant_id: 'github.com:20' });
  const attempt = await post(h, id, envelope(forged, { sender: { sender_id: { open_id: 'ou_owner' } } })); await finished(h, attempt.value.operation_id);
  assert.equal(managementOutcome(h, attempt.value.operation_id).input.content, forged);
  assert.equal(h.store.get("SELECT count(*) n FROM management_events WHERE type='tool_call'").n, 0);
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 0);
});

test('one global connection serves authorized projects in different organizations without widening user or group permissions', async t => {
  const f = await channelFixture(t), { h, id, admin, service } = f;
  h.store.run("UPDATE installed_repositories SET owner_id='20',owner_login='second-fixture' WHERE repository_id='201'");
  const member = await f.member('multi-org-im', { repository_ids: ['101', '201'] });
  bindFixture(h, id, member.id, 'ou_multi');
  scriptedModel(f, [readNamed, '已读取任务事实。']);
  const send = (project, task) => post(h, id, envelope(ask(project, task), { sender: { sender_id: { open_id: 'ou_multi' } }, message: { chat_id: 'oc_multi' } }));
  for (const [project, task] of [['101', 'blocked'], ['201', 'foreign']]) {
    const r = await send(project, task); assert.equal((await finished(h, r.value.operation_id)).state, 'completed');
  }
  const denied = await send('102', 'blocked'); await finished(h, denied.value.operation_id);
  assert.equal(managementOutcome(h, denied.value.operation_id).error, 'capability_forbidden');
  const event = service.adapter(service.connector(id)).normalize(envelope(ask(), { sender: { sender_id: { open_id: 'ou_multi' } } }));
  const actor = await service.actor(event);
  assert.equal(actor.tenant_id, null); authorize(actor, 'tasks.read', { project_id: '201' });
  assert.throws(() => authorize(actor, 'tasks.read', { project_id: '102' }), /capability_forbidden/);
  // A group without a binding answers only with how to bind it; old /project text runs nothing there.
  const before = h.store.get('SELECT count(*) n FROM management_messages').n;
  const unbound = await post(h, id, inGroup('/project 201 /query ' + JSON.stringify({ operation: 'get_task', target: { project_id: '201', task_id: 'foreign' }, arguments: {} }), 'ou_multi'));
  assert.equal((await finished(h, unbound.value.operation_id)).state, 'completed');
  await until(() => f.wire.sent.some(s => s.receive_id === 'oc_group' && JSON.stringify(s.content).includes('本群尚未绑定群聊助手')));
  assert.equal(h.store.get('SELECT count(*) n FROM management_messages').n, before);
  // A project's schedule panel offers the member's own private chat directly (#330), only for projects the member may manage.
  const chat = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_multi'");
  const offered = project => member.client('/api/management/query', 'POST', { operation: 'list_schedule_destinations', target: { project_id: project }, arguments: {} });
  assert.ok((await offered('201')).value.destinations.some(d => d.id === 'chat:' + chat.id));
  const destination = await registerDestination(member.client, chat, '201');
  assert.ok((await offered('201')).value.destinations.some(d => d.id === destination), 'a registered chat is listed by its registration');
  assert.equal((await offered('102')).value.error, 'capability_forbidden');
  h.store.run('DELETE FROM project_admin_assignments WHERE user_id=? AND repository_id=?', member.id, '201');
  invalidate(h.store, member.id, 'test-project-revoked');
  const revoked = await send('201', 'foreign'); await finished(h, revoked.value.operation_id);
  assert.equal(managementOutcome(h, revoked.value.operation_id).error, 'capability_forbidden');
  assert.equal((await admin('/api/channels/setup')).value.connectors.length, 1);
});

test('an identity bound through an organization app acts only inside that organization: no platform authority and no other tenant (#424)', async t => {
  const f = await channelFixture(t), { h, id, service } = f;
  h.store.run("UPDATE installed_repositories SET owner_id='20',owner_login='second-fixture' WHERE repository_id='201'");
  h.store.run("UPDATE channel_connectors SET owner_tenant='github.com:10' WHERE id=?", id);
  const member = await f.member('org-app-im', { repository_ids: ['101', '201'] });
  bindFixture(h, id, member.id, 'ou_org_member');
  scriptedModel(f, [readNamed, '已读取任务事实。']);
  const send = (project, task, actor = 'ou_org_member', chat = 'oc_org_member') => post(h, id, envelope(ask(project, task), { sender: { sender_id: { open_id: actor } }, message: { chat_id: chat } }));
  const allowed = await send('101', 'blocked'); assert.equal((await finished(h, allowed.value.operation_id)).state, 'completed');
  assert.equal(managementOutcome(h, allowed.value.operation_id).error, null);
  // The member administers 201 too, but not through this organization's app.
  const foreign = await send('201', 'foreign'); await finished(h, foreign.value.operation_id);
  assert.equal(managementOutcome(h, foreign.value.operation_id).error, 'tenant_forbidden');
  const conversation = h.store.get('SELECT c.* FROM channel_sessions s JOIN management_conversations c ON c.id=s.conversation_id WHERE s.principal_id=?', member.id);
  assert.equal(conversation.scope, 'tenant:github.com:10');
  const actor = await service.actor(service.adapter(service.connector(id)).normalize(envelope(ask(), { sender: { sender_id: { open_id: 'ou_org_member' } } })));
  assert.equal(actor.tenant_id, 'github.com:10'); authorize(actor, 'tasks.read', { project_id: '101' });
  assert.throws(() => authorize(actor, 'tasks.read', { project_id: '201' }), /tenant_forbidden/);
  assert.throws(() => resolvePrincipalActor(h.store, member.id, 'github.com:20', undefined, 'im', actor), /tenant_forbidden/);
  assert.throws(() => narrowActor(actor, ['tasks.read']) && authorize(narrowActor(actor, ['tasks.read']), 'tasks.read', { project_id: '201' }), /tenant_forbidden/);
  // A platform administrator's authority never passes through an organization's app.
  const platform = await service.actor(service.adapter(service.connector(id)).normalize(envelope(ask())));
  assert.throws(() => authorize(platform, 'platform.manage'), /capability_forbidden/);
  assert.throws(() => authorize(platform, 'tasks.read', { project_id: '101' }), /capability_forbidden/);
  assert.equal(service.management.service.user(platform).role, 'project_admin');
  const refused = await send('101', 'blocked', 'ou_alice', 'oc_private'); await finished(h, refused.value.operation_id);
  assert.equal(h.store.get('SELECT error FROM channel_inbox WHERE id=?', refused.value.operation_id).error, 'channel_application_tenant_forbidden');
  await until(() => f.wire.sent.some(s => s.receive_id === 'oc_private' && JSON.stringify(s.content).includes('属于一个 GitHub 组织')));
  // A private chat of the organization's app is offered only for that organization's projects.
  const chat = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_org_member'");
  const offered = async project => (await member.client('/api/management/query', 'POST', { operation: 'list_schedule_destinations', target: { project_id: project }, arguments: {} })).value.destinations.map(d => d.id);
  assert.ok((await offered('101')).includes('chat:' + chat.id));
  assert.ok(!(await offered('201')).includes('chat:' + chat.id));
  await assert.rejects(registerDestination(member.client, chat, '201'), { code: 'channel_application_scope_forbidden' });
});

test('a project offers chats directly as destinations and registers a chosen one on save, only for its owner or a manager of the group binding (#330)', async t => {
  const f = await channelFixture(t), { h, admin, wire } = f;
  const own = await privateChat(f);
  const offered = async (client, project = '101') => (await client('/api/management/query', 'POST', { operation: 'list_schedule_destinations', target: { project_id: project }, arguments: {} })).value.destinations;
  const save = async (client, destination, key) => {
    const { revision } = (await client('/api/management/query', 'POST', { operation: 'list_subscriptions', target: { project_id: '101' }, arguments: {} })).value;
    return client('/api/management/commands', 'POST', { operation: 'notification.register', target: { project_id: '101' }, expected_revision: revision, idempotency_key: key,
      source_conversation: 'destination-test', source_message: key, arguments: { subscription: { name: 'Failures ' + key, destination_id: destination, events: ['task.failed'], projects: ['101'], aggregate_ms: 60000, timezone: 'UTC', enabled: true } } });
  };
  assert.deepEqual((await offered(admin)).map(d => [d.id, d.type, d.chat_id]), [['chat:' + own.id, 'p2p', own.chat_id]]);
  // Saving with a chosen chat registers it once for this chat, project and registrant, and sends nothing.
  const sent = wire.sent.length, first = await save(admin, 'chat:' + own.id, 'first'), second = await save(admin, 'chat:' + own.id, 'second');
  assert.equal(first.value.state, 'succeeded', JSON.stringify(first.value));
  const id = first.value.result.subscription.spec.destination_id;
  assert.match(id, /^[a-f0-9]{48}$/); assert.equal(second.value.result.subscription.spec.destination_id, id, 'one registration per chat, project and registrant');
  assert.deepEqual((await offered(admin)).map(d => d.id), [id], 'a registered chat is listed once, by its registration');
  await f.service.tick(); assert.equal(wire.sent.length, sent);
  // Someone else's private chat is neither offered nor accepted, even for a member with the project.
  const member = await f.member('destination-member', { repository_ids: ['101'] }); bindFixture(h, f.id, member.id, 'ou_member');
  assert.ok(!(await offered(member.client)).some(d => d.id === 'chat:' + own.id));
  assert.match(JSON.stringify((await save(member.client, 'chat:' + own.id, 'member')).value), /channel_destination_forbidden/);
  // A group is offered for the projects its enabled binding reaches; its registration is not tied to a speaker.
  const groupChat = await boundGroup(f, ['101']);
  assert.ok((await offered(admin)).some(d => d.id === 'chat:' + groupChat.id && d.type === 'group'));
  assert.ok(!(await offered(admin, '102')).some(d => d.id === 'chat:' + groupChat.id), 'outside the binding scope the group is not offered');
  const groupDestination = (await save(admin, 'chat:' + groupChat.id, 'group')).value.result.subscription.spec.destination_id;
  const payload = h.store.secrets.open(h.store.get('SELECT payload FROM channel_outbox WHERE id=?', groupDestination).payload, 'channel-outbox:' + groupDestination);
  assert.equal(payload.event.chat_type, 'group'); assert.equal(payload.event.actor_id, ''); assert.ok(payload.protection.binding_id);
  // The separate registration endpoints are gone.
  assert.equal((await admin('/api/channels/destinations')).value.error, 'channel_endpoint_not_found');
  assert.equal((await admin('/api/channels/chats/' + own.id + '/destinations', 'POST', { project_id: '101' })).value.error, 'channel_endpoint_not_found');
  assert.deepEqual(h.store.all("SELECT action FROM audit WHERE action LIKE 'channel.destination.%' ORDER BY created_at").map(a => a.action), ['channel.destination.registered', 'channel.destination.registered']);
});

test('private chat text is natural language: /project, /query, /command, /link and /chat start no special flow', async t => {
  const f = await channelFixture(t), { h, id, admin, service, principal } = f;
  const plain = await post(h, id, envelope('看看当前任务')); await finished(h, plain.value.operation_id);
  assert.equal(h.store.get('SELECT count(*) n FROM management_messages').n, 1);
  const target = { project_id: '101', task_id: 'blocked' };
  for (const text of ['/project 101 /query ' + JSON.stringify({ operation: 'get_task', target, arguments: {} }),
    '/project 101 /command ' + JSON.stringify({ operation: 'task.instructions', target, arguments: { instruction: 'x' }, expected_revision: service.management.service.revision(target) }),
    '/project 101 /link ' + 'a'.repeat(48), '/project 101 /destination', '/chat 你好']) {
    const r = await post(h, id, envelope(text)); await finished(h, r.value.operation_id);
    const outcome = managementOutcome(h, r.value.operation_id);
    assert.deepEqual(Object.keys(outcome.input).sort(), ['content', 'source_message']); assert.equal(outcome.input.content, text);
  }
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 0);
  assert.deepEqual(h.store.all('SELECT DISTINCT project_id FROM channel_sessions').map(r => r.project_id), ['']);
  assert.equal(h.store.get("SELECT count(*) n FROM channel_outbox WHERE state='registered'").n, 0);
  const older = envelope(ask(), { message: { create_time: String(Date.now() - 5000) } });
  const old = await post(h, id, older); assert.equal((await finished(h, old.value.operation_id)).error, 'channel_message_out_of_order');
  // The same provider message id under two applications stays two sources, each with its own command.
  const second = await connector(admin, { app_id: 'cli_same_message_id' }); bindFixture(h, second, principal, 'ou_alice', 'actor-tenant', 'cli_same_message_id');
  scriptedModel(f, [read(), done => ['management_command', { operation: 'task.instructions', target, arguments: { instruction: 'Inspect again.' }, expected_revision: done[0].revision }], '已追加。']);
  for (const [connectorId, app] of [[id, 'cli_fixture'], [second, 'cli_same_message_id']]) {
    const r = await post(h, connectorId, envelope('给 blocked 任务追加检查要求', { header: { app_id: app }, message: { message_id: 'same-provider-message-id' } }));
    assert.equal((await finished(h, r.value.operation_id)).state, 'completed');
  }
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im' AND state='succeeded'").n, 2);
});

test('result cards carry no refresh action, a click on an older card is answered as stale, and unbinding stops the chat', async t => {
  const f = await channelFixture(t), { h, id, wire, admin } = f;
  const target = { project_id: '101', task_id: 'blocked' };
  scriptedModel(f, [read(), done => ['management_command', { operation: 'task.instructions', target, arguments: { instruction: 'Inspect current logs.' }, expected_revision: done[0].revision }], '已追加。']);
  const r = await post(h, id, envelope('给 blocked 任务追加：检查当前日志')); await finished(h, r.value.operation_id);
  const result = await until(() => wire.sent.find(s => JSON.stringify(s.content).includes('已执行')));
  assert.equal(cardToken(result), undefined); assert.ok(JSON.stringify(result.content).includes('登录后台查看'));
  const click = await post(h, id, cardEvent('legacy-card-token', 'remote-1'));
  assert.equal((await finished(h, click.value.operation_id)).error, 'channel_card_stale');
  assert.ok(!wire.sent.some(s => s.method === 'PATCH'));
  const identity = h.store.get("SELECT id FROM external_identities WHERE provider='feishu'");
  await admin('/api/identity/bindings/' + identity.id, 'DELETE', {});
  const unlinked = await post(h, id, envelope(ask())); assert.equal((await finished(h, unlinked.value.operation_id)).error, 'external_binding_required');
});

test('external members use their own binding and project authorization without an enterprise list; an unbound group only explains binding', async t => {
  const f = await channelFixture(t), { h, id, wire, principal } = f;
  const external = content => envelope(content, { sender: { tenant_key: 'external-tenant' } });
  const unbound = await post(h, id, external(ask()));
  assert.equal((await finished(h, unbound.value.operation_id)).error, 'external_binding_required');
  const binding = await post(h, id, external('/bind'));
  assert.equal((await finished(h, binding.value.operation_id)).state, 'completed');
  bindFixture(h, id, principal, 'ou_alice', 'external-tenant');
  const query = await post(h, id, external(ask())), answered = await finished(h, query.value.operation_id);
  assert.equal(answered.state, 'completed', JSON.stringify(managementOutcome(h, query.value.operation_id)));
  const externalGroup = inGroup(ask()); externalGroup.event.sender.tenant_key = 'external-tenant';
  const group = await post(h, id, externalGroup);
  assert.equal((await finished(h, group.value.operation_id)).state, 'completed');
  await until(() => wire.sent.some(s => s.receive_id === 'oc_group' && JSON.stringify(s.content).includes('本群尚未绑定群聊助手')));
  const target = { project_id: '101', task_id: 'blocked' };
  scriptedModel(f, [read(), done => ['management_command', { operation: 'task.instructions', target, arguments: { instruction: 'Inspect external member evidence.' }, expected_revision: done[0].revision }], '已追加。']);
  const write = await post(h, id, external('给 blocked 任务追加外部成员证据检查'));
  assert.equal((await finished(h, write.value.operation_id)).state, 'completed');
  assert.equal(h.store.get("SELECT state FROM management_commands WHERE channel='im'").state, 'succeeded');
  assert.ok(h.store.all('SELECT actor_tenant FROM channel_sessions').every(row => row.actor_tenant === 'external-tenant'));
});

test('enterprise SDK persists an external member card callback once and answers an older card as stale', async t => {
  const { h, id, wire, service, principal } = await channelFixture(t);
  bindFixture(h, id, principal, 'ou_alice', 'external-tenant');
  h.store.run("UPDATE channel_connectors SET transport='websocket' WHERE id=?", id);
  let dispatcher;
  const sockets = new ChannelConnections(service, () => ({ start: async options => { dispatcher = options.eventDispatcher; }, close() {},
    getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }));
  t.after(() => sockets.close()); sockets.reconcile();
  const click = cardEvent('legacy-card-token', 'remote-legacy'); click.event.operator.tenant_key = 'external-tenant';
  const receipt = await dispatcher.invoke(click, { needCheck: false });
  assert.equal(receipt.state, 'queued');
  assert.equal((await dispatcher.invoke(click, { needCheck: false })).operation_id, receipt.operation_id);
  assert.equal((await finished(h, receipt.operation_id)).error, 'channel_card_stale');
  assert.equal(h.store.get('SELECT count(*) n FROM channel_inbox WHERE event_id=?', click.header.event_id).n, 1);
  assert.ok(!wire.sent.some(s => s.method === 'PATCH'));
});

test('HTTP and enterprise SDK ingress share dedup; config CAS, outbox retries, current scope fences and registered notifications stay observable', async t => {
  const f = await channelFixture(t), { h, id, service, admin, wire } = f;
  assert.equal((await connector(admin, { app_id: 'cli_invalid_saas', application_type: 'saas', transport: 'websocket', enabled: false }).catch(e => ({ error: String(e) }))).error.includes('channel_transport_invalid'), true);
  const event = envelope(ask()), first = await post(h, id, event); await finished(h, first.value.operation_id);
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
  const e = service.adapter(service.connector(id)).normalize(envelope()), actor = await service.actor(e);
  const chat = h.store.get("SELECT * FROM channel_chats WHERE chat_type='p2p'"), registration = await registerDestination(admin, chat);
  await service.tick(); assert.equal(h.store.get('SELECT state FROM channel_outbox WHERE id=?', registration).state, 'registered');
  const uninstall = envelope(); uninstall.header.event_type = 'app.uninstalled'; uninstall.event = {};
  await post(h, id, uninstall);
  assert.throws(() => authorize(actor, 'tasks.read', { project_id: '101' }), /channel_connector_inactive/);
  assert.equal((await post(h, id, envelope(ask()))).value.error, 'channel_connector_inactive');
});

test('revoking project access while a model is waiting blocks its command and reply', async t => {
  const f = await channelFixture(t), { h, admin, id, modelState, wire } = f;
  const member = await f.member('waiting-member', { repository_ids: ['101'] }); bindFixture(h, id, member.id, 'ou_waiting');
  let release; modelState.gate = new Promise(r => { release = r; }); t.after(() => release());
  const r = await post(h, id, envelope('修改 Issue 检视的提示词', { sender: { sender_id: { open_id: 'ou_waiting' } }, message: { chat_id: 'oc_waiting' } }));
  await until(() => f.requests.length);
  assert.equal((await admin('/api/project-admin-assignments', 'PUT', { user_id: member.id, repository_ids: [] })).status, 200);
  modelState.gate = null; release();
  assert.equal((await finished(h, r.value.operation_id)).state, 'failed');
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n, 0);
  assert.ok(wire.sent.every(s => !JSON.stringify(s.content).includes('Inspect evidence')));
});

test('IM commands and revision conflicts retain the shared business outcome without any approval step; revoked access stops a later message', async t => {
  const f = await channelFixture(t), { h, admin, service, id, wire } = f;
  const target = { project_id: '101', workflow_id: 'review.issue' }, revision = service.management.service.revision(target);
  const submit = async (expected = revision, actor = 'ou_alice', chat = 'oc_private') => {
    scriptedModel(f, [['management_command', { operation: 'workflow.update', target, arguments: { prompt: 'Approved future prompt.' }, expected_revision: expected }], '已提交。']);
    const r = await post(h, id, envelope('修改 Issue 检视提示词', { sender: { sender_id: { open_id: actor } }, message: { chat_id: chat } })); return finished(h, r.value.operation_id);
  };
  const wrong = await submit('obsolete-revision');
  assert.equal(h.store.get('SELECT state FROM management_messages WHERE id=?', wrong.message_id).state, 'failed');
  const webConflict = await admin('/api/management/commands', 'POST', { operation: 'workflow.update', target, arguments: { prompt: 'Approved future prompt.' }, expected_revision: 'obsolete-revision', idempotency_key: 'web-conflict', source_conversation: 'web', source_message: 'web-conflict' });
  assert.equal(webConflict.value.error, 'management_revision_conflict');
  // A policy left by an older version is no longer read: the private chat's command runs at once, with the console's receipt.
  h.store.run("INSERT INTO management_policies(tenant_id,approval_operations) VALUES('github.com:10','[\"workflow.update\"]')");
  const pending = await submit(), op = h.store.get("SELECT * FROM management_commands WHERE channel='im'");
  assert.equal(op.state, 'succeeded');
  assert.equal((await managerSection(admin,'101','review.issue')), 'Approved future prompt.');
  assert.equal((await admin('/api/management/commands/' + op.id)).value.source_conversation, pending.conversation_id);
  assert.ok(!JSON.stringify(wire.sent).includes('等待审批'));
  const member = await f.member('revoked-member', { repository_ids: ['101'] });
  bindFixture(h, id, member.id, 'ou_member');
  await admin('/api/project-admin-assignments', 'PUT', { user_id: member.id, repository_ids: [] });
  const message = await post(h, id, envelope(ask(), { sender: { sender_id: { open_id: 'ou_member' } }, message: { chat_id: 'oc_member' } }));
  assert.equal((await finished(h, message.value.operation_id)).state, 'completed');
  await until(() => wire.sent.some(s => s.receive_id === 'oc_member' && JSON.stringify(s.content).includes(noProjects)));
});

test('durable ingress survives restart and a retried write keeps its original conversation and operation', async t => {
  const f = await channelFixture(t), { h, id, service } = f;
  service.close();
  const data = envelope('修改 Issue 检视的提示词'), accepted = await post(h, id, data);
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
  const data = envelope(ask(), { header: { app_id: 'cli_store', tenant_key: 'second-install' } });
  const r = await post(h, id, data); const row = await finished(h, r.value.operation_id);
  assert.equal(row.connector_id, other); assert.equal(row.state, 'completed');
  await until(() => wire.state.authRequests.some(a => a.tenant_key === 'second-install'));
  assert.ok(wire.state.authRequests.some(a => a.url.endsWith('/app_access_token') && a.app_id === 'cli_store'));
  const c = service.connector(other), secret = h.store.secrets.open(h.store.get('SELECT sealed FROM channel_credentials WHERE id=?', c.credential_ref).sealed, 'channel-credential:' + c.credential_ref);
  assert.equal(secret.app_ticket, 'fixture-store-app-ticket');
  assert.ok(!readFileSync(h.database).includes(Buffer.from('fixture-store-app-ticket')));
  const uninstall = { ...ticket, uuid: 'legacy-uninstall', event: { type: 'app_uninstalled', app_id: 'cli_store', tenant_key: 'install-tenant' } };
  await post(h, id, uninstall); assert.equal(h.store.get('SELECT enabled FROM channel_connectors WHERE id=?', id).enabled, 0);
  const next = await post(h, id, envelope(ask(), { header: { app_id: 'cli_store', tenant_key: 'second-install' } }));
  assert.equal((await finished(h, next.value.operation_id)).state, 'completed');
});

test('the send fence rechecks a group binding after asynchronous token exchange', async t => {
  const f = await channelFixture(t), { h, admin, wire } = f;
  await repositoryAssistant(f);
  const chat = await boundGroup(f, ['101']);
  scriptedModel(f, ['本群可以使用 admin-fixture-101。']);
  let release; wire.state.authGate = new Promise(r => { release = r; }); t.after(() => release());
  const r = await post(h, f.id, inGroup('你能看哪些仓库？', 'ou_bob')); await finished(h, r.value.operation_id);
  const sending = await until(() => h.store.get("SELECT * FROM channel_outbox WHERE source_event=? AND state='sending'", r.value.operation_id));
  const binding = h.store.get('SELECT * FROM channel_service_bindings');
  assert.equal((await admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { enabled: false, expected_revision: binding.revision })).status, 200);
  wire.state.authGate = null; release();
  const failed = await until(() => h.store.get('SELECT * FROM channel_outbox WHERE id=?', sending.id), row => row.state === 'failed');
  assert.equal(failed.last_error, 'conversation_source_changed'); assert.ok(!wire.sent.some(s => JSON.stringify(s.content).includes('本群可以使用')));
});

test('extensions keep the IM source guard across asynchronous steps before any external write', async t => {
  const f = await channelFixture(t), { h, service } = f;
  let entered = false, release, writes = 0; const gate = new Promise(r => { release = r; }); t.after(() => release());
  service.management.service.extensions.delete('knowledge.revise'); // Replace the real adapter with an asynchronous failure fixture.
  service.management.service.register('knowledge.revise', { execute: async actor => {
    entered = true; await gate; service.management.service.scope(actor, '101', 'knowledge.write'); writes++; return { revised: true };
  }, reconcile: async () => null });
  const target = { project_id: '101' };
  scriptedModel(f, [['management_command', { operation: 'knowledge.revise', target, arguments: { id: 'fixture-document', revision: 1, body: 'Safe revision.' }, expected_revision: service.management.service.revision(target) }], '已提交。']);
  const r = await post(h, f.id, envelope('修订项目知识 fixture-document'));
  // The command runs directly in the chat turn; the private chat's owner unbinds Feishu while the external step is in flight.
  await until(() => entered); h.store.run("UPDATE external_identities SET status='revoked' WHERE provider='feishu'"); release();
  await finished(h, r.value.operation_id);
  const op = await until(() => h.store.get("SELECT * FROM management_commands WHERE channel='im'"), row => row && !['pending', 'executing'].includes(row.state));
  assert.equal(writes, 0); assert.equal(op.state, 'unknown'); assert.equal(JSON.parse(op.result).error, 'external_binding_required');
});
