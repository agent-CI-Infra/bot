import test from 'node:test';
import assert from 'node:assert/strict';
import { validVersion, compareVersions } from '../dist/releases/version.js';
import { releaseWorkflow, filter } from '../dist/releases/workflow.js';
import { noCI, noRelease } from '../dist/releases/preflight.js';
import { releaseFixture, workflow, writes, target, other, tagObject, run } from './release-fixtures.mjs';
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
async function observe(f) { const r = await f.create(); await f.service.worker.process(r.value.release.id); await f.service.worker.process(r.value.release.id); return (await f.admin(f.endpoint + '/' + r.value.release.id)).value.release; }
const job = (overrides = {}) => ({ id: 1, run_id: 800, run_attempt: 1, name: 'release lane', status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project-101/actions/runs/800/job/1', ...overrides });
test('Actions binding rejects other workflows, other tags, dispatches, wrong repositories and older runs', async t => {
  const f = await releaseFixture(t);
  f.state.runs = [run({ workflow_id: 44 }), run({ head_branch: 'v9.0.0' }), run({ event: 'workflow_dispatch' }), run({ repository: { id: 202 } }), run({ created_at: '2020-01-01T00:00:00Z' })];
  const r = await observe(f); assert.equal(r.stage, 'waiting_run'); assert.equal(r.run_id, undefined); assert.match(r.detail, /等待 Release/);
  assert.ok(!writes(f.state).some(r => r.path.endsWith('/releases')));
});
test('Actions association ambiguity is diagnosed instead of guessing a successful run', async t => {
  const f = await releaseFixture(t); f.state.runs = [run(), run({ id: 801 })]; f.state.jobs = [job()];
  const r = await observe(f); assert.equal(r.error, 'release_run_ambiguous'); assert.equal(r.candidates.length, 2);
  const g = await releaseFixture(t); g.state.files['.github/workflows/release.yml'] = workflow.replace("tags: ['v*']", "tags: ['v*']\n    branches: ['v*']"); g.state.runs = [run()]; g.state.jobs = [job()];
  assert.equal((await observe(g)).error, 'release_run_ambiguous');
});
test('failed, cancelled, timed out, skipped and neutral jobs never advance to a draft', async t => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral']) {
    const f = await releaseFixture(t); f.state.runs = [run({ conclusion })]; f.state.jobs = conclusion === 'cancelled' ? [] : [job({ conclusion, steps: [{ number: 1, name: 'Build artifacts', conclusion }] })];
    const r = await observe(f); assert.equal(r.stage, 'failed'); assert.equal(r.error, 'release_ci_unsuccessful'); assert.ok(r.detail.includes(conclusion));
    assert.equal(r.run.conclusion, conclusion); assert.equal(r.run.jobs.length, f.state.jobs.length);
    await new ReleaseService(f.h.store, f.apiUrl).tick(); assert.ok(!writes(f.state).some(r => /rerun|releases$/.test(r.path)));
  }
});
test('only all jobs from the matching attempt allow progress; permission failures preserve Actions facts', async t => {
  const f = await releaseFixture(t); f.state.runs = [run()]; f.state.jobs = [job(), job({ id: 2, conclusion: 'skipped' })];
  assert.equal((await observe(f)).stage, 'failed');
  const g = await releaseFixture(t); g.state.runs = [run()]; g.state.jobs = [job()];
  g.state.deny = '/repos/fixture/project-101/actions/runs/800/attempts/1/jobs';
  const r = await observe(g); assert.equal(r.stage, 'waiting_permission'); assert.equal(r.run_id, 800); assert.ok(r.actions_url); assert.equal(r.error, 'github_permission_403');
  g.state.deny = ''; const resumed = await g.admin(g.endpoint + '/' + r.id + '/resume', 'POST', { revision: r.revision }); assert.equal(resumed.status, 201);
  await new ReleaseService(g.h.store, g.apiUrl).worker.process(r.id);
  assert.equal((await g.admin(g.endpoint + '/' + r.id)).value.release.stage, 'preparing_notes');
});
test('manual rerun keeps the bound run and tag and waits for a higher attempt', async t => {
  const f = await releaseFixture(t); f.state.runs = [run({ conclusion: 'failure' })]; f.state.jobs = [job({ conclusion: 'failure' })];
  const r = await observe(f), before = writes(f.state).length;
  f.state.custom = async ({ method, path, send }) => { if (path.endsWith('/rerun') && method === 'POST') { send({}, 201); return true; } };
  const rerun = await f.admin(f.endpoint + '/' + r.id + '/rerun', 'POST', { revision: r.revision }); assert.equal(rerun.status, 201);
  f.state.runs[0].conclusion = 'success'; f.state.jobs = [job()]; await f.service.worker.process(r.id);
  let current = (await f.admin(f.endpoint + '/' + r.id)).value.release; assert.equal(current.stage, 'running'); assert.equal(current.ci_success, null);
  f.state.runs[0].run_attempt = 2; f.state.jobs = [job({ run_attempt: 2 })]; await f.service.worker.process(r.id);
  current = (await f.admin(f.endpoint + '/' + r.id)).value.release; assert.equal(current.stage, 'preparing_notes'); assert.equal(current.ci_success.attempt, 2);
  assert.deepEqual(writes(f.state).slice(before).map(r => r.path), ['/repos/fixture/project-101/actions/runs/800/rerun']);
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM release_attempts WHERE release_id=?', r.id).n, 2);
  assert.ok(f.state.tokens.some(t => t.permissions.actions === 'write' && t.permissions.contents === 'read'));
});
test('rerun refuses a moved tag and never issues a dispatch or tag write', async t => {
  const f = await releaseFixture(t); f.state.runs = [run({ conclusion: 'failure' })]; f.state.jobs = [job({ conclusion: 'failure' })];
  const r = await observe(f), before = writes(f.state).length; f.state.tags[r.version] = { type: 'commit', sha: other };
  await f.admin(f.endpoint + '/' + r.id + '/rerun', 'POST', { revision: r.revision });
  assert.equal(writes(f.state).length, before);
  assert.equal((await f.admin(f.endpoint + '/' + r.id)).value.release.error, 'release_tag_conflict');
});
