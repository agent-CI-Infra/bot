import test from 'node:test';
import assert from 'node:assert/strict';
import { validVersion, compareVersions } from '../dist/releases/version.js';
import { releaseWorkflow, filter } from '../dist/releases/workflow.js';
import { noCI, noRelease } from '../dist/releases/preflight.js';
import { releaseFixture, workflow, writes, target, other, tagObject } from './release-fixtures.mjs';
import { Store } from '../dist/storage/database.js';
import { ReleaseService } from '../dist/releases/service.js';
import { testPassword } from './helpers.mjs';

test('release versions and precedence follow SemVer without metadata or precision loss', () => {
  for (const v of ['v0.1.0', 'v1.2.3-beta', 'v1.2.3-beta.1', 'v1.2.3-rc.1', 'v999999999999999999.0.0']) assert.ok(validVersion(v), v);
  for (const v of ['v01.2.3', 'v1.2.3-', 'v1.2.3-beta.01', 'v1', '1.2.3', 'v1.2', 'v1.2.3+build', ' v1.2.3', 'v1.2.3-a..b']) assert.ok(!validVersion(v), v);
  assert.ok(compareVersions('v1.2.3-beta.10', 'v1.2.3-beta.2') > 0);
  assert.ok(compareVersions('v1.2.3', 'v1.2.3-rc.1') > 0);
});
test('release workflow parses YAML and applies ordered GitHub tag filters', () => {
  assert.ok(releaseWorkflow(workflow, 'v1.2.3-beta.1').matched);
  assert.ok(!releaseWorkflow(workflow.replace("['v*']", "['v*', '!v*-beta*']"), 'v1.2.3-beta.1').matched);
  assert.ok(filter(['v*', '!v*-beta*', 'v1.2.3-beta.1'], 'v1.2.3-beta.1').matched);
  assert.ok(filter(['v[0-9]+.[0-9]+.[0-9]+'], 'v12.345.6').matched);
  for (const content of ['on: workflow_dispatch', 'on:\n  push:\n    branches: [main]', 'on: [', '# v*\non: workflow_dispatch']) assert.throws(() => releaseWorkflow(content, 'v1.2.3'));
});
test('release preflight checks immutable files, beta exclusions and diagnostic failures without writes', async t => {
  const f = await releaseFixture(t);
  assert.ok((await f.preview('v1.2.3-beta.1')).available);
  assert.equal((await f.preview('v01.2.3')).available, false);
  delete f.state.files['.github/ci-gates.json'];
  assert.equal((await f.preview()).checks[0].message, noCI);
  f.state.files['.github/ci-gates.json'] = '{}'; delete f.state.files['.github/workflows/release.yml'];
  assert.equal((await f.preview()).checks[1].message, noRelease);
  f.state.files['.github/workflows/release.yml'] = workflow.replace("['v*']", "['v*', '!v*-beta*']");
  const beta = await f.preview('v1.2.3-beta.1'); assert.equal(beta.available, false); assert.match(beta.checks[1].reason, /排除/);
  f.state.deny = '/repos/fixture/project-101/git/trees/' + 'a'.repeat(40);
  const denied = await f.preview(); assert.equal(denied.available, false); assert.match(denied.detail, /暂时无法检查/);
  assert.equal(writes(f.state).length, 0);
  assert.ok(f.state.tokens.every(token => Object.values(token.permissions).every(p => p === 'read')));
});
test('release endpoints enforce project and organization grants on every operation and CSRF', async t => {
  const f = await releaseFixture(t), password = testPassword();
  const user = (await f.admin('/api/users', 'POST', { username: 'release-admin', password, repository_ids: ['101'] })).value.user;
  const client = f.h.client(); await client('/api/auth/login', 'POST', { username: user.username, password });
  for (const [path, method] of [['', 'GET'], ['/preflight', 'GET'], ['/foreign', 'GET'], ['', 'POST'], ['/foreign/draft', 'PATCH'], ['/foreign/rerun', 'POST'], ['/foreign/publish', 'POST'], ['/foreign/observe', 'POST'], ['/foreign/resume', 'POST']])
    assert.equal((await client('/api/repositories/202/releases' + path, method, method === 'GET' ? undefined : {})).status, 403);
  assert.equal((await client(f.endpoint)).status, 200);
  assert.equal((await f.admin(f.endpoint, 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
  await f.admin('/api/project-admin-assignments', 'PUT', { user_id: user.id, repository_ids: [], organization_ids: ['10'] });
  assert.equal((await client('/api/repositories/202/releases')).status, 200);
});
test('confirmation binds the displayed SHA and preflight files, never silently advancing', async t => {
  const f = await releaseFixture(t), p = await f.preview(); f.state.head = other;
  assert.equal((await f.admin(f.endpoint, 'POST', { version: p.version, target_sha: p.target_sha, credential: p.credential })).status, 409);
  f.state.head = target; f.state.files['.github/workflows/release.yml'] += '\n# changed';
  assert.equal((await f.admin(f.endpoint, 'POST', { version: p.version, target_sha: target, credential: p.credential })).status, 409);
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 0);
  assert.equal(writes(f.state).length, 0);
});
test('concurrent confirmations and workers create one record and one annotated tag', async t => {
  const f = await releaseFixture(t), p = await f.preview();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.admin(f.endpoint, 'POST', { version: p.version, target_sha: target, credential: p.credential })));
  assert.ok(results.every(r => r.status === 201)); assert.equal(new Set(results.map(r => r.value.release.id)).size, 1);
  const id = results[0].value.release.id, secondStore = new Store(f.h.database, f.h.key), second = new ReleaseService(secondStore, f.apiUrl);
  try { await Promise.all([f.service.worker.process(id), second.worker.process(id)]); } finally { secondStore.close(); }
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 1);
  const mutations = writes(f.state);
  assert.equal(mutations.length, 2); assert.deepEqual(mutations[0].body, { tag: 'v1.2.3', message: 'v1.2.3', object: target, type: 'commit' });
  assert.deepEqual(mutations[1].body, { ref: 'refs/tags/v1.2.3', sha: tagObject });
  assert.equal(f.h.store.get('SELECT stage FROM project_releases WHERE id=?', id).stage, 'waiting_run');
  assert.ok(f.state.tokens.every(token => token.repository_ids.join() === '101' && !token.permissions.workflows && !token.permissions.administration));
});
test('same lightweight or annotated tag is reused and a conflicting tag is never moved', async t => {
  for (const type of ['commit', 'tag']) {
    const f = await releaseFixture(t); f.state.tags['v1.2.3'] = { type, sha: type === 'tag' ? tagObject : target, commit: target };
    const result = await f.create(); assert.equal(result.status, 201);
    await f.service.tick(); assert.equal((await f.admin(f.endpoint + '/' + result.value.release.id)).value.release.stage, 'waiting_run');
    assert.equal(writes(f.state).length, 0);
  }
  const f = await releaseFixture(t), r = await f.create(); f.state.tags['v1.2.3'] = { type: 'commit', sha: other };
  await f.service.tick(); const failed = (await f.admin(f.endpoint + '/' + r.value.release.id)).value.release;
  assert.equal(failed.error, 'release_tag_conflict'); assert.ok(failed.detail.includes(target) && failed.detail.includes(other)); assert.equal(writes(f.state).length, 0);
});
test('uncertain tag writes are reconciled and an unknown tag object is never posted twice after restart', async t => {
  const f = await releaseFixture(t); f.state.unknown = '/repos/fixture/project-101/git/refs';
  const r = await f.create(); await f.service.tick();
  assert.equal((await f.admin(f.endpoint + '/' + r.value.release.id)).value.release.stage, 'waiting_run');
  assert.equal(writes(f.state).filter(r => r.path.endsWith('/git/refs')).length, 1);
  const g = await releaseFixture(t); g.state.unknown = '/repos/fixture/project-101/git/tags'; const result = await g.create(); await g.service.tick();
  assert.equal((await g.admin(g.endpoint + '/' + result.value.release.id)).value.release.stage, 'write_unknown');
  const restarted = new ReleaseService(g.h.store, g.apiUrl); await restarted.tick();
  assert.equal(writes(g.state).filter(r => r.path.endsWith('/git/tags')).length, 1);
  assert.equal(g.h.store.get("SELECT state FROM release_effects WHERE kind='tag_object'").state, 'unknown');
});
