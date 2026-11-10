import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { identityFixture } from './identity-fixture.mjs';
import { session } from '../dist/app/auth.js';
import { authorize, resolveActor, listEffectiveScopes, resolveServiceActor, createProjectServicePrincipal, assertSessionWrite, resolvePrincipalActor, invalidate } from '../dist/identity/authorization.js';
import { InstallationSetup } from '../dist/installations/setup.js';
import { identityStorage } from '../dist/identity/storage.js';
import { ExternalBindings, revokeIdentity } from '../dist/identity/bindings.js';
import { digest } from '../dist/core/security.js';
import { testPassword } from './helpers.mjs';

const token = client => client.cookie().slice('bot_session='.length);
const active = (s, p) => listEffectiveScopes(s, p).filter(g => g.state === 'active');

test('OAuth uses S256, browser-bound single-use state and stable numeric identity; local names never merge', async t => {
  const f = await identityFixture(t), { h, identity } = f;
  const begun = identity.begin('browser-a', 'login'), url = new URL(begun.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('code_challenge').length, 43);
  assert.equal(url.searchParams.get('scope'), '');
  await assert.rejects(identity.callback('browser-b', url.searchParams.get('state'), 'code'), /invalid_oauth_state/);
  const authorized = await fetch(begun.url, { redirect: 'manual' }), callback = new URL(authorized.headers.get('location'));
  const result = await identity.callback('browser-a', callback.searchParams.get('state'), callback.searchParams.get('code'));
  assert.notEqual(result.principal_id, (await f.admin('/api/auth/me')).value.id);
  assert.equal(h.store.get('SELECT role FROM users WHERE id=?', result.principal_id).role, 'project_admin');
  await assert.rejects(identity.callback('browser-a', callback.searchParams.get('state'), callback.searchParams.get('code')), /invalid_oauth_state/);
  assert.equal((await f.login()).result.principal_id, result.principal_id);
  const failed = new URL(identity.begin('bad-code', 'login').url);
  await assert.rejects(identity.callback('bad-code', failed.searchParams.get('state'), 'bad'), /github_oauth_failed/);
  await assert.rejects(identity.callback('bad-code', failed.searchParams.get('state'), 'bad'), /invalid_oauth_state/);
  const expired = new URL(identity.begin('expired', 'login').url);
  h.store.run('UPDATE github_oauth_states SET expires_at=0 WHERE state_hash=?', digest(expired.searchParams.get('state')));
  await assert.rejects(identity.callback('expired', expired.searchParams.get('state'), 'bad'), /invalid_oauth_state/);
  const row = h.store.get('SELECT * FROM external_identities WHERE id=?', result.identity_id);
  assert.ok(!row.credentials.includes('fixture-user')); assert.ok(!row.credentials.includes('fixture-refresh'));
  const credential = session(h.store, result.principal_id, result.identity_id), req = await fetch(h.admin + '/api/identity', { headers: { Cookie: 'bot_session=' + credential.token } });
  assert.doesNotMatch(await req.text(), /fixture-user|fixture-refresh|credentials|access_token|private_key/);
  assert.ok(!readFileSync(h.database).includes(Buffer.from('fixture-user-42')));
});

test('existing GitHub sessions expose the verified login and avatar without changing local usernames or identity keys', async t => {
  const f = await identityFixture(t), { h } = f, login = await f.login();
  const credentials = session(h.store, login.result.principal_id, login.result.identity_id);
  const me = async (token = credentials.token) => {
    const response = await fetch(h.admin + '/api/auth/me', { headers: { Cookie: 'bot_session=' + token } });
    return { status: response.status, value: await response.json() };
  };
  const first = await me(); assert.equal(first.status, 200);
  assert.deepEqual(first.value.github, { login: 'administrator', avatar_url: 'https://avatars.githubusercontent.com/u/42?s=64&v=4' });
  assert.match(first.value.username, /^github:42:/); assert.equal(first.value.id, login.result.principal_id);
  f.state.login = 'renamed-user'; await f.identity.reverify(login.result.principal_id);
  const renamed = await me(); assert.equal(renamed.value.github.login, 'renamed-user');
  assert.equal(renamed.value.username, first.value.username); assert.equal(renamed.value.id, first.value.id);
  assert.equal(renamed.value.github.avatar_url, first.value.github.avatar_url);
  h.store.run("UPDATE external_identities SET status='pending_verification' WHERE id=?", login.result.identity_id);
  assert.equal((await me()).value.github.login, 'renamed-user');
  h.store.transaction(() => revokeIdentity(h.store, login.result.principal_id, login.result.identity_id));
  assert.equal((await me()).status, 401);
  // A local recovery session retains its own name even when that account has a GitHub binding.
  const localToken = token(f.admin); f.state.id = 43;
  const bound = await f.login('bind', localToken);
  const local = await me(localToken); assert.equal(local.value.username, 'administrator'); assert.equal(local.value.github, undefined);
  const external = session(h.store, bound.result.principal_id, bound.result.identity_id);
  assert.equal((await me(external.token)).value.github.login, 'renamed-user');
  assert.doesNotMatch(JSON.stringify(first.value), /fixture-user|fixture-refresh|credentials|access_token|private_key/);
});

test('OAuth only reads identity; installation queries use short-lived read-only App tokens and reject mismatched proof', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const reads = state.requests.filter(r => r.authorization?.startsWith('Bearer fixture-user-'));
  assert.ok(reads.length > 0); assert.ok(reads.every(r => r.path === '/user'));
  const issued = state.requests.filter(r => r.path.endsWith('/access_tokens'));
  assert.ok(issued.length > 0); assert.deepEqual(issued[0].body.permissions, { metadata: 'read', members: 'read' });
  assert.equal(state.requests.filter(r => r.path === '/installation/token' && r.method === 'DELETE').length, issued.length);
  assert.equal(state.requests.some(r => r.path.startsWith('/user/')), false);
  state.owner = false; state.admin = true; state.permissionUserId = 99;
  await f.identity.reverify(p); assert.deepEqual(active(h.store, p), []);
  state.permissionUserId = 42; await f.identity.reverify(p);
  assert.equal(active(h.store, p).some(g => g.project_id === '101'), true);
  state.repositoryProofId = 999; await f.identity.reverify(p); assert.deepEqual(active(h.store, p), []);
  state.repositoryProofId = 101;
  state.owner = true; state.membershipUserId = 99; state.admin = false;
  await f.identity.reverify(p); assert.deepEqual(active(h.store, p), []);
  state.membershipUserId = 42; state.membersPermission = false;
  await f.identity.reverify(p); assert.deepEqual(active(h.store, p), []);
  assert.deepEqual(state.requests.filter(r => r.path.endsWith('/access_tokens')).at(-1).body.permissions, { metadata: 'read' });
});

test('identity-only OAuth rejects previously granted extra scopes before saving a user or token', async t => {
  const f = await identityFixture(t); f.state.scope = 'repo,read:org';
  await assert.rejects(f.login(), /github_oauth_excessive_scope/);
  assert.equal(f.h.store.get('SELECT count(*) n FROM external_identities').n, 0);
});

test('current GitHub owner, selected repositories, repo admin and ordinary members follow installation scope', async t => {
  const f = await identityFixture(t), { h, state } = f, first = await f.login(), principal = first.result.principal_id;
  const creds = session(h.store, principal, first.result.identity_id);
  let actor = resolveActor(h.store, creds.token); authorize(actor, 'config.write', { project_id: '101' });
  assert.equal(active(h.store, principal).some(g => g.role === 'org_admin'), true);
  assert.throws(() => authorize(actor, 'config.write', { project_id: '201' }), /forbidden/);
  assert.throws(() => authorize(actor, 'platform.manage'), /forbidden/);
  state.selection = 'selected'; f.snapshot(); await f.identity.reverify(principal);
  actor = resolveActor(h.store, creds.token); assert.equal(active(h.store, principal).some(g => g.role === 'org_admin'), false);
  authorize(actor, 'roles.publish', { project_id: '101' });
  state.owner = false; state.admin = true; await f.identity.reverify(principal);
  actor = resolveActor(h.store, creds.token); authorize(actor, 'config.write', { project_id: '101' });
  state.admin = undefined; await f.identity.reverify(principal);
  assert.ok(listEffectiveScopes(h.store, principal).some(g => g.state === 'pending_verification'));
  assert.deepEqual(active(h.store, principal), []);
  state.admin = true; await f.identity.reverify(principal); actor = resolveActor(h.store, creds.token);
  state.admin = false; await f.identity.reverify(principal);
  assert.throws(() => authorize(actor, 'config.write', { project_id: '101' }), /authorization_changed/);
  assert.deepEqual(active(h.store, principal), []); // sender/requester are never consulted.
  state.type = 'User'; f.snapshot(); await f.identity.reverify(principal);
  authorize(resolveActor(h.store, creds.token), 'config.write', { project_id: '101' });
  state.id = 43; const other = await f.login(); assert.deepEqual(active(h.store, other.result.principal_id), []);
});

test('permission downgrade blocks stale writes; explicit delegation remains independent; unknown API evidence fails closed', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const creds = session(h.store, p, login.result.identity_id), actor = resolveActor(h.store, creds.token);
  const username = h.store.get('SELECT username FROM users WHERE id=?', p).username;
  assert.equal((await f.admin('/api/project-admin-assignments', 'PUT', { user_id: p, repository_ids: ['101'] })).status, 200);
  state.owner = false; state.admin = false; await f.identity.reverify(p);
  assert.throws(() => assertSessionWrite(h.store, creds.token, actor), /authorization_changed/);
  const current = resolveActor(h.store, creds.token); authorize(current, 'release.manage', { project_id: '101' });
  assert.equal(active(h.store, p).filter(g => g.source === 'explicit_delegation').length, 1);
  assert.throws(() => authorize(current, 'grants.manage', { project_id: '101' }), /forbidden/);
  state.owner = true; await f.identity.reverify(p); state.failure = 403; await f.identity.reverify(p);
  assert.equal(h.store.get('SELECT status FROM external_identities WHERE id=?', login.result.identity_id).status, 'pending_verification');
  assert.ok(listEffectiveScopes(h.store, p).some(g => g.source === 'github_derived' && g.state === 'pending_verification'));
  authorize(resolveActor(h.store, creds.token), 'release.manage', { project_id: '101' });
  assert.equal(h.store.get('SELECT username FROM users WHERE id=?', p).username, username);
  state.failure = 0; h.store.run('UPDATE external_identities SET expires_at=0 WHERE id=?', login.result.identity_id); await f.identity.reverify(p);
  assert.equal(state.refreshed, 1);
  const before = resolveActor(h.store, creds.token);
  h.store.transaction(() => revokeIdentity(h.store, p, login.result.identity_id));
  assert.throws(() => authorize(before, 'config.write', { project_id: '101' }), /authorization_changed/);
  assert.throws(() => resolveActor(h.store, creds.token), /login_required/);
  assert.equal(active(h.store, p).filter(g => g.source === 'explicit_delegation').length, 1);
});

test('binding requires both sessions, rejects conflicts, forged proofs, forwarding, expiration, reuse and cross-tenant completion', async t => {
  const f = await identityFixture(t), { h, admin } = f, adminToken = token(admin);
  await admin('/api/identity/tenant', 'POST', { tenant_id: 'github.com:10' });
  const proofs = new Map(), bindings = new ExternalBindings(h.store, async credential => proofs.get(credential) || null);
  const subject = { provider: 'mock-im', host: 'im.test', connector: 'app-a', external_tenant: 'org-a', external_actor: 'alice' };
  const begun = bindings.beginExternalBinding(adminToken, subject), proof = { ...subject, challenge: begun.challenge, proof_id: 'signed-1', expires_at: Date.now() + 60000 };
  proofs.set('signed', proof);
  await assert.rejects(bindings.completeExternalBinding(adminToken, begun.challenge, { ...proof }), /binding_proof_mismatch/);
  const second = session(h.store, (await admin('/api/auth/me')).value.id);
  await assert.rejects(bindings.completeExternalBinding(second.token, begun.challenge, 'signed'), /binding_context_mismatch/);
  await admin('/api/identity/tenant', 'POST', { tenant_id: 'github.com:20' });
  await assert.rejects(bindings.completeExternalBinding(adminToken, begun.challenge, 'signed'), /binding_context_mismatch/);
  await admin('/api/identity/tenant', 'POST', { tenant_id: 'github.com:10' });
  const [result, concurrent] = await Promise.all([bindings.completeExternalBinding(adminToken, begun.challenge, 'signed'), bindings.completeExternalBinding(adminToken, begun.challenge, 'signed')]);
  assert.deepEqual(concurrent, result); assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE provider='mock-im'").n, 1);
  assert.deepEqual(await bindings.completeExternalBinding(adminToken, begun.challenge, 'signed'), result);
  assert.equal(await bindings.resolveExternalPrincipal('signed'), result.principal_id);
  const im = resolvePrincipalActor(h.store, result.principal_id, 'github.com:10', '101', 'im'); authorize(im, 'knowledge.write');
  assert.throws(() => authorize({ ...im }, 'knowledge.write'), /untrusted_actor/);
  bindings.revokeExternalBinding(adminToken, result.identity_id);
  assert.equal(await bindings.resolveExternalPrincipal('signed'), null);
  assert.throws(() => authorize(im, 'knowledge.write'), /authorization_changed/);
  await assert.rejects(bindings.completeExternalBinding(adminToken, begun.challenge, 'signed'), /binding_replayed/);
  const expired = bindings.beginExternalBinding(adminToken, { ...subject, external_actor: 'expired' });
  proofs.set('expired', { ...proof, external_actor: 'expired', challenge: expired.challenge, proof_id: 'signed-2' });
  h.store.run('UPDATE bind_challenges SET expires_at=0 WHERE challenge_hash=?', digest(expired.challenge));
  await assert.rejects(bindings.completeExternalBinding(adminToken, expired.challenge, 'expired'), /binding_expired/);
  await admin('/api/auth/me');
  const other = await admin('/api/users', 'POST', { username: 'other-user', password: testPassword(), organization_ids: ['10'] });
  const otherSession = session(h.store, other.value.user.id); h.store.run('UPDATE sessions SET tenant_id=? WHERE token_hash=?', 'github.com:10', digest(otherSession.token));
  const conflict = bindings.beginExternalBinding(otherSession.token, subject);
  proofs.set('conflict', { ...proof, challenge: conflict.challenge, proof_id: 'signed-3' });
  await assert.rejects(bindings.completeExternalBinding(otherSession.token, conflict.challenge, 'conflict'), /external_identity_conflict/);
});

test('tenant boundaries cover API body, detail, list, logs and async contexts; project service credentials outlive the creator', async t => {
  const f = await identityFixture(t), { h, admin } = f, login = await f.login(), p = login.result.principal_id;
  const credentials = session(h.store, p, login.result.identity_id);
  const request = async (path, method = 'GET', body) => fetch(h.admin + path, { method, headers: { Cookie: 'bot_session=' + credentials.token, 'X-CSRF-Token': credentials.csrf, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/api/repositories/201')).status, 403);
  assert.deepEqual((await (await request('/api/repositories')).json()).repositories.map(r => r.id), ['101']);
  assert.equal((await request('/api/repositories/101/policy', 'PATCH', { enabled: true, project_id: '201' })).status, 403);
  assert.equal((await request('/api/users')).status, 403);
  assert.equal((await request('/api/repositories/101/policy', 'PATCH', { review_enabled: true })).status, 200);
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE user_id=? AND action='policy.updated'", p));
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('tenant-b-task','201','task.request','queued','private')");
  h.store.run("INSERT INTO task_logs(id,task_id,content) VALUES('tenant-b-log','tenant-b-task','private-log')");
  for (const path of ['/api/tasks/tenant-b-task', '/api/tasks/tenant-b-task/logs', '/api/tasks/tenant-b-task/events', '/api/repositories/201/memory']) {
    const result = await request(path); assert.ok([403, 404].includes(result.status), path); assert.ok(!(await result.text()).includes('private-log'));
  }
  const listing = await request('/api/tasks?repository_id=201'); assert.equal(listing.status, 403);
  const adminActor = resolveActor(h.store, token(admin)), service = createProjectServicePrincipal(h.store, adminActor, '101', 'tenant operations');
  h.store.run('UPDATE users SET active=0 WHERE id IN (?,?)', p, adminActor.principal_id);
  const serviceActor = resolveServiceActor(h.store, service); authorize(serviceActor, 'config.write');
  assert.throws(() => authorize(serviceActor, 'config.write', { tenant_id: 'github.com:20', project_id: '201' }), /tenant_forbidden/);
  assert.ok(!JSON.stringify(serviceActor).includes('fixture-user'));
  h.store.run('UPDATE principals SET maintenance=? WHERE id=?', '', service);
  assert.throws(() => resolveServiceActor(h.store, service), /service_paused/);
});

test('identity migration is repeatable, retains live task, role, memory and legacy grants; unknown owners are quarantined', async t => {
  const f = await identityFixture(t), { h, admin } = f;
  const user = (await admin('/api/users', 'POST', { username: 'legacy', password: testPassword(), repository_ids: ['101'], organization_ids: ['10'] })).value.user;
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('existing-task','101','task.request','running','keep')");
  h.store.run("INSERT INTO role_instances(id,task_id,role,definition,harness,updated_at) VALUES('existing-role','existing-task','developer','{}','process','original')");
  h.store.run("INSERT INTO project_memories VALUES('existing-memory','101','original',1,'{}','original')");
  h.store.run("UPDATE repositories SET owner_id='unknown' WHERE id='201'");
  identityStorage(h.store); const first = JSON.stringify(h.store.all('SELECT * FROM scoped_grants ORDER BY id'));
  const migrations = JSON.stringify(h.store.all('SELECT * FROM identity_migrations'));
  identityStorage(h.store); assert.equal(JSON.stringify(h.store.all('SELECT * FROM scoped_grants ORDER BY id')), first);
  assert.equal(JSON.stringify(h.store.all('SELECT * FROM identity_migrations')), migrations);
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id='existing-task'").status, 'running');
  assert.equal(h.store.get("SELECT updated_at FROM role_instances WHERE id='existing-role'").updated_at, 'original');
  assert.equal(h.store.get("SELECT data FROM project_memories WHERE id='existing-memory'").data, '{}');
  assert.equal(h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='201'").tenant_id, null);
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE principal_id=?", user.id).n, 0);
  assert.equal(active(h.store, user.id).length, 2);
});

test('the installation adapter verifies current owner and repo subsets; Setup persists an encrypted session reference', async t => {
  const f = await identityFixture(t), { h } = f, login = await f.login(), p = login.result.principal_id;
  const credentials = session(h.store, p, login.result.identity_id), ref = { github_host: 'github.com', app_id: '123', installation_id: '77' };
  let access = await f.identity.verifyInstallation(credentials.token, ref); assert.equal(access.repository_ids, null); assert.equal(access.can_manage, true);
  f.state.owner = false; f.state.admin = true; await f.identity.reverify(p);
  access = await f.identity.verifyInstallation(credentials.token, ref); assert.deepEqual(access.repository_ids, ['101']);
  const request = await fetch(h.admin + '/api/installations/archive/github.com/123/77/repositories', { headers: { Cookie: 'bot_session=' + credentials.token } });
  assert.equal(request.status, 200); assert.deepEqual((await request.json()).repositories.map(r => r.repository_id), ['101']);
  assert.equal((await fetch(h.admin + '/api/installations/archive/github.com/123/77', { headers: { Cookie: 'bot_session=' + credentials.token } })).status, 403);
  f.state.owner = true; await f.identity.reverify(p);
  h.store.run("UPDATE accounts SET type='github_app',app_id='123' WHERE id=?", f.a.id);
  const setup = new InstallationSetup(h.store, f.identity), begun = setup.begin(f.a.id, '10');
  setup.bindIdentity(begun.state, f.identity.sessionReference(credentials.token));
  assert.equal((await setup.callback(begun.state, '77', 'install')).status, 'ready');
  assert.ok(!h.store.get('SELECT identity_session_ref FROM installation_setup_states WHERE state_hash=?', digest(begun.state)).identity_session_ref.includes(credentials.token));
});

test('an in-flight write cannot commit after revocation, and installation suspension blocks even before event consumption', async t => {
  const f = await identityFixture(t), { h } = f, login = await f.login(), p = login.result.principal_id;
  const credentials = session(h.store, p, login.result.identity_id), actor = resolveActor(h.store, credentials.token);
  let resume; const barrier = new Promise(resolve => { resume = resolve; });
  const write = h.store.withAuthorizationGuard(() => authorize(actor, 'config.write', { project_id: '101' }), async () => {
    await barrier; h.store.transaction(() => h.store.run("UPDATE policies SET review_enabled=1 WHERE repository_id='101'"));
  });
  invalidate(h.store, p, 'test.revoked'); resume(); await assert.rejects(write, /authorization_changed/);
  assert.equal(h.store.get("SELECT review_enabled FROM policies WHERE repository_id='101'").review_enabled, 0);
  const current = resolveActor(h.store, credentials.token); h.store.run("UPDATE github_installations SET status='suspended' WHERE ref='github.com/123/77'");
  assert.throws(() => authorize(current, 'config.write', { project_id: '101' }), /capability_forbidden/);
});


test('incomplete installation evidence, a different App or credential rotation cannot retain derived authority', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  state.repositoryTotal = 2; await f.identity.reverify(p); assert.deepEqual(active(h.store, p), []);
  state.repositoryTotal = 0; await f.identity.reverify(p); assert.ok(active(h.store, p).length > 0);
  state.appId = 999; await f.identity.reverify(p); assert.deepEqual(active(h.store, p), []);
  state.appId = 123; await f.identity.reverify(p); assert.ok(active(h.store, p).length > 0);
  state.suspended = true; await f.identity.reverify(p); assert.deepEqual(active(h.store, p), []);
  state.suspended = false; await f.identity.reverify(p); assert.ok(active(h.store, p).length > 0);
  const original = h.store.get('SELECT credentials FROM accounts WHERE id=?', f.a.id).credentials;
  state.apiGate = async path => {
    if (path === '/installation/token') h.store.run('UPDATE accounts SET credentials=? WHERE id=?', h.store.secrets.seal(h.store.secrets.open(original, `account:${f.a.id}`), `account:${f.a.id}`), f.a.id);
  };
  await f.identity.reverify(p); assert.deepEqual(active(h.store, p), []);
  state.apiGate = undefined;
  state.owner = false; state.admin = true; state.membershipFailure = 404;
  await f.identity.reverify(p); assert.equal(active(h.store, p).some(g => g.project_id === '101'), true);
  assert.equal(active(h.store, p).some(g => g.role === 'org_admin'), false);
});
