import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { identityFixture } from './identity-fixture.mjs';
import { session } from '../dist/app/auth.js';
import { assertCurrent, authorize, resolveActor, listEffectiveScopes, resolveServiceActor, createProjectServicePrincipal, resolvePrincipalActor, invalidate } from '../dist/identity/authorization.js';
import { InstallationSetup } from '../dist/installations/setup.js';
import { emitInstallationEvent } from '../dist/installations/archive.js';
import { identityStorage } from '../dist/identity/storage.js';
import { ExternalBindings, revokeIdentity } from '../dist/identity/bindings.js';
import { digest } from '../dist/core/security.js';
import { repository, testPassword } from './helpers.mjs';

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
  assert.deepEqual(user.access, { projects: [{ id: '101', full_name: 'fixture/project-101', sources: ['github_derived'], can_configure: true }], github_pending: false });
  await f.admin('/api/project-admin-assignments', 'PUT', { user_id: principal, repository_ids: ['101', '201'] });
  user = await access(); assert.deepEqual(user.access.projects.map(p => p.id).sort(), ['101', '201']);
  assert.deepEqual(user.access.projects.find(p => p.id === '101').sources.sort(), ['explicit_delegation', 'github_derived']);
  assert.deepEqual(user.access.projects.find(p => p.id === '201').sources, ['explicit_delegation']);
  h.store.run("UPDATE scoped_grants SET expires_at=0 WHERE principal_id=? AND source='github_derived'", principal);
  user = await access(); assert.equal(user.access.github_pending, true);
  assert.ok(user.access.projects.every(p => p.sources.length === 1 && p.sources[0] === 'explicit_delegation'));
  await f.admin('/api/project-admin-assignments', 'PUT', { user_id: principal, repository_ids: [] });
  assert.deepEqual((await access()).access.projects, []);
  assert.equal((await f.admin('/api/identity/grants', 'POST', { principal_id: principal, tenant_id: 'github.com:20', project_id: '201', capabilities: ['tasks.read'] })).status, 201);
  user = await access(); assert.deepEqual(user.access.projects, [{ id: '201', full_name: 'other/project-201', sources: ['explicit_delegation'], can_configure: false }]);
  await f.identity.reverify(principal); user = await access(); assert.equal(user.access.github_pending, false);
  h.store.run("UPDATE github_installations SET status='suspended' WHERE ref='github.com/123/77'");
  user = await access(); assert.equal(user.access.github_pending, true); assert.deepEqual(user.access.projects.map(p => p.id), ['201']);
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

test('only repository Admin automatically grants management; Write, Maintain, Triage and Read do not', async t => {
  const f = await identityFixture(t); f.state.owner = false;
  const login = await f.login(), principal = login.result.principal_id;
  for (const permission of ['write', 'maintain', 'triage', 'read', 'none', 'admin']) {
    f.state.permission = permission; await f.identity.reverify(principal);
    const user = (await f.admin('/api/users')).value.users.find(user => user.id === principal);
    assert.deepEqual(user.access.projects.map(p => p.id), permission === 'admin' ? ['101'] : [], permission);
  }
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
  assert.throws(() => authorize(actor, 'config.write', { project_id: '101' }), /capability_forbidden/);
  assert.deepEqual(active(h.store, principal), []); // sender/requester are never consulted.
  state.type = 'User'; f.snapshot(); await f.identity.reverify(principal);
  authorize(resolveActor(h.store, creds.token), 'config.write', { project_id: '101' });
  state.id = 43; const other = await f.login(); assert.deepEqual(active(h.store, other.result.principal_id), []);
});

test('permission downgrade blocks only what was lost; explicit delegation remains independent; unknown API evidence fails closed', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const creds = session(h.store, p, login.result.identity_id), actor = resolveActor(h.store, creds.token);
  const username = h.store.get('SELECT username FROM users WHERE id=?', p).username;
  assert.equal((await f.admin('/api/project-admin-assignments', 'PUT', { user_id: p, repository_ids: ['101'] })).status, 200);
  state.owner = false; state.admin = false; await f.identity.reverify(p);
  // The actor predates the downgrade, but the explicit delegation still covers this write (#521); the lost owner grant does not.
  authorize(actor, 'config.write', { project_id: '101' });
  assert.throws(() => authorize(actor, 'config.write', { tenant_id: 'github.com:10' }), /capability_forbidden/);
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
  assert.throws(() => authorize(before, 'config.write', { project_id: '101' }), /login_required/);
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

test('an in-flight console write rechecks what it relied on, and installation suspension blocks even before event consumption', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const credentials = session(h.store, p, login.result.identity_id), review = () => h.store.get("SELECT review_enabled FROM policies WHERE repository_id='101'").review_enabled;
  // Like the server: the request authorizes its project once; each later write only runs the freshness guard.
  const write = async (change, value) => {
    const actor = resolveActor(h.store, credentials.token); authorize(actor, 'config.write', { project_id: '101' });
    let resume; const barrier = new Promise(resolve => { resume = resolve; });
    const pending = h.store.withAuthorizationGuard(() => assertCurrent(actor), async () => {
      await barrier; h.store.transaction(() => h.store.run("UPDATE policies SET review_enabled=? WHERE repository_id='101'", value));
    });
    await change(); resume(); return pending;
  };
  // A revision raised for some other loss does not stop a request whose grants still hold (#521).
  await write(() => invalidate(h.store, p, 'test.unrelated'), 1); assert.equal(review(), 1);
  // Losing the grant it relied on stops the next write with 403, and nothing commits.
  await assert.rejects(write(async () => { state.owner = false; state.admin = false; await f.identity.reverify(p); }, 0), /capability_forbidden/);
  assert.equal(review(), 1);
  state.owner = true; await f.identity.reverify(p);
  // A disabled account and an ended session still end the request.
  await assert.rejects(write(() => h.store.run('UPDATE users SET active=0 WHERE id=?', p), 0), /login_required/);
  h.store.run('UPDATE users SET active=1 WHERE id=?', p);
  await assert.rejects(write(() => h.store.run('UPDATE sessions SET expires_at=0 WHERE token_hash=?', digest(credentials.token)), 0), /login_required/);
  assert.equal(review(), 1);
  const fresh = session(h.store, p, login.result.identity_id), current = resolveActor(h.store, fresh.token);
  h.store.run("UPDATE github_installations SET status='suspended' WHERE ref='github.com/123/77'");
  assert.throws(() => authorize(current, 'config.write', { project_id: '101' }), /capability_forbidden/);
});

test('console writes follow current grants, not the revision a session saw (#521)', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const credentials = session(h.store, p, login.result.identity_id);
  const patch = body => fetch(h.admin + '/api/repositories/101/policy', { method: 'PATCH', body: JSON.stringify(body),
    headers: { Cookie: 'bot_session=' + credentials.token, 'X-CSRF-Token': credentials.csrf, 'Content-Type': 'application/json' } });
  // The session never re-read /api/auth/me after this revision rose; it still holds the project, so the write succeeds.
  invalidate(h.store, p, 'test.unrelated');
  assert.equal((await patch({ review_enabled: true })).status, 200);
  state.owner = false; state.admin = false;
  const denied = await patch({ review_enabled: false });
  assert.equal(denied.status, 403); assert.match((await denied.json()).error, /forbidden/);
  state.owner = true; assert.equal((await patch({ review_enabled: false })).status, 200);
  h.store.run('UPDATE users SET active=0 WHERE id=?', p);
  assert.equal((await patch({ review_enabled: true })).status, 401);
});

test('a deleted installation\'s stale grant and another uncertain installation do not raise the revision on every check (#521)', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const revision = () => h.store.get('SELECT authorization_revision FROM principals WHERE id=?', p).authorization_revision;
  const installation = (ref, id, status, scopePending, revision) => h.store.run(`INSERT INTO github_installations(ref,github_host,app_id,installation_id,account_id,target_id,
    target_type,target_login,repository_selection,status,completeness,revision,scope_pending,updated_at) VALUES(?,'github.com','123',?,?,'10','Organization','fixture','all',?,'complete',?,?,?)`,
    ref, id, f.a.id, status, revision, scopePending, new Date().toISOString());
  // Production v0.3.0: the installation was deleted, and its grant had expired without being revoked.
  installation('github.com/123/88', '88', 'deleted', 0, 5);
  const stale = `github:${p}:github.com/123/88:101`;
  h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,policy,evidence,verified_at,expires_at,installation_ref,installation_revision)
    VALUES(?,?,'github.com:10','101','project','project_admin','["tasks.read"]','github_derived','current_github','repository_admin',1,2,'github.com/123/88',3)`, stale, p);
  // A second installation cannot be settled, which made every check uncertain.
  installation('github.com/123/99', '99', 'active', 1, 1);
  const start = revision();
  for (let i = 0; i < 3; i++) await f.identity.reverify(p);
  assert.equal(revision(), start, 'nothing the principal could use was lost');
  assert.ok(h.store.get('SELECT revoked_at FROM scoped_grants WHERE id=?', stale).revoked_at, 'a confirmed deletion revokes its grants despite the uncertainty');
  assert.ok(active(h.store, p).some(g => g.project_id === '101' && g.expires_at > Date.now()), 'current grants are renewed');
  const identity = h.store.get('SELECT status,verification_issues FROM external_identities WHERE id=?', login.result.identity_id);
  assert.equal(identity.status, 'active');
  assert.deepEqual(JSON.parse(identity.verification_issues), [{ installation: 'github.com/123/99', code: 'installation_scope_pending' }]);
  assert.doesNotMatch(identity.verification_issues, /fixture-|token|secret/);
  // The proved installation turns uncertain too: its grants stop counting once, which is one loss.
  state.membershipFailure = 500;
  for (let i = 0; i < 3; i++) await f.identity.reverify(p);
  assert.equal(revision(), start + 1); assert.deepEqual(active(h.store, p), []);
  assert.ok(h.store.get("SELECT 1 FROM scoped_grants WHERE principal_id=? AND installation_ref='github.com/123/77' AND revoked_at IS NULL", p), 'uncertain grants wait, they are not revoked');
  assert.deepEqual(JSON.parse(h.store.get('SELECT verification_issues FROM external_identities WHERE id=?', login.result.identity_id).verification_issues).map(i => i.code).sort(),
    ['installation_scope_pending', 'membership:github_permission_pending']);
  // Proof comes back: authority returns without raising the revision; a real loss raises it once more.
  state.membershipFailure = 0; await f.identity.reverify(p);
  assert.ok(active(h.store, p).length > 0); assert.equal(revision(), start + 1);
  h.store.run("UPDATE github_installations SET status='deleted' WHERE ref='github.com/123/99'"); await f.identity.reverify(p);
  assert.equal(h.store.get('SELECT verification_issues FROM external_identities WHERE id=?', login.result.identity_id).verification_issues, null);
  state.owner = false; state.admin = false;
  for (let i = 0; i < 2; i++) await f.identity.reverify(p);
  assert.equal(revision(), start + 2);
});

test('only lost authority raises the authorization revision; unchanged or added authority does not (#521)', async t => {
  const f = await identityFixture(t), { h, admin } = f, login = await f.login(), p = login.result.principal_id;
  const revision = () => h.store.get('SELECT authorization_revision FROM principals WHERE id=?', p).authorization_revision;
  let expected = revision();
  const step = async (action, raised) => { await action(); if (raised) expected++; assert.equal(revision(), expected, String(action)); };
  // Adding a manual project, saving the same list again, and an explicit delegation add authority only.
  await step(() => admin('/api/project-admin-assignments', 'PUT', { user_id: p, repository_ids: ['201'] }), false);
  await step(() => admin('/api/project-admin-assignments', 'PUT', { user_id: p, repository_ids: ['201'] }), false);
  const grant = (await admin('/api/identity/grants', 'POST', { principal_id: p, tenant_id: 'github.com:20', project_id: '201', capabilities: ['tasks.read'] })).value.grant_id;
  await step(() => {}, false);
  // Revoking a delegation still covered by the manual project loses nothing; removing the project does.
  await step(() => admin('/api/identity/grants/' + grant, 'DELETE', {}), false);
  await step(() => admin('/api/project-admin-assignments', 'PUT', { user_id: p, repository_ids: [] }), true);
  // Any other path that removes a manual assignment, such as removing the project, raises it too.
  await step(() => admin('/api/project-admin-assignments', 'PUT', { user_id: p, repository_ids: ['201'] }), false);
  await step(() => h.store.run("DELETE FROM project_admin_assignments WHERE repository_id='201'"), true);
  // Repeated proof of unchanged GitHub permissions changes nothing.
  await step(() => f.identity.reverify(p), false);
  // Promotion adds authority; demotion and disabling remove it; enabling again does not count.
  await step(() => h.store.run("UPDATE users SET role='super_admin' WHERE id=?", p), false);
  await step(() => h.store.run("UPDATE users SET role='project_admin' WHERE id=?", p), true);
  await step(() => h.store.run('UPDATE users SET active=0 WHERE id=?', p), true);
  await step(() => h.store.run('UPDATE users SET active=1 WHERE id=?', p), false);
  // An installation change that leaves the derived grant stale is a loss once, however many events it emits.
  const ref = 'github.com/123/77', row = h.store.get('SELECT * FROM github_installations WHERE ref=?', ref);
  h.store.run('UPDATE github_installations SET revision=revision+1 WHERE ref=?', ref);
  for (const type of ['installation.changed', 'installation.access_revoked'])
    emitInstallationEvent(h.store, { ...row, revision: row.revision + 1 }, type, 'test');
  await step(() => resolveActor(h.store, session(h.store, p, login.result.identity_id).token), true);
  await step(() => f.identity.reverify(p), false);
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

  // The same organization as the repository: the count and the list agree again.
  const own = await read('github.com:10');
  assert.equal(own.connection.state, 'connected');
  assert.deepEqual(own.listed, ['101']);
  assert.equal(own.connection.repository_count, 1);
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
    install_url: null,
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
    h.store.run("DELETE FROM identity_projects WHERE project_id='101'");
    h.store.run("DELETE FROM repositories WHERE id='101'");
  });
  const pending = await read(principal, identity);
  assert.equal(pending.state, 'pending_activation');
  assert.equal(pending.status, '已登录 GitHub，有 1 个仓库已安装但还没有被管理员启动');
  assert.match(pending.next_step, /联系管理员/);
  assert.equal(pending.action, 'wait_activation');
  assert.deepEqual(pending.repositories, []);
  assert.equal(pending.repository_count, 0);
  assert.deepEqual(pending.pending_repositories, [{ id: '101', full_name: 'fixture/project-101' }]);

  // A selected tenant must not list another organization's unstarted repositories.
  const tenantSession = session(h.store, principal, identity);
  const readWith = async (tenant) => {
    h.store.run('UPDATE sessions SET tenant_id=? WHERE token_hash=?', tenant, digest(tenantSession.token));
    const response = await fetch(h.admin + '/api/identity', { headers: { Cookie: 'bot_session=' + tenantSession.token } });
    assert.equal(response.status, 200);
    return (await response.json()).github_connection;
  };
  assert.deepEqual((await readWith('github.com:10')).pending_repositories, [{ id: '101', full_name: 'fixture/project-101' }]);
  const otherTenant = await readWith('github.com:20');
  assert.deepEqual(otherTenant.pending_repositories, []);
  assert.notEqual(otherTenant.state, 'pending_activation');
  h.store.run('UPDATE sessions SET tenant_id=NULL WHERE token_hash=?', digest(tenantSession.token));


  // Write/Maintain/Triage/Read never become management: the person is signed in, with no authorized repositories.
  // Restore a started project so membership checks have a target, then drop Admin.
  await repository(f.admin, f.a.id, '101');
  f.state.owner = false; f.state.permission = 'write'; await f.identity.reverify(principal);
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

test('login and reverify renew an expired GitHub-derived grant', async t => {
  const f = await identityFixture(t), { h } = f, login = await f.login(), p = login.result.principal_id;
  const grant = () => h.store.get("SELECT verified_at,expires_at FROM scoped_grants WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", p);
  const first = grant(); assert.ok(first); assert.ok(first.expires_at > Date.now() + 4 * 60_000);
  h.store.run("UPDATE scoped_grants SET verified_at=1,expires_at=1 WHERE principal_id=? AND source='github_derived'", p);
  assert.ok(listEffectiveScopes(h.store, p).some(g => g.source === 'github_derived' && g.state === 'pending_verification'));
  await f.identity.reverify(p);
  const renewed = grant();
  assert.ok(renewed.expires_at > Date.now() + 4 * 60_000);
  assert.ok(renewed.verified_at > Date.now() - 15_000);
  assert.ok(listEffectiveScopes(h.store, p).some(g => g.source === 'github_derived' && g.state === 'active'));
  h.store.run("UPDATE scoped_grants SET verified_at=1,expires_at=1 WHERE principal_id=? AND source='github_derived'", p);
  await f.login();
  const afterLogin = grant();
  assert.ok(afterLogin.expires_at > Date.now() + 4 * 60_000);
  assert.ok(afterLogin.verified_at > Date.now() - 15_000);
  assert.ok(listEffectiveScopes(h.store, p).some(g => g.source === 'github_derived' && g.state === 'active'));
});

test('a login that overlaps an in-flight permission check still renews derived grants', async t => {
  const f = await identityFixture(t), { h, state } = f, first = await f.login(), p = first.result.principal_id;
  h.store.run("UPDATE scoped_grants SET verified_at=1,expires_at=1 WHERE principal_id=? AND source='github_derived'", p);
  let release, blocked = 0;
  const held = new Promise(resolve => { release = resolve; });
  state.apiGate = async path => { if (path === '/user' && blocked++ === 0) await held; };
  // Start refresh() itself (not reverify(), whose own /user probe runs before refresh()), so the
  // blocked /user call below belongs to a permission check that is registered as in flight.
  const inflight = f.identity.refresh(p);
  const started = Date.now();
  while (!blocked) {
    if (Date.now() - started > 5000) throw new Error('permission check did not reach GitHub');
    await new Promise(r => setTimeout(r, 10));
  }
  // The in-flight check captured the previous revision. A login that arrives now must not just join it:
  // bump the revision while the check is still blocked, so that check ends without renewing grants.
  const loginDone = f.login();
  await new Promise(r => setTimeout(r, 200));
  invalidate(h.store, p, 'manual_change');
  release();
  await loginDone;
  await inflight;
  const after = h.store.get("SELECT verified_at,expires_at FROM scoped_grants WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", p);
  assert.ok(after.expires_at > Date.now() + 4 * 60_000, `expires_at=${after?.expires_at}`);
  assert.ok(after.verified_at > Date.now() - 15_000);
  assert.ok(listEffectiveScopes(h.store, p).some(g => g.source === 'github_derived' && g.state === 'active'));
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
  f.state.owner = false; f.state.admin = false; f.state.permission = 'write';
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
