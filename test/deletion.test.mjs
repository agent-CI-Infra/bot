import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { InstallationSync } from '../dist/app/installations.js';
import { Store } from '../dist/storage/database.js';
import { Projects } from '../manager/projects.mjs';
import { FakeDocker } from './fake-docker.mjs';
import { loadConsole } from './console-page.mjs';
import { externalFixture } from './external-helpers.mjs';

const full = { contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'write', actions: 'write', checks: 'write', metadata: 'read' };
const repo = id => ({ id: Number(id), full_name: `fixture/project-${id}`, private: false, owner: { id: 10, login: 'fixture' } });
const installation = (id, permissions = full, extra = {}) => ({ id, account: { id: 10, login: 'fixture', type: 'Organization' }, permissions, ...extra });
const random = () => randomBytes(24).toString('hex');
const remove = (admin, id, body = { confirm: true }) => admin(`/api/installations/${id}`, 'DELETE', body);
const listedIds = async admin => (await admin('/api/installations')).value.repositories.map(row => row.id);

// A GitHub that answers what installation sync and the deletion check ask. `installations` is the App's installation list,
// `listed` maps an installation ID to the repository IDs it covers, `repos` maps a repository ID to the status a read of it
// returns (404 when absent), and `userRepos` is a bot account's own listing as [id, role flags]. `rateLimited` marks answers as rate limited.
async function fakeGitHub(t) {
  const github = { down: false, installations: [], listed: {}, repos: {}, userRepos: [], requests: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake'), auth = String(req.headers.authorization || '').slice(7), page = Number(url.searchParams.get('page') || 1);
    github.requests.push(`${req.method} ${url.pathname}`);
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', ...(github.rateLimited ? { 'X-RateLimit-Remaining': '0' } : {}) }); res.end(JSON.stringify(value)); };
    const paged = list => page === 1 ? list : [];
    if (github.down) return send(503, { message: 'unavailable' });
    if (url.pathname === '/app/installations') return send(200, paged(github.installations));
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (mint && req.method === 'POST') return send(201, { token: 'installation-' + mint[1] });
    if (url.pathname === '/installation/repositories') return send(200, { repositories: paged((github.listed[auth.replace('installation-', '')] || []).map(repo)) });
    if (url.pathname === '/user/repos') return send(200, paged(github.userRepos.map(([id, permissions]) => ({ ...repo(id), permissions }))));
    const read = /^\/repositories\/(\d+)$/.exec(url.pathname);
    if (read) { const status = github.repos[read[1]] || 404; return send(status, status === 200 ? repo(read[1]) : { message: 'fixture' }); }
    send(404, {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  return Object.assign(github, { url: `http://127.0.0.1:${server.address().port}` });
}
async function appAccount(admin) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { ...await account(admin, { type: 'github_app', app_id: '123', private_key: privateKey, token: undefined }), privateKey };
}
// The real manager project logic over a Docker stand-in, called directly instead of over HTTP.
function managerFixture(t) {
  mkdirSync('.tmp', { recursive: true }); const directory = mkdtempSync(resolve('.tmp/delete-manager-')), docker = new FakeDocker();
  const projects = new Projects({ database: join(directory, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  t.after(() => { projects.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = async (method, path, input) => {
    const [, id, action] = /^\/v1\/projects\/(\d+)(?:\/(\w+))?$/.exec(path);
    if (method === 'GET' && !action) return projects.describe(id);
    if (method === 'PUT') return projects.register(id);
    if (method === 'POST') return projects.operate(id, action, input);
    throw new Error(`unexpected manager call ${method} ${path}`);
  };
  return { docker, projects, manager: { call } };
}
function tablesWith(store, column) {
  return store.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name).filter(name => store.all(`PRAGMA table_info(${name})`).some(c => c.name === column));
}

test('a project whose repository GitHub answers 404 for is deleted with its records; its computer goes, its volumes and audit stay', async t => {
  const github = await fakeGitHub(t), env = managerFixture(t), engine = { active: new Map(), api: async () => undefined };
  let sync; const h = await harness(t, env.manager, store => ({ installations: sync = new InstallationSync(store, github.url), engine }));
  const { admin } = await setup(h), a = await account(admin), now = new Date().toISOString();
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  for (let i = 0; i < 3; i++) await h.projects.reconcile();
  assert.deepEqual([env.projects.get('101').state, env.projects.get('202').state], ['ready', 'ready']);
  // A reset leaves the first generation's volume behind; deletion must not remove it either.
  assert.equal((await admin('/api/environments/101/reset', 'POST', { operation_id: random(), generation: 1 })).status, 201);
  assert.equal(env.docker.volumes.size, 3);

  // Records that belong only to 101, next to the same kinds of records for 202.
  const shared = (await admin('/api/models', 'POST', { repository_id: null, api_url: 'https://model.invalid/v1', api_key: testPassword(), model_name: 'shared' })).value.model;
  await admin(`/api/models/${shared.id}/projects`, 'PUT', { repository_ids: ['101', '202'] });
  const own = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: testPassword(), model_name: 'own',
    pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2, cache_per_million: 0.5 } })).value.model;
  assert.equal((await admin('/api/repositories/101/policy', 'PATCH', { model_id: own.id })).status, 200);
  const member = (await admin('/api/users', 'POST', { username: 'member', password: testPassword(), repository_ids: ['101', '202'] })).value.user;
  await h.hook(a.path, a.secret, 'issue-101', { repository: { id: 101 }, action: 'opened', issue: { number: 5, title: 'Fixture issue', body: 'x' } });
  const delivery = h.store.get("SELECT id FROM deliveries WHERE repository_id='101'").id;
  const task = (id, status, repositoryId = '101') => h.store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at,updated_at)
    VALUES(?,?,'review.issue',?,'fixture',5,?,?)`, id, repositoryId, status, now, now);
  task('running-101', 'running'); task('queued-101', 'queued'); task('done-101', 'succeeded'); task('done-202', 'succeeded', '202');
  h.store.run("INSERT INTO task_logs(id,task_id,content,created_at) VALUES('log-101','done-101','{}',?)", now);
  h.store.run("INSERT INTO task_tools VALUES('tool-101','done-101','{}',NULL,'completed')");
  h.store.run("INSERT INTO github_effects VALUES('effect-101','done-101','comment','{}','sent',NULL,'marker')");
  h.store.run("INSERT INTO development_candidates VALUES('done-101','{}')");
  h.store.run("INSERT INTO model_requests(id,task_id,repository_id,request_id,model_id,model_name,requested_at) VALUES('usage-101','done-101','101','request',?,'own',?)", own.id, now);
  h.store.run("INSERT INTO task_locks(repository_id,task_id,token) VALUES('101','running-101','claim')");
  h.store.run("INSERT INTO bot_branches VALUES('101','bot/issue-5','done-101')");
  h.store.run("INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id) VALUES('101',6,'pr','1','101','bot/issue-5','abc','done-101')");
  h.store.run("INSERT INTO automation_runs VALUES('automation-101','101',NULL,'issues','issues.opened',1,'[]','[]',?)", now);
  h.store.run("INSERT INTO external_clients(id,repository_id,name,auth_type,trust,created_at) VALUES('client-101','101','Fixture','private_key_jwt','{}',?)", now);
  h.store.run("INSERT INTO external_grants(id,client_id,request_id,created_at,state) VALUES('grant-101','client-101','request-101',0,'issued')");
  h.store.run("INSERT INTO external_subscriptions(id,client_id,repository_id,name,url,secret,filters,created_at) VALUES('sub-101','client-101','101','s','https://receiver.invalid','x','{}',?)", now);
  h.store.run("INSERT INTO external_deliveries(id,subscription_id,repository_id,source_id,version,created_at) VALUES('forward-101','sub-101','101',?,1,?)", delivery, now);
  h.store.run("INSERT INTO external_event_cursors VALUES('client-101',1)");
  h.store.run("INSERT INTO repo_integrations(repository_id,checked_at) VALUES('101',?)", now);
  h.store.run("INSERT INTO quickstart_runs(id,repository_id,state,steps,created_at,updated_at) VALUES('quickstart-101','101','done','[]',?,?)", now, now);
  const field = (await admin('/api/board/fields', 'POST', { name: 'Priority' })).value.field, option = (await admin(`/api/board/fields/${field.id}/options`, 'POST', { name: 'High' })).value.option;
  assert.equal((await admin('/api/board/cards/101/issue/5', 'PATCH', { field_id: field.id, option_id: option.id })).status, 200);
  assert.ok(h.store.get("SELECT 1 FROM external_events WHERE repository_id='101'"));
  // The running task stops at its next checkpoint once it is cancelled, as the engine's guard does.
  let stoppedAs = null;
  engine.active.set('101', new Promise(resolve => { const timer = setInterval(() => {
    const status = h.store.get("SELECT status FROM tasks WHERE id='running-101'")?.status;
    if (status === 'cancelled') { stoppedAs = status; clearInterval(timer); engine.active.delete('101'); resolve(); }
  }, 5); }));

  assert.equal((await remove(admin, '101', {})).status, 400);
  const result = await remove(admin, '101');
  assert.equal(result.status, 200); assert.deepEqual(result.value, { deleted: true, repository_id: '101', registered: true });
  assert.equal(stoppedAs, 'cancelled');
  assert.deepEqual(await listedIds(admin), ['202']);
  assert.ok(github.requests.includes('GET /repositories/101'));
  // Nothing that names 101 is left except the audit, which keeps its records.
  for (const table of tablesWith(h.store, 'repository_id').filter(name => name !== 'audit')) assert.equal(h.store.get(`SELECT count(*) n FROM ${table} WHERE repository_id='101'`).n, 0, table);
  for (const table of ['task_logs', 'task_tools', 'github_effects', 'development_candidates', 'task_metrics']) assert.equal(h.store.get(`SELECT count(*) n FROM ${table} WHERE task_id LIKE '%-101'`).n, 0, table);
  for (const table of ['external_grants', 'external_subscriptions', 'external_event_cursors']) assert.equal(h.store.get(`SELECT count(*) n FROM ${table} WHERE client_id='client-101'`).n, 0, table);
  for (const table of ['models', 'model_pricing', 'model_projects']) assert.equal(h.store.get(`SELECT count(*) n FROM ${table} WHERE ${table === 'models' ? 'id' : 'model_id'}=?`, own.id).n, 0, table);
  assert.equal(h.store.get('SELECT count(*) n FROM repositories WHERE id=?', '101').n, 0);
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE repository_id='101' AND action='repository.deleted'"));
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE repository_id='101' AND action='repository.activated'"));
  // 202 keeps everything: its task, policy, shared model grant and assignment.
  assert.ok(h.store.get("SELECT 1 FROM tasks WHERE id='done-202'")); assert.ok(h.store.get("SELECT 1 FROM policies WHERE repository_id='202'"));
  assert.deepEqual(h.store.all('SELECT repository_id FROM model_projects WHERE model_id=?', shared.id).map(r => r.repository_id), ['202']);
  assert.deepEqual(h.store.all('SELECT repository_id FROM project_admin_assignments WHERE user_id=?', member.id).map(r => r.repository_id), ['202']);
  assert.ok(h.store.get('SELECT 1 FROM board_fields WHERE id=?', field.id));
  // The existing environment deletion ran: containers and networks of both generations went, no volume was removed.
  assert.equal(env.projects.get('101').state, 'deleted');
  assert.ok(env.docker.calls.includes('DELETE /containers/' + env.projects.names('101', 1).container));
  assert.ok(env.docker.calls.includes('DELETE /containers/' + env.projects.names('101', 2).container));
  assert.ok(!env.docker.calls.some(call => call.startsWith('DELETE /volumes')));
  assert.deepEqual([...env.docker.volumes.keys()].filter(name => name.includes('-101-')).sort(), [env.projects.names('101', 1).volume, env.projects.names('101', 2).volume]);
  assert.ok(![...env.docker.networks.keys()].some(name => name.includes('-101-')));
  assert.ok(env.docker.containers.has(env.projects.names('202', 1).container));
  // A later sync that sees the repository again lists it like a new one.
  github.userRepos = [['101', { admin: false, push: true, pull: true }], ['202', { admin: false, push: true, pull: true }]];
  await sync.sync(a.id);
  const again = (await admin('/api/installations')).value.repositories.find(row => row.id === '101');
  assert.deepEqual([again.registered, again.installed, again.enabled], [false, true, false]);
});

test('a GitHub App project is deleted only when GitHub, asked right then, says the account no longer reaches the repository', async t => {
  const github = await fakeGitHub(t); let sync;
  const h = await harness(t, undefined, store => ({ installations: sync = new InstallationSync(store, github.url) })), { admin } = await setup(h), a = await appAccount(admin);
  github.installations = [installation(77, { ...full, contents: 'read', actions: 'read' })];
  github.listed = { 77: ['101', '202', '303', '505'] }; github.repos = { 101: 200, 202: 200, 303: 200, 505: 200 };
  await sync.sync(a.id);
  for (const id of ['101', '202', '303']) await repository(admin, a.id, id);
  const row = async id => (await admin('/api/installations')).value.repositories.find(r => r.id === id);
  const kept = async id => assert.ok(h.store.get('SELECT 1 FROM repositories WHERE id=?', id), id + ' should be kept');

  // Still listed and readable, but the installation grants less than the bot needs: shown on the list, and not deletable.
  const limited = await row('101');
  assert.deepEqual(limited.permission_missing, [{ permission: 'contents', required: 'write', current: 'read' }, { permission: 'actions', required: 'write', current: 'read' }]);
  assert.equal(limited.permissions_stale, false);
  let result = await remove(admin, '101');
  assert.deepEqual([result.status, result.value.error], [409, 'repository_permissions_insufficient']); await kept('101');
  // Everything granted: still not deletable.
  github.installations = [installation(77)];
  result = await remove(admin, '101');
  assert.deepEqual([result.status, result.value.error], [409, 'repository_still_accessible']); await kept('101');
  // The list's flags do not decide: 101 left the installation on GitHub, but GitHub is down, so nothing is deleted.
  github.listed[77] = ['202', '303']; github.down = true;
  result = await remove(admin, '101');
  assert.deepEqual([result.status, result.value.error], [502, 'github_http_503']); await kept('101');
  assert.equal(h.store.get("SELECT enabled FROM policies WHERE repository_id='101'").enabled, 1);
  github.down = false;
  // Removed from the installation: deleted, although the public repository is still readable by anyone.
  result = await remove(admin, '101');
  assert.deepEqual([result.status, result.value.registered], [200, true]);
  assert.ok(!(await listedIds(admin)).includes('101'));
  // A suspended installation: deleted.
  github.installations = [installation(77, full, { suspended_at: '2026-10-01T00:00:00Z' })];
  assert.equal((await remove(admin, '202')).status, 200);
  // Without credentials GitHub cannot be asked, so nothing is deleted; with the App uninstalled from the owner it is.
  await admin(`/api/accounts/${a.id}/credentials/revoke`, 'POST', {});
  result = await remove(admin, '303');
  assert.deepEqual([result.status, result.value.error], [409, 'github_credentials_missing']); await kept('303');
  await admin(`/api/accounts/${a.id}`, 'PATCH', { private_key: a.privateKey });
  github.installations = [];
  assert.equal((await remove(admin, '303')).status, 200);
  // A repository that was never started loses only its installation row, once GitHub answers 404 for it.
  assert.deepEqual((await row('505')).registered, false);
  github.installations = [installation(77)]; github.listed[77] = ['505'];
  assert.equal((await remove(admin, '505')).value.error, 'repository_still_accessible');
  github.listed[77] = []; delete github.repos['505'];
  result = await remove(admin, '505');
  assert.deepEqual([result.status, result.value.registered], [200, false]);
  assert.equal(h.store.get("SELECT count(*) n FROM installed_repositories WHERE repository_id='505'").n, 0);
  assert.deepEqual(await listedIds(admin), []);
  assert.equal((await remove(admin, '505')).status, 404);
  // Only super administrators delete projects.
  const password = testPassword(), member = h.client();
  await admin('/api/users', 'POST', { username: 'member', password, repository_ids: [] }); await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await remove(member, '505')).status, 403);
});

test('a bot account project is not deletable while it is still listed, even with less than write access', async t => {
  const github = await fakeGitHub(t); let sync;
  const h = await harness(t, undefined, store => ({ installations: sync = new InstallationSync(store, github.url) })), { admin } = await setup(h), a = await account(admin);
  github.userRepos = [['101', { admin: false, push: false, triage: false, pull: true }]]; github.repos = { 101: 200 };
  await sync.sync(a.id); await repository(admin, a.id, '101');
  const row = (await admin('/api/installations')).value.repositories[0];
  assert.deepEqual(row.permission_missing, [{ permission: 'repository_role', required: 'write', current: 'read' }]);
  assert.equal((await remove(admin, '101')).value.error, 'repository_permissions_insufficient');
  // A rate-limited 403 says nothing about access; a plain 403 means no access at all.
  github.repos = { 101: 403 }; github.rateLimited = true;
  const limited = await remove(admin, '101');
  assert.deepEqual([limited.status, limited.value.error], [502, 'github_rate_limited']); assert.ok(h.store.get("SELECT 1 FROM repositories WHERE id='101'"));
  github.rateLimited = false;
  assert.equal((await remove(admin, '101')).status, 200);
});

test('the permission check refreshes what installations grant without touching what is installed', async t => {
  const github = await fakeGitHub(t); let sync;
  const h = await harness(t, undefined, store => ({ installations: sync = new InstallationSync(store, github.url) })), { admin } = await setup(h), a = await appAccount(admin);
  github.installations = [installation(77)]; github.listed = { 77: ['101', '202'] };
  await sync.sync(a.id);
  h.store.run("UPDATE installed_repositories SET permissions_at='2026-01-01T00:00:00.000Z'");
  let rows = (await admin('/api/installations')).value.repositories;
  assert.deepEqual(rows.map(r => [r.id, r.permission_missing.length, r.permissions_stale]), [['101', 0, true], ['202', 0, true]]);
  // Someone lowers the installation's Actions access on GitHub; the next check shows it on every repository it covers.
  github.installations = [installation(77, { ...full, actions: 'read' })]; github.listed = { 77: [] };
  const checked = await admin('/api/installations/permissions/check', 'POST', {});
  assert.equal(checked.status, 201); assert.deepEqual(checked.value.errors, []);
  assert.deepEqual(checked.value.repositories.map(r => [r.id, r.permission_missing.map(m => m.permission + ':' + m.current).join(), r.permissions_stale]),
    [['101', 'actions:read', false], ['202', 'actions:read', false]]);
  rows = (await admin('/api/installations')).value.repositories;
  assert.deepEqual(rows.map(r => r.installed), [true, true]);
  // An installation event carries the new grant too.
  await h.hook(a.path, a.secret, 'accepted', { action: 'new_permissions_accepted', installation: { ...installation(77), account: { id: 10, login: 'fixture' } }, repositories: [] },
    { 'X-GitHub-Event': 'installation' });
  assert.deepEqual((await admin('/api/installations')).value.repositories.map(r => r.permission_missing.length), [0, 0]);
  github.down = true;
  assert.deepEqual((await admin('/api/installations/permissions/check', 'POST', {})).value.errors, [{ account_id: a.id, error: 'github_http_503' }]);
});

test('users are deleted with their sessions and assignments, but never the last active super administrator', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin), password = testPassword();
  await repository(admin, a.id, '101');
  const self = (await admin('/api/auth/me')).value;
  assert.equal((await admin(`/api/users/${self.id}`, 'DELETE', {})).status, 400);
  let result = await admin(`/api/users/${self.id}`, 'DELETE', { confirm: true });
  assert.deepEqual([result.status, result.value.error], [409, 'last_super_admin']);
  const member = (await admin('/api/users', 'POST', { username: 'member', password, repository_ids: ['101'] })).value.user, memberClient = h.client();
  await memberClient('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await memberClient(`/api/users/${member.id}`, 'DELETE', { confirm: true })).status, 403);
  assert.equal((await admin(`/api/users/${member.id}`, 'DELETE', { confirm: true })).status, 200);
  assert.equal((await memberClient('/api/auth/me')).status, 401);
  assert.equal(h.store.get('SELECT count(*) n FROM project_admin_assignments WHERE user_id=?', member.id).n, 0);
  assert.equal((await admin('/api/users', 'POST', { username: 'member', password, repository_ids: [] })).status, 201);
  assert.equal((await admin('/api/users/missing', 'DELETE', { confirm: true })).status, 404);
  // With a second active super administrator, the first may delete itself; its session ends and its audit records stay.
  await admin('/api/users', 'POST', { username: 'second', password, role: 'super_admin' });
  result = await admin(`/api/users/${self.id}`, 'DELETE', { confirm: true });
  assert.deepEqual([result.status, result.value.self], [200, true]);
  assert.equal((await admin('/api/auth/me')).status, 401);
  assert.ok(h.store.get('SELECT count(*) n FROM audit WHERE user_id=?', self.id).n > 0);
  const second = h.client(); await second('/api/auth/login', 'POST', { username: 'second', password });
  assert.deepEqual((await second('/api/users')).value.users.map(u => u.username), ['member', 'second']);
  const secondId = (await second('/api/auth/me')).value.id;
  assert.equal((await second(`/api/users/${secondId}`, 'DELETE', { confirm: true })).value.error, 'last_super_admin');
});

test('an account is removed from this system only, and only once no project uses it', async t => {
  const github = await fakeGitHub(t);
  const h = await harness(t, undefined, store => ({ installations: new InstallationSync(store, github.url) })), { admin } = await setup(h);
  const a = await account(admin), app = await appAccount(admin), other = await account(admin, { name: 'Other' });
  await repository(admin, a.id, '101'); await repository(admin, app.id, '202');
  h.store.run("INSERT INTO installation_syncs VALUES(?,?,NULL,1)", a.id, new Date().toISOString());
  for (const target of [a, app]) {
    const result = await admin(`/api/accounts/${target.id}`, 'DELETE', { confirm: true });
    assert.deepEqual([result.status, result.value.error], [409, 'account_has_projects']);
  }
  github.installations = [installation(77)];
  assert.equal((await remove(admin, '101')).status, 200); assert.equal((await remove(admin, '202')).status, 200);
  h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,installed,synced_at) VALUES(?,'909','fixture/other','10',1,?)`, a.id, new Date().toISOString());
  assert.equal((await admin(`/api/accounts/${a.id}`, 'DELETE', {})).status, 400);
  for (const target of [a, app]) assert.equal((await admin(`/api/accounts/${target.id}`, 'DELETE', { confirm: true })).status, 200);
  assert.deepEqual((await admin('/api/accounts')).value.accounts.map(row => row.id), [other.id]);
  for (const table of ['endpoints', 'installation_syncs', 'installed_repositories']) assert.equal(h.store.get(`SELECT count(*) n FROM ${table} WHERE account_id IN (?,?)`, a.id, app.id).n, 0, table);
  assert.equal((await h.hook(a.path, a.secret, 'after-delete', { repository: { id: 101 }, action: 'opened' })).status, 404);
  // Nothing was uninstalled or deleted on GitHub.
  assert.ok(!github.requests.some(request => request.startsWith('DELETE')));
  assert.equal((await admin(`/api/accounts/${a.id}`, 'DELETE', { confirm: true })).status, 404);
});

test('deleting an external client takes its grants, subscriptions, cursor and pending forwards, not the project', async t => {
  const h = await externalFixture(t), first = await h.client('101'), second = await h.client('101'), outside = await h.client('202');
  const sub = (await h.admin('/api/repositories/101/external/subscriptions', 'POST', { client_id: first.client.id, name: 'Issues', url: 'https://receiver.invalid/hook',
    filters: { events: ['issues'], actions: [], exclude_drafts: false } })).value.subscription;
  assert.equal((await h.exchange(first.client.id, first.privateKey)).status, 200);
  h.store.run('INSERT INTO external_event_cursors VALUES(?,1)', first.client.id);
  await h.hook(h.a.path, h.a.secret, 'forwarded', { repository: { id: 101 }, action: 'opened', issue: { number: 1, title: 'x' } });
  assert.equal(h.store.get("SELECT state FROM external_deliveries WHERE subscription_id=?", sub.id).state, 'pending');
  // A project administrator deletes clients of assigned projects only.
  const password = testPassword(), member = h.managementClient();
  await h.admin('/api/users', 'POST', { username: 'member', password, repository_ids: ['101'] }); await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await member(`/api/repositories/202/external/clients/${outside.client.id}`, 'DELETE', { confirm: true })).status, 403);
  assert.equal((await member(`/api/external/clients/${outside.client.id}`, 'DELETE', { confirm: true })).status, 404);
  assert.equal((await member(`/api/repositories/101/external/clients/${first.client.id}`, 'DELETE', {})).status, 400);
  assert.equal((await member(`/api/repositories/101/external/clients/${first.client.id}`, 'DELETE', { confirm: true })).status, 200);
  for (const table of ['external_grants', 'external_subscriptions', 'external_event_cursors']) assert.equal(h.store.get(`SELECT count(*) n FROM ${table} WHERE client_id=?`, first.client.id).n, 0, table);
  assert.equal(h.store.get('SELECT count(*) n FROM external_deliveries WHERE subscription_id=?', sub.id).n, 0);
  assert.deepEqual((await h.admin('/api/repositories/101/external/clients')).value.clients.map(c => c.id), [second.client.id]);
  // A super administrator deletes any project's client, here through the global page's path; the projects stay.
  assert.equal((await h.admin(`/api/external/clients/${outside.client.id}`, 'DELETE', { confirm: true })).status, 200);
  assert.ok(h.store.get("SELECT 1 FROM policies WHERE repository_id='101' AND enabled=1")); assert.ok(h.store.get("SELECT 1 FROM repositories WHERE id='202'"));
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='external.client.deleted' AND resource_id=?", first.client.id));
});

test('an older audit with foreign keys is rebuilt without them and keeps its records', async t => {
  mkdirSync('.tmp', { recursive: true }); const directory = mkdtempSync(resolve('.tmp/audit-')), path = join(directory, 'control.sqlite'), key = randomBytes(32);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(path, key);
  store.db.exec(`DROP TABLE audit; CREATE TABLE audit(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), repository_id TEXT REFERENCES repositories(id),
    action TEXT NOT NULL, resource_id TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO users(id,username,password_hash,role) VALUES('u','someone','x','super_admin');`);
  store.audit('u', 'system.initialized', 'u'); store.close();
  store = new Store(path, key); t.after(() => store.close());
  assert.deepEqual(store.all('PRAGMA foreign_key_list(audit)'), []);
  store.run("DELETE FROM users WHERE id='u'");
  assert.deepEqual(store.all('SELECT user_id,action FROM audit').map(row => ({ ...row })), [{ user_id: 'u', action: 'system.initialized' }]);
});

test('the project list marks reduced permissions, refreshes stale ones in place once, and offers deletion only off the installation', async () => {
  const gap = [{ permission: 'actions', required: 'write', current: 'read' }];
  const row = (id, extra) => ({ id, full_name: 'fixture/project-' + id, owner_id: '10', installed: true, registered: true, enabled: true, review_enabled: true,
    development_enabled: false, model_id: 'm', running_tasks: 0, queued_tasks: 0, permission_missing: [], permissions_stale: false, ...extra });
  let listing = [row('101', { permission_missing: gap, permissions_stale: true }), row('202', { installed: false, permission_missing: null }), row('303')];
  let check = () => [201, { errors: [], repositories: [{ id: '101', permission_missing: [...gap, { permission: 'contents', required: 'write', current: null }] }, { id: '303', permission_missing: gap }] }];
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path === '/api/integrations') return [200, { integrations: [{ repository_id: '101', gate_state: 'live', dashboard_state: 'none', stale: false }] }];
    if (path === '/api/installations') return [200, { syncs: [], repositories: listing }];
    if (method === 'POST' && path === '/api/installations/permissions/check') return check();
    return [404, { error: 'not_found' }];
  });
  page.run("var startCalls = 0; start = async () => { startCalls++; }; var projectRoute = () => null; me = { role: 'super_admin', csrf_token: 'csrf' }; tab = 'projects';");
  const settle = () => new Promise(r => setTimeout(r, 50)), permission = line => line.querySelector('[data-permission]');
  const actions = line => line.querySelectorAll('button').map(b => b.textContent);
  await page.run('render()');
  const [first, removed, third] = page.$('rows').children;
  assert.deepEqual([permission(first).textContent, permission(first).hidden], ['权限不足', false]);
  assert.match(permission(first).title, /Actions 需要「Read and write」，现在「Read-only」/);
  assert.deepEqual([permission(removed).hidden, permission(third).hidden], [true, true]);
  assert.ok(removed.querySelectorAll('.status').some(chip => chip.textContent === '已移出安装'));
  assert.ok(actions(removed).includes('删除')); assert.ok(!actions(first).includes('删除')); assert.ok(!actions(third).includes('删除'));
  await settle();
  // One background check; the badges changed on the rows already drawn, which stayed on the list.
  assert.deepEqual(page.requests, ['GET /api/integrations', 'GET /api/installations', 'POST /api/installations/permissions/check']);
  assert.equal(page.run('startCalls'), 0); assert.equal(page.$('rows').children[0], first);
  assert.match(permission(first).title, /Contents 需要「Read and write」，现在「No access」/);
  assert.deepEqual([permission(third).textContent, permission(third).hidden], ['权限不足', false]);
  // The five-second task refresh reads the list again but leaves permission badges alone.
  page.requests.length = 0; listing = listing.map(r => ({ ...r, permission_missing: [], permissions_stale: false, running_tasks: 2 })); const badge = permission(first);
  await page.run('refreshProjectActivity()');
  assert.deepEqual(page.requests, ['GET /api/installations']); assert.equal(permission(first), badge);
  assert.match(first.querySelector('.project-task-preview').title, /正在执行 2 个任务/);
  // Fresh grants on the next visit: no check at all.
  page.requests.length = 0; await page.run('render()'); await settle();
  assert.deepEqual(page.requests, ['GET /api/integrations', 'GET /api/installations']);
});

test('deletions confirm in the console dialog, which shows the check and a refusal in place instead of a browser popup', async () => {
  let answer = [409, { error: 'repository_still_accessible' }];
  const listing = [{ id: '202', full_name: 'fixture/project-202', owner_id: '10', installed: false, registered: true, enabled: false, review_enabled: false,
    development_enabled: false, model_id: 'm', running_tasks: 0, queued_tasks: 0, permission_missing: null, permissions_stale: false }];
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path === '/api/integrations') return [200, { integrations: [] }];
    if (path === '/api/installations') return [200, { syncs: [], repositories: listing }];
    if (method === 'DELETE' && path === '/api/installations/202') return answer;
    return [404, { error: 'not_found' }];
  });
  // A browser popup would fail here: the page has no confirm() or prompt().
  page.run("var startCalls = 0; start = async () => { startCalls++; }; me = { role: 'super_admin', csrf_token: 'csrf' }; tab = 'projects';");
  await page.run('render()');
  const view = page.run('confirmView'), settle = () => new Promise(r => setTimeout(r, 20)), deletes = () => page.requests.filter(r => r.startsWith('DELETE')).length;
  const remove = () => page.$('rows').children[0].querySelectorAll('button').find(b => b.textContent === '删除').listeners.click[0]();
  const buttons = () => view.querySelectorAll('.confirm-actions button'), submit = () => view.querySelector('form').listeners.submit[0]({ preventDefault() {} });
  const texts = selector => view.querySelectorAll(selector).map(node => node.textContent);
  // Cancel sends nothing.
  remove();
  assert.equal(view.open, true);
  assert.deepEqual(texts('h2'), ['删除项目 fixture/project-202？']);
  assert.ok(texts('li').includes('虚拟电脑的容器和网络会去掉')); assert.ok(texts('li').some(line => line.startsWith('工作卷按现有环境删除保留')));
  assert.deepEqual([buttons().map(b => b.textContent), buttons()[1].className], [['取消', '删除'], 'danger']);
  assert.equal(buttons()[0].ownerFocus, true);
  buttons()[0].listeners.click[0](); await settle();
  assert.equal(view.open, false); assert.equal(deletes(), 0);
  // A refusal stays in the dialog, which can be tried again; success closes it and reloads the list.
  remove(); submit(); await settle();
  assert.equal(view.open, true); assert.equal(deletes(), 1);
  assert.equal(view.querySelector('.confirm-status').textContent, '当前账号仍能访问这个仓库，权限也齐全，不能删除。');
  assert.deepEqual(buttons().map(b => b.disabled), [false, false]);
  answer = [200, { deleted: true }]; submit(); await settle();
  assert.equal(view.open, false); assert.equal(deletes(), 2); assert.equal(page.run('startCalls'), 1);
  // Closing with Esc cancels too.
  remove(); view.close(); await settle();
  assert.equal(deletes(), 2);
});
