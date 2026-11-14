import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, testPassword } from './helpers.mjs';

// #547: the global user list has to say, from the server's own records, how each account can sign in — a local password,
// a GitHub identity, both — and what state that GitHub binding is in. The browser must never infer any of it from whether
// a display name happens to exist: a pending verification and a revoked binding both read as "there is a name" today.
const identity = (h, principal, login, status) => h.store.run(`INSERT INTO external_identities(id,principal_id,provider,host,
  connector,external_tenant,external_actor,display_name,status,verified_at) VALUES(?,?,'github','github.com','','',?,?,?,?)`,
  'ext-' + principal, principal, 'gh-' + principal, login, status, Date.now());
const create = async (admin, username) => {
  const created = await admin('/api/users', 'POST', { username, password: testPassword() });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  return created.value.user;
};
const rows = async admin => Object.fromEntries((await admin('/api/users')).value.users.map(user => [user.username, user]));

test('the user projection names each account\'s login methods and its GitHub binding state', async t => {
  const h = await harness(t), { admin } = await setup(h);
  const mike = await create(admin, 'mike');                      // local only
  const bob = await create(admin, 'bob'); identity(h, bob.id, 'bob-dev', 'active');       // local + GitHub, bound
  const carol = await create(admin, 'carol'); identity(h, carol.id, 'carol-gh', 'pending_verification');
  const dave = await create(admin, 'dave'); identity(h, dave.id, 'dave-gh', 'revoked');   // unbound again
  // A GitHub-only account: an opaque local name and the external-only sentinel in place of a password.
  h.store.run("INSERT INTO users(id,username,password_hash,role) VALUES('gh-zoe','github:9001:abcd1234','!external-only','project_admin')");
  identity(h, 'gh-zoe', 'octozoe', 'active');
  // Same visible name, no binding: two separate accounts, never one row.
  const zoe = await create(admin, 'zoe');
  const erin = await create(admin, 'erin'); identity(h, erin.id, 'erin-gh', 'pending_verification');
  assert.equal((await admin(`/api/users/${erin.id}`, 'PATCH', { active: false })).status, 200);

  const list = await rows(admin);
  assert.deepEqual([list.mike.local_login, list.mike.login_methods, list.mike.github, list.mike.github_binding], [true, ['local'], null, 'none']);
  assert.equal(list.mike.display_name, 'mike');
  assert.deepEqual(list.bob.login_methods, ['local', 'github']);
  assert.deepEqual(list.bob.github, { login: 'bob-dev', status: 'active' });
  assert.equal(list.bob.github_binding, 'bound');
  assert.equal(list.bob.display_name, '@bob-dev');
  assert.equal(list.carol.github_binding, 'pending_verification');
  assert.deepEqual(list.carol.github, { login: 'carol-gh', status: 'pending_verification' });
  // Unbound again: the row says so and does not keep showing the login the administrator just removed.
  assert.equal(list.dave.github_binding, 'revoked');
  assert.deepEqual(list.dave.github, { status: 'revoked' });
  assert.deepEqual(list.dave.login_methods, ['local']);
  // A GitHub-only user has no local password, and its placeholder name is not a local account.
  const zoeGithub = list['github:9001:abcd1234'];
  assert.equal(zoeGithub.local_login, false);
  assert.deepEqual(zoeGithub.login_methods, ['github']);
  assert.equal(zoeGithub.display_name, '@octozoe');
  assert.equal(zoeGithub.local_account, null);
  assert.deepEqual(list.zoe.login_methods, ['local']);
  assert.equal(list.zoe.github_binding, 'none');
  // A disabled account still reports its binding: switching an account off is not unbinding it.
  assert.equal(list.erin.active, false);
  assert.equal(list.erin.github_binding, 'pending_verification');
  assert.equal(list.erin.access.github_pending, true);
  // The list is ordered by what an administrator reads, not by the internal placeholder name, which sorts under "g".
  const shown = (await admin('/api/users')).value.users.map(user => user.display_name);
  assert.deepEqual(shown, [...shown].sort((left, right) => left.localeCompare(right, 'zh-CN')));
  assert.ok(shown.indexOf('@octozoe') > shown.indexOf('mike'), shown.join(','));
  // Nothing secret reaches the page: no password digest, no credential blob, no token.
  const text = JSON.stringify((await admin('/api/users')).value);
  assert.doesNotMatch(text, /!external-only|password_hash|credentials|access_token|refresh_token/);
  assert.ok(mike.id && zoe.id);
});
