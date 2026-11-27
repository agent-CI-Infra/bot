// GitHub permissions come from the local installation-owner and repository-collaborator caches (#1158);
// warm sign-in and daily writes hit local SQLite directly without per-installation serial crawls (#708, #1158).
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from '../../../fixtures/identity-fixture.mjs';
import { testPassword } from '../../../fixtures/helpers.mjs';
import { session } from '../../../../dist/app/auth.js';
import { listEffectiveScopes } from '../../../../dist/identity/authorization.js';
import { GitHubRefresh, fullRefreshInterval } from '../../../../dist/identity/github-refresh.js';

const userReads = (f, id = 42) => f.state.requests.filter(r => r.path === '/user' && r.authorization === 'Bearer fixture-user-' + id).length;
const installationReads = f => f.state.requests.filter(r => r.path.startsWith('/app/installations/') || r.path.startsWith('/installation/') || r.path.startsWith('/orgs/') || r.path.includes('/collaborators')).length;
const derived = (h, p) => h.store.all("SELECT id,verified_at,expires_at FROM scoped_grants WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL ORDER BY id", p);
const usable = (h, p) => listEffectiveScopes(h.store, p).filter(g => g.source === 'github_derived' && g.state === 'active');
const identity = (h, p) => h.store.get("SELECT status,verified_at,verification_issues FROM external_identities WHERE principal_id=? AND provider='github'", p);
const write = (f, credentials, path = '/api/repositories/101/policy', method = 'PATCH', body = { review_enabled: true }) => fetch(f.h.admin + path, {
  method, body: JSON.stringify(body), headers: { Cookie: 'bot_session=' + credentials.token, 'X-CSRF-Token': credentials.csrf, 'Content-Type': 'application/json' } });
const lapse = (h, p) => {
  h.store.run("UPDATE external_identities SET verified_at=? WHERE principal_id=? AND provider='github'", Date.now() - 31 * 60_000, p);
  h.store.run("UPDATE scoped_grants SET expires_at=? WHERE principal_id=? AND source='github_derived'", Date.now() - 60_000, p);
};

test('cold sign-in warms the member cache, warm sign-in and daily writes make zero installation calls', async t => {
  const f = await identityFixture(t), { h, state } = f;
  state.owners = [{ id: 42, login: 'administrator' }, { id: 43, login: 'second-owner' }];
  const before = installationReads(f), login = await f.login(), p = login.result.principal_id;
  assert.ok(installationReads(f) > before, 'cold-start sign-in populates the member cache');
  const grants = derived(h, p); assert.ok(grants.length);
  for (const grant of grants) assert.equal(grant.expires_at, null);

  // Second user signing in against a warm member cache only exchanges OAuth code + /user: zero installation/repo calls.
  const warmBefore = installationReads(f);
  state.id = 43; state.login = 'second-owner';
  const second = await f.login(), p2 = second.result.principal_id;
  assert.equal(installationReads(f), warmBefore, 'warm sign-in hits local member cache with zero installation requests');
  assert.ok(usable(h, p2).length > 0);

  const credentials = session(h.store, p, login.result.identity_id), sent = f.state.requests.length;
  for (const enabled of [true, false, true]) assert.equal((await write(f, credentials, undefined, undefined, { review_enabled: enabled })).status, 200);
  assert.equal(f.state.requests.length, sent);
});

const holdCheck = state => {
  let release, reached; const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  state.apiGate = async path => { if (path === '/app/installations/77') { reached(); await held; } };
  return { arrived, release: () => { state.apiGate = undefined; release(); } };
};
const progress = async cookie => (await (await fetch(cookie.base + '/api/auth/me', { headers: { Cookie: cookie.value } })).json()).github_verification;
const until = async (check, ms = 5_000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 25))) if (await check()) return; throw new Error('timed out'); };

test('cold-start GitHub sign-in opens the session before the member-cache sync ends, and the console can follow its progress', async t => {
  const f = await identityFixture(t), { h, state } = f, hold = holdCheck(state);
  const start = await fetch(h.admin + '/auth/github/start', { redirect: 'manual' }), browser = start.headers.get('set-cookie').split(';')[0];
  const authorized = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const returned = fetch(authorized.headers.get('location'), { redirect: 'manual', headers: { Cookie: browser } });
  await hold.arrived;
  const callback = await returned; assert.equal(callback.status, 303);
  assert.match(callback.headers.get('location'), /github_auth=1/);
  const cookie = { base: h.admin, value: callback.headers.getSetCookie().find(c => c.startsWith('bot_session=')).split(';')[0] };
  assert.deepEqual(await progress(cookie), { checked: 0, total: 1 });
  const p = h.store.get("SELECT principal_id FROM external_identities WHERE provider='github'").principal_id;
  assert.deepEqual(usable(h, p), []);
  hold.release();
  await until(async () => (await progress(cookie)) === null);
  assert.ok(usable(h, p).length > 0);
});

test('password sign-in of a bound local account uses cached grants directly, and reconciles in background when pending', async t => {
  const f = await identityFixture(t), { h, admin, state } = f, password = testPassword();
  const user = (await admin('/api/users', 'POST', { username: 'bound-local', password })).value.user;
  const local = h.client(); assert.equal((await local('/api/auth/login', 'POST', { username: 'bound-local', password })).status, 200);
  assert.equal((await f.login('bind', local.cookie().slice('bot_session='.length))).result.principal_id, user.id);

  // Warm cache: password sign-in makes zero GitHub requests and grants stay immediately usable.
  const sentBeforeWarm = state.requests.length;
  const warmClient = h.client();
  assert.equal((await warmClient('/api/auth/login', 'POST', { username: 'bound-local', password })).status, 200);
  assert.equal(await progress({ base: h.admin, value: warmClient.cookie() }), null);
  assert.equal(state.requests.length, sentBeforeWarm);
  assert.ok(usable(h, user.id).length > 0);

  // Pending grant (e.g. invalidated by configuration change): reconciles in background without blocking sign-in.
  lapse(h, user.id); assert.deepEqual(usable(h, user.id), []);
  let releaseUser, reachedUser;
  const heldUser = new Promise(resolve => { releaseUser = resolve; }), arrivedUser = new Promise(resolve => { reachedUser = resolve; });
  state.apiGate = async path => { if (path === '/user') { reachedUser(); await heldUser; } };
  const again = h.client();
  assert.equal((await again('/api/auth/login', 'POST', { username: 'bound-local', password })).status, 200);
  await arrivedUser;
  const cookie = { base: h.admin, value: again.cookie() };
  assert.deepEqual(await progress(cookie), { checked: 0, total: 0 });
  state.apiGate = undefined; releaseUser();
  await until(async () => (await progress(cookie)) === null);
  assert.ok(identity(h, user.id).verified_at > Date.now() - 60_000);
  assert.ok(usable(h, user.id).length > 0);
  assert.equal(await progress({ base: h.admin, value: f.admin.cookie() }), null);
});

test('a write whose proof is pending checks once, concurrent writes share that check, and a failing GitHub pauses retries', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const credentials = session(h.store, p, login.result.identity_id);
  lapse(h, p);
  let release, reached; const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  state.apiGate = async path => { if (path === '/user') { reached(); await held; } };
  const before = userReads(f), writes = [true, false, true].map(enabled => write(f, credentials, undefined, undefined, { review_enabled: enabled }));
  await arrived; await new Promise(resolve => setTimeout(resolve, 300)); release();
  assert.deepEqual(await Promise.all(writes.map(async pending => (await pending).status)), [200, 200, 200]);
  assert.equal(userReads(f) - before, 1);
  state.apiGate = undefined;
  let sent = f.state.requests.length; assert.equal((await write(f, credentials)).status, 200); assert.equal(f.state.requests.length, sent);
  lapse(h, p); state.failure = 500; sent = userReads(f);
  assert.equal((await write(f, credentials)).status, 403); assert.equal(userReads(f) - sent, 1);
  assert.equal((await write(f, credentials)).status, 403); assert.equal(userReads(f) - sent, 1);
});

test('the background refresh syncs installation member caches once per installation (0 /user calls), and super admins / explicit delegations stay exempt', async t => {
  const f = await identityFixture(t), { h, state, admin } = f;
  state.owners = [{ id: 42, login: 'owner-a' }];
  state.collaborators = [{ id: 43, login: 'writer-b', role_name: 'write' }, { id: 44, login: 'reader-c', role_name: 'read' }];
  const a = await f.login();
  state.id = 43; state.login = 'writer-b'; const b = await f.login();
  state.id = 44; state.login = 'reader-c'; const c = await f.login();
  const [A, B, C] = [a, b, c].map(x => x.result.principal_id);
  const refresh = new GitHubRefresh(h.store, () => f.identity, { stagger: 0 });

  // Regardless of console sessions, Feishu bindings or offline accounts, GitHubRefresh sends 0 /user calls and 1 installation token round.
  const userReadsBefore = [42, 43, 44].map(id => userReads(f, id));
  const tokensBefore = state.requests.filter(r => r.path.endsWith('/access_tokens')).length;
  await refresh.run();
  assert.deepEqual([42, 43, 44].map(id => userReads(f, id)), userReadsBefore, 'background refresh never polls per-user /user');
  assert.equal(state.requests.filter(r => r.path.endsWith('/access_tokens')).length - tokensBefore, 1, 'one installation token per active installation');
  // Conditional requests hit 304 Not Modified on unchanged owners and collaborators.
  assert.ok(state.requests.slice(-3).some(r => r.ifNoneMatch !== null), 'conditional If-None-Match sent');

  // Collaborator removed on GitHub: background refresh revokes C's derived grant even while C is signed out.
  state.collaborators = [{ id: 43, login: 'writer-b', role_name: 'write' }];
  await refresh.run();
  assert.deepEqual(usable(h, C), []);
  assert.ok(usable(h, A).length > 0 && usable(h, B).length > 0);

  // Super administrators and accounts holding independent explicit delegation keep no derived grants and send no OAuth requests.
  const sessionA = session(h.store, A, a.result.identity_id), sessionB = session(h.store, B, b.result.identity_id);
  h.store.run("UPDATE users SET role='super_admin' WHERE id=?", A);
  assert.equal((await admin('/api/identity/grants', 'POST', { principal_id: B, tenant_id: 'github.com:20', project_id: '201', capabilities: ['tasks.read'] })).status, 201);
  await refresh.run();
  assert.deepEqual(derived(h, A), []); assert.deepEqual(derived(h, B), []);
  const sent = state.requests.length;
  assert.equal((await write(f, sessionA, '/api/identity/tenant', 'POST', { tenant_id: null })).status, 201);
  assert.equal((await write(f, sessionB, '/api/identity/tenant', 'POST', { tenant_id: null })).status, 201);
  await f.identity.reverify(A); await f.identity.reverify(B);
  assert.equal(state.requests.length, sent);
  const reads = installationReads(f);
  state.id = 42; state.login = 'owner-a'; await f.login();
  state.id = 43; state.login = 'writer-b'; await f.login();
  assert.equal(installationReads(f), reads);
});

test('GitHub rate limits and 5xx outages pause the refresh and retain the last confirmed member-cache snapshot', async t => {
  const f = await identityFixture(t), { h, state } = f;
  state.owners = [{ id: 42, login: 'owner-a' }];
  state.collaborators = [{ id: 43, login: 'writer-b', role_name: 'write' }];
  const a = await f.login();
  state.id = 43; state.login = 'writer-b'; const b = await f.login();
  const A = a.result.principal_id, B = b.result.principal_id;
  const refresh = new GitHubRefresh(h.store, () => f.identity, { stagger: 0, concurrency: 1 });
  const grantsBefore = [...derived(h, A), ...derived(h, B)];

  // 429 rate limit stops the round, pauses subsequent rounds, and keeps every user's confirmed grants active.
  state.failure = 429; const before = state.requests.length;
  await refresh.run();
  assert.equal(state.requests.length - before, 1);
  assert.ok(f.identity.rateLimitedUntil > Date.now());
  assert.deepEqual([...derived(h, A), ...derived(h, B)], grantsBefore);
  for (const p of [A, B]) { assert.equal(identity(h, p).status, 'active'); assert.ok(usable(h, p).length > 0); }
  state.failure = 0; let sent = state.requests.length; await refresh.run(); assert.equal(state.requests.length, sent);

  // 503 outage during background refresh also preserves the confirmed snapshot without revoking active grants.
  f.identity.rateLimitedUntil = 0; state.failure = 503;
  await refresh.run();
  for (const p of [A, B]) { assert.equal(identity(h, p).status, 'active'); assert.ok(usable(h, p).length > 0); }
  state.failure = 0;

  // Rate-limited in the middle of an installation check (/orgs/fixture/members -> 429): stops before /collaborators and retains proof.
  const verified = identity(h, A).verified_at;
  state.id = 42; state.login = 'owner-a';
  state.membershipFailure = 429; f.identity.rateLimitedUntil = 0; sent = state.requests.length;
  await f.identity.reverify(A);
  assert.equal(identity(h, A).verified_at, verified); assert.equal(identity(h, A).status, 'active');
  assert.ok(usable(h, A).length > 0);
  assert.match(identity(h, A).verification_issues, /github_rate_limited/);
  assert.equal(state.requests.some((r, i) => i >= sent && r.path.includes('/collaborators')), false);
});

test('webhook revocations still take effect at once, without asking GitHub', async t => {
  const f = await identityFixture(t), { h, state } = f, login = await f.login(), p = login.result.principal_id;
  const credentials = session(h.store, p, login.result.identity_id);
  const hook = (event, delivery, payload) => h.hook(f.a.path, f.a.secret, delivery, payload, { 'X-GitHub-Event': event });
  assert.equal((await write(f, credentials)).status, 200);
  const sent = state.requests.length;
  assert.equal((await hook('organization', 'membership-1', { action: 'member_removed', membership: { user: { id: 42 } } })).status, 200);
  assert.equal((await write(f, credentials)).status, 403);
  assert.equal(state.requests.length, sent);
  await f.identity.reverify(p); assert.equal((await write(f, credentials)).status, 200);
  assert.equal((await hook('installation', 'suspend-1', { action: 'suspend', installation: { id: 77, account: { id: 10, login: 'fixture', type: 'Organization' } } })).status, 200);
  assert.equal((await write(f, credentials)).status, 403);
  assert.equal((await hook('github_app_authorization', 'revoked-1', { action: 'revoked', sender: { id: 42 } })).status, 200);
  assert.equal((await write(f, credentials)).status, 401);
  assert.equal(identity(h, p).status, 'revoked');
});

// Rounds that read the installation (#1411): each starts with the App's JWT lookup of installation 77.
const lookups = f => f.state.requests.filter(r => r.path === '/app/installations/77').length;
const minted = f => f.state.requests.filter(r => r.path === '/app/installations/77/access_tokens').length;
const revoked = f => f.state.requests.filter(r => r.path === '/installation/token' && r.method === 'DELETE').map(r => r.authorization);

test('the full member-cache round is an eight-hour fallback, and an installation sync refreshes only what changed (#1411)', async t => {
  const f = await identityFixture(t), { h, state } = f;
  await f.login();
  const refresh = new GitHubRefresh(h.store, () => f.identity, { stagger: 0 });
  // The schedule alone, with the clock mocked: the rounds are counted, not sent, so no HTTP runs on mocked timers.
  let rounds = 0;
  const run = refresh.run;
  refresh.run = async () => { rounds++; };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The first full round runs at once; `round` is the timer's round in flight.
  refresh.start(); await refresh.round;
  assert.equal(rounds, 1);
  t.mock.timers.tick(fullRefreshInterval - 1); await new Promise(resolve => setImmediate(resolve));
  assert.equal(rounds, 1, 'no full round before eight hours have passed');
  t.mock.timers.tick(1); await refresh.round;
  assert.equal(rounds, 2, 'the next full round eight hours after the last one');
  t.mock.timers.reset();
  refresh.run = run;

  // A full round reads the installation; after an installation sync that changed nothing, no member-cache request is sent.
  const before = lookups(f);
  await refresh.run();
  assert.equal(lookups(f) - before, 1);
  const sent = state.requests.length;
  await refresh.runChanged();
  assert.equal(state.requests.length, sent);
  // A sync that changed the installation (its revision moved) refreshes it.
  f.snapshot();
  const revision = h.store.get("SELECT revision FROM github_installations WHERE ref='github.com/123/77'").revision;
  await refresh.runChanged();
  assert.equal(lookups(f) - before, 2);
  assert.equal(h.store.get('SELECT installation_revision FROM github_installation_member_cache').installation_revision, revision);
  await refresh.close();
});

test('member-cache rounds reuse the read-only installation token while it lives, so ETags answer 304 (#1411)', async t => {
  const f = await identityFixture(t), { h, state } = f;
  // GitHub-like tokens on a repository-only installation: /assignees, /collaborators and /permission all send ETags.
  Object.assign(state, { tokenLife: 3600_000, membersPermission: false, issuesPermission: 'read', owner: false,
    collaborators: [{ id: 42, login: 'administrator', role_name: 'write' }], concealedMembers: [{ id: 43, login: 'concealed', role_name: 'read' }] });
  state.id = 43; state.login = 'concealed'; await f.login();
  state.id = 42; state.login = 'administrator'; const p = (await f.login()).result.principal_id;
  assert.ok(usable(h, p).length > 0);
  assert.equal(minted(f), 1); assert.deepEqual(revoked(f), [], 'the token outlives the round');
  const refresh = new GitHubRefresh(h.store, () => f.identity, { stagger: 0 });

  // A full round within the token's life: no new token, no revoke, and every conditional request answers 304.
  let sent = state.requests.length, hits = state.notModified ?? 0;
  await refresh.run();
  const round = state.requests.slice(sent), conditional = round.filter(r => r.ifNoneMatch).length;
  assert.equal(minted(f), 1); assert.deepEqual(revoked(f), []);
  assert.ok(conditional >= 3, `conditional requests: ${conditional}`);
  assert.equal(state.notModified - hits, conditional);
  assert.ok(round.filter(r => !r.path.startsWith('/app/')).every(r => r.authorization === 'Bearer fixture-installation-1'));

  // 46 minutes on, 14 are left: the next round mints a new token and revokes the old one. Its ETags are the old token's.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(46 * 60_000);
  hits = state.notModified;
  await refresh.run();
  assert.equal(minted(f), 2); assert.deepEqual(revoked(f), ['Bearer fixture-installation-1']);
  assert.equal(state.notModified, hits);
  assert.ok(usable(h, p).length > 0);

  // GitHub refusing the cached token drops it: the round reads again with a new one and records no error.
  state.refused.add('fixture-installation-2');
  await refresh.run();
  assert.equal(minted(f), 3); assert.equal(revoked(f).length, 1, 'a refused token is not revoked');
  assert.equal(h.store.get('SELECT last_error FROM github_installation_member_cache').last_error, null);
  assert.ok(usable(h, p).length > 0);

  // New account credentials retire the cached token: it is revoked, and the round mints from the new credentials.
  const account = h.store.get('SELECT id,credentials FROM accounts WHERE id=?', f.a.id), aad = `account:${account.id}`;
  h.store.run('UPDATE accounts SET credentials=? WHERE id=?', h.store.secrets.seal(h.store.secrets.open(account.credentials, aad), aad), account.id);
  sent = state.requests.length;
  await refresh.run();
  assert.equal(minted(f), 4); assert.deepEqual(revoked(f).slice(1), ['Bearer fixture-installation-3']);
  assert.ok(state.requests.slice(sent).findIndex(r => r.method === 'DELETE') < state.requests.slice(sent).findIndex(r => r.path.endsWith('/access_tokens')));
  // Closing the refresh revokes the token it keeps.
  t.mock.timers.reset();
  await refresh.close();
  assert.deepEqual(revoked(f).slice(2), ['Bearer fixture-installation-4']);
});
