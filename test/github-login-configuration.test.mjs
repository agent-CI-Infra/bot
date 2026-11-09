import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { identityFixture } from './identity-fixture.mjs';
import { GitHubLogin } from '../dist/identity/github-login.js';
import { Onboarding } from '../dist/onboarding/service.js';
import { generateKeyPairSync } from 'node:crypto';
import { session } from '../dist/app/auth.js';
import { authorize, listEffectiveScopes, resolveActor } from '../dist/identity/authorization.js';

const path = '/api/onboarding/github-login';
test('super administrators configure login at runtime, preserve a write-only secret and retain configuration after restart', async t => {
  const h = await harness(t), { admin, password } = await setup(h), origin = h.admin, secret = testPassword();
  assert.equal((await admin('/api/auth/github/status')).value.enabled, false);
  const saved = await admin(path, 'PUT', { enabled: true, client_id: 'Iv1.fixture', client_secret: secret, admin_origin: origin });
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
  const config = { enabled: true, client_id: 'fixture', client_secret: testPassword(), admin_origin: h.admin };
  assert.equal((await h.client()('/api/onboarding')).status, 401);
  assert.equal((await member('/api/onboarding')).status, 403);
  assert.equal((await member(path, 'PUT', config)).status, 403);
  assert.equal((await admin(path, 'PUT', config, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await admin(path, 'PUT', config, { Origin: 'https://other.invalid' })).status, 403);
  for (const origin of ['http://public.invalid', 'https://admin.invalid/path', 'https://user:password@admin.invalid', 'https://admin.invalid?query=1'])
    assert.equal((await admin(path, 'PUT', { ...config, admin_origin: origin })).status, 400);
  assert.equal((await admin(path, 'PUT', { ...config, enabled: 'true' })).status, 400);
  assert.equal((await admin(path, 'PUT', { enabled: true, client_id: 'fixture', admin_origin: h.admin })).value.error, 'github_login_secret_required');
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
  const config = { enabled: true, client_id: 'fixture-client', client_secret: 'fixture-secret', admin_origin: h.admin };
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
  const manifest = await admin('/api/onboarding/manifest', 'POST', { organization: 'fixture', name: 'new-app' });
  const state = new URL(manifest.value.create_url).searchParams.get('state'); await onboarding.callback('manifest-code', state);
  const before = (await admin('/api/onboarding')).value.github_login;
  assert.equal(before.client_id, 'Iv1.new-app'); assert.equal(before.secret_configured, true); assert.equal(before.enabled, false);
  assert.equal((await admin(path, 'PUT', { enabled: true })).status, 200);
  const visible = JSON.stringify([(await admin('/api/onboarding')).value, (await admin('/api/accounts')).value]);
  assert.ok(!visible.includes(secret)); assert.ok(!visible.includes(pem));
  await admin(path, 'PUT', { enabled: false, revoke_secret: true });
  const row = h.store.get("SELECT id,credentials FROM accounts WHERE app_id='123'");
  const credentials = h.store.secrets.open(row.credentials, 'account:' + row.id);
  assert.equal(credentials.oauth_client_secret, undefined); assert.equal(credentials.private_key, pem);
  assert.equal((await admin('/api/onboarding')).value.github_login.secret_configured, false);
});

test('disabling login during callback permission verification cannot issue a new session', async t => {
  const f = await identityFixture(t, { wizardOnly: true }), { h, admin } = f;
  await admin(path, 'PUT', { enabled: true, client_id: 'fixture-client', client_secret: 'fixture-secret', admin_origin: h.admin });
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
  await admin(path, 'PUT', { enabled: true, client_id: 'fixture-client', client_secret: 'fixture-secret', admin_origin: h.admin });
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
