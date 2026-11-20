// #1158: repository collaborator and installation owner local cache, public-repository outsider isolation,
// tiered caching (`full` vs `?permission=admin`), ETag 304 conditional requests, webhook-driven incremental sync,
// legacy outsider grant revocation, and rate-limit / 5xx fault safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from '../../../fixtures/identity-fixture.mjs';
import { session } from '../../../../dist/app/auth.js';
import { authorize, listEffectiveScopes, resolveActor } from '../../../../dist/identity/authorization.js';
import { GitHubRefresh } from '../../../../dist/identity/github-refresh.js';

const activeGrants = (store, principal) => listEffectiveScopes(store, principal).filter(g => g.state === 'active');
const waitUntil = async (fn, ms = 5_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 20))) {
    if (await fn()) return;
  }
  throw new Error('timed out waiting for condition');
};

test('public repository non-collaborators receive zero access while real owners and Read/Triage/Write/Maintain/Admin collaborators get exact roles (#1158)', async t => {
  const f = await identityFixture(t), { h, state } = f;
  // Mark repository 101 public in both installation projection and the fake GitHub API.
  state.publicRepos = ['101'];
  h.store.run("UPDATE installation_repositories SET private=0 WHERE repository_id='101'");
  state.owners = [{ id: 40, login: 'org-owner' }];
  state.collaborators = [
    { id: 41, login: 'repo-admin', role_name: 'admin' },
    { id: 42, login: 'repo-maintain', role_name: 'maintain' },
    { id: 43, login: 'repo-write', role_name: 'write' },
    { id: 44, login: 'repo-triage', role_name: 'triage' },
    { id: 45, login: 'repo-read', role_name: 'read' },
  ];

  // Confirm our fixture faithfully reproduces GitHub's public-repo implicit read on the retired single-user endpoint.
  const implicitRead = await (await fetch(`${f.base}/repos/fixture/project-101/collaborators/stranger/permission`, {
    headers: { Authorization: 'Bearer fixture-installation' },
  })).json();
  assert.equal(implicitRead.permission, 'read');
  state.requests.length = 0;

  const signInAs = async (id, login) => {
    state.id = id; state.login = login;
    return (await f.login()).result;
  };

  // Cold sync on first login, then warm local-cache hits for every subsequent user.
  const owner = await signInAs(40, 'org-owner');
  const installationCallsAfterFirst = state.requests.filter(r => r.path.startsWith('/app/installations/') || r.path.includes('/collaborators') || r.path.startsWith('/orgs/')).length;
  assert.ok(installationCallsAfterFirst > 0);

  const adminUser = await signInAs(41, 'repo-admin');
  const maintainUser = await signInAs(42, 'repo-maintain');
  const writeUser = await signInAs(43, 'repo-write');
  const triageUser = await signInAs(44, 'repo-triage');
  const readUser = await signInAs(45, 'repo-read');
  const outsider = await signInAs(99, 'public-outsider');

  // All 6 subsequent logins hit the warm SQLite cache directly: zero installation/org/collaborator API calls.
  const installationCallsAfterAll = state.requests.filter(r => r.path.startsWith('/app/installations/') || r.path.includes('/collaborators') || r.path.startsWith('/orgs/')).length;
  assert.equal(installationCallsAfterAll, installationCallsAfterFirst, 'warm sign-ins send only OAuth exchange and /user');
  assert.equal(state.requests.some(r => /\/collaborators\/[^/]+\/permission$/.test(r.path)), false, 'never calls single-user /permission');

  // Outsider on a Public repository gets NO grants, sees NO projects, and is rejected by verifyInstallation.
  assert.deepEqual(activeGrants(h.store, outsider.principal_id), []);
  const outsiderSession = session(h.store, outsider.principal_id, outsider.identity_id);
  const outsiderRepos = await (await fetch(h.admin + '/api/repositories', { headers: { Cookie: 'bot_session=' + outsiderSession.token } })).json();
  assert.deepEqual(outsiderRepos.repositories, []);
  const outsiderIdentity = await (await fetch(h.admin + '/api/identity', { headers: { Cookie: 'bot_session=' + outsiderSession.token } })).json();
  assert.equal(outsiderIdentity.github_connection.state, 'no_repositories');
  assert.throws(() => authorize(resolveActor(h.store, outsiderSession.token), 'tasks.read', { project_id: '101' }), /capability_forbidden/);
  assert.equal(await f.identity.verifyInstallation(outsiderSession.token, { github_host: 'github.com', app_id: '123', installation_id: '77' }), null);
  const archiveRes = await fetch(h.admin + '/api/installations/archive/github.com/123/77/repositories', {
    headers: { Cookie: 'bot_session=' + outsiderSession.token },
  });
  assert.equal(archiveRes.status, 403);

  // Real collaborators and org owner receive their exact roles and capabilities.
  assert.deepEqual(activeGrants(h.store, owner.principal_id).map(g => g.role).sort(), ['org_admin', 'project_admin']);
  assert.deepEqual(activeGrants(h.store, adminUser.principal_id).map(g => g.role), ['project_admin']);
  assert.deepEqual(activeGrants(h.store, maintainUser.principal_id).map(g => g.role), ['project_member']);
  assert.deepEqual(activeGrants(h.store, writeUser.principal_id).map(g => g.role), ['project_member']);
  assert.deepEqual(activeGrants(h.store, triageUser.principal_id).map(g => g.role), ['project_reader']);
  assert.deepEqual(activeGrants(h.store, readUser.principal_id).map(g => g.role), ['project_reader']);

  const readSession = session(h.store, readUser.principal_id, readUser.identity_id);
  assert.deepEqual((await f.identity.verifyInstallation(readSession.token, { github_host: 'github.com', app_id: '123', installation_id: '77' })).repository_ids, ['101']);
});

test('first member-cache sync automatically revokes pre-upgrade public-repository outsider grants and increments authorization_revision once (#1158)', async t => {
  const f = await identityFixture(t), { h, state } = f;
  state.publicRepos = ['101'];
  state.owners = [{ id: 40, login: 'org-owner' }];
  state.collaborators = [{ id: 41, login: 'real-reader', role_name: 'read' }];

  // Simulate an upgraded database where outsider (id 99) previously received a github_derived project_reader grant on public repo 101.
  h.store.run("INSERT INTO users(id,username,password_hash,role) VALUES('legacy-outsider','github:99:legacy','!external-only','project_admin')");
  h.store.run(`INSERT INTO external_identities(id,principal_id,provider,host,connector,external_tenant,external_actor,display_name,credentials,status,verified_at)
    VALUES('id-outsider','legacy-outsider','github','github.com','','','99','stranger',?,'active',?)`,
    h.store.secrets.seal({ access_token: 'fixture-user-99' }, 'identity:id-outsider'), Date.now());
  h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,policy,evidence,verified_at,expires_at,installation_ref,installation_revision)
    VALUES('github:legacy-outsider:github.com/123/77:101','legacy-outsider','github.com:10','101','project','project_reader','["tasks.read"]','github_derived','current_github','repository_read',?,?, 'github.com/123/77',1)`,
    Date.now(), Date.now() + 30 * 60_000);

  assert.equal(activeGrants(h.store, 'legacy-outsider').length, 1);
  const revBefore = h.store.get("SELECT authorization_revision r FROM principals WHERE id='legacy-outsider'").r;

  const refresh = new GitHubRefresh(h.store, () => f.identity, { stagger: 0 });
  await refresh.run();

  const revokedGrant = h.store.get("SELECT revoked_at FROM scoped_grants WHERE id='github:legacy-outsider:github.com/123/77:101'");
  assert.ok(revokedGrant.revoked_at > 0, 'legacy public-repo outsider grant is automatically revoked');
  assert.deepEqual(activeGrants(h.store, 'legacy-outsider'), []);
  const revAfter = h.store.get("SELECT authorization_revision r FROM principals WHERE id='legacy-outsider'").r;
  assert.equal(revAfter, revBefore + 1, 'losing active authority raises authorization_revision once');

  // Subsequent rounds do not bump authorization_revision again.
  await refresh.run();
  assert.equal(h.store.get("SELECT authorization_revision r FROM principals WHERE id='legacy-outsider'").r, revAfter);
});

test('tiered sync uses ?permission=admin for unstarted repos, reuses one installation token, sends ETag If-None-Match (304), and upgrades on activate (#1158)', async t => {
  const f = await identityFixture(t), { h, state, admin } = f;
  // 101 is started; 102 is installed in installation 77 but not yet started.
  const nowIso = new Date().toISOString();
  h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?, '102', '77', 'fixture/project-102', '10', 'fixture', 1, 1, ?)`, f.a.id, nowIso);
  h.store.run("INSERT OR REPLACE INTO installation_repositories VALUES('github.com/123/77','102','fixture/project-102','10','fixture',1,1,?)", nowIso);
  state.accessible = ['101', '102'];
  state.owners = [];
  state.collaborators = {
    101: [{ id: 50, login: 'writer-50', role_name: 'write' }],
    102: [
      { id: 51, login: 'admin-51', role_name: 'admin' },
      { id: 50, login: 'writer-50', role_name: 'write' },
    ],
  };

  state.requests.length = 0;
  const refresh = new GitHubRefresh(h.store, () => f.identity, { stagger: 0 });
  await refresh.run();

  // Single installation token minted and revoked across the whole installation round.
  assert.equal(state.requests.filter(r => r.path === '/app/installations/77/access_tokens').length, 1);
  assert.equal(state.requests.filter(r => r.path === '/installation/token' && r.method === 'DELETE').length, 1);

  // Started repo 101 requested full collaborators; unstarted repo 102 requested ?permission=admin only.
  const req101 = state.requests.find(r => r.path === '/repos/fixture/project-101/collaborators');
  const req102 = state.requests.find(r => r.path === '/repos/fixture/project-102/collaborators');
  assert.ok(req101 && !req101.query.includes('permission=admin'), `101 query=${req101?.query}`);
  assert.ok(req102 && req102.query.includes('permission=admin'), `102 query=${req102?.query}`);

  assert.equal(h.store.get("SELECT tier FROM github_repository_member_cache WHERE repository_id='101'").tier, 'full');
  assert.equal(h.store.get("SELECT tier FROM github_repository_member_cache WHERE repository_id='102'").tier, 'admin');

  // Sign in both users: warm cache, zero installation calls.
  state.id = 50; state.login = 'writer-50'; const w = (await f.login()).result;
  state.id = 51; state.login = 'admin-51'; const a51 = (await f.login()).result;

  // Admin 51 sees unstarted 102 in pending_repositories; Writer 50 does not, and already has project_member on started 101.
  const adminSession = session(h.store, a51.principal_id, a51.identity_id);
  const adminIdentity = await (await fetch(h.admin + '/api/identity', { headers: { Cookie: 'bot_session=' + adminSession.token } })).json();
  assert.deepEqual(adminIdentity.github_connection.pending_repositories.map(r => r.id), ['102']);
  const writerSession = session(h.store, w.principal_id, w.identity_id);
  const writerIdentity = await (await fetch(h.admin + '/api/identity', { headers: { Cookie: 'bot_session=' + writerSession.token } })).json();
  assert.deepEqual(writerIdentity.github_connection.pending_repositories, []);
  assert.deepEqual(writerIdentity.github_connection.repositories.map(r => r.id), ['101']);

  // Second periodic round sends If-None-Match on owners + both repos and gets 304 Not Modified without changing grants.
  state.requests.length = 0;
  await refresh.run();
  for (const targetPath of ['/orgs/fixture/members', '/repos/fixture/project-101/collaborators', '/repos/fixture/project-102/collaborators']) {
    const req = state.requests.find(r => r.path === targetPath);
    assert.ok(req?.ifNoneMatch, `expected If-None-Match on ${targetPath}`);
  }

  // Super admin activates 102 -> background single-flight upgrades 102's cache tier from 'admin' to 'full', granting writer-50 access automatically!
  state.requests.length = 0;
  assert.equal((await admin('/api/installations/102/activate', 'POST', {})).status, 201);
  await waitUntil(() => h.store.get("SELECT tier FROM github_repository_member_cache WHERE repository_id='102'")?.tier === 'full');
  assert.ok(activeGrants(h.store, w.principal_id).some(g => g.project_id === '102' && g.role === 'project_member'));
  // Unchanged repo 101 was NOT re-fetched during 102's targeted activation upgrade.
  assert.equal(state.requests.some(r => r.path === '/repos/fixture/project-101/collaborators'), false);
});

test('member, team, membership and organization webhooks incrementally refresh caches and obey #521 authorization_revision rules (#1158)', async t => {
  const f = await identityFixture(t), { h, state } = f;
  state.owners = [{ id: 40, login: 'org-owner' }];
  state.collaborators = [];
  state.id = 60; state.login = 'alice';
  const alice = (await f.login()).result;
  assert.deepEqual(activeGrants(h.store, alice.principal_id), []);

  const rev = () => h.store.get('SELECT authorization_revision r FROM principals WHERE id=?', alice.principal_id).r;
  const hook = (event, delivery, payload) => h.hook(f.a.path, f.a.secret, delivery, payload, { 'X-GitHub-Event': event });
  const r0 = rev();

  // 1) `member` added -> Alice becomes Write collaborator; added authority does NOT raise authorization_revision.
  state.collaborators = [{ id: 60, login: 'alice', role_name: 'write' }];
  assert.equal((await hook('member', 'member-add-1', {
    action: 'added',
    installation: { id: 77 },
    repository: { id: 101, full_name: 'fixture/project-101' },
    member: { id: 60, login: 'alice' },
  })).status, 200);
  await waitUntil(() => activeGrants(h.store, alice.principal_id).some(g => g.role === 'project_member'));
  assert.equal(rev(), r0, 'adding collaborator authority does not raise revision');

  // 2) `team` edited -> Alice narrowed to Read collaborator; lost write authority raises authorization_revision once.
  state.collaborators = [{ id: 60, login: 'alice', role_name: 'read' }];
  assert.equal((await hook('team', 'team-edit-1', {
    action: 'edited',
    installation: { id: 77 },
    organization: { id: 10, login: 'fixture' },
    repository: { id: 101, full_name: 'fixture/project-101' },
  })).status, 200);
  await waitUntil(() => activeGrants(h.store, alice.principal_id).some(g => g.role === 'project_reader'));
  assert.equal(rev(), r0 + 1, 'narrowing write -> read raises revision once');

  // 3) `organization` member_added promoting Alice to org owner -> wider authority does NOT raise revision.
  state.owners = [{ id: 40, login: 'org-owner' }, { id: 60, login: 'alice' }];
  assert.equal((await hook('organization', 'org-owner-1', {
    action: 'member_added',
    installation: { id: 77 },
    organization: { id: 10, login: 'fixture' },
    membership: { state: 'active', role: 'admin', user: { id: 60, login: 'alice' } },
  })).status, 200);
  await waitUntil(() => activeGrants(h.store, alice.principal_id).some(g => g.role === 'org_admin'));
  assert.equal(rev(), r0 + 1, 'promoting to org_admin does not raise revision');

  // 4) `membership` + removal from org & collaborators -> grants revoked and revision increments once.
  state.owners = [{ id: 40, login: 'org-owner' }];
  state.collaborators = [];
  assert.equal((await hook('membership', 'team-remove-1', {
    action: 'removed',
    installation: { id: 77 },
    organization: { id: 10, login: 'fixture' },
    member: { id: 60, login: 'alice' },
  })).status, 200);
  await waitUntil(() => activeGrants(h.store, alice.principal_id).length === 0);
  assert.equal(rev(), r0 + 2);
});

test('installations without Members: read degrade cleanly to repository collaborator roles and record diagnostic reason (#1158)', async t => {
  const f = await identityFixture(t), { h, state } = f;
  state.membersPermission = false;
  state.collaborators = [{ id: 42, login: 'repo-admin', role_name: 'admin' }];
  state.requests.length = 0;

  const login = await f.login(), p = login.result.principal_id;
  assert.equal(state.requests.some(r => r.path.startsWith('/orgs/')), false, 'no org members call without Members: read');
  assert.deepEqual(state.requests.find(r => r.path.endsWith('/access_tokens')).body.permissions, { metadata: 'read' });
  assert.deepEqual(activeGrants(h.store, p).map(g => [g.project_id, g.role]), [['101', 'project_admin']]);
  const cache = h.store.get("SELECT owners_uncertain FROM github_installation_member_cache WHERE installation_ref='github.com/123/77'");
  assert.equal(cache.owners_uncertain, 'membership_unreadable');
});

test('collaborator pagination beyond 100 entries, >30-minute warm writes without GitHub calls, and rename/transfer repository ID verification (#1158)', async t => {
  const f = await identityFixture(t), { h, state } = f;
  state.owners = [];
  // 125 collaborators across two pages (100 + 25): collaborator #125 on page 2 must receive its exact role.
  state.collaborators = Array.from({ length: 125 }, (_, index) => ({
    id: 1000 + index,
    login: `collab-${index}`,
    role_name: index === 124 ? 'admin' : 'read',
  }));
  state.id = 1124; state.login = 'collab-124';
  const pageTwoAdmin = (await f.login()).result;
  assert.deepEqual(activeGrants(h.store, pageTwoAdmin.principal_id).map(g => g.role), ['project_admin']);
  const pageQueries = state.requests.filter(r => r.path === '/repos/fixture/project-101/collaborators').map(r => r.query);
  assert.ok(pageQueries.some(q => q.includes('page=1')) && pageQueries.some(q => q.includes('page=2')), `expected multi-page queries, got ${JSON.stringify(pageQueries)}`);

  // Even 2 hours after OAuth sign-in (> 30 minutes), console writes use the warm cache directly with zero GitHub requests.
  h.store.run("UPDATE external_identities SET verified_at=? WHERE id=?", Date.now() - 2 * 3600_000, pageTwoAdmin.identity_id);
  const creds = session(h.store, pageTwoAdmin.principal_id, pageTwoAdmin.identity_id);
  const beforeWrite = state.requests.length;
  const writeRes = await fetch(h.admin + '/api/repositories/101/policy', {
    method: 'PATCH',
    headers: { Cookie: 'bot_session=' + creds.token, 'X-CSRF-Token': creds.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ review_enabled: true }),
  });
  assert.equal(writeRes.status, 200);
  assert.equal(state.requests.length, beforeWrite, 'writes after >30m hit warm cache with zero GitHub requests');

  // If `owner/repo` resolves to a different numeric repository ID on `/repos/{owner}/{repo}` (concurrent rename/transfer),
  // fail closed instead of caching a foreign repository's collaborators under `101`.
  state.repositoryMetaId = 999;
  state.collaborators = [{ id: 1999, login: 'foreign-admin', role_name: 'admin' }];
  await f.identity.reverify(pageTwoAdmin.principal_id);
  assert.deepEqual(activeGrants(h.store, pageTwoAdmin.principal_id), [], 'mismatched repository ID makes the grant pending rather than active');
  assert.equal(h.store.get("SELECT 1 FROM github_repository_collaborators WHERE repository_id='101' AND github_user_id='1999'"), undefined);
});

