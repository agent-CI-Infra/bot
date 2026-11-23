import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { identityFixture } from '../../../fixtures/identity-fixture.mjs';
import { session } from '../../../../dist/app/auth.js';
import { authorize, resolveActor, listEffectiveScopes, resolveServiceActor, createProjectServicePrincipal, resolvePrincipalActor } from '../../../../dist/identity/authorization.js';
import { InstallationSetup } from '../../../../dist/installations/setup.js';
import { identityStorage } from '../../../../dist/identity/storage.js';
import { ExternalBindings, revokeIdentity } from '../../../../dist/identity/bindings.js';
import { digest } from '../../../../dist/core/security.js';
import { repository, testPassword } from '../../../fixtures/helpers.mjs';

const token = client => client.cookie().slice('bot_session='.length);
const active = (s, p) => listEffectiveScopes(s, p).filter(g => g.state === 'active');

test('OAuth uses S256, browser-bound single-use state and stable numeric identity; local names never merge', async t => {
  const f = await identityFixture(t), { h, identity } = f;
  const begun = identity.begin('browser-a', 'login'), url = new URL(begun.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('code_challenge').length, 43);
  assert.equal(url.searchParams.get('scope'), '');
  await assert.rejects(identity.callback('browser-b', url.searchParams.get('state'), 'code'), /invalid_oauth_state/);
  const authorized = await fetch(begun.url, { redirect: 'manual' }), callback = new URL(authorized.headers.get('location'));
  const result = await identity.callback('browser-a', callback.searchParams.get('state'), callback.searchParams.get('code')); await result.verification;
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

test('global user access matches authorized project lists, including inherited, manual, expired and read-only grants', async t => {
  const f = await identityFixture(t), { h } = f, login = await f.login(), principal = login.result.principal_id;
  // An enabled project in the same organization is outside this installation's current proof.
  await repository(f.admin, f.a.id, '102');
  const credentials = session(h.store, principal, login.result.identity_id);
  const access = async () => {
    const user = (await f.admin('/api/users')).value.users.find(user => user.id === principal);
    const response = await fetch(h.admin + '/api/repositories', { headers: { Cookie: 'bot_session=' + credentials.token } });
    assert.equal(response.status, 200);
    assert.deepEqual(user.access.projects.map(p => p.id).sort(), (await response.json()).repositories.map(p => p.id).sort());
    return user;
  };
  let user = await access(); assert.equal(user.github_login, 'administrator');
  assert.deepEqual(user.access, { projects: [{ id: '101', full_name: 'fixture/project-101', sources: ['github_derived'], can_configure: true, can_write: true }], github_pending: false });
  await f.admin('/api/project-admin-assignments', 'PUT', { user_id: principal, repository_ids: ['101', '201'] });
  user = await access(); assert.deepEqual(user.access.projects.map(p => p.id).sort(), ['101', '201']);
  assert.deepEqual(user.access.projects.find(p => p.id === '101').sources.sort(), ['explicit_delegation', 'github_derived']);
  assert.deepEqual(user.access.projects.find(p => p.id === '201').sources, ['explicit_delegation']);
  h.store.run("UPDATE scoped_grants SET expires_at=0 WHERE principal_id=? AND source='github_derived'", principal);
  user = await access(); assert.equal(user.access.github_pending, true);
  assert.ok(user.access.projects.every(p => p.sources.length === 1 && p.sources[0] === 'explicit_delegation'));
  await f.admin('/api/project-admin-assignments', 'PUT', { user_id: principal, repository_ids: [] });
  assert.deepEqual((await access()).access.projects, []);
  await f.identity.reverify(principal); user = await access(); assert.equal(user.access.github_pending, false);
  h.store.run("UPDATE github_installations SET status='suspended' WHERE ref='github.com/123/77'");
  user = await access(); assert.equal(user.access.github_pending, true); assert.deepEqual(user.access.projects, []);
  h.store.run("UPDATE github_installations SET status='active' WHERE ref='github.com/123/77'");
  // Explicit delegation ends GitHub verification (#708): the next check sends nothing to GitHub and drops the derived grant.
  assert.equal((await f.admin('/api/identity/grants', 'POST', { principal_id: principal, tenant_id: 'github.com:20', project_id: '201', capabilities: ['tasks.read'] })).status, 201);
  const sent = f.state.requests.length;
  await f.identity.reverify(principal); assert.equal(f.state.requests.length, sent);
  user = await access();
  assert.deepEqual(user.access, { projects: [{ id: '201', full_name: 'other/project-201', sources: ['explicit_delegation'], can_configure: false, can_write: false }], github_pending: false });
  await f.admin('/api/users/' + principal, 'PATCH', { active: false });
  user = (await f.admin('/api/users')).value.users.find(user => user.id === principal);
  assert.deepEqual(user.access.projects, []); assert.equal(user.access.github_pending, false);
});

test('project members expose only applicable grants and require current project configuration authority', async t => {
  const f = await identityFixture(t), login = await f.login(), principal = login.result.principal_id;
  await repository(f.admin, f.a.id, '102');
  const credentials = session(f.h.store, principal, login.result.identity_id);
  const read = path => fetch(f.h.admin + path, { headers: { Cookie: 'bot_session=' + credentials.token } });
  const own = await read('/api/repositories/101/members'); assert.equal(own.status, 200);
  const data = await own.json(); assert.equal(data.can_manage_legacy, false);
  assert.ok(data.grants.some(g => g.principal_id === principal && g.source === 'github_derived' && g.state === 'active'));
  assert.ok(data.grants.every(g => !('evidence' in g) && !('installation_ref' in g) && !('credentials' in g)));
  assert.equal((await read('/api/repositories/201/members')).status, 403);
  assert.equal((await read('/api/project-admin-assignments')).status, 403);
  assert.equal((await f.admin('/api/repositories/101/members')).value.can_manage_legacy, true);
  // An owner-wide derived grant must not appear for a same-tenant project outside its installation.
  assert.ok(!(await f.admin('/api/repositories/102/members')).value.grants.some(g => g.principal_id === principal));
  const manual = await f.admin('/api/identity/grants', 'POST', { principal_id: principal, tenant_id: 'github.com:20', project_id: '201', capabilities: ['tasks.read'] });
  assert.equal(manual.status, 201);
  const view = await read('/api/repositories/201'); assert.equal(view.status, 200); assert.equal((await view.json()).can_configure, false);
  assert.equal((await read('/api/repositories/201/members')).status, 403);
  f.h.store.run("UPDATE github_installations SET status='suspended'");
  assert.equal((await read('/api/repositories/101/members')).status, 403);
  const historical = (await f.admin('/api/repositories/101/members')).value.grants.find(g => g.principal_id === principal);
  assert.equal(historical.state, 'pending_verification');
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
  h.store.db.exec('CREATE TABLE IF NOT EXISTS project_memories(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,fact_key TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL)');
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

test('a pending grant names the condition it waits on; states outside the three names keep no reason', async t => {
  const f = await identityFixture(t), { h } = f, login = await f.login(), p = login.result.principal_id;
  const credential = session(h.store, p, login.result.identity_id);
  // The response the console reads, not the internal list: this is what has to stay backward compatible.
  const scopes = async () => {
    const response = await fetch(h.admin + '/api/identity', { headers: { Cookie: 'bot_session=' + credential.token } });
    assert.equal(response.status, 200);
    return (await response.json()).scopes.filter(g => g.source === 'github_derived');
  };
  const grant = h.store.get("SELECT * FROM scoped_grants WHERE principal_id=? AND source='github_derived'", p);
  assert.ok(grant, 'the login above derives a GitHub grant');
  const installation = () => h.store.get('SELECT * FROM github_installations WHERE ref=?', grant.installation_ref);
  const before = installation();
  assert.equal((await scopes())[0].reason, undefined); // an active grant names nothing

  // 1) installation_pending: verified against an installation revision that has moved since.
  h.store.run('UPDATE github_installations SET revision=revision+1 WHERE ref=?', grant.installation_ref);
  let [scope] = await scopes();
  assert.equal(scope.state, 'pending_verification'); assert.equal(scope.reason, 'installation_pending');
  h.store.run("UPDATE external_identities SET status='pending_verification' WHERE id=?", login.result.identity_id);
  [scope] = await scopes();
  assert.equal(scope.state, 'pending_verification'); assert.equal(scope.reason, undefined);
  h.store.run("UPDATE external_identities SET status='active' WHERE id=?", login.result.identity_id);
  h.store.run('UPDATE github_installations SET revision=? WHERE ref=?', before.revision, grant.installation_ref);

  // 2) permission_pending: same installation, but its scope is unconfirmed or the installation is not active.
  h.store.run('UPDATE github_installations SET scope_pending=1 WHERE ref=?', grant.installation_ref);
  [scope] = await scopes();
  assert.equal(scope.state, 'pending_verification'); assert.equal(scope.reason, 'permission_pending');
  h.store.run("UPDATE github_installations SET scope_pending=0, status='suspended' WHERE ref=?", grant.installation_ref);
  [scope] = await scopes();
  assert.equal(scope.reason, 'permission_pending');
  h.store.run('UPDATE github_installations SET status=? WHERE ref=?', before.status, grant.installation_ref);
  assert.equal((await scopes())[0].reason, undefined); // restored: usable again, no reason

  // 3) tenant_missing: the grant's tenant is gone, which is the quarantined state.
  const tenant = grant.tenant_id;
  h.store.run("UPDATE scoped_grants SET tenant_id='missing-tenant' WHERE id=?", grant.id);
  [scope] = await scopes();
  assert.equal(scope.state, 'quarantined'); assert.equal(scope.reason, 'tenant_missing');
  h.store.run('UPDATE scoped_grants SET tenant_id=? WHERE id=?', tenant, grant.id);

  // Outside the three names: an expired grant, and a missing GitHub proof, keep the combined state and no reason.
  h.store.run('UPDATE scoped_grants SET expires_at=1 WHERE id=?', grant.id);
  [scope] = await scopes();
  assert.equal(scope.state, 'pending_verification'); assert.equal('reason' in scope, false);
  h.store.run('UPDATE scoped_grants SET expires_at=NULL WHERE id=?', grant.id);
  h.store.run("UPDATE external_identities SET status='pending_verification' WHERE id=?", login.result.identity_id);
  [scope] = await scopes();
  assert.equal(scope.state, 'pending_verification'); assert.equal(scope.reason, undefined);
  h.store.run("UPDATE external_identities SET status='active' WHERE id=?", login.result.identity_id);
  assert.equal((await scopes())[0].state, 'active');
});

test('GET /api/identity counts only the repositories the project list of this session shows', async t => {
  const f = await identityFixture(t), { h } = f;
  const login = await f.login(), principal = login.result.principal_id, identity = login.result.identity_id;
  const read = async tenant => {
    const credential = session(h.store, principal, identity);
    h.store.run('UPDATE sessions SET tenant_id=? WHERE token_hash=?', tenant, digest(credential.token));
    const headers = { Cookie: 'bot_session=' + credential.token };
    const body = await (await fetch(h.admin + '/api/identity', { headers })).json();
    const listed = (await (await fetch(h.admin + '/api/repositories', { headers })).json()).repositories.map(r => r.id);
    return { connection: body.github_connection, listed };
  };
  const all = await read(null);
  assert.equal(all.connection.state, 'connected');
  assert.deepEqual(all.listed, ['101']);
  assert.equal(all.connection.repository_count, all.listed.length);

  // The session is limited to an organization the repository is not in: the project list is empty, so the identity
  // page must not say "可访问 1 个仓库，可在项目列表中打开", and it names the way out instead.
  h.store.run("INSERT OR IGNORE INTO tenants(id,github_host,github_account_id,display_name) VALUES('github.com:30','github.com','30','elsewhere')");
  const elsewhere = await read('github.com:30');
  assert.deepEqual(elsewhere.listed, []);
  assert.equal(elsewhere.connection.state, 'outside_tenant');
  assert.equal(elsewhere.connection.action, 'switch_tenant');
  assert.equal(elsewhere.connection.repository_count, 0);
  assert.deepEqual(elsewhere.connection.repositories, []);
  assert.equal(elsewhere.connection.status, '已连接 GitHub，但当前组织下没有你能打开的项目');
  assert.match(elsewhere.connection.next_step, /1 个仓库不在当前组织「elsewhere」里/);
  assert.match(elsewhere.connection.next_step, /所有已授权组织与项目/);
  assert.doesNotMatch(elsewhere.connection.next_step, /可在项目列表中打开这些仓库/);
  // The console translates by state code, so the count and the organization name travel as fields too.
  assert.equal(elsewhere.connection.hidden_repository_count, 1);
  assert.equal(elsewhere.connection.tenant_name, 'elsewhere');

  // The same organization as the repository: the count and the list agree again.
  const own = await read('github.com:10');
  assert.equal(own.connection.state, 'connected');
  assert.deepEqual(own.listed, ['101']);
  assert.equal(own.connection.repository_count, 1);
  assert.equal(own.connection.hidden_repository_count, 0);
  assert.equal(own.connection.tenant_name, null);
});

test('GET /api/identity names a plain GitHub connection state, the next step, and repository names', async t => {
  const f = await identityFixture(t), { h } = f;
  const read = async (principal, identityId) => {
    const credential = session(h.store, principal, identityId);
    const response = await fetch(h.admin + '/api/identity', { headers: { Cookie: 'bot_session=' + credential.token } });
    assert.equal(response.status, 200);
    const body = await response.json();
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /fixture-user|fixture-refresh|credentials|access_token|private_key/);
    assert.equal('github_connection' in body, true);
    return body.github_connection;
  };

  // A local recovery account has no GitHub binding; started repositories it administers are still listed.
  const local = await read((await f.admin('/api/auth/me')).value.id, null);
  assert.equal(local.state, 'disconnected');
  assert.equal(local.status, '尚未连接 GitHub');
  assert.match(local.next_step, /连接 GitHub/);
  assert.equal(local.action, 'connect');
  assert.deepEqual(local.repositories.map(r => r.id).sort(), ['101', '201']);
  assert.equal(local.repository_count, 2);
  assert.deepEqual(local.pending_repositories, []);

  const login = await f.login(), principal = login.result.principal_id, identity = login.result.identity_id;
  const connected = await read(principal, identity);
  assert.deepEqual(connected, {
    state: 'connected', status: '已连接 GitHub，可访问 1 个仓库', next_step: '可在项目列表中打开这些仓库。', action: null,
    repository_count: 1, repositories: [{ id: '101', full_name: 'fixture/project-101' }], pending_repositories: [],
    install_url: null, hidden_repository_count: 0, tenant_name: null,
  });

  // A pending GitHub proof drops derived grants, so the person cannot see those repositories until they re-verify.
  h.store.run("UPDATE external_identities SET status='pending_verification' WHERE id=?", identity);
  const pendingProof = await read(principal, identity);
  assert.equal(pendingProof.state, 'pending_verification');
  assert.equal(pendingProof.action, 'reverify');
  assert.deepEqual(pendingProof.repositories, []);
  // An independent explicit grant still lets them into that project while GitHub is pending.
  assert.equal((await f.admin('/api/identity/grants', 'POST', { principal_id: principal, tenant_id: 'github.com:20', project_id: '201', capabilities: ['tasks.read'] })).status, 201);
  const delegated = await read(principal, identity);
  assert.equal(delegated.state, 'connected');
  assert.deepEqual(delegated.repositories, [{ id: '201', full_name: 'other/project-201' }]);
  h.store.run("UPDATE external_identities SET status='active' WHERE id=?", identity);
  h.store.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id=? AND source='explicit_delegation'", Date.now(), principal);

  // Installed and administered, but not started: the name is visible, the project list stays empty.
  h.store.transaction(() => {
    h.store.run("DELETE FROM policies WHERE repository_id='101'");
    // A started project has Actions failure handling on (#851).
    h.store.run("DELETE FROM actions_failure_scans WHERE repository_id='101'");
    h.store.run("DELETE FROM identity_projects WHERE project_id='101'");
    h.store.run("DELETE FROM repositories WHERE id='101'");
  });
  const pending = await read(principal, identity);
  assert.equal(pending.state, 'pending_activation');
  assert.equal(pending.status, '已登录 GitHub，有 1 个仓库已安装但还没有被超级管理员启动');
  assert.match(pending.next_step, /联系超级管理员/);
  assert.equal(pending.action, 'wait_activation');
  assert.deepEqual(pending.repositories, []);
  assert.equal(pending.repository_count, 0);
  assert.deepEqual(pending.pending_repositories, [{ id: '101', full_name: 'fixture/project-101', self_start: false }]);

  // A selected tenant must not list another organization's unstarted repositories.
  const tenantSession = session(h.store, principal, identity);
  const readWith = async (tenant) => {
    h.store.run('UPDATE sessions SET tenant_id=? WHERE token_hash=?', tenant, digest(tenantSession.token));
    const response = await fetch(h.admin + '/api/identity', { headers: { Cookie: 'bot_session=' + tenantSession.token } });
    assert.equal(response.status, 200);
    return (await response.json()).github_connection;
  };
  assert.deepEqual((await readWith('github.com:10')).pending_repositories, [{ id: '101', full_name: 'fixture/project-101', self_start: false }]);
  const otherTenant = await readWith('github.com:20');
  assert.deepEqual(otherTenant.pending_repositories, []);
  assert.notEqual(otherTenant.state, 'pending_activation');
  h.store.run('UPDATE sessions SET tenant_id=NULL WHERE token_hash=?', digest(tenantSession.token));


  // Without any permission on the repository the person is signed in, with no authorized repositories. (Write, Maintain,
  // Triage and Read give access since #847.) Restore a started project so membership checks have a target, then drop Admin.
  await repository(f.admin, f.a.id, '101');
  f.state.owner = false; f.state.permission = 'none'; await f.identity.reverify(principal);
  const member = await read(principal, identity);
  assert.equal(member.state, 'no_repositories');
  assert.equal(member.status, '已登录 GitHub，但还没有授权任何仓库');
  assert.match(member.next_step, /选择要授权的仓库/);
  assert.equal(member.action, 'choose_repos');
  assert.deepEqual(member.repositories, []);
  assert.deepEqual(member.pending_repositories, []);

  // Expired derived grants, with no other access, ask the person to re-verify — not that they have no repositories.
  f.state.owner = true; f.state.permission = undefined; await f.identity.reverify(principal);
  h.store.run("UPDATE scoped_grants SET expires_at=1 WHERE principal_id=? AND source='github_derived'", principal);
  h.store.run("DELETE FROM scoped_grants WHERE principal_id=? AND source='explicit_delegation'", principal);
  const expired = await read(principal, identity);
  assert.equal(expired.state, 'pending_verification');
  assert.equal(expired.status, 'GitHub 授权待验证');
  assert.equal(expired.action, 'reverify');
  assert.deepEqual(expired.repositories, []);

  h.store.run("UPDATE external_identities SET credentials=NULL WHERE id=?", identity);
  const expiredAuth = await read(principal, identity);
  assert.equal(expiredAuth.state, 'reauthorization_required');
  assert.equal(expiredAuth.status, 'GitHub 授权已失效');
  assert.equal(expiredAuth.action, 'reconnect');
  assert.match(expiredAuth.next_step, /重新连接/);
});

test('a signed-in user with no repositories gets a public GitHub App install URL; onboarding stays super-admin only', async t => {
  const f = await identityFixture(t), { h } = f;
  const saved = {
    account_id: f.a.id, app_id: '123', slug: 'fixture-app',
    settings_url: 'https://github.com/settings/apps/fixture-app',
    webhook_url: 'https://hooks.invalid/secret-webhook',
    install_url: 'https://github.com/apps/fixture-app/installations/new?next=https://evil.example',
  };
  h.store.run("INSERT INTO settings VALUES('onboarding.app',?)", JSON.stringify(saved));
  f.state.owner = false; f.state.admin = false; f.state.permission = 'none';
  const login = await f.login(), principal = login.result.principal_id;
  const credential = session(h.store, principal, login.result.identity_id);
  const headers = { Cookie: 'bot_session=' + credential.token };
  const body = await (await fetch(h.admin + '/api/identity', { headers })).json();
  const text = JSON.stringify(body);
  assert.equal(body.github_connection.state, 'no_repositories');
  assert.equal(body.github_connection.action, 'choose_repos');
  assert.equal(body.github_connection.install_url, 'https://github.com/apps/fixture-app/installations/select_target');
  assert.doesNotMatch(text, /settings\/apps|hooks\.invalid|secret-webhook|evil\.example/);
  assert.equal('account_id' in body.github_connection, false);
  assert.equal('settings_url' in body.github_connection, false);
  assert.equal('webhook_url' in body.github_connection, false);
  assert.equal((await fetch(h.admin + '/api/onboarding', { headers })).status, 403);
  assert.equal((await f.admin('/api/onboarding')).status, 200);

  h.store.run("UPDATE settings SET value=? WHERE key='onboarding.app'", JSON.stringify({ slug: 'from-slug', settings_url: 'https://evil.example/settings' }));
  assert.equal((await (await fetch(h.admin + '/api/identity', { headers })).json()).github_connection.install_url,
    'https://github.com/apps/from-slug/installations/select_target');
  h.store.run("UPDATE settings SET value=? WHERE key='onboarding.app'", JSON.stringify({
    slug: '../not-a-slug', install_url: 'https://evil.example/apps/fixture-app/installations/new' }));
  assert.equal((await (await fetch(h.admin + '/api/identity', { headers })).json()).github_connection.install_url, null);

  h.store.run("UPDATE settings SET value=? WHERE key='onboarding.app'", JSON.stringify({
    install_url: 'https://github.com/apps/fixture-app/installations/select_target' }));
  assert.equal((await (await fetch(h.admin + '/api/identity', { headers })).json()).github_connection.install_url,
    'https://github.com/apps/fixture-app/installations/select_target');
});

test('the identity-page install link mints a setup state that returns to the console', async t => {
  const f = await identityFixture(t), { h } = f;
  h.store.run("INSERT INTO settings VALUES('onboarding.app',?)", JSON.stringify({
    account_id: f.a.id, app_id: '123', slug: 'fixture-app',
    install_url: 'https://github.com/apps/fixture-app/installations/select_target',
  }));
  f.state.owner = false; f.state.admin = false; f.state.permission = 'write';
  const login = await f.login(), principal = login.result.principal_id;
  const credential = session(h.store, principal, login.result.identity_id);
  const headers = { Cookie: 'bot_session=' + credential.token, 'X-CSRF-Token': credential.csrf, 'Content-Type': 'application/json' };
  const minted = await fetch(h.admin + '/api/identity/github/install', { method: 'POST', headers, body: '{}' });
  assert.equal(minted.status, 201);
  const body = await minted.json();
  const install = new URL(body.url);
  assert.equal(install.origin + install.pathname, 'https://github.com/apps/fixture-app/installations/select_target');
  assert.match(install.searchParams.get('state'), /^[a-f0-9]{48}$/);
  const setup = await fetch(h.admin + '/onboarding/github/setup?state=' + install.searchParams.get('state') + '&installation_id=77&setup_action=install', { redirect: 'manual', headers: { Cookie: 'bot_session=' + credential.token } });
  assert.equal(setup.status, 303);
  assert.match(setup.headers.get('location'), /[?&]github_setup=/);
  const missing = await fetch(h.admin + '/onboarding/github/setup?installation_id=77', { redirect: 'manual' });
  assert.equal(missing.status, 400);
});
