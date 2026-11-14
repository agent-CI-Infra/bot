// GitHub permissions are checked at sign-in and by the background refresh, never by a write whose grants are still valid (#708).
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from './identity-fixture.mjs';
import { testPassword } from './helpers.mjs';
import { session } from '../dist/app/auth.js';
import { listEffectiveScopes } from '../dist/identity/authorization.js';
import { GitHubRefresh } from '../dist/identity/github-refresh.js';

// Requests the fake GitHub received: the user's own /user reads, and the permission reads made with installation tokens.
const userReads = (f, id = 42) => f.state.requests.filter(r => r.path === '/user' && r.authorization === 'Bearer fixture-user-' + id).length;
const installationReads = f => f.state.requests.filter(r => r.path.startsWith('/app/installations/') || r.path.startsWith('/installation/')).length;
const derived = (h, p) => h.store.all("SELECT id,verified_at,expires_at FROM scoped_grants WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL ORDER BY id", p);
const usable = (h, p) => listEffectiveScopes(h.store, p).filter(g => g.source === 'github_derived' && g.state === 'active');
const identity = (h, p) => h.store.get("SELECT status,verified_at,verification_issues FROM external_identities WHERE principal_id=? AND provider='github'", p);
// A write the console sends: the project's review switch, authorized by the project's config.write.
const write = (f, credentials, path = '/api/repositories/101/policy', method = 'PATCH', body = { review_enabled: true }) => fetch(f.h.admin + path, {
  method, body: JSON.stringify(body), headers: { Cookie: 'bot_session=' + credentials.token, 'X-CSRF-Token': credentials.csrf, 'Content-Type': 'application/json' } });
// No check succeeded for 31 minutes: the stored proof and the grants it gave have lapsed.
const lapse = (h, p) => {
  h.store.run("UPDATE external_identities SET verified_at=? WHERE principal_id=? AND provider='github'", Date.now() - 31 * 60_000, p);
  h.store.run("UPDATE scoped_grants SET expires_at=? WHERE principal_id=? AND source='github_derived'", Date.now() - 60_000, p);
};

test('sign-in proves derived grants for 30 minutes, and writes inside that time send nothing to GitHub', async t => {
  const f = await identityFixture(t), { h } = f, before = installationReads(f), login = await f.login(), p = login.result.principal_id;
  assert.ok(installationReads(f) > before, 'GitHub login checks the permissions');
  const grants = derived(h, p); assert.ok(grants.length);
  for (const grant of grants) assert.equal(grant.expires_at - grant.verified_at, 30 * 60_000);
  const credentials = session(h.store, p, login.result.identity_id), sent = f.state.requests.length;
  for (const enabled of [true, false, true]) assert.equal((await write(f, credentials, undefined, undefined, { review_enabled: enabled })).status, 200);
  assert.equal(f.state.requests.length, sent);
});

test('password sign-in of a local account bound to GitHub checks it again', async t => {
  const f = await identityFixture(t), { h, admin } = f, password = testPassword();
  const user = (await admin('/api/users', 'POST', { username: 'bound-local', password })).value.user;
  const local = h.client(); assert.equal((await local('/api/auth/login', 'POST', { username: 'bound-local', password })).status, 200);
  assert.equal((await f.login('bind', local.cookie().slice('bot_session='.length))).result.principal_id, user.id);
  lapse(h, user.id); assert.deepEqual(usable(h, user.id), []);
  const reads = installationReads(f), again = h.client();
  assert.equal((await again('/api/auth/login', 'POST', { username: 'bound-local', password })).status, 200);
  assert.ok(installationReads(f) > reads);
  assert.ok(identity(h, user.id).verified_at > Date.now() - 60_000);
  assert.ok(usable(h, user.id).length > 0);
});

test('a write whose proof lapsed checks once, concurrent writes share that check, and a failing GitHub is not asked again at once', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const credentials = session(h.store, p, login.result.identity_id);
  lapse(h, p);
  let release, reached; const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  state.apiGate = async path => { if (path === '/user') { reached(); await held; } };
  const before = userReads(f), writes = [true, false, true].map(enabled => write(f, credentials, undefined, undefined, { review_enabled: enabled }));
  // The first write holds the check at GitHub; the others arrive while it waits.
  await arrived; await new Promise(resolve => setTimeout(resolve, 300)); release();
  assert.deepEqual(await Promise.all(writes.map(async pending => (await pending).status)), [200, 200, 200]);
  assert.equal(userReads(f) - before, 1);
  state.apiGate = undefined;
  // Proved again: the next write sends nothing.
  let sent = f.state.requests.length; assert.equal((await write(f, credentials)).status, 200); assert.equal(f.state.requests.length, sent);
  // GitHub fails: the lapsed write is refused after one check, and the next write within a minute does not check again.
  lapse(h, p); state.failure = 500; sent = userReads(f);
  assert.equal((await write(f, credentials)).status, 403); assert.equal(userReads(f) - sent, 1);
  assert.equal((await write(f, credentials)).status, 403); assert.equal(userReads(f) - sent, 1);
});

test('the background refresh checks signed-in principals only, and never super administrators or explicit delegation', async t => {
  const f = await identityFixture(t), { h, state, admin } = f;
  const a = await f.login(); state.id = 43; const b = await f.login();
  const A = a.result.principal_id, B = b.result.principal_id;
  const refresh = new GitHubRefresh(h.store, () => f.identity, { stagger: 0 });
  const due = () => h.store.run("UPDATE external_identities SET verified_at=1 WHERE provider='github'");
  // Only A is signed in to the console.
  session(h.store, A, a.result.identity_id); due();
  let [readsA, readsB] = [userReads(f, 42), userReads(f, 43)];
  await refresh.run();
  assert.equal(userReads(f, 42) - readsA, 1); assert.equal(userReads(f, 43) - readsB, 0);
  assert.ok(identity(h, A).verified_at > 1); assert.equal(identity(h, B).verified_at, 1);
  // Proved within the last half interval (at sign-in, say): the next round leaves A alone.
  readsA = userReads(f, 42); await refresh.run(); assert.equal(userReads(f, 42), readsA);
  // Sessions that ended end the refresh.
  h.store.run('UPDATE sessions SET expires_at=? WHERE user_id=?', Date.now() - 1, A); due();
  let sent = f.state.requests.length; await refresh.run(); assert.equal(f.state.requests.length, sent);
  // Signed in again, now a super administrator and an explicitly delegated user: never sent to GitHub.
  const sessionA = session(h.store, A, a.result.identity_id), sessionB = session(h.store, B, b.result.identity_id);
  h.store.run("UPDATE users SET role='super_admin' WHERE id=?", A);
  assert.equal((await admin('/api/identity/grants', 'POST', { principal_id: B, tenant_id: 'github.com:20', project_id: '201', capabilities: ['tasks.read'] })).status, 201);
  due(); sent = f.state.requests.length; await refresh.run(); assert.equal(f.state.requests.length, sent);
  // Nor by a write whose proof lapsed, or by 「重新验证」; signing in with GitHub reads only who the person is.
  assert.equal((await write(f, sessionA, '/api/identity/tenant', 'POST', { tenant_id: null })).status, 201);
  assert.equal((await write(f, sessionB, '/api/identity/tenant', 'POST', { tenant_id: null })).status, 201);
  await f.identity.reverify(A); await f.identity.reverify(B);
  assert.equal(f.state.requests.length, sent);
  const reads = installationReads(f); state.id = 42; await f.login(); state.id = 43; await f.login();
  assert.equal(installationReads(f), reads);
  // Their leftover derived grants are gone; access comes from the platform role and the delegation.
  assert.deepEqual(derived(h, A), []); assert.deepEqual(derived(h, B), []);
});

test('a GitHub rate limit pauses the refresh, and grants keep the rest of their validity', async t => {
  const f = await identityFixture(t), { h, state } = f;
  const a = await f.login(); state.id = 43; const b = await f.login();
  const A = a.result.principal_id, B = b.result.principal_id;
  session(h.store, A, a.result.identity_id); session(h.store, B, b.result.identity_id);
  const refresh = new GitHubRefresh(h.store, () => f.identity, { stagger: 0, concurrency: 1 });
  const grants = [...derived(h, A), ...derived(h, B)];
  h.store.run("UPDATE external_identities SET verified_at=? WHERE provider='github'", Date.now() - 6 * 60_000);
  // GitHub refuses the first request of the round; the second principal is not sent at all.
  state.failure = 429; const before = f.state.requests.length;
  await refresh.run();
  assert.equal(f.state.requests.length - before, 1);
  assert.ok(f.identity.rateLimitedUntil > Date.now());
  assert.deepEqual([...derived(h, A), ...derived(h, B)], grants);
  for (const p of [A, B]) { assert.equal(identity(h, p).status, 'active'); assert.ok(usable(h, p).length > 0); }
  // The next round waits for GitHub, then the refresh resumes.
  state.failure = 0; let sent = f.state.requests.length; await refresh.run(); assert.equal(f.state.requests.length, sent);
  const reads = userReads(f, 42) + userReads(f, 43);
  f.identity.rateLimitedUntil = 0; await refresh.run(); assert.equal(userReads(f, 42) + userReads(f, 43) - reads, 2);
  assert.ok(identity(h, A).verified_at > Date.now() - 60_000 && identity(h, B).verified_at > Date.now() - 60_000);
  // Limited in the middle of a check: what was proved before stands, and the check stops sending.
  const proved = derived(h, A), verified = identity(h, A).verified_at;
  state.membershipFailure = 429; f.identity.rateLimitedUntil = 0; sent = f.state.requests.length;
  await f.identity.reverify(A);
  assert.deepEqual(derived(h, A), proved); assert.equal(identity(h, A).verified_at, verified); assert.equal(identity(h, A).status, 'active');
  assert.match(identity(h, A).verification_issues, /github_rate_limited/);
  assert.equal(f.state.requests.some((r, i) => i >= sent && r.path.includes('/collaborators/')), false);
});

test('webhook revocations still take effect at once, without asking GitHub', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const credentials = session(h.store, p, login.result.identity_id);
  const hook = (event, delivery, payload) => h.hook(f.a.path, f.a.secret, delivery, payload, { 'X-GitHub-Event': event });
  assert.equal((await write(f, credentials)).status, 200);
  const sent = state.requests.length;
  // Removed from the organization: the derived grants stop counting before any check.
  assert.equal((await hook('organization', 'membership-1', { action: 'member_removed', membership: { user: { id: 42 } } })).status, 200);
  assert.equal((await write(f, credentials)).status, 403);
  assert.equal(state.requests.length, sent);
  // Proved again, then the installation is suspended: refused at once.
  await f.identity.reverify(p); assert.equal((await write(f, credentials)).status, 200);
  assert.equal((await hook('installation', 'suspend-1', { action: 'suspend', installation: { id: 77, account: { id: 10, login: 'fixture', type: 'Organization' } } })).status, 200);
  assert.equal((await write(f, credentials)).status, 403);
  // The person revokes the App's authorization: the identity and its sessions end.
  assert.equal((await hook('github_app_authorization', 'revoked-1', { action: 'revoked', sender: { id: 42 } })).status, 200);
  assert.equal((await write(f, credentials)).status, 401);
  assert.equal(identity(h, p).status, 'revoked');
});
