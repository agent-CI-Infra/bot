// A super administrator trusts a GitHub owner; that owner's repository administrators then start their own repositories
// (#848). GitHub is a local protocol fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from './identity-fixture.mjs';
import { session } from '../dist/app/auth.js';

// A console client of a session: JSON in and out, with the session's CSRF token on writes.
const client = (f, credentials) => async (path, method = 'GET', body) => {
  const response = await fetch(f.h.admin + path, { method, headers: { Cookie: 'bot_session=' + credentials.token, ...(method === 'GET' ? {} : { 'X-CSRF-Token': credentials.csrf, 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json() };
};
// Installed in organization 10 through the fixture's installation, never started.
const installed = (f, id) => {
  const now = new Date().toISOString();
  f.h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?,?,'77',?,'10','fixture',1,1,?)`, f.a.id, id, 'fixture/project-' + id, now);
  f.h.store.run("INSERT OR REPLACE INTO installation_repositories VALUES('github.com/123/77',?,?,'10','fixture',1,1,?)", id, 'fixture/project-' + id, now);
};
const audits = (f, action) => f.h.store.all('SELECT user_id,resource_id FROM audit WHERE action=? ORDER BY rowid', action).map(row => ({ ...row }));

test('project administrators start repositories of a trusted organization with its defaults; elsewhere they wait (#848)', async t => {
  const f = await identityFixture(t), { h, state, admin } = f;
  installed(f, '103'); installed(f, '104'); state.accessible = ['101', '103', '104'];
  // A GitHub repository admin, not an owner: project administrator of every repository of the installation.
  Object.assign(state, { id: 42, login: 'repo-admin', owner: false, permission: 'admin' });
  const login = await f.login(), principal = login.result.principal_id, byAdmin = client(f, session(h.store, principal, login.result.identity_id));
  const pending = async () => (await byAdmin('/api/identity')).value.github_connection.pending_repositories.map(repo => [repo.id, repo.self_start]);
  assert.deepEqual(await pending(), [['103', false], ['104', false]]);
  // Not trusted: the project list keeps "waiting for a super administrator", and the API refuses with a clear code.
  assert.equal((await byAdmin('/api/installations/103/activate', 'POST', {})).value.error, 'organization_not_trusted');
  assert.equal((await byAdmin('/api/trusted-organizations')).status, 403);

  const model = (await admin('/api/models', 'POST', { model_name: 'Shared fixture', api_url: 'http://127.0.0.1:9/v1', api_key: 'fixture-key' })).value.model;
  const own = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Project fixture', api_url: 'http://127.0.0.1:9/v1', api_key: 'fixture-key' })).value.model;
  assert.equal((await admin('/api/trusted-organizations/10', 'PUT', { model_id: own.id })).value.error, 'model_not_shared');
  assert.equal((await admin('/api/trusted-organizations/999', 'PUT', {})).value.error, 'organization_not_found');
  const trusted = await admin('/api/trusted-organizations/10', 'PUT', { model_id: model.id, development_enabled: true });
  assert.equal(trusted.status, 200, JSON.stringify(trusted.value));
  assert.deepEqual({ ...trusted.value.organization, trusted_at: undefined, updated_at: undefined },
    { owner_id: '10', owner_login: 'fixture', trusted_by: 'administrator', trusted_at: undefined, updated_at: undefined, model: { id: model.id, name: 'Shared fixture' }, development_enabled: true });
  assert.deepEqual(audits(f, 'organization.trusted').map(row => row.resource_id), ['10']);
  assert.deepEqual(await pending(), [['103', true], ['104', true]]);

  // The administrator starts 103: no choices, the organization's defaults, and the start is audited as theirs.
  assert.equal((await byAdmin('/api/installations/103/activate', 'POST', { model_id: own.id })).value.error, 'unknown_field');
  const started = await byAdmin('/api/installations/103/activate', 'POST', {});
  assert.equal(started.status, 201, JSON.stringify(started.value));
  assert.deepEqual({ ...h.store.get("SELECT enabled,review_enabled,development_enabled,model_id FROM policies WHERE repository_id='103'") },
    { enabled: 1, review_enabled: 1, development_enabled: 1, model_id: model.id });
  assert.ok(h.store.get("SELECT 1 FROM model_projects WHERE model_id=? AND repository_id='103'", model.id), 'the default model is authorized to the new project');
  assert.deepEqual(audits(f, 'repository.activated').filter(row => row.resource_id === '103'), [{ user_id: principal, resource_id: '103' }]);
  assert.ok((await byAdmin('/api/repositories')).value.repositories.some(repo => repo.id === '103'));
  // Starting a disabled project again stays with super administrators.
  assert.equal((await admin('/api/installations/103/disable', 'POST', {})).status, 201);
  assert.equal((await byAdmin('/api/installations/103/activate', 'POST', {})).value.error, 'installation_forbidden');
  assert.equal((await admin('/api/installations/103/activate', 'POST', {})).status, 201);

  // A Read collaborator of the same organization is no administrator there.
  Object.assign(state, { id: 43, login: 'reader', permission: 'read' });
  const reader = await f.login(), byReader = client(f, session(h.store, reader.result.principal_id, reader.result.identity_id));
  assert.equal((await byReader('/api/installations/104/activate', 'POST', {})).value.error, 'repository_admin_required');

  // Untrusting changes only later starts: 103 keeps running, 104 waits for a super administrator again.
  assert.equal((await admin('/api/trusted-organizations/10', 'DELETE', {})).status, 200);
  assert.deepEqual(audits(f, 'organization.untrusted').map(row => row.resource_id), ['10']);
  assert.equal(h.store.get("SELECT enabled FROM policies WHERE repository_id='103'").enabled, 1);
  assert.deepEqual(await pending(), [['104', false]]);
  assert.equal((await byAdmin('/api/installations/104/activate', 'POST', {})).value.error, 'organization_not_trusted');
  assert.equal((await admin('/api/trusted-organizations/10', 'DELETE', {})).value.error, 'organization_not_trusted');

  // A super administrator's start can trust the organization again, with this start's shared model and development choice.
  const list = (await admin('/api/installations')).value.repositories;
  assert.equal(list.find(repo => repo.id === '104').organization_trusted, false);
  assert.equal((await admin('/api/installations/104/activate', 'POST', { model_id: model.id, development_enabled: false, trust_organization: true })).status, 201);
  const again = (await admin('/api/trusted-organizations')).value;
  assert.deepEqual(again.organizations.map(o => [o.owner_id, o.model?.id, o.development_enabled]), [['10', model.id, false]]);
  assert.equal((await admin('/api/installations')).value.repositories.find(repo => repo.id === '104').organization_trusted, true);
});
