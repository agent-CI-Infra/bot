// GitHub collaborators get default platform access, and project administrators delegate inside their projects (#847).
// GitHub is a local protocol fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from './identity-fixture.mjs';
import { session } from '../dist/app/auth.js';
import { authorize, listEffectiveScopes, resolveActor } from '../dist/identity/authorization.js';
import { verificationExempt } from '../dist/identity/github.js';
import { memberCapabilities, projectCapabilities } from '../dist/identity/storage.js';

const tenant = 'github.com:10';
// A console client of a session: JSON in and out, with the session's CSRF token on writes.
const client = (f, credentials) => async (path, method = 'GET', body) => {
  const response = await fetch(f.h.admin + path, { method, headers: { Cookie: 'bot_session=' + credentials.token, ...(method === 'GET' ? {} : { 'X-CSRF-Token': credentials.csrf, 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json() };
};
const can = (f, credentials, capability, project = '101') => { try { authorize(resolveActor(f.h.store, credentials.token), capability, { project_id: project }); return true; } catch { return false; } };
const delegations = (f, p) => listEffectiveScopes(f.h.store, p).filter(g => g.source === 'explicit_delegation');
// Points the fake GitHub at one user: whose membership and repository permission it reports.
const as = (f, id, login, github) => Object.assign(f.state, { id, login, ...github });

test('Write and Maintain collaborators may ask and create tasks, Triage and Read may ask, Admin configures (#847)', async t => {
  const f = await identityFixture(t); f.state.owner = false;
  const principal = (await f.login()).result.principal_id;
  const expected = { admin: ['project_admin', true, true], write: ['project_member', false, true], maintain: ['project_member', false, true],
    triage: ['project_reader', false, false], read: ['project_reader', false, false], none: null };
  for (const [permission, want] of Object.entries(expected)) {
    f.state.permission = permission; await f.identity.reverify(principal);
    const user = (await f.admin('/api/users')).value.users.find(user => user.id === principal);
    assert.deepEqual(user.access.projects.map(p => [p.id, p.can_configure, p.can_write]), want ? [['101', want[1], want[2]]] : [], permission);
    assert.deepEqual(listEffectiveScopes(f.h.store, principal).filter(g => g.state === 'active').map(g => g.role), want ? [want[0]] : [], permission);
  }
  // A narrower GitHub role is lost authority: the revision moves when Write becomes Read, not when it stays.
  f.state.permission = 'write'; await f.identity.reverify(principal);
  const revision = () => f.h.store.get('SELECT authorization_revision r FROM principals WHERE id=?', principal).r, before = revision();
  await f.identity.reverify(principal); assert.equal(revision(), before);
  f.state.permission = 'read'; await f.identity.reverify(principal); assert.ok(revision() > before);
});

test('a project administrator delegates and revokes inside their project only, and the delegation lasts while they hold it (#847)', async t => {
  const f = await identityFixture(t), { h } = f;
  // A: organization owner, so project administrator of 101 through GitHub. B: a Read collaborator.
  as(f, 42, 'owner-a', { owner: true }); const a = await f.login(), A = a.result.principal_id;
  as(f, 43, 'reader-b', { owner: false, permission: 'read' }); const b = await f.login(), B = b.result.principal_id;
  const sessionA = session(h.store, A, a.result.identity_id), sessionB = session(h.store, B, b.result.identity_id), byA = client(f, sessionA), byB = client(f, sessionB);
  assert.equal(can(f, sessionB, 'tasks.read'), true); assert.equal(can(f, sessionB, 'tasks.write'), false);
  // A gives B task write by GitHub login, then appoints B project administrator.
  const member = await byA('/api/identity/grants', 'POST', { github_login: '@Reader-B', tenant_id: tenant, project_id: '101', capabilities: memberCapabilities });
  assert.equal(member.status, 201, JSON.stringify(member.value));
  assert.equal(can(f, sessionB, 'tasks.write'), true); assert.equal(can(f, sessionB, 'config.write'), false);
  const admin = await byA('/api/identity/grants', 'POST', { github_login: 'reader-b', tenant_id: tenant, project_id: '101', capabilities: projectCapabilities });
  assert.equal(admin.status, 201, JSON.stringify(admin.value)); assert.equal(can(f, sessionB, 'config.write'), true);
  assert.deepEqual(delegations(f, B).map(g => g.state), ['active', 'active']);
  // Never beyond A's projects, the organization or what only grant managers turn on.
  assert.equal((await byA('/api/identity/grants', 'POST', { principal_id: B, tenant_id: 'github.com:20', project_id: '201', capabilities: ['tasks.read'] })).status, 403);
  assert.equal((await byA('/api/identity/grants', 'POST', { principal_id: B, tenant_id: tenant, capabilities: ['tasks.read'] })).value.error, 'organization_delegation_forbidden');
  assert.equal((await byA('/api/identity/grants', 'POST', { principal_id: B, tenant_id: tenant, project_id: '101', capabilities: ['knowledge.review'] })).value.error, 'capability_forbidden');
  assert.equal((await byA('/api/identity/grants', 'POST', { github_login: 'nobody', tenant_id: tenant, project_id: '101', capabilities: ['tasks.read'] })).value.error, 'principal_not_found');
  assert.equal((await byA('/api/identity/grants', 'POST', { principal_id: A, tenant_id: tenant, project_id: '101', capabilities: ['tasks.read'] })).value.error, 'self_delegation_forbidden');
  // The project's members page tells A what A may give and take back here.
  const members = (await byA('/api/repositories/101/members')).value;
  assert.deepEqual(members.delegable_capabilities, projectCapabilities); assert.equal(members.tenant_id, tenant);
  const listed = members.grants.filter(g => g.principal_id === B);
  assert.deepEqual(listed.map(g => [g.source, g.can_revoke, g.grantor_name]).sort(), [['explicit_delegation', true, 'owner-a'], ['explicit_delegation', true, 'owner-a'], ['github_derived', false, null]]);
  assert.equal(listed.find(g => g.source === 'github_derived').role, 'project_reader');
  // Delegated by a project administrator, B is still checked on GitHub and keeps the Read grant GitHub gives.
  assert.equal(verificationExempt(h.store, B), false);
  as(f, 43, 'reader-b', { owner: false, permission: 'read' }); await f.identity.reverify(B);
  assert.ok(listEffectiveScopes(h.store, B).some(g => g.source === 'github_derived' && g.state === 'active'));

  // B, now administrator, appoints A in return. GitHub takes A's ownership away: neither delegation keeps the other alive.
  assert.equal((await byB('/api/identity/grants', 'POST', { principal_id: A, tenant_id: tenant, project_id: '101', capabilities: projectCapabilities })).status, 201);
  as(f, 42, 'owner-a', { owner: false, permission: 'none' }); await f.identity.reverify(A);
  assert.equal(can(f, sessionA, 'config.write'), false); assert.equal(can(f, sessionB, 'config.write'), false); assert.equal(can(f, sessionB, 'tasks.read'), true);
  assert.deepEqual([...delegations(f, A), ...delegations(f, B)].map(g => [g.state, g.reason]), Array(3).fill(['suspended', 'grantor_authority']));
  // A is owner again: both delegations count again.
  as(f, 42, 'owner-a', { owner: true }); await f.identity.reverify(A);
  assert.equal(can(f, sessionB, 'config.write'), true); assert.deepEqual(delegations(f, B).map(g => g.state), ['active', 'active']);
  // A revokes B's administration; GitHub's own grant can only change on GitHub (the members page offers no revoke for it).
  assert.equal((await byA('/api/identity/grants/' + admin.value.grant_id, 'DELETE', {})).status, 200);
  assert.equal(can(f, sessionB, 'config.write'), false); assert.equal(can(f, sessionB, 'tasks.write'), true);
  // Removing the collaborator on GitHub removes the derived grant at the next check; A's delegation stays.
  as(f, 43, 'reader-b', { owner: false, permission: 'none' }); await f.identity.reverify(B);
  assert.equal(can(f, sessionB, 'tasks.read'), true, 'the delegated member grant still covers reading');
  assert.equal(listEffectiveScopes(h.store, B).filter(g => g.source === 'github_derived' && g.state === 'active').length, 0);
  assert.equal((await byA('/api/identity/grants/' + member.value.grant_id, 'DELETE', {})).status, 200);
  assert.equal(can(f, sessionB, 'tasks.read'), false);
  assert.ok(h.store.all("SELECT action FROM audit WHERE action IN ('delegation.created','delegation.revoked')").length >= 4);
});
