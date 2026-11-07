import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { harness, setup, account, testPassword } from './helpers.mjs';
import { InstallationSync } from '../dist/app/installations.js';
import { InstallationArchive, installationSnapshot, installationExecutionDenied, readInstallationDomainEvents } from '../dist/installations/archive.js';
import { InstallationSetup } from '../dist/installations/setup.js';
import { GitHub, appPermissions, appEvents } from '../dist/github/client.js';
import { Redactor } from '../dist/agent/common.js';
import { loadConsole } from './console-page.mjs';
import { ProjectRemoval } from '../dist/projects/removal.js';
import { GateOnboarding } from '../dist/projects/gate-onboarding.js';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const ref = { github_host: 'github.com', app_id: '123', installation_id: '77' }, key = 'github.com/123/77';
const target = { id: 10, type: 'Organization', login: 'agent-test-zone' };
const installation = (extra = {}) => ({ id: 77, app_id: 123, account: { ...target }, repository_selection: 'all', permissions: { ...appPermissions }, events: [...appEvents], suspended_at: null, ...extra });
const repo = (id = 101, extra = {}) => ({ id, full_name: `agent-test-zone/project-${id}`, owner: { ...target }, private: true, ...extra });
const created = (extra = {}) => ({ action: 'created', installation: installation(), repositories: [{ id: 101, full_name: repo().full_name }],
  sender: { id: 20, login: 'installer', type: 'User' }, requester: null, ...extra });
const verified = { github_user_id: '20', target_id: '10', repository_ids: null, can_manage: true, authorization_revision: 'verified-1' };

async function fixture(t, options = {}) {
  const state = { installations: [installation()], repositories: { 77: [repo()] }, failures: new Map(), requests: [], before: null, ...options };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), path = url.pathname, page = Number(url.searchParams.get('page') || 1);
    state.requests.push(`${req.method} ${path}?page=${page}`);
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
    const failure = state.failures.get(path + '?page=' + page) || state.failures.get(path);
    if (failure === 'network') return req.socket.destroy();
    if (failure) { if (failure === 429) res.setHeader('retry-after', '1'); return send({ message: 'fixture failure' }, failure); }
    if (state.before) await state.before(req, url);
    if (path === '/app') return send({ slug: 'fixture-app', owner: target, permissions: appPermissions, events: appEvents });
    if (path === '/rate_limit') return send({});
    if (path === '/app/installations') return send(state.installations.slice((page - 1) * 100, page * 100));
    const detail = /^\/app\/installations\/(\d+)$/.exec(path);
    if (detail) return send(state.detail || state.installations.find(i => String(i.id) === detail[1]) || {}, state.installations.some(i => String(i.id) === detail[1]) ? 200 : 404);
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (mint) return send({ token: 'fixture-install-' + mint[1] }, 201);
    if (path === '/installation/token') return send(undefined, 204);
    if (path === '/installation/repositories') {
      const id = String(req.headers.authorization).replace('Bearer fixture-install-', ''), repositories = state.repositories[id] || [];
      return send({ total_count: repositories.length, repositories: repositories.slice((page - 1) * 100, page * 100) });
    }
    return send({}, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const h = await harness(t), { admin } = await setup(h), a = await account(admin, { type: 'github_app', app_id: '123', private_key: pem, token: undefined });
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const sync = () => new InstallationSync(h.store, apiUrl);
  const hook = (delivery, payload = created(), event = 'installation') => h.hook(a.path, a.secret, delivery, payload, { 'X-GitHub-Event': event });
  const snapshot = () => installationSnapshot(h.store, key);
  const archiveUrl = '/api/installations/archive/github.com/123/77';
  return { h, admin, a, state, sync, hook, snapshot, apiUrl, archiveUrl };
}

test('installation evidence distinguishes target, sender, requester, unknown approver and missing history without granting roles', async t => {
  for (const [name, payload] of [['self', created()], ['approval', created({ requester: { id: 30, login: 'requester', type: 'User' } })],
    ['nullable', created({ requester: null })], ['historical', null]]) {
    await t.test(name, async t => {
      const f = await fixture(t);
      if (payload) assert.equal((await f.hook(name, payload)).status, 200);
      await f.sync().sync(f.a.id);
      const snapshot = f.snapshot();
      assert.equal(snapshot.target.id, '10'); assert.equal(snapshot.status, 'active');
      assert.equal(snapshot.evidence.history_missing, !payload);
      assert.equal(snapshot.evidence.sender?.id || null, payload ? '20' : null);
      assert.equal(snapshot.evidence.requester?.id || null, name === 'approval' ? '30' : null);
      assert.deepEqual(snapshot.evidence.approval, { status: 'unknown', label: '批准者未知' });
      assert.ok(!JSON.stringify(snapshot).includes('approved_by'));
      for (const table of ['project_admin_assignments', 'project_admin_organizations']) assert.equal(f.h.store.get(`SELECT count(*) n FROM ${table}`).n, 0);
      const api = await f.admin(f.archiveUrl); assert.equal(api.status, 200); assert.deepEqual(api.value.installation, snapshot);
      assert.equal(f.h.store.get('SELECT count(*) n FROM repositories').n, 0, 'scope does not activate projects');
    });
  }
});

test('signed archive and queued processing commit atomically, and retry after a transaction failure', async t => {
  const f = await fixture(t);
  f.h.store.db.exec("CREATE TRIGGER fail_installation BEFORE INSERT ON installation_events BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  assert.equal((await f.hook('rollback')).status, 503);
  for (const table of ['deliveries', 'installation_events', 'installation_receipts', 'github_installations', 'installation_sync_jobs'])
    assert.equal(f.h.store.get(`SELECT count(*) n FROM ${table}`).n, 0, table);
  f.h.store.db.exec('DROP TRIGGER fail_installation');
  assert.equal((await f.hook('rollback')).status, 200);
  assert.equal(f.h.store.get('SELECT state FROM installation_sync_jobs').state, 'pending');
  assert.equal(f.snapshot().status, 'pending_sync');
  assert.equal(f.state.requests.length, 0, 'control event ingestion never calls GitHub');
});

test('duplicate receipts survive ordinary delivery cleanup and a process restart; raw evidence is encrypted and retained', async t => {
  const f = await fixture(t), payload = created({ access_token: 'ghs_never_return_this_fixture', private_key: pem });
  // Use a compact unexpected secret field to stay inside this harness webhook size limit.
  delete payload.private_key;
  const first = await f.hook('durable', payload); assert.equal(first.status, 200);
  const before = f.snapshot().projection_version, event = f.h.store.get('SELECT * FROM installation_events');
  assert.ok(!event.payload.includes(payload.access_token));
  const raw = f.h.store.secrets.open(event.payload, 'installation-event:' + event.id);
  assert.deepEqual(JSON.parse(Buffer.from(raw.body, 'base64').toString()), payload);
  const ordinary = (await f.admin('/api/events/' + first.value.record_id)).value;
  assert.ok(!JSON.stringify(ordinary).includes(payload.access_token));
  f.h.store.run('DELETE FROM deliveries'); f.h.store.run('DELETE FROM processed_deliveries');
  await f.h.stop(); await f.h.start();
  const duplicate = await f.hook('durable', payload); assert.equal(duplicate.value.duplicate, true);
  const endpointId = randomBytes(24).toString('hex');
  f.h.store.run('INSERT INTO endpoints VALUES(?,?,?)', endpointId, f.a.id, f.h.store.secrets.seal({ value: f.a.secret }, 'endpoint:' + endpointId));
  const other = await f.h.hook(`/hooks/github/${f.a.id}/${endpointId}`, f.a.secret, 'durable', payload, { 'X-GitHub-Event': 'installation' });
  assert.equal(other.value.duplicate, true);
  assert.equal(f.h.store.get('SELECT count(*) n FROM installation_events').n, 1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM installation_receipts').n, 3);
  assert.equal(f.snapshot().projection_version, before);
  assert.equal(f.h.store.get('SELECT count(*) n FROM installation_domain_events').n, 1);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {Store} from './dist/storage/database.js';
      import {InstallationSync} from './dist/app/installations.js';
      const s=new Store(process.env.FIXTURE_DB,Buffer.from(process.env.FIXTURE_KEY,'base64'));
      await new InstallationSync(s,process.env.FIXTURE_API).sync(process.env.FIXTURE_ACCOUNT);s.close();
    `], { env: { ...process.env, FIXTURE_DB: f.h.database, FIXTURE_KEY: f.h.key.toString('base64'), FIXTURE_API: f.apiUrl, FIXTURE_ACCOUNT: f.a.id }, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', bytes => { error += bytes; }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve(code) : reject(new Error(error)));
  });
  assert.equal(result, 0); assert.equal(f.snapshot().status, 'active');
  assert.equal(f.h.store.get('SELECT result FROM installation_events').result, 'synchronized');
  assert.equal(f.h.store.get('SELECT state FROM installation_sync_jobs').state, 'idle');
  const serialized = JSON.stringify((await f.admin(f.archiveUrl + '/events')).value);
  assert.ok(!serialized.includes(payload.access_token)); assert.ok(!serialized.includes('PRIVATE KEY'));
});

test('pagination failure, 403, rate limiting and network errors keep the last complete scope, then durable retry recovers', async t => {
  const f = await fixture(t); await f.sync().sync(f.a.id);
  const last = f.snapshot().last_success_at;
  for (const failure of [403, 429, 'network']) {
    f.state.failures.set('/installation/repositories', failure);
    await assert.rejects(f.sync().sync(f.a.id));
    assert.equal(f.snapshot().status, 'active'); assert.equal(f.snapshot().completeness, 'error'); assert.equal(f.snapshot().last_success_at, last);
    assert.equal(f.h.store.get('SELECT installed FROM installed_repositories').installed, 1);
    assert.equal(f.h.store.get('SELECT present FROM installation_repositories').present, 1);
  }
  f.state.failures.clear(); f.state.repositories[77] = Array.from({ length: 101 }, (_, index) => repo(1000 + index));
  f.state.failures.set('/installation/repositories?page=2', 500);
  await assert.rejects(f.sync().sync(f.a.id), /github_http_500/);
  assert.equal(f.h.store.get('SELECT count(*) n FROM installed_repositories').n, 1);
  assert.equal(f.snapshot().last_success_at, last);
  assert.equal(f.h.store.get('SELECT state FROM installation_sync_jobs').state, 'retry');
  assert.equal(f.h.store.get("SELECT count(*) n FROM installation_sync_attempts WHERE result='retry'").n, 4);
  f.state.failures.clear(); f.h.store.run('UPDATE installation_sync_jobs SET next_attempt=0');
  const worker = f.sync(); worker.start();
  try {
    for (let i = 0; i < 200 && f.h.store.get('SELECT state FROM installation_sync_jobs').state !== 'idle'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.h.store.get('SELECT state FROM installation_sync_jobs').state, 'idle');
    assert.equal(f.snapshot().completeness, 'complete'); assert.equal(f.snapshot().error, null);
    assert.equal(f.h.store.get('SELECT count(*) n FROM installed_repositories WHERE installed=1').n, 101);
  } finally { await worker.close(); }
});

test('an expired processing lease can be recovered and the previous worker cannot commit over its replacement', async t => {
  const f = await fixture(t); await f.hook('lease');
  let release, entered, heldOnce = false;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  f.state.before = async (_req, url) => { if (url.pathname === '/installation/repositories' && !heldOnce) { heldOnce = true; entered(); await held; } };
  const stale = f.sync().sync(f.a.id); await started;
  const other = f.sync(); assert.equal((await other.sync(f.a.id)).status, 'sync_running');
  f.h.store.run('UPDATE installation_sync_jobs SET lease_until=0');
  try { assert.equal((await other.sync(f.a.id)).repositories, 1); } finally { release(); }
  await assert.rejects(stale, /github_installation_sync_superseded/);
  assert.equal(f.h.store.get('SELECT state FROM installation_sync_jobs').state, 'idle');
  assert.equal(f.h.store.get("SELECT count(*) n FROM installation_sync_attempts WHERE result='lease_expired'").n, 1);
  assert.equal(f.snapshot().status, 'active');
});

test('two credential configurations for the same App share revocations and cannot commit a stale projection through the other job', async t => {
  const f = await fixture(t); await f.sync().sync(f.a.id);
  const second = await account(f.admin, { type: 'github_app', app_id: '123', private_key: pem, token: undefined });
  await f.sync().sync(second.id);
  let release, entered; const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  f.state.before = async (_req, url) => { if (url.pathname === '/installation/repositories') { entered(); await held; } };
  const old = f.sync().sync(f.a.id); await started;
  try {
    await f.h.hook(second.path, second.secret, 'other-credential-suspend', { ...created(), action: 'suspend' }, { 'X-GitHub-Event': 'installation' });
    for (const a of [f.a, second]) assert.equal(installationExecutionDenied(f.h.store, a.id, '101'), true);
  } finally { release(); }
  await assert.rejects(old, /github_installation_sync_superseded/);
  assert.equal(f.h.store.get('SELECT count(*) n FROM installed_repositories WHERE installed=1').n, 0);
  assert.equal(f.snapshot().status, 'suspended');
});

test('a revocation during an in-flight sync fences the stale result; late created and unverified unsuspend cannot restore execution', async t => {
  const f = await fixture(t); await f.sync().sync(f.a.id);
  await f.admin('/api/installations/101/activate', 'POST', {});
  let release, started; const entered = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  f.state.before = async (_req, url) => { if (url.pathname === '/installation/repositories') { started(); await held; } };
  const old = f.sync().sync(f.a.id); await entered;
  try {
    assert.equal((await f.hook('suspend', { ...created(), action: 'suspend' })).status, 200);
    assert.equal(f.snapshot().status, 'suspended'); assert.equal(installationExecutionDenied(f.h.store, f.a.id, '101'), true);
  } finally { release(); }
  await assert.rejects(old, /github_installation_sync_superseded/); f.state.before = null;
  assert.equal(f.h.store.get('SELECT installed FROM installed_repositories').installed, 0);
  await f.hook('late-created'); await f.hook('unsuspend', { ...created(), action: 'unsuspend' });
  assert.equal(f.snapshot().status, 'suspended');
  f.state.detail = installation({ suspended_at: '2026-11-07T01:00:00Z' });
  await f.sync().sync(f.a.id); assert.equal(f.snapshot().status, 'suspended');
  f.state.detail = installation(); await f.sync().sync(f.a.id);
  assert.equal(f.snapshot().status, 'active'); assert.equal(installationExecutionDenied(f.h.store, f.a.id, '101'), false);
  assert.equal(f.h.store.get('SELECT enabled FROM policies').enabled, 0, 'synchronization cannot undo administrative disablement');
  assert.ok(f.state.requests.some(path => path.startsWith('GET /app/installations/77?')), 'suspension recovery uses authoritative reread');
});

test('deleted installation IDs remain terminal and every GitHub operation is fenced after a deletion or removal', async t => {
  const f = await fixture(t); await f.sync().sync(f.a.id); await f.admin('/api/installations/101/activate', 'POST', {});
  const github = new GitHub(f.h.store, f.h.store.get('SELECT * FROM repositories'), new Redactor(), async () => {}, f.apiUrl);
  await f.hook('deleted', { ...created(), action: 'deleted' });
  const count = f.state.requests.length;
  await assert.rejects(github.request('POST', '/fixture/write'), error => error.code === 'github_installation_access_revoked');
  assert.equal(f.state.requests.length, count);
  const removed = f.h.store.get("SELECT count(*) n FROM installation_domain_events WHERE type='installation.access_revoked'").n;
  assert.equal((await f.hook('deleted', { ...created(), action: 'deleted' })).value.duplicate, true);
  assert.equal(f.h.store.get("SELECT count(*) n FROM installation_domain_events WHERE type='installation.access_revoked'").n, removed);
  await f.hook('late-created'); await f.hook('late-unsuspend', { ...created(), action: 'unsuspend' });
  f.state.installations = []; await f.sync().sync(f.a.id); assert.equal(f.snapshot().completeness, 'complete');
  f.state.installations = [installation()]; await f.sync().sync(f.a.id);
  assert.equal(f.snapshot().status, 'deleted'); assert.equal(f.h.store.get('SELECT installed FROM installed_repositories').installed, 0);
});

test('repository removal fences cached GitHub and gate-onboarding tokens and domain events can be replayed without repeating unchanged snapshots', async t => {
  const f = await fixture(t); await f.hook('domain-created'); await f.sync().sync(f.a.id); await f.admin('/api/installations/101/activate', 'POST', {});
  const events = readInstallationDomainEvents(f.h.store); assert.equal(events.length, 2);
  await f.sync().sync(f.a.id); assert.deepEqual(readInstallationDomainEvents(f.h.store), events);
  const github = new GitHub(f.h.store, f.h.store.get('SELECT * FROM repositories'), new Redactor(), async () => {}, f.apiUrl);
  const gate = new GateOnboarding(f.h.store, f.apiUrl), app = gate.source('101').app;
  const token = await gate.token(app, installation(), { contents: 'write' }, { repository_ids: [101] });
  await f.hook('removed', { action: 'removed', installation: installation(), repositories_removed: [{ id: 101 }], repositories_added: [] }, 'installation_repositories');
  const count = f.state.requests.length;
  await assert.rejects(github.request('POST', '/fixture/write'), error => error.code === 'github_installation_access_revoked');
  await assert.rejects(gate.request('POST', '/fixture/write', token, {}), error => error.code === 'installation_access_revoked');
  assert.equal(f.state.requests.length, count);
  const next = readInstallationDomainEvents(f.h.store, events.at(-1).sequence);
  assert.equal(next.filter(row => row.event.type === 'installation.access_revoked').length, 1);
  assert.deepEqual(next.find(row => row.event.type === 'installation.access_revoked').event.repository_ids, ['101']);
  assert.ok(!JSON.stringify(next).includes(token)); await gate.revoke(app);
});

test('scope contraction with empty removed, new repositories, renames and owner transfers reconcile without changing hidden or disabled settings', async t => {
  const f = await fixture(t); await f.sync().sync(f.a.id);
  await f.admin('/api/installations/101/activate', 'POST', {}); await f.admin('/api/installations/101/disable', 'POST', {});
  await f.admin('/api/installations/101', 'DELETE', {});
  await f.hook('selected', { action: 'removed', installation: installation(), repository_selection: 'selected', repositories_added: [], repositories_removed: [] }, 'installation_repositories');
  assert.equal(f.snapshot().execution_blocked, true);
  f.state.installations[0].repository_selection = 'selected'; f.state.repositories[77] = [];
  await f.sync().sync(f.a.id);
  assert.equal(f.h.store.get('SELECT present FROM installation_repositories').present, 0);
  assert.equal(f.snapshot().repository_selection, 'selected');
  f.state.repositories[77] = [repo(101, { full_name: 'agent-test-zone/renamed' }), repo(202)];
  await f.sync().sync(f.a.id);
  assert.deepEqual({ ...f.h.store.get('SELECT full_name,hidden,installed FROM installed_repositories WHERE repository_id=?', '101') },
    { full_name: 'agent-test-zone/renamed', hidden: 1, installed: 1 });
  assert.equal(f.h.store.get('SELECT enabled FROM policies').enabled, 0);
  assert.equal(f.h.store.get('SELECT count(*) n FROM repositories').n, 1);
  const nextTarget = { id: 11, login: 'new-owner', type: 'User' };
  f.state.installations.push(installation({ id: 88, account: nextTarget }));
  f.state.repositories[77] = [repo(202)]; f.state.repositories[88] = [repo(101, { full_name: 'new-owner/renamed', owner: nextTarget })];
  await f.sync().sync(f.a.id);
  assert.equal(f.h.store.get('SELECT owner_id FROM repositories').owner_id, '11');
  assert.equal(f.h.store.get('SELECT hidden FROM installed_repositories WHERE repository_id=?', '101').hidden, 1);
  assert.equal(installationExecutionDenied(f.h.store, f.a.id, '101'), false);
  f.state.installations[1].account.login = 'renamed-owner';
  await f.hook('rename-target', { action: 'renamed', installation: { id: 88 }, account: f.state.installations[1].account, target_type: 'User',
    changes: { login: { from: 'new-owner' } }, sender: { id: 20, login: 'installer' } }, 'installation_target');
  await f.sync().sync(f.a.id);
  assert.equal(installationSnapshot(f.h.store, 'github.com/123/88').target.login, 'renamed-owner');
});

test('zero-repository installations remain independent records, and deleting projects or credentials preserves audit facts', async t => {
  const f = await fixture(t, { repositories: { 77: [] } });
  await f.hook('empty'); await f.sync().sync(f.a.id);
  assert.equal(f.snapshot().status, 'active'); assert.equal(f.h.store.get('SELECT count(*) n FROM installed_repositories').n, 0);
  f.state.repositories[77] = [repo()]; await f.sync().sync(f.a.id); await f.admin('/api/installations/101/activate', 'POST', {});
  // Exercise the actual project-removal service; the fixture answers 404 for a direct repository read.
  const removal = new ProjectRemoval(f.h.store, f.sync());
  const removed = await removal.api({ role: 'super_admin', id: 'fixture' }, 'DELETE', new URL('http://local/api/installations/101/removal'), { confirm: true });
  assert.equal(removed.deleted, true);
  f.h.store.run('DELETE FROM deliveries'); f.h.store.run('DELETE FROM processed_deliveries');
  assert.equal((await f.admin('/api/accounts/' + f.a.id, 'DELETE', { confirm: true })).status, 200);
  assert.equal(f.h.store.get('SELECT count(*) n FROM installation_events').n, 1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM installation_repositories').n, 1);
  assert.equal(f.snapshot().target.id, '10');
  assert.equal((await f.admin(f.archiveUrl)).status, 200);
  assert.equal((await f.admin(f.archiveUrl + '/sync', 'POST', {})).status, 409);
});

test('OAuth, Setup and webhook converge for all six arrival orders and duplicate callbacks attach to existing work', async t => {
  for (const order of ['OSW', 'OWS', 'SOW', 'SWO', 'WOS', 'WSO']) await t.test(order, async t => {
    const f = await fixture(t), setup = new InstallationSetup(f.h.store, { verifyInstallation: async (session, lookup) => session === 'verified-session' && lookup.installation_id === '77' ? verified : null });
    const intent = setup.begin(f.a.id);
    for (const step of order) {
      if (step === 'O') setup.bindIdentity(intent.state, 'verified-session');
      if (step === 'S') {
        const result = await setup.callback(intent.state, '77', 'install');
        assert.ok(['waiting_identity', 'waiting_sync'].includes(result.status));
      }
      if (step === 'W') await f.hook('permutation-' + order);
    }
    assert.equal((await setup.resume(intent.state)).status, 'waiting_sync');
    const generation = f.h.store.get('SELECT generation FROM installation_sync_jobs').generation;
    assert.equal((await setup.callback(intent.state, '77', 'install')).status, 'waiting_sync');
    assert.equal(f.h.store.get('SELECT generation FROM installation_sync_jobs').generation, generation);
    await f.sync().sync(f.a.id);
    assert.deepEqual(await setup.callback(intent.state, '77', 'install'), { contract_version: 1, status: 'ready' });
    await assert.rejects(setup.callback(intent.state, '88', 'install'), error => error.code === 'installation_callback_conflict');
    assert.equal(f.h.store.get('SELECT count(*) n FROM project_admin_organizations').n, 0);
  });
});

test('unverified setup, forged installation IDs, requests awaiting approval and cross-tenant readers disclose no scope', async t => {
  const f = await fixture(t); await f.sync().sync(f.a.id);
  const setup = new InstallationSetup(f.h.store), intent = setup.begin(f.a.id);
  assert.deepEqual(await setup.callback(intent.state, '999', 'install'), { contract_version: 1, status: 'waiting_identity' });
  setup.bindIdentity(intent.state, 'unverified');
  await assert.rejects(setup.resume(intent.state), error => error.code === 'installation_forbidden');
  const request = setup.begin(f.a.id); setup.bindIdentity(request.state, 'unverified');
  assert.equal((await setup.callback(request.state, '', 'request')).status, 'waiting_approval');
  assert.equal(f.h.store.get('SELECT count(*) n FROM github_installations').n, 1);
  const wrongTarget = new InstallationSetup(f.h.store, { verifyInstallation: async () => verified }), wrongIntent = wrongTarget.begin(f.a.id, '11');
  wrongTarget.bindIdentity(wrongIntent.state, 'otherwise-valid');
  await assert.rejects(wrongTarget.callback(wrongIntent.state, '77', 'install'), error => error.code === 'installation_forbidden');
  const anonymous = new InstallationArchive(f.h.store);
  await assert.rejects(anonymous.getInstallationSnapshot('not-verified', ref), error => error.code === 'installation_forbidden');
  const identity = { verifyInstallation: async (session, lookup) => session === 'own-session' && lookup.installation_id === '77' ? verified : null };
  const archive = new InstallationArchive(f.h.store, identity);
  assert.equal((await archive.getInstallationSnapshot('own-session', ref)).target.id, '10');
  await assert.rejects(archive.getInstallationSnapshot('other-session', ref), error => error.code === 'installation_forbidden');
  await assert.rejects(archive.getInstallationSnapshot('own-session', { ...ref, installation_id: '88' }), error => error.code === 'installation_forbidden');
  const subset = new InstallationArchive(f.h.store, { verifyInstallation: async () => ({ ...verified, repository_ids: ['999'], can_manage: false }) });
  assert.deepEqual((await subset.listInstallationRepositories('subset', ref)).repositories, []);
  await assert.rejects(subset.getInstallationSnapshot('subset', ref), error => error.code === 'installation_target_access_required');
  await assert.rejects(subset.requestInstallationSync('subset', ref), error => error.code === 'installation_forbidden');
  const pass = testPassword(), member = f.h.client();
  await f.admin('/api/users', 'POST', { username: 'tenant-admin', password: pass, repository_ids: ['101'] });
  await member('/api/auth/login', 'POST', { username: 'tenant-admin', password: pass });
  for (const path of ['/api/installations/archive', f.archiveUrl, f.archiveUrl + '/events', f.archiveUrl + '/repositories']) assert.equal((await member(path)).status, 403);
  const callback = await fetch(f.h.admin + '/onboarding/github/setup?installation_id=77'); assert.equal(callback.status, 400);
});

test('verified consumers can request durable synchronization before the first webhook, while invalid signatures leave no installation facts', async t => {
  const f = await fixture(t), archive = new InstallationArchive(f.h.store, { verifyInstallation: async () => verified });
  const invalid = await f.h.hook(f.a.path, 'wrong-fixture-secret', 'invalid', created(), { 'X-GitHub-Event': 'installation' });
  assert.equal(invalid.status, 401); assert.equal(f.h.store.get('SELECT count(*) n FROM installation_events').n, 0);
  const pending = await archive.getInstallationSnapshot('verified-session', ref);
  assert.equal(pending.target.id, '10'); assert.equal(pending.status, 'pending_sync'); assert.equal(pending.execution_blocked, true);
  const request = await archive.requestInstallationSync('verified-session', ref); assert.equal(request.status, 'pending');
  assert.equal(f.h.store.get('SELECT state FROM installation_sync_jobs').state, 'pending');
  await f.sync().sync(f.a.id);
  assert.equal((await archive.getInstallationSnapshot('verified-session', ref)).status, 'active');
  assert.deepEqual((await archive.listInstallationRepositories('verified-session', ref)).repositories.map(row => [row.repository_id, row.present]), [['101', true]]);
});

test('the archive view displays evidence and unknowns without credentials or a fabricated approver', async t => {
  const f = await fixture(t); await f.hook('view', created({ requester: { id: 30, login: 'requester' } })); await f.sync().sync(f.a.id);
  const view = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/settings.js'], (_method, path) =>
    path === '/api/installations/archive' ? [200, { installations: [f.snapshot()] }] : [404, { error: 'not_found' }]);
  view.run("me={role:'super_admin'};var archiveCards;");
  await view.run("settingsCards.installations().then(value=>{archiveCards=value;})");
  const text = view.run("(function text(nodes){return nodes.map(node=>node.textContent+' '+text(node.children)).join(' ')})(archiveCards)");
  for (const expected of ['agent-test-zone', 'installer', 'requester', '批准者未知']) assert.ok(text.includes(expected), text);
  assert.ok(!text.includes('PRIVATE KEY')); assert.ok(!text.includes('fixture-install-77'));
});
