import test from 'node:test';
import assert from 'node:assert/strict';
import { validVersion, compareVersions } from '../dist/releases/version.js';
import { releaseWorkflow, filter } from '../dist/releases/workflow.js';
import { noCI, noRelease } from '../dist/releases/preflight.js';
import { releaseFixture, workflow, writes } from './release-fixtures.mjs';
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
