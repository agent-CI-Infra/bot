import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from './identity-fixture.mjs';

test('reverify surfaces GitHub reauthorization after recording pending state, and succeeds again once GitHub answers', async t => {
  const f = await identityFixture(t);
  const login = await f.login();
  const principal = login.result.principal_id;
  const identity = f.h.store.get("SELECT * FROM external_identities WHERE principal_id=? AND provider='github'", principal);
  assert.equal(identity.status, 'active');

  f.state.failure = 401;
  await assert.rejects(() => f.identity.reverify(principal), err => err.status === 401 && err.code === 'github_reauthorization_required');
  assert.equal(f.h.store.get("SELECT status FROM external_identities WHERE id=?", identity.id).status, 'pending_verification');

  f.state.failure = 0;
  await f.identity.reverify(principal);
  assert.equal(f.h.store.get("SELECT status FROM external_identities WHERE id=?", identity.id).status, 'active');
});

test('reverify surfaces a transport failure instead of finishing as a silent success', async t => {
  const f = await identityFixture(t);
  const login = await f.login();
  const principal = login.result.principal_id;
  const identity = f.h.store.get("SELECT id FROM external_identities WHERE principal_id=? AND provider='github'", principal);
  const previous = f.identity.config.apiUrl;
  // A closed local port fails immediately (no 15s GitHub timeout), the way a dropped connection does in production.
  f.identity.config.apiUrl = 'http://127.0.0.1:1';
  try {
    await assert.rejects(() => f.identity.reverify(principal), err => err.status === 502 && err.code === 'github_verification_unavailable');
  } finally { f.identity.config.apiUrl = previous; }
  assert.equal(f.h.store.get("SELECT status FROM external_identities WHERE id=?", identity.id).status, 'pending_verification');
});
