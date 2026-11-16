import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from './identity-fixture.mjs';
import { session } from '../dist/app/auth.js';
import { assertCurrent, authorize, resolveActor, listEffectiveScopes, invalidate } from '../dist/identity/authorization.js';
import { emitInstallationEvent } from '../dist/installations/archive.js';
import { revokeIdentity } from '../dist/identity/bindings.js';
import { digest } from '../dist/core/security.js';

const active = (s, p) => listEffectiveScopes(s, p).filter(g => g.state === 'active');

// What Write, Maintain, Triage and Read collaborators get is in project-delegation.test.mjs (#847).
test('current GitHub owner, selected repositories, repo admin and ordinary members follow installation scope', async t => {
  const f = await identityFixture(t), { h, state } = f, first = await f.login(), principal = first.result.principal_id;
  const creds = session(h.store, principal, first.result.identity_id);
  let actor = resolveActor(h.store, creds.token); authorize(actor, 'config.write', { project_id: '101' });
  assert.equal(active(h.store, principal).some(g => g.role === 'org_admin'), true);
  assert.throws(() => authorize(actor, 'config.write', { project_id: '201' }), /forbidden/);
  assert.throws(() => authorize(actor, 'platform.manage'), /forbidden/);
  state.selection = 'selected'; f.snapshot(); await f.identity.reverify(principal);
  actor = resolveActor(h.store, creds.token); assert.equal(active(h.store, principal).some(g => g.role === 'org_admin'), false);
  authorize(actor, 'roles.edit', { project_id: '101' });
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

test('unknown API evidence fails closed; explicit delegation ends GitHub verification and keeps only what it covers', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const creds = session(h.store, p, login.result.identity_id);
  const username = h.store.get('SELECT username FROM users WHERE id=?', p).username;
  state.failure = 403; await f.identity.reverify(p);
  assert.equal(h.store.get('SELECT status FROM external_identities WHERE id=?', login.result.identity_id).status, 'pending_verification');
  assert.ok(listEffectiveScopes(h.store, p).some(g => g.source === 'github_derived' && g.state === 'pending_verification'));
  assert.throws(() => authorize(resolveActor(h.store, creds.token), 'config.write', { project_id: '101' }), /capability_forbidden/);
  state.failure = 0; h.store.run('UPDATE external_identities SET expires_at=0 WHERE id=?', login.result.identity_id); await f.identity.reverify(p);
  assert.equal(state.refreshed, 1);
  const actor = resolveActor(h.store, creds.token); authorize(resolveActor(h.store, creds.token), 'config.write', { tenant_id: 'github.com:10' });
  // A manual project is explicit delegation (#708): GitHub is no longer asked, and the derived grants go at the next check.
  assert.equal((await f.admin('/api/project-admin-assignments', 'PUT', { user_id: p, repository_ids: ['101'] })).status, 200);
  const sent = state.requests.length;
  state.owner = false; state.admin = false; await f.identity.reverify(p);
  assert.equal(state.requests.length, sent);
  // The actor predates the change, but the explicit delegation still covers this write (#521); the dropped owner grant does not.
  authorize(actor, 'config.write', { project_id: '101' });
  assert.throws(() => authorize(actor, 'config.write', { tenant_id: 'github.com:10' }), /capability_forbidden/);
  const current = resolveActor(h.store, creds.token); authorize(current, 'release.manage', { project_id: '101' });
  assert.equal(active(h.store, p).filter(g => g.source === 'explicit_delegation').length, 1);
  assert.equal(listEffectiveScopes(h.store, p).filter(g => g.source === 'github_derived' && g.state !== 'revoked').length, 0);
  assert.throws(() => authorize(current, 'grants.manage', { project_id: '101' }), /forbidden/);
  assert.equal(h.store.get('SELECT username FROM users WHERE id=?', p).username, username);
  const before = resolveActor(h.store, creds.token);
  h.store.transaction(() => revokeIdentity(h.store, p, login.result.identity_id));
  assert.throws(() => authorize(before, 'config.write', { project_id: '101' }), /login_required/);
  assert.throws(() => resolveActor(h.store, creds.token), /login_required/);
  assert.equal(active(h.store, p).filter(g => g.source === 'explicit_delegation').length, 1);
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
  // A change on GitHub reaches writes through the next check, not through the write itself (#708).
  state.owner = false; state.admin = false;
  assert.equal((await patch({ review_enabled: false })).status, 200);
  await f.identity.reverify(p);
  const denied = await patch({ review_enabled: true });
  assert.equal(denied.status, 403); assert.match((await denied.json()).error, /forbidden/);
  state.owner = true; await f.identity.reverify(p); assert.equal((await patch({ review_enabled: false })).status, 200);
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
