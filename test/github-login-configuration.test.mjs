import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { identityFixture } from './identity-fixture.mjs';
import { GitHubLogin } from '../dist/identity/github-login.js';
import { Onboarding } from '../dist/onboarding/service.js';
import { generateKeyPairSync } from 'node:crypto';
import { session } from '../dist/app/auth.js';
import { authorize, listEffectiveScopes, resolveActor } from '../dist/identity/authorization.js';

const path = '/api/onboarding/github-login';
// A wizard configuration saved before the single entry, as an upgraded deployment still has it.
const legacyConfiguration = (h, origin, extra = {}) => h.store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'identity.github_login',
  h.store.secrets.seal({ enabled: false, client_id: '', client_secret: '', admin_origin: origin, account_id: null, ...extra }, 'identity.github_login'));
// fetch cannot set Host, and the Origin rules depend on it; these requests go through node:http with the client's session.
const hostRequest = (client, method, target, headers, data) => new Promise((resolve, reject) => {
  const req = request(new URL(client.harness.admin + target), { method, headers: { 'Content-Type': 'application/json', Cookie: client.cookie(), 'X-CSRF-Token': client.csrf(), ...headers } }, res => {
    let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text || '{}') }));
  });
  req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
});
const verify = (h, origin) => h.store.run("INSERT INTO settings VALUES('onboarding.public',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ origin, checked_at: new Date().toISOString() }));

test('writes stay possible from the deployment origin, the verified entry, a pre-migration console address and this machine', async t => {
  for (const publicOrigin of [undefined, 'https://deployment.invalid']) {
    const h = await harness(t, undefined, { publicOrigin }), { password } = await setup(h);
    const settings = (client, value, headers) => client('/api/settings', 'PATCH', { task_concurrency: value }, headers);
    // A browser on this machine can always log in and write, whichever origin the deployment names; the cookie stays usable over HTTP.
    const recovery = h.client(), login = await recovery('/api/auth/login', 'POST', { username: 'administrator', password }, { Origin: h.admin });
    assert.equal(login.status, 200); assert.ok(!login.headers.get('set-cookie').includes('; Secure'));
    assert.equal((await settings(recovery, 2, { Origin: h.admin })).status, 200);
    if (publicOrigin) assert.equal((await settings(recovery, 2, { Origin: publicOrigin })).status, 200);
    legacyConfiguration(h, 'https://console.invalid');
    assert.equal((await settings(recovery, 3, { Origin: 'https://console.invalid' })).status, 200);
    verify(h, 'https://bot.invalid');
    const entry = await h.client()('/api/auth/login', 'POST', { username: 'administrator', password }, { Origin: 'https://bot.invalid' });
    assert.equal(entry.status, 200); assert.match(entry.headers.get('set-cookie'), /; Secure/);
    assert.equal((await settings(recovery, 4, { Origin: 'https://bot.invalid' })).status, 200);
    assert.equal((await settings(recovery, 5, { Origin: 'https://other.invalid' })).value.error, 'origin_forbidden');
    // A deployment origin replaces the Host-derived one, so a rebound host name cannot write; a loopback Host always can.
    const rebound = await hostRequest(recovery, 'PATCH', '/api/settings', { Origin: 'http://rebound.invalid', Host: 'rebound.invalid' }, { task_concurrency: 6 });
    assert.equal(rebound.status, publicOrigin ? 403 : 200);
    assert.equal((await hostRequest(recovery, 'PATCH', '/api/settings', { Origin: 'http://localhost:9', Host: 'localhost:9' }, { task_concurrency: 7 })).status, 200);
  }
});

test('the login callback follows the single entry and points out a callback saved for another address', async t => {
  const h = await harness(t), { admin } = await setup(h), callback = origin => origin + '/auth/github/callback';
  const redirect = async () => new URL((await fetch(h.admin + '/auth/github/start', { redirect: 'manual' })).headers.get('location')).searchParams.get('redirect_uri');
  // Before a public address exists, the callback stays on the origin the configuration was saved from.
  const saved = (await admin(path, 'PUT', { enabled: true, client_id: 'Iv1.fixture', client_secret: testPassword() })).value.github_login;
  assert.equal(saved.callback_url, callback(h.admin)); assert.equal(saved.origin_source, 'local'); assert.equal(saved.previous_callback_url, undefined);
  assert.equal(await redirect(), callback(h.admin));
  // Verifying the public address moves the live callback at once; the page names the old one until the configuration is saved again.
  verify(h, 'https://bot.invalid');
  let view = (await admin('/api/onboarding')).value.github_login;
  assert.equal(view.callback_url, callback('https://bot.invalid')); assert.equal(view.origin_source, 'public_address');
  assert.equal(view.previous_callback_url, callback(h.admin)); assert.equal(await redirect(), callback('https://bot.invalid'));
  view = (await admin(path, 'PUT', { enabled: true })).value.github_login;
  assert.equal(view.previous_callback_url, undefined); assert.equal(view.callback_url, callback('https://bot.invalid'));
  // An upgraded configuration that named a separate console domain keeps its credentials and is told to update the App.
  legacyConfiguration(h, 'https://console.invalid', { enabled: true, client_id: 'Iv1.fixture', client_secret: testPassword() });
  view = (await admin('/api/onboarding')).value.github_login;
  assert.equal(view.enabled, true); assert.equal(view.callback_url, callback('https://bot.invalid')); assert.equal(view.previous_callback_url, callback('https://console.invalid'));
  assert.equal(await redirect(), callback('https://bot.invalid'));
  assert.equal((await admin(path, 'PUT', { enabled: true, admin_origin: 'https://console.invalid' })).value.error, 'unknown_field');
});

test('a deployment BOT_PUBLIC_ORIGIN is the callback until the wizard verifies an address', async t => {
  const h = await harness(t, undefined, { publicOrigin: 'https://deployment.invalid' }), { admin } = await setup(h);
  let view = (await admin(path, 'PUT', { enabled: true, client_id: 'Iv1.fixture', client_secret: testPassword() })).value.github_login;
  assert.equal(view.callback_url, 'https://deployment.invalid/auth/github/callback'); assert.equal(view.origin_source, 'deployment');
  verify(h, 'https://bot.invalid'); view = (await admin('/api/onboarding')).value.github_login;
  assert.equal(view.callback_url, 'https://bot.invalid/auth/github/callback'); assert.equal(view.previous_callback_url, 'https://deployment.invalid/auth/github/callback');
});

test('super administrators configure login at runtime, preserve a write-only secret and retain configuration after restart', async t => {
  const h = await harness(t), { admin, password } = await setup(h), origin = h.admin, secret = testPassword();
  assert.equal((await admin('/api/auth/github/status')).value.enabled, false);
  const saved = await admin(path, 'PUT', { enabled: true, client_id: 'Iv1.fixture', client_secret: secret });
  assert.equal(saved.status, 200); assert.equal(saved.value.github_login.secret_configured, true);
  assert.equal((await admin('/api/auth/github/status')).value.enabled, true);
  const first = await fetch(h.admin + '/auth/github/start', { redirect: 'manual' }); assert.equal(first.status, 303);
  const authorize = new URL(first.headers.get('location'));
  assert.equal(authorize.searchParams.get('client_id'), 'Iv1.fixture'); assert.equal(authorize.searchParams.get('redirect_uri'), origin + '/auth/github/callback');
  assert.ok(!JSON.stringify(saved.value).includes(secret)); assert.ok(!JSON.stringify((await admin('/api/onboarding')).value).includes(secret));
  assert.ok(!h.store.get("SELECT value FROM settings WHERE key='identity.github_login'").value.includes(secret));
  assert.ok(!readFileSync(h.database).includes(Buffer.from(secret)));
  assert.equal((await admin(path, 'PUT', { enabled: true, client_secret: '' })).value.github_login.secret_configured, true);
  assert.equal((await admin(path, 'PUT', { enabled: true, client_id: 'different-client' })).value.error, 'github_login_secret_required');
  assert.equal((await admin('/api/onboarding')).value.github_login.client_id, 'Iv1.fixture');
  assert.equal(h.store.secrets.open(h.store.get("SELECT value FROM settings WHERE key='identity.github_login'").value, 'identity.github_login').client_secret, secret);
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='github_login.configured'"));
  await h.stop(); await h.start();
  assert.equal((await admin('/api/auth/github/status')).value.enabled, true);
  assert.equal((await admin('/api/onboarding')).value.github_login.callback_url, origin + '/auth/github/callback');
  assert.equal((await admin(path, 'PUT', { enabled: false, revoke_secret: true })).value.github_login.secret_configured, false);
  assert.equal((await admin('/api/auth/github/status')).value.enabled, false);
  assert.equal((await fetch(h.admin + '/auth/github/start')).status, 503);
  const recovery = h.client(); assert.equal((await recovery('/api/auth/login', 'POST', { username: 'administrator', password })).status, 200);
});

test('onboarding and OAuth secrets are restricted to platform super administrators with CSRF and origin checks', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const password = testPassword(); await admin('/api/users', 'POST', { username: 'tenant-admin', password, organization_ids: ['10'] });
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'tenant-admin', password });
  const config = { enabled: true, client_id: 'fixture', client_secret: testPassword() };
  assert.equal((await h.client()('/api/onboarding')).status, 401);
  assert.equal((await member('/api/onboarding')).status, 403);
  assert.equal((await member(path, 'PUT', config)).status, 403);
  assert.equal((await admin(path, 'PUT', config, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await admin(path, 'PUT', config, { Origin: 'https://other.invalid' })).status, 403);
  // The callback address comes from the single entry; a separate console address is no longer accepted.
  assert.equal((await admin(path, 'PUT', { ...config, admin_origin: 'https://admin.invalid' })).value.error, 'unknown_field');
  // Enabling needs an HTTPS or loopback callback: a plain HTTP console on another host cannot enable GitHub login.
  assert.equal((await hostRequest(admin, 'PUT', path, { Origin: 'http://lan.invalid', Host: 'lan.invalid' }, config)).value.error, 'github_login_https_required');
  assert.equal((await admin(path, 'PUT', { ...config, enabled: 'true' })).status, 400);
  assert.equal((await admin(path, 'PUT', { enabled: true, client_id: 'fixture' })).value.error, 'github_login_secret_required');
  assert.equal((await admin(path, 'PUT', { ...config, secret_file: '/private' })).status, 400);
  assert.equal(h.store.get("SELECT 1 FROM settings WHERE key='identity.github_login'"), undefined);
});

test('deployment configuration remains usable and explicit disable does not reactivate it on restart', async t => {
  const h = await harness(t, undefined, { githubOAuth: { clientId: 'deployment', clientSecret: testPassword(), redirectUri: 'http://127.0.0.1/auth/github/callback' } });
  const { admin } = await setup(h); assert.equal((await admin('/api/auth/github/status')).value.enabled, true);
  assert.equal((await admin('/api/onboarding')).value.github_login.source, 'deployment');
  assert.equal((await admin(path, 'PUT', { enabled: false })).status, 200);
  await h.stop(); await h.start(); assert.equal((await admin('/api/auth/github/status')).value.enabled, false);
  const login = new GitHubLogin(h.store, { environment: () => { throw new Error('unused deployment secret must not be read'); } });
  assert.equal(login.identity, undefined);
});

test('reconfiguration invalidates outstanding and in-flight OAuth callbacks without creating an identity', async t => {
  const f = await identityFixture(t, { wizardOnly: true }), { h, admin } = f;
  const config = { enabled: true, client_id: 'fixture-client', client_secret: 'fixture-secret' };
  assert.equal((await admin(path, 'PUT', config)).status, 200);
  const identity = f.githubLogin.identity, begun = new URL(identity.begin('browser', 'login').url);
  const authorized = await fetch(begun, { redirect: 'manual' }), callback = new URL(authorized.headers.get('location'));
  let entered, release; const waiting = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  f.state.exchangeGate = async () => { entered(); await gate; };
  const completing = identity.callback('browser', callback.searchParams.get('state'), callback.searchParams.get('code'));
  await waiting;
  assert.equal((await admin(path, 'PUT', { ...config, client_secret: 'rotated-fixture' })).status, 200);
  release(); await assert.rejects(completing, /github_login_configuration_changed/);
  assert.equal(h.store.get('SELECT count(*) n FROM external_identities').n, 0);
  await assert.rejects(identity.callback('browser', callback.searchParams.get('state'), callback.searchParams.get('code')), /invalid_oauth_state/);
});

test('new App credentials are reused privately by the wizard and an explicit clear removes both saved copies', async t => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), secret = testPassword();
  let onboarding;
  const h = await harness(t, undefined, store => ({ onboarding: onboarding = new Onboarding(store, { fetcher: async () => new Response(JSON.stringify({
    id: 123, slug: 'new-app', pem, webhook_secret: testPassword(), client_id: 'Iv1.new-app', client_secret: secret,
  })) }) }));
  const { admin } = await setup(h); onboarding.save('public', { origin: 'https://hooks.invalid' });
  await admin(path, 'PUT', { enabled: true, client_id: 'Iv1.old-app', client_secret: testPassword() });
  const manifest = await admin('/api/onboarding/manifest', 'POST', { organization: 'fixture', name: 'new-app' });
  const state = new URL(manifest.value.create_url).searchParams.get('state'); await onboarding.callback('manifest-code', state);
  const before = (await admin('/api/onboarding')).value.github_login;
  assert.equal(before.client_id, 'Iv1.new-app'); assert.equal(before.secret_configured, true); assert.equal(before.enabled, false);
  assert.equal(before.source, 'app'); assert.equal(before.account_id, onboarding.saved('app').account_id);
  const clientId = async () => new URL((await fetch(h.admin + '/auth/github/start', { redirect: 'manual' })).headers.get('location')).searchParams.get('client_id');
  assert.equal(await clientId(), 'Iv1.old-app');
  assert.equal((await admin(path, 'PUT', { enabled: true, client_id: 'Iv1.old-app' })).value.error, 'github_login_app_changed');
  assert.equal((await admin(path, 'PUT', { enabled: true })).status, 200);
  assert.equal(await clientId(), 'Iv1.new-app');
  assert.equal(h.store.secrets.open(h.store.get("SELECT value FROM settings WHERE key='identity.github_login'").value, 'identity.github_login').client_secret, secret);
  const visible = JSON.stringify([(await admin('/api/onboarding')).value, (await admin('/api/accounts')).value]);
  assert.ok(!visible.includes(secret)); assert.ok(!visible.includes(pem));
  await admin(path, 'PUT', { enabled: false, revoke_secret: true });
  const row = h.store.get("SELECT id,credentials FROM accounts WHERE app_id='123'");
  const credentials = h.store.secrets.open(row.credentials, 'account:' + row.id);
  assert.equal(credentials.oauth_client_secret, undefined); assert.equal(credentials.private_key, pem);
  assert.equal((await admin('/api/onboarding')).value.github_login.secret_configured, false);
});

test('a new App without OAuth credentials requires its own Client ID and never reuses the old App secret', async t => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  let onboarding;
  const h = await harness(t, undefined, store => ({ onboarding: onboarding = new Onboarding(store, { fetcher: async () => new Response(JSON.stringify({
    id: 456, slug: 'unconfigured-app', pem, webhook_secret: testPassword(),
  })) }) }));
  const { admin } = await setup(h); onboarding.save('public', { origin: 'https://hooks.invalid' });
  await admin(path, 'PUT', { enabled: true, client_id: 'Iv1.old-app', client_secret: testPassword() });
  const manifest = await admin('/api/onboarding/manifest', 'POST', { organization: 'fixture', name: 'unconfigured-app' });
  await onboarding.callback('manifest-code', new URL(manifest.value.create_url).searchParams.get('state'));
  const draft = (await admin('/api/onboarding')).value.github_login;
  assert.equal(draft.client_id, ''); assert.equal(draft.secret_configured, false); assert.equal(draft.enabled, false);
  assert.equal((await admin(path, 'PUT', { enabled: true })).value.error, 'github_client_id_required');
  assert.equal((await admin(path, 'PUT', { enabled: true, client_id: 'Iv1.old-app' })).value.error, 'github_login_secret_required');
  assert.equal((await admin(path, 'PUT', { enabled: true, client_id: 'Iv1.new-app', client_secret: testPassword() })).status, 200);
  const started = await fetch(h.admin + '/auth/github/start', { redirect: 'manual' });
  assert.equal(new URL(started.headers.get('location')).searchParams.get('client_id'), 'Iv1.new-app');
});

test('disabling login during callback permission verification cannot issue a new session', async t => {
  const f = await identityFixture(t, { wizardOnly: true }), { h, admin } = f;
  await admin(path, 'PUT', { enabled: true, client_id: 'fixture-client', client_secret: 'fixture-secret' });
  const identity = f.githubLogin.identity, begun = new URL(identity.begin('browser', 'login').url);
  const response = await fetch(begun, { redirect: 'manual' }), callback = new URL(response.headers.get('location'));
  let entered, release; const waiting = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  f.state.apiGate = async path => { if (path === '/user/installations') { entered(); await gate; } };
  const completing = identity.callback('browser', callback.searchParams.get('state'), callback.searchParams.get('code'));
  await waiting;
  assert.equal((await admin(path, 'PUT', { enabled: false })).status, 200);
  release(); await assert.rejects(completing, /github_login_configuration_changed/);
  const identityRow = h.store.get('SELECT * FROM external_identities');
  assert.equal(identityRow.credentials, null);
  assert.equal(h.store.get('SELECT count(*) n FROM sessions WHERE identity_id=?', identityRow.id).n, 0);
  assert.equal(listEffectiveScopes(h.store, identityRow.principal_id).some(g => g.state === 'active'), false);
});

test('disabling login ends GitHub sessions and derived authority while retaining local sessions and explicit delegation', async t => {
  const f = await identityFixture(t, { wizardOnly: true }), { h, admin } = f;
  await admin(path, 'PUT', { enabled: true, client_id: 'fixture-client', client_secret: 'fixture-secret' });
  const identity = f.githubLogin.identity, begun = new URL(identity.begin('browser', 'login').url);
  const response = await fetch(begun, { redirect: 'manual' }), callback = new URL(response.headers.get('location'));
  const result = await identity.callback('browser', callback.searchParams.get('state'), callback.searchParams.get('code'));
  const externalSession = session(h.store, result.principal_id, result.identity_id), localSession = session(h.store, result.principal_id);
  assert.equal((await admin('/api/project-admin-assignments', 'PUT', { user_id: result.principal_id, repository_ids: ['101'] })).status, 200);
  const before = resolveActor(h.store, externalSession.token);
  authorize(before, 'config.write', { project_id: '101' });
  assert.equal((await admin(path, 'PUT', { enabled: false })).status, 200);
  assert.throws(() => authorize(before, 'config.write', { project_id: '101' }), /authorization_changed/);
  assert.throws(() => resolveActor(h.store, externalSession.token), /login_required/);
  assert.equal(h.store.get('SELECT credentials FROM external_identities WHERE id=?', result.identity_id).credentials, null);
  const scopes = listEffectiveScopes(h.store, result.principal_id).filter(g => g.state === 'active');
  assert.equal(scopes.some(g => g.source === 'github_derived'), false);
  assert.equal(scopes.some(g => g.source === 'explicit_delegation'), true);
  authorize(resolveActor(h.store, localSession.token), 'config.write', { project_id: '101' });
  assert.equal((await admin('/api/onboarding')).status, 200);
});
