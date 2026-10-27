import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../dist/storage/database.js';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';

// A repository the account lists on GitHub that nobody has enabled yet.
function install(h, accountId, id, fullName, ownerId, ownerLogin, installed = 1) {
  h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at) VALUES(?,?,?,?,?,0,?,?)`,
    accountId, id, fullName, ownerId, ownerLogin, installed, new Date().toISOString());
}
async function member(h, admin, username, grants) {
  const password = testPassword(), created = await admin('/api/users', 'POST', { username, password, ...grants });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const client = h.client(); assert.equal((await client('/api/auth/login', 'POST', { username, password })).status, 200);
  return { user: created.value.user, client, scope: async () => (await client('/api/repositories')).value.repositories.map(r => r.id) };
}
const enable = async (admin, id) => assert.equal((await admin(`/api/installations/${id}/activate`, 'POST', {})).status, 201);
const grant = (admin, user, grants) => admin('/api/project-admin-assignments', 'PUT', { user_id: user.id, ...grants });

test('a repository grant stays on that repository; an organization grant also covers projects its owner enables later', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  install(h, a.id, '102', 'fixture/project-102', '10', 'fixture'); install(h, a.id, '201', 'other/app', '20', 'other');
  const single = await member(h, admin, 'single', { repository_ids: ['101'] }), whole = await member(h, admin, 'whole', { organization_ids: ['10'] });
  assert.deepEqual(await single.scope(), ['101']); assert.deepEqual(await whole.scope(), ['101']);
  // Grants are chosen from what is installed: one group per owner, repositories not enabled yet included.
  const listed = (await admin('/api/project-admin-assignments')).value;
  assert.deepEqual(listed.organizations, [
    { owner_id: '10', owner_login: 'fixture', repositories: [{ id: '101', full_name: 'fixture/project-101', registered: true }, { id: '102', full_name: 'fixture/project-102', registered: false }] },
    { owner_id: '20', owner_login: 'other', repositories: [{ id: '201', full_name: 'other/app', registered: false }] }]);
  assert.deepEqual(listed.organization_assignments.map(row => ({ ...row })), [{ user_id: whole.user.id, owner_id: '10' }]);
  // The same sessions after enabling: the organization reaches its new project without an assignment row or a new login,
  // the single repository grant does not, and another organization's project stays out of both.
  await enable(admin, '102'); await enable(admin, '201');
  assert.deepEqual(await single.scope(), ['101']); assert.deepEqual(await whole.scope(), ['101', '102']);
  assert.deepEqual((await whole.client('/api/auth/me')).value.repository_ids.sort(), ['101', '102']);
  assert.equal(h.store.get('SELECT count(*) n FROM project_admin_assignments WHERE user_id=?', whole.user.id).n, 0);
  assert.equal((await whole.client('/api/repositories/201')).status, 403);
  // Repositories and organizations add up; each list sent replaces only itself, and dropping the organization keeps the repository.
  assert.equal((await grant(admin, single.user, { repository_ids: ['101'], organization_ids: ['10'] })).status, 200);
  assert.deepEqual(await single.scope(), ['101', '102']);
  assert.equal((await grant(admin, single.user, { organization_ids: [] })).status, 200);
  assert.deepEqual(await single.scope(), ['101']);
  assert.equal((await grant(admin, whole.user, { repository_ids: ['201'] })).status, 200);
  assert.deepEqual(await whole.scope(), ['101', '102', '201']);
  assert.equal((await grant(admin, whole.user, { repository_ids: [], organization_ids: [] })).status, 200);
  assert.deepEqual(await whole.scope(), []);
});

test('a repository can be granted while installed but not enabled; unknown repositories and organizations are refused', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  install(h, a.id, '303', 'fixture/pending', '10', 'fixture'); install(h, a.id, '404', 'gone/left', '40', 'gone', 0);
  const early = await member(h, admin, 'early', { repository_ids: ['303'] });
  // The grant neither makes it a project nor lets the project administrator enable it.
  assert.deepEqual(await early.scope(), []);
  assert.equal((await early.client('/api/installations/303/activate', 'POST', {})).status, 403);
  assert.equal(h.store.get("SELECT count(*) n FROM repositories WHERE id='303'").n, 0);
  await enable(admin, '303');
  assert.deepEqual(await early.scope(), ['303']);
  for (const [grants, code] of [[{ repository_ids: ['999'] }, 'repository_not_found'], [{ repository_ids: ['404'] }, 'repository_not_found'],
    [{ organization_ids: ['99'] }, 'organization_not_found'], [{ organization_ids: ['40'] }, 'organization_not_found'], [{ organization_ids: '10' }, 'invalid_organization_ids']]) {
    const created = await admin('/api/users', 'POST', { username: 'refused', password: testPassword(), ...grants });
    assert.deepEqual([created.status, created.value.error], [400, code]);
    const replaced = await grant(admin, early.user, grants);
    assert.deepEqual([replaced.status, replaced.value.error], [400, code]);
  }
  assert.equal(h.store.get("SELECT count(*) n FROM users WHERE username='refused'").n, 0);
  assert.deepEqual(await early.scope(), ['303']);
  assert.equal((await admin('/api/project-admin-assignments', 'PUT', { user_id: early.user.id })).status, 400);
  // A super administrator sees everything and holds no grants: whatever is sent with one is ignored, and none can be set later.
  const chief = (await admin('/api/users', 'POST', { username: 'chief', password: testPassword(), role: 'super_admin', repository_ids: ['999'], organization_ids: ['10'] }));
  assert.equal(chief.status, 201);
  for (const table of ['project_admin_assignments', 'project_admin_organizations']) assert.equal(h.store.get(`SELECT count(*) n FROM ${table} WHERE user_id=?`, chief.value.user.id).n, 0);
  assert.equal((await grant(admin, chief.value.user, { organization_ids: ['10'] })).value.error, 'project_admin_not_found');
});

test('an older database keeps its repository grants and stops requiring them to name a project', async t => {
  mkdirSync('.tmp', { recursive: true }); const directory = mkdtempSync(resolve('.tmp/grants-')), path = join(directory, 'control.sqlite'), key = randomBytes(32);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(path, key);
  store.db.exec(`DROP TABLE project_admin_assignments; CREATE TABLE project_admin_assignments(user_id TEXT NOT NULL REFERENCES users(id),
      repository_id TEXT NOT NULL REFERENCES repositories(id), PRIMARY KEY(user_id,repository_id));
    INSERT INTO users(id,username,password_hash,role) VALUES('u','someone','x','project_admin');
    INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'x','2026-01-01T00:00:00.000Z');
    INSERT INTO repositories VALUES('101','fixture/project-101','10','a');
    INSERT INTO project_admin_assignments VALUES('u','101');`);
  store.close();
  store = new Store(path, key); t.after(() => store.close());
  assert.deepEqual(store.all('PRAGMA foreign_key_list(project_admin_assignments)').map(row => row.table), ['users']);
  store.run("INSERT INTO project_admin_assignments VALUES('u','303')");
  assert.deepEqual(store.all('SELECT repository_id FROM project_admin_assignments ORDER BY repository_id').map(row => row.repository_id), ['101', '303']);
});
