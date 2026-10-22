import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';

test('bootstrap is atomic, survives restart, and stores only a slow password hash', async t => {
  const h = await harness(t), first = h.client(), second = h.client(), password = testPassword();
  assert.equal((await first('/api/setup')).value.initialized, false);
  const outcomes = await Promise.all([first('/api/setup', 'POST', { username: 'first', password }), second('/api/setup', 'POST', { username: 'second', password })]);
  assert.deepEqual(outcomes.map(r => r.status).sort(), [201, 409]);
  const row = h.store.get('SELECT * FROM users');
  assert.match(row.password_hash, /^scrypt\$16384\$/); assert.ok(!row.password_hash.includes(password));
  assert.equal(h.store.get('SELECT count(*) n FROM users').n, 1);
  await h.stop(); await h.start();
  assert.equal((await h.client()('/api/setup', 'POST', { username: 'again', password })).status, 409);
  const session = h.client(); assert.equal((await session('/api/auth/login', 'POST', { username: row.username, password })).status, 200);
  assert.equal((await session('/api/auth/me')).value.role, 'super_admin');
  assert.equal((await session('/api/auth/logout', 'POST', {})).status, 200);
  assert.equal((await session('/api/auth/me')).status, 401);
});

test('project administrator lists and details stay within assigned repositories, including logs and models', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  const password = testPassword();
  const user = (await admin('/api/users', 'POST', { username: 'project-admin', password, repository_ids: ['101'] })).value.user;
  const project = h.client(); assert.equal((await project('/api/auth/login', 'POST', { username: user.username, password })).status, 200);
  await h.hook(a.path, a.secret, 'repo-101', { repository: { id: 101 }, action: 'opened' });
  await h.hook(a.path, a.secret, 'repo-202', { repository: { id: 202 }, action: 'opened' });
  const all = (await admin('/api/events')).value.events, foreign = all.find(r => r.repository_id === '202');
  for (const [id, repo] of [['own', '101'], ['foreign', '202']]) {
    h.store.run('INSERT INTO tasks VALUES(?,?,?,?,?)', id, repo, 'fixture', 'done', id);
    h.store.run('INSERT INTO task_logs VALUES(?,?,?)', id, id, `${id} log`);
  }
  assert.deepEqual((await project('/api/repositories')).value.repositories.map(r => r.id), ['101']);
  assert.deepEqual((await project('/api/events')).value.events.map(r => r.repository_id), ['101']);
  assert.equal((await project('/api/events?repository_id=202')).status, 403);
  assert.equal((await project('/api/events/' + foreign.id)).status, 404);
  assert.deepEqual((await project('/api/tasks')).value.tasks.map(r => r.id), ['own']);
  assert.equal((await project('/api/tasks/foreign')).status, 404);
  assert.equal((await project('/api/tasks/foreign/logs')).status, 404);
  assert.equal((await project('/api/tasks/own/logs')).value.logs[0].content, 'own log');
  for (const path of ['/api/accounts', '/api/users', '/api/project-admin-assignments']) assert.equal((await project(path)).status, 403);
  assert.equal((await project('/api/accounts', 'POST', {})).status, 403);
  assert.equal((await project('/api/users/' + user.id, 'PATCH', { role: 'super_admin' })).status, 403);
  assert.equal((await project('/api/project-admin-assignments', 'PUT', { user_id: user.id, repository_ids: ['202'] })).status, 403);
  const otherModel = (await admin('/api/models', 'POST', { repository_id: '202', api_url: 'https://model.invalid/v1', api_key: testPassword(), model_name: 'fixture' })).value.model;
  assert.deepEqual((await project('/api/models')).value.models, []);
  assert.equal((await project('/api/models/' + otherModel.id)).status, 404);
  assert.equal((await project('/api/models', 'POST', { repository_id: '202', api_url: 'https://model.invalid', api_key: testPassword(), model_name: 'fixture' })).status, 403);
  assert.equal((await project('/api/models/' + otherModel.id, 'PATCH', { version: 1, api_key: testPassword() })).status, 404);
  assert.equal((await project('/api/models', 'POST', { api_url: 'https://model.invalid', api_key: testPassword(), model_name: 'fixture' })).status, 403);
  await admin('/api/project-admin-assignments', 'PUT', { user_id: user.id, repository_ids: [] });
  assert.deepEqual((await project('/api/events')).value.events, []);
  assert.deepEqual((await project('/api/repositories')).value.repositories, []);
});

test('API keys, private keys, and account tokens never appear in read or write responses', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  const password = testPassword(); await admin('/api/users', 'POST', { username: 'project', password, repository_ids: ['101'] });
  const project = h.client(); await project('/api/auth/login', 'POST', { username: 'project', password });
  const apiKey = randomBytes(24).toString('hex');
  let response = await project('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: apiKey, model_name: 'fixture' });
  assert.equal(response.status, 201); assert.equal(response.value.model.trusted, true);
  assert.ok(!JSON.stringify(response.value).includes(apiKey)); const model = response.value.model;
  const ciphertext = h.store.get('SELECT api_key FROM models WHERE id=?', model.id).api_key;
  assert.ok(!ciphertext.includes(apiKey));
  response = await project('/api/models/' + model.id, 'PATCH', { version: 1, api_key: '   ', model_name: 'renamed' });
  assert.equal(response.status, 200); assert.equal(h.store.get('SELECT api_key FROM models WHERE id=?', model.id).api_key, ciphertext);
  assert.equal((await project('/api/models/' + model.id, 'PATCH', { version: 1, model_name: 'stale' })).status, 409);
  for (const path of ['/api/models', '/api/models/' + model.id]) {
    const value = JSON.stringify((await project(path)).value); assert.ok(!value.includes(apiKey)); assert.ok(!value.includes(ciphertext));
  }
  assert.equal((await project('/api/models/' + model.id + '/credentials/revoke', 'POST', {})).value.model.key_configured, false);
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const app = await account(admin, { type: 'github_app', app_id: '123', private_key: privateKey, token: undefined });
  for (const path of ['/api/accounts', '/api/accounts/' + app.id, '/api/accounts/' + a.id, '/api/audit']) {
    const value = JSON.stringify((await admin(path)).value);
    for (const secret of [apiKey, a.token, a.secret, privateKey, h.store.get('SELECT credentials FROM accounts WHERE id=?', app.id).credentials]) assert.ok(!value.includes(secret));
  }
  assert.equal(h.store.secrets.open(h.store.get('SELECT credentials FROM accounts WHERE id=?', app.id).credentials, `account:${app.id}`).private_key, privateKey.trim());
  await h.stop();
  for (const secret of [apiKey, a.token, privateKey.trim()]) assert.ok(!readFileSync(h.database).includes(Buffer.from(secret)));
  await h.start();
});

test('verified delivery, body, response and dedupe key commit before HTTP success; duplicates remain archived', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  const raw = '{ "action": "opened", "repository": {"id":101}, "issue":{"number":1} }';
  const result = await h.hook(a.path, a.secret, 'delivery-1', raw);
  assert.equal(result.status, 200); assert.equal(result.value.tasks_created, 0);
  const independent = new DatabaseSync(h.database);
  const row = independent.prepare('SELECT * FROM deliveries WHERE id=?').get(result.value.record_id);
  assert.equal(Buffer.from(row.payload).toString(), raw); assert.deepEqual(JSON.parse(row.response), result.value);
  assert.equal(independent.prepare('SELECT count(*) n FROM processed_deliveries').get().n, 1); independent.close();
  const duplicate = await h.hook(a.path, a.secret, 'delivery-1', raw);
  assert.equal(duplicate.value.duplicate, true); assert.equal(h.store.get('SELECT count(*) n FROM deliveries').n, 2);
  await h.stop(); await h.start();
  assert.equal((await h.hook(a.path, a.secret, 'delivery-1', raw)).value.duplicate, true);
  const b = await account(admin);
  assert.equal((await h.hook(b.path, b.secret, 'delivery-1', raw)).value.duplicate, false);
});

test('storage failure returns 503 without consuming delivery; retry can succeed', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  h.store.db.exec("CREATE TRIGGER fail_commit BEFORE INSERT ON processed_deliveries BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.equal((await h.hook(a.path, a.secret, 'retryable', {})).status, 503);
  assert.equal(h.store.get('SELECT count(*) n FROM deliveries').n, 0);
  assert.equal(h.store.get('SELECT count(*) n FROM processed_deliveries').n, 0);
  h.store.db.exec('DROP TRIGGER fail_commit');
  const result = await h.hook(a.path, a.secret, 'retryable', {});
  assert.equal(result.status, 200); assert.equal(result.value.duplicate, false);
});

test('signature validation precedes parsing and repository association, failed deliveries are archived and never deduplicated', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const invalid = await h.hook(a.path, testPassword(), 'signature', { repository: { id: 101 } }, { Authorization: 'sensitive-header' });
  assert.equal(invalid.status, 401);
  const row = h.store.get('SELECT * FROM deliveries WHERE id=?', invalid.value.record_id);
  assert.equal(row.repository_id, null); assert.ok(!row.request_headers.includes('sensitive-header')); assert.ok(!row.request_headers.includes('sha256='));
  assert.equal(h.store.get('SELECT count(*) n FROM processed_deliveries').n, 0);
  assert.equal((await h.hook(a.path, a.secret, 'signature', {})).value.duplicate, false);
  assert.equal((await h.hook(a.path, a.secret, 'bad-json', '{')).status, 400);
  assert.equal((await h.hook(a.path, a.secret, 'large', 'x'.repeat(3000))).status, 413);
  const revoked = await admin(`/api/accounts/${a.id}/endpoints/${a.endpoints[0].id}`, 'PATCH', { revoke: true }); assert.equal(revoked.status, 200);
  assert.equal((await h.hook(a.path, a.secret, 'revoked', {})).status, 401);
});

test('empty repository configuration only archives, and policy flags do not pretend an executor exists', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  assert.deepEqual((await admin('/api/repositories')).value.repositories, []);
  const result = await h.hook(a.path, a.secret, 'opened', { action: 'opened', repository: { id: 987 }, issue: { number: 1, body: 'Please implement this' } });
  assert.equal(result.status, 200); assert.equal(result.value.tasks_created, 0);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 0); assert.equal(h.store.get('SELECT repository_id FROM deliveries').repository_id, null);
  await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true });
  await h.hook(a.path, a.secret, 'enabled', { action: 'opened', repository: { id: 101 } });
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 0);
  assert.deepEqual((await admin('/api/status')).value, { review_available: false, development_available: false, project_environments_available: false, model_calls_available: false });
  assert.equal((await fetch(h.webhook + '/api/users')).status, 404);
});

test('authentication, CSRF, origin and strict input checks guard management mutations', async t => {
  const h = await harness(t), { admin } = await setup(h);
  assert.equal((await h.client()('/api/accounts')).status, 401);
  assert.equal((await admin('/api/users', 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await admin('/api/users', 'POST', {}, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await admin('/api/accounts', 'POST', { unexpected: 'value' })).status, 400);
  const me = (await admin('/api/auth/me')).value;
  assert.equal((await admin('/api/users/' + me.id, 'PATCH', { active: false })).status, 409);
  assert.equal((await admin('/api/users/' + me.id, 'PATCH', { role: 'super_admin' })).status, 400);
  assert.equal((await h.client()('/api/auth/login', 'POST', { username: 'administrator', password: testPassword() })).status, 401);
});

test('shared model access requires explicit project grants and never grants credential editing', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  const password = testPassword(); await admin('/api/users', 'POST', { username: 'member', password, repository_ids: ['101'] });
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'member', password });
  const key = testPassword();
  const model = (await admin('/api/models', 'POST', { api_url: 'https://model.invalid', api_key: key, model_name: 'shared' })).value.model;
  assert.equal((await member('/api/models/' + model.id)).status, 404);
  await admin(`/api/models/${model.id}/projects`, 'PUT', { repository_ids: ['101'] });
  const list = (await member('/api/models')).value.models;
  assert.deepEqual(list.map(r => r.id), [model.id]); assert.ok(!JSON.stringify(list).includes(key));
  assert.equal((await member(`/api/models/${model.id}/credentials/revoke`, 'POST', {})).status, 403);
  assert.equal((await member(`/api/models/${model.id}/projects`, 'PUT', { repository_ids: ['202'] })).status, 403);
  assert.equal((await member(`/api/models/${model.id}`, 'PATCH', { version: 1, api_key: testPassword() })).status, 403);
  assert.equal((await member('/api/repositories/101/policy', 'PATCH', { model_id: model.id })).status, 200);
  assert.equal((await admin('/api/repositories/202/policy', 'PATCH', { model_id: model.id })).status, 400);
  await admin(`/api/models/${model.id}/projects`, 'PUT', { repository_ids: [] });
  assert.equal((await member('/api/models/' + model.id)).status, 404);
  const b = await account(admin);
  await h.hook(b.path, b.secret, 'other-account', { repository: { id: 101 } });
  assert.equal(h.store.get("SELECT repository_id FROM deliveries WHERE delivery_id='other-account'").repository_id, null);
  assert.deepEqual((await member('/api/events')).value.events, []);
});
