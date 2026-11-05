import test from 'node:test';
import assert from 'node:assert/strict';
import { validVersion, compareVersions, nextVersions } from '../dist/releases/version.js';
import { releaseWorkflow, filter } from '../dist/releases/workflow.js';
import { noCI, noRelease } from '../dist/releases/preflight.js';
import { releaseFixture, workflow, writes, target, previous, other, tagObject, run } from './release-fixtures.mjs';
import { Store } from '../dist/storage/database.js';
import { ReleaseService } from '../dist/releases/service.js';
import { testPassword } from './helpers.mjs';
import { runEventTasks } from './event-tasks.mjs';
import { workspaceProfile } from '../dist/agent/profiles.js';
import { workflowPermissions } from '../dist/workflows/resolve.js';
import { selectedModel } from '../dist/agent/model.js';
import { GitHub } from '../dist/github/client.js';
import { Redactor } from '../dist/agent/common.js';

test('release versions and precedence follow SemVer without metadata or precision loss', () => {
  for (const v of ['v0.1.0', 'v1.2.3-beta', 'v1.2.3-beta.1', 'v1.2.3-rc.1', 'v999999999999999999.0.0']) assert.ok(validVersion(v), v);
  for (const v of ['v01.2.3', 'v1.2.3-', 'v1.2.3-beta.01', 'v1', '1.2.3', 'v1.2', 'v1.2.3+build', ' v1.2.3', 'v1.2.3\n', 'v1.2.3-a..b']) assert.ok(!validVersion(v), v);
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
// notes: the agent of the release.notes task (which runs in the project computer), when the release asks for one.
async function toDraft(f, version = 'v1.2.3', notes) {
  f.state.runs = [run({ head_branch: version, head_sha: f.state.head })]; f.state.jobs = [job()];
  const created = await f.create(version); assert.equal(created.status, 201);
  for (let i = 0; i < 5; i++) { await f.service.worker.process(created.value.release.id); if (notes) await runEventTasks(f.h.store, 'release.notes', notes); }
  return (await f.admin(f.endpoint + '/' + created.value.release.id)).value.release;
}
test('release notes freeze the highest reachable SemVer tag and verified merge, squash and rebase PR sources', async t => {
  const f = await releaseFixture(t);
  f.state.tags = { 'v1.2.0-beta.2': { type: 'commit', sha: previous }, 'v1.2.0-beta.10': { type: 'tag', sha: 'e'.repeat(40), commit: previous }, 'v99.0.0': { type: 'commit', sha: other } };
  f.state.prs[target] = [1, 2, 3].map(number => ({ number, title: ['Merge change', 'Squash change', 'Rebase change'][number - 1], merged_at: '2026-01-01T00:00:00Z', merge_commit_sha: target, base: { repo: { id: 101 } }, html_url: `https://github.com/fixture/project-101/pull/${number}` }));
  f.state.prs[target].push({ number: 4, merged_at: '2026-01-01T00:00:00Z', merge_commit_sha: other, base: { repo: { id: 101 } } });
  const r = await toDraft(f); assert.equal(r.stage, 'draft'); assert.equal(r.previous_tag.name, 'v1.2.0-beta.10'); assert.equal(r.previous_tag.sha, previous);
  assert.equal(r.sources.length, 4); assert.ok(!r.body.includes('Initial commit')); assert.ok(r.body.includes('#1') && r.body.includes('#2') && r.body.includes('#3'));
  assert.equal(r.skill.source, 'builtin'); assert.equal(r.skill.version, 'release-notes-v1'); assert.ok(r.skill.hash);
  const draft = writes(f.state).find(r => r.path.endsWith('/releases')); assert.equal(draft.body.draft, true); assert.equal(draft.body.tag_name, r.version);
});
test('a first release still confirms and describes the existing history', async t => {
  const f = await releaseFixture(t), first = await toDraft(f); assert.equal(first.previous_tag, null); assert.match(first.body, /从仓库历史起算/); assert.ok(first.body.includes('Initial commit'));
});
test('preflight and notes subtract every ancestor of the previous tag, including earlier merged history', async t => {
  const f = await releaseFixture(t);
  f.state.commits.push({ sha: other, commit: { message: 'Earlier merged change' }, html_url: 'https://github.com/fixture/project-101/commit/' + other });
  f.state.histories[previous] = f.state.commits.filter(commit => commit.sha !== target);
  f.state.tags['v1.2.2'] = { type: 'commit', sha: previous };
  const p = await f.preview(); assert.equal(p.available, true); assert.equal(p.no_changes, false);
  const draft = await toDraft(f); assert.deepEqual(draft.sources.map(source => source.sha), [target]);
  assert.ok(!draft.body.includes('Earlier merged change')); assert.ok(!draft.body.includes('Initial commit'));
});
test('an empty source range blocks preflight and confirmation without creating a record, tag or Release', async t => {
  for (const type of ['commit', 'tag']) {
    const f = await releaseFixture(t);
    f.state.tags['v1.2.2'] = type === 'tag' ? { type, sha: tagObject, commit: target } : { type, sha: target };
    const tags = structuredClone(f.state.tags), p = await f.preview();
    assert.equal(p.no_changes, true); assert.equal(p.available, false); assert.equal(p.previous_tag.sha, target);
    assert.match(p.checks.find(c => !c.ok).message, /没有新变更.*跳过/);
    const result = await f.admin(f.endpoint, 'POST', { version: p.version, target_sha: target, credential: p.credential });
    assert.equal(result.status, 409); assert.equal(result.value.error, 'release_no_changes');
    await f.service.tick();
    assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 0);
    assert.deepEqual(f.state.tags, tags); assert.deepEqual(f.state.releases, []); assert.deepEqual(writes(f.state), []);
  }
});
test('version hints keep the major version and lead a prerelease to its stable version', () => {
  assert.deepEqual(nextVersions('v1.2.3'), ['v1.2.4', 'v1.3.0']);
  assert.deepEqual(nextVersions('v0.1.0'), ['v0.1.1', 'v0.2.0']);
  assert.deepEqual(nextVersions('v1.3.0-beta.2'), ['v1.3.0']);
  assert.deepEqual(nextVersions('v999999999999999999.0.9'), ['v999999999999999999.0.10', 'v999999999999999999.1.0']);
});
test('a version not above the previous reachable tag is refused with a hint before any write', async t => {
  const f = await releaseFixture(t);
  // v1.2.2 is reachable from the candidate; v99.0.0 sits on a commit outside its history and is not compared.
  f.state.tags = { 'v1.2.2': { type: 'commit', sha: previous }, 'v99.0.0': { type: 'commit', sha: other } };
  for (const version of ['v1.2.1', 'v1.2.2-rc.1', 'v0.9.0']) {
    const p = await f.preview(version);
    assert.equal(p.available, false, version); assert.equal(p.version_behind, true, version); assert.equal(p.no_changes, false, version);
    assert.equal(p.previous_tag.name, 'v1.2.2'); assert.deepEqual(p.suggested_versions, ['v1.2.3', 'v1.3.0']);
    const failed = p.checks.filter(c => !c.ok); assert.equal(failed.length, 1, version);
    assert.equal(failed[0].message, `版本 ${version} 不高于上一枚版本标签 v1.2.2，不能发布。请填写更高的版本，例如 v1.2.3 或 v1.3.0。`);
    const result = await f.admin(f.endpoint, 'POST', { version, target_sha: target, credential: p.credential });
    assert.equal(result.status, 409, version); assert.equal(result.value.error, 'release_version_not_higher'); assert.equal(result.value.release, undefined);
  }
  await f.service.tick();
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 0); assert.deepEqual(writes(f.state), []);
  const blank = await f.preview('');
  assert.equal(blank.checks.at(-1).ok, false); assert.equal(blank.checks.at(-1).message, '版本号需要高于上一枚版本标签 v1.2.2，例如 v1.2.3 或 v1.3.0');
  for (const version of ['v1.2.3', 'v1.2.3-beta.1', 'v2.0.0']) {
    const p = await f.preview(version);
    assert.equal(p.available, true, version); assert.equal(p.version_behind, false, version);
    assert.equal(p.checks.at(-1).message, `版本 ${version} 高于上一枚版本标签 v1.2.2`);
  }
  assert.equal((await f.create('v1.2.3')).status, 201);
});
test('a prerelease previous tag accepts later prereleases and its stable version only', async t => {
  const f = await releaseFixture(t); f.state.tags = { 'v1.3.0-beta.2': { type: 'commit', sha: previous } };
  const lower = await f.preview('v1.3.0-beta.1');
  assert.equal(lower.available, false); assert.match(lower.checks.at(-1).message, /不高于上一枚版本标签 v1\.3\.0-beta\.2.*例如 v1\.3\.0。$/);
  for (const version of ['v1.3.0-beta.10', 'v1.3.0-rc.1', 'v1.3.0']) assert.equal((await f.preview(version)).available, true, version);
  assert.equal((await f.preview('v1.2.9')).version_behind, true);
});
test('without a previous version tag the version order is not compared', async t => {
  const f = await releaseFixture(t), p = await f.preview('v0.0.1');
  assert.equal(p.available, true); assert.equal(p.version_behind, false); assert.deepEqual(p.suggested_versions, []);
  assert.deepEqual(p.checks.at(-1), { ok: true, message: '还没有上一枚版本标签，不比较版本号' });
});
test('an existing record of a version now below a newer tag is still returned for viewing and recovery', async t => {
  const f = await releaseFixture(t), first = await f.create('v1.2.3'); assert.equal(first.status, 201);
  f.state.tags['v1.3.0'] = { type: 'commit', sha: previous };
  assert.equal((await f.preview('v1.2.3')).version_behind, true);
  const again = await f.create('v1.2.3'); assert.equal(again.status, 201); assert.equal(again.value.release.id, first.value.release.id);
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 1);
});
function advanceHead(f) {
  f.state.histories[f.state.head] = structuredClone(f.state.commits);
  f.state.head = other;
  f.state.commits.unshift({ sha: other, commit: { message: 'Add another change' }, html_url: 'https://github.com/fixture/project-101/commit/' + other });
}
test('an idle draft does not bypass no-changes confirmation and a new commit creates a second draft', async t => {
  const f = await releaseFixture(t), first = await toDraft(f);
  assert.equal(first.stage, 'draft');
  assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', first.id).active, 0);
  const tags = structuredClone(f.state.tags), releases = structuredClone(f.state.releases), before = writes(f.state).length;
  f.h.store.run('UPDATE project_releases SET active=1 WHERE id=?', first.id);
  const p = await f.preview('v1.2.4'); assert.equal(p.no_changes, true); assert.equal(p.available, false);
  for (let i = 0; i < 2; i++) {
    const result = await f.admin(f.endpoint, 'POST', { version: p.version, target_sha: p.target_sha, credential: p.credential });
    assert.equal(result.status, 409); assert.equal(result.value.error, 'release_no_changes'); assert.equal(result.value.release, undefined);
  }
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 1);
  assert.deepEqual(f.state.tags, tags); assert.deepEqual(f.state.releases, releases); assert.equal(writes(f.state).length, before);
  assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', first.id).active, 0);
  const again = await f.create(first.version); assert.equal(again.status, 201); assert.equal(again.value.release.id, first.id);
  advanceHead(f);
  assert.equal((await f.preview('v1.2.4')).available, true);
  const second = await toDraft(f, 'v1.2.4');
  assert.equal(second.stage, 'draft'); assert.equal(second.version, 'v1.2.4'); assert.equal(second.target_sha, other); assert.notEqual(second.id, first.id);
  assert.equal(second.previous_tag.sha, target); assert.deepEqual(second.sources.map(source => source.sha), [other]);
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 2);
  assert.ok(f.h.store.all('SELECT active,lease,stage FROM project_releases').every(row => row.active === 0 && row.lease === null && row.stage === 'draft'));
  assert.equal(f.state.tags[first.version].commit, target); assert.equal(f.state.tags[second.version].commit, other);
  assert.equal(f.state.releases.length, 2); assert.ok(f.state.releases.every(release => release.draft === true));
  assert.deepEqual(f.state.releases[0], releases[0]);
  assert.ok(!writes(f.state).some(request => request.body?.draft === false || request.method === 'DELETE'));
  const listed = (await f.admin(f.endpoint)).value.releases;
  assert.deepEqual(new Set(listed.map(release => release.id)), new Set([first.id, second.id]));
  assert.equal((await f.create(first.version)).value.release.id, first.id);
  assert.equal((await f.create(second.version)).value.release.id, second.id);
});
test('another active version returns repository busy while same-version confirmation keeps its own record', async t => {
  const f = await releaseFixture(t), created = await f.create(), first = created.value.release;
  const p = await f.preview('v1.2.4'); assert.equal(p.available, true);
  for (const stage of ['tagging', 'waiting_run', 'running', 'preparing_notes', 'creating_draft', 'publishing', 'waiting_permission', 'write_unknown']) {
    f.h.store.run('UPDATE project_releases SET stage=? WHERE id=?', stage, first.id);
    const result = await f.admin(f.endpoint, 'POST', { version: p.version, target_sha: p.target_sha, credential: p.credential });
    assert.equal(result.status, 409, stage); assert.equal(result.value.error, 'release_repository_busy', stage); assert.equal(result.value.release, undefined);
    assert.equal((await f.create(first.version)).value.release.id, first.id);
    assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', first.id).active, 1);
  }
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 1); assert.deepEqual(writes(f.state), []);
  f.h.store.run("UPDATE project_releases SET stage='tagging' WHERE id=?", first.id); await f.service.worker.process(first.id);
  assert.equal((await f.preview('v1.2.4')).no_changes, true);
  const blocked = await f.create('v1.2.4'); assert.equal(blocked.status, 409); assert.equal(blocked.value.error, 'release_repository_busy');
  assert.equal(blocked.value.release, undefined); assert.equal((await f.create(first.version)).value.release.id, first.id);
});
test('concurrent different-version confirmations return one record and one repository-busy response', async t => {
  const f = await releaseFixture(t), results = await Promise.all([f.create('v1.2.3'), f.create('v1.2.4')]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const accepted = results.find(result => result.status === 201), busy = results.find(result => result.status === 409);
  assert.equal(accepted.value.release.version, results[0] === accepted ? 'v1.2.3' : 'v1.2.4');
  assert.equal(busy.value.error, 'release_repository_busy'); assert.equal(busy.value.release, undefined);
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 1); assert.deepEqual(writes(f.state), []);
});
test('startup frees legacy and expired draft claims while preserving live claims and active workflow stages', async t => {
  const f = await releaseFixture(t), created = await f.create(), id = created.value.release.id;
  for (const [lease, leaseUntil, active] of [[null, 0, 0], ['expired', Date.now() - 1, 0], ['live', Date.now() + 300000, 1]]) {
    f.h.store.run("UPDATE project_releases SET stage='draft',active=1,lease=?,lease_until=? WHERE id=?", lease, leaseUntil, id);
    new ReleaseService(f.h.store, f.apiUrl);
    const row = f.h.store.get('SELECT * FROM project_releases WHERE id=?', id);
    assert.equal(row.active, active); assert.equal(row.lease, active ? lease : null);
  }
  for (const stage of ['tagging', 'waiting_run', 'running', 'preparing_notes', 'creating_draft', 'publishing', 'waiting_permission', 'write_unknown']) {
    f.h.store.run('UPDATE project_releases SET stage=?,active=1,lease=NULL,lease_until=0 WHERE id=?', stage, id);
    new ReleaseService(f.h.store, f.apiUrl);
    const row = f.service.claim(id); f.service.save(row, {}); f.service.unlock(row);
    assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', id).active, 1, stage);
  }
  for (const stage of ['draft', 'failed', 'published', 'externally_published']) {
    f.h.store.run('UPDATE project_releases SET stage=? WHERE id=?', stage, id);
    const row = f.service.claim(id); f.service.save(row, {}); f.service.unlock(row);
    assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', id).active, 0, stage);
  }
});
test('expired draft claims are released on confirmation without restarting the service', async t => {
  const f = await releaseFixture(t), first = await toDraft(f), row = f.service.claim(first.id);
  f.h.store.run('UPDATE project_releases SET lease_until=? WHERE id=?', Date.now() - 1, first.id);
  advanceHead(f);
  const second = await f.create('v1.2.4'); assert.equal(second.status, 201); assert.equal(second.value.release.version, 'v1.2.4');
  assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', first.id).active, 0);
  await assert.rejects(() => f.service.guard(row), error => error.code === 'release_lease_lost');
  f.service.unlock(row);
  assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', second.value.release.id).active, 1);
});
test('confirmation rechecks the range when another version tags the candidate after preflight', async t => {
  const f = await releaseFixture(t), p = await f.preview(); assert.equal(p.available, true);
  f.state.tags['v1.2.2'] = { type: 'commit', sha: target };
  const result = await f.admin(f.endpoint, 'POST', { version: p.version, target_sha: target, credential: p.credential });
  assert.equal(result.status, 409); assert.equal(result.value.error, 'release_candidate_changed');
  assert.equal((await f.preview()).no_changes, true);
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 0); assert.deepEqual(writes(f.state), []);
});
test('an existing failed record can still be viewed and resumed when a later tag makes its range empty', async t => {
  const f = await releaseFixture(t), created = await f.create(), id = created.value.release.id;
  f.state.deny = '/repos/fixture/project-101/git/tags'; await f.service.worker.process(id);
  const failed = (await f.admin(f.endpoint + '/' + id)).value.release; assert.equal(failed.stage, 'waiting_permission');
  f.state.tags['v1.2.2'] = { type: 'commit', sha: target }; f.state.deny = '';
  assert.equal((await f.preview()).available, false);
  const again = await f.create(); assert.equal(again.value.release.id, id);
  const resumed = await f.admin(f.endpoint + '/' + id + '/resume', 'POST', { revision: failed.revision });
  assert.equal(resumed.value.release.stage, 'tagging'); await f.service.worker.process(id);
  assert.equal((await f.admin(f.endpoint + '/' + id)).value.release.stage, 'waiting_run');
  assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 1);
  assert.equal(f.state.tags['v1.2.2'].sha, target);
});
test('existing drafts preserve manual text and an existing published release never returns to draft', async t => {
  for (const draft of [true, false]) {
    const f = await releaseFixture(t); f.state.releases = [{ id: 900, tag_name: 'v1.2.3', draft, body: 'Human edited text', html_url: 'https://github.com/fixture/project-101/releases/tag/v1.2.3' }];
    const r = await toDraft(f); assert.equal(r.stage, draft ? 'draft' : 'externally_published'); assert.equal(r.release_id, 900); assert.equal(r.body, 'Human edited text');
    assert.equal(writes(f.state).filter(r => /\/releases(?:\/|$)/.test(r.path)).length, 0);
  }
});
test('draft saving enforces both revisions and preserves external edits instead of overwriting them', async t => {
  const f = await releaseFixture(t), r = await toDraft(f);
  const saved = await f.admin(f.endpoint + '/' + r.id + '/draft', 'PATCH', { revision: r.revision, body_revision: r.body_revision, body: 'Human edited notes' });
  assert.equal(saved.status, 200); assert.equal(f.state.releases[0].body, 'Human edited notes');
  assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', r.id).active, 0);
  assert.equal((await f.admin(f.endpoint + '/' + r.id + '/draft', 'PATCH', { revision: r.revision, body_revision: r.body_revision, body: 'Stale overwrite' })).status, 409);
  const current = saved.value.release; f.state.releases[0].body = 'Edited directly on GitHub';
  assert.equal((await f.admin(f.endpoint + '/' + r.id + '/draft', 'PATCH', { revision: current.revision, body_revision: current.body_revision, body: 'Overwrite external changes' })).status, 409);
  assert.equal(f.state.releases[0].body, 'Edited directly on GitHub');
  assert.equal((await f.admin(f.endpoint + '/' + r.id)).value.release.body, 'Edited directly on GitHub');
  assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', r.id).active, 0);
  assert.ok(writes(f.state).filter(r => r.method === 'PATCH').every(r => Object.keys(r.body).join() === 'body'));
});
test('manual draft saving holds the repository only until the edit finishes', async t => {
  const f = await releaseFixture(t), first = await toDraft(f); advanceHead(f);
  let checked = false;
  f.state.custom = async ({ method, path }) => {
    if (method !== 'PATCH' || !path.endsWith('/releases/' + first.release_id)) return false;
    const row = f.h.store.get('SELECT active,lease FROM project_releases WHERE id=?', first.id);
    assert.equal(row.active, 1); assert.ok(row.lease);
    new ReleaseService(f.h.store, f.apiUrl);
    assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', first.id).active, 1);
    const blocked = await f.create('v1.2.4'); assert.equal(blocked.status, 409); assert.equal(blocked.value.error, 'release_repository_busy');
    checked = true; return false;
  };
  const saved = await f.admin(f.endpoint + '/' + first.id + '/draft', 'PATCH', { revision: first.revision, body_revision: first.body_revision, body: 'Reviewed notes' });
  assert.equal(saved.status, 200); assert.ok(checked); assert.equal(saved.value.release.stage, 'draft');
  assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', first.id).active, 0);
  assert.equal((await f.create('v1.2.4')).status, 201); assert.equal(f.state.releases[0].draft, true);
});
test('repository release-notes Skill is explicitly loaded at the target SHA into a release.notes task that can only read', async t => {
  const f = await releaseFixture(t), skill = 'Group real commits under Changes. Do not invent results.';
  f.state.files['.agents/skills/release-notes/SKILL.md'] = skill;
  await f.admin('/api/models', 'POST', { repository_id: '101', api_url: f.apiUrl + '/v1', api_key: 'fixture-model-release-key', model_name: 'notes-fixture' });
  const model = f.h.store.get('SELECT id FROM models WHERE repository_id=?', '101');
  const fallback = (await f.admin('/api/models', 'POST', { repository_id: '101', api_url: f.apiUrl + '/v1', api_key: 'fixture-default-model-key', model_name: 'default-fixture' })).value.model;
  await f.admin('/api/repositories/101/policy', 'PATCH', { model_id: fallback.id, task_models: {'release.notes': model.id} });
  let seen;
  const r = await toDraft(f, 'v1.2.3', ({ input, target: event }) => { seen = { input, event }; return { groups: [{ heading: 'Changes', source_ids: input.sources.map(s => s.id) }] }; });
  assert.equal(r.stage, 'draft'); assert.equal(r.skill.source, 'repository'); assert.equal(r.skill.sha, target); assert.match(r.body, /## Changes/);
  // The task works on a checkout of the release commit, with the verified sources and the Skill as context files.
  const task = f.h.store.get("SELECT * FROM tasks WHERE kind='release.notes'");
  assert.deepEqual([task.status, task.head_sha, seen.event.sha], ['succeeded', target, target]);
  assert.equal(seen.event.files['release-notes-skill.md'], skill); assert.deepEqual(JSON.parse(seen.event.files['sources.json']).map(s => s.id), seen.input.sources.map(s => s.id));
  assert.equal(selectedModel(f.h.store, '101', 'release.notes').model, 'notes-fixture');
  // Like every workflow it may read GitHub and start agents; its only write is the notes it hands back.
  const profile = workspaceProfile('release.notes', seen.event.context, workflowPermissions(f.h.store, '101', 'release.notes')), names = profile.tools.map(t => t.function.name);
  for (const name of ['read_file', 'github_read_token', 'github_read', 'read_job_log', 'start_agent', 'finish_release_notes']) assert.ok(names.includes(name), name);
  for (const name of ['create_issue', 'create_pull_request', 'finish_review']) assert.ok(!names.includes(name), name);
  assert.ok(profile.system.includes(skill)); assert.deepEqual(profile.finishTools, ['finish_release_notes']);
});
test('invalid Skill content, unsupported model claims and known secrets cannot enter a release body', async t => {
  const f = await releaseFixture(t); f.state.files['.agents/skills/release-notes/SKILL.md'] = '';
  assert.equal((await f.preview()).available, false);
  const g = await releaseFixture(t); g.state.files['.agents/skills/release-notes/SKILL.md'] = 'Write notes';
  const m = await g.admin('/api/models', 'POST', { repository_id: '101', api_url: g.apiUrl + '/v1', api_key: 'fixture-secret-note-key', model_name: 'notes-fixture' });
  await g.admin('/api/repositories/101/policy', 'PATCH', { model_id: m.value.model.id });
  const invalid = await toDraft(g, 'v1.2.3', () => ({ groups: [{ heading: 'All tests passed, 10x faster', source_ids: [] }] }));
  assert.equal(invalid.error, 'release_notes_invalid'); assert.equal(g.state.releases.length, 0);
  const h = await releaseFixture(t); await h.admin('/api/models', 'POST', { repository_id: '101', api_url: h.apiUrl + '/v1', api_key: 'registered-secret-release', model_name: 'fixture' });
  h.state.commits[0].commit.message = 'Leak registered-secret-release'; const sensitive = await toDraft(h); assert.equal(sensitive.error, 'release_sensitive_body'); assert.equal(h.state.releases.length, 0);
  assert.ok(!JSON.stringify(sensitive).includes('registered-secret-release'));
  const j = await releaseFixture(t), draft = await toDraft(j); await j.admin('/api/models', 'POST', { repository_id: '101', api_url: j.apiUrl + '/v1', api_key: 'registered-secret-release', model_name: 'fixture' });
  assert.equal((await j.admin(j.endpoint + '/' + draft.id + '/draft', 'PATCH', { revision: draft.revision, body_revision: draft.body_revision, body: 'registered-secret-release' })).status, 400);
  assert.ok(!j.state.releases[0].body.includes('registered-secret-release'));
});
test('draft creation timeout is reconciled to the same draft without a duplicate POST', async t => {
  const f = await releaseFixture(t); f.state.unknown = '/repos/fixture/project-101/releases';
  const r = await toDraft(f, 'v1.2.3-rc.1'); assert.equal(r.stage, 'draft'); assert.equal(f.state.releases.length, 1); assert.equal(f.state.releases[0].prerelease, true);
  assert.equal(writes(f.state).filter(r => r.path.endsWith('/releases')).length, 1);
  assert.ok(!writes(f.state).some(r => r.body?.draft === false));
});
test('complete beta release journey requires an explicit publish, preserves prerelease and is idempotent', async t => {
  const f = await releaseFixture(t), r = await toDraft(f, 'v1.2.3-beta.1');
  assert.equal(r.stage, 'draft'); await new ReleaseService(f.h.store, f.apiUrl).tick();
  assert.ok(!writes(f.state).some(r => r.body?.draft === false));
  const saved = await f.admin(f.endpoint + '/' + r.id + '/draft', 'PATCH', { revision: r.revision, body_revision: r.body_revision, body: 'Release notes reviewed by a maintainer' });
  assert.equal(saved.status, 200); const current = saved.value.release;
  let publishingClaim = false;
  f.state.custom = async ({ method, path, body }) => {
    if (method === 'PATCH' && path.endsWith('/releases/' + r.release_id) && body.draft === false) {
      const row = f.h.store.get('SELECT stage,active,lease FROM project_releases WHERE id=?', r.id);
      assert.equal(row.stage, 'publishing'); assert.equal(row.active, 1); assert.ok(row.lease); publishingClaim = true;
    }
    return false;
  };
  const published = await f.admin(f.endpoint + '/' + r.id + '/publish', 'POST', { revision: current.revision, body_revision: current.body_revision });
  assert.equal(published.status, 201); assert.equal(published.value.release.stage, 'published'); assert.ok(published.value.release.publish_actor); assert.ok(published.value.release.published_at);
  assert.ok(publishingClaim);
  assert.equal(f.h.store.get('SELECT active FROM project_releases WHERE id=?', r.id).active, 0);
  assert.equal(f.state.releases[0].draft, false); assert.equal(f.state.releases[0].prerelease, true);
  const again = await f.admin(f.endpoint + '/' + r.id + '/publish', 'POST', { revision: current.revision, body_revision: current.body_revision });
  assert.equal(again.value.release.release_id, r.release_id);
  const formal = writes(f.state).filter(r => r.body?.draft === false); assert.equal(formal.length, 1); assert.deepEqual(formal[0].body, { draft: false, prerelease: true });
  assert.equal(f.h.store.get("SELECT COUNT(*) n FROM audit WHERE action='release.publish'").n, 1);
});
test('publication rechecks the tag, successful attempt and draft revision before any formal write', async t => {
  const f = await releaseFixture(t), r = await toDraft(f); f.state.tags[r.version] = { type: 'commit', sha: other };
  await f.admin(f.endpoint + '/' + r.id + '/publish', 'POST', { revision: r.revision, body_revision: r.body_revision });
  assert.ok(!writes(f.state).some(r => r.body?.draft === false));
  const g = await releaseFixture(t), s = await toDraft(g); g.state.runs[0].run_attempt = 2; g.state.runs[0].conclusion = 'failure'; g.state.jobs = [job({ run_attempt: 2, conclusion: 'failure' })];
  await g.admin(g.endpoint + '/' + s.id + '/publish', 'POST', { revision: s.revision, body_revision: s.body_revision });
  assert.equal((await g.admin(g.endpoint + '/' + s.id)).value.release.error, 'release_ci_evidence_changed'); assert.ok(!writes(g.state).some(r => r.body?.draft === false));
  const h = await releaseFixture(t), u = await toDraft(h); h.state.releases[0].body = 'Externally edited before publishing';
  assert.equal((await h.admin(h.endpoint + '/' + u.id + '/publish', 'POST', { revision: u.revision, body_revision: u.body_revision })).status, 409);
  assert.ok(!writes(h.state).some(r => r.body?.draft === false));
});
test('publish timeout is probed and restart recovery never resends formal publication', async t => {
  const f = await releaseFixture(t), r = await toDraft(f); f.state.unknown = '/repos/fixture/project-101/releases/' + r.release_id;
  const result = await f.admin(f.endpoint + '/' + r.id + '/publish', 'POST', { revision: r.revision, body_revision: r.body_revision });
  assert.equal(result.value.release.stage, 'published'); assert.equal(writes(f.state).filter(r => r.body?.draft === false).length, 1);
  const g = await releaseFixture(t), s = await toDraft(g);
  g.state.custom = async ({ method, path, body, req }) => { if (method === 'PATCH' && path.endsWith('/releases/' + s.release_id) && body.draft === false) { req.socket.destroy(); return true; } };
  const uncertain = await g.admin(g.endpoint + '/' + s.id + '/publish', 'POST', { revision: s.revision, body_revision: s.body_revision });
  assert.equal(uncertain.value.release.stage, 'write_unknown');
  await g.admin(g.endpoint + '/' + s.id + '/resume', 'POST', { revision: uncertain.value.release.revision });
  assert.equal(writes(g.state).filter(r => r.body?.draft === false).length, 1);
  g.state.releases[0].draft = false; g.h.store.run("UPDATE project_releases SET stage='publishing',next_poll=0 WHERE id=?", s.id);
  await new ReleaseService(g.h.store, g.apiUrl).tick(); assert.equal((await g.admin(g.endpoint + '/' + s.id)).value.release.stage, 'published');
  assert.equal(writes(g.state).filter(r => r.body?.draft === false).length, 1);
});
test('read-only observation can finish without requesting logs and has no write tools', async t => {
  const f = await releaseFixture(t); f.state.runs = [run({ conclusion: 'failure' })]; f.state.jobs = [job({ conclusion: 'failure', steps: [{ name: 'Build', number: 1, conclusion: 'failure' }] })];
  const r = await observe(f), m = await f.admin('/api/models', 'POST', { repository_id: '101', api_url: f.apiUrl + '/v1', api_key: 'observation-fixture-secret', model_name: 'fixture' });
  await f.admin('/api/repositories/101/policy', 'PATCH', { model_id: m.value.model.id });
  const github = async task => { const client = new GitHub(f.h.store, f.h.store.get('SELECT * FROM repositories WHERE id=?', task.repository_id), new Redactor(), async () => {}, f.apiUrl);
    await client.connect(false, { contents: 'read', actions: 'read' }, undefined, false); return client; };
  const before = writes(f.state).length, tokens = f.state.tokens.length;
  // Asking for an observation queues a task of the CI observation workflow and changes nothing else.
  const result = await f.admin(f.endpoint + '/' + r.id + '/observe', 'POST', { revision: r.revision });
  assert.equal(result.status, 201); assert.equal(result.value.release.stage, 'failed'); assert.ok(result.value.release.observation_task); assert.equal(result.value.release.observation, undefined);
  let seen; await runEventTasks(f.h.store, 'release.observe', ({ input, target: event }) => { seen = { input, event }; return { job_ids: [1], advice: 'Inspect the Build step output' }; }, { github });
  const done = (await f.admin(f.endpoint + '/' + r.id)).value.release;
  assert.equal(done.observation.run_id, 800); assert.equal(done.observation.advice, 'Inspect the Build step output'); assert.equal(done.observation_task, null); assert.equal(seen.input.run_attempt, 1);
  assert.equal(JSON.parse(seen.event.files['run.json']).jobs[0].id, 1); assert.equal(seen.event.sha, target);
  const names = workspaceProfile('release.observe', seen.event.context, workflowPermissions(f.h.store, '101', 'release.observe')).tools.map(t => t.function.name);
  for (const name of ['create_issue', 'create_pull_request', 'rerun_failed_run', 'report_failure']) assert.ok(!names.includes(name), name);
  assert.ok(f.state.tokens.slice(tokens).every(t => Object.values(t.permissions).every(p => p === 'read')));
  assert.deepEqual(writes(f.state).slice(before), []); assert.equal(f.state.releases.length, 0);
  // A task that ends without a result says why beside the run; the CI facts stay as GitHub reported them.
  const again = await f.admin(f.endpoint + '/' + r.id + '/observe', 'POST', { revision: done.revision });
  await runEventTasks(f.h.store, 'release.observe', () => { throw Object.assign(new Error('down'), { code: 'model_http_503', state: 'failed', detail: '模型请求失败' }); }, { github });
  const failed = (await f.admin(f.endpoint + '/' + r.id)).value.release;
  assert.equal(again.status, 201); assert.equal(failed.stage, 'failed'); assert.match(failed.observation_error, /model_http_503/); assert.equal(failed.run.conclusion, 'failure');
});
test('every attempt job page is checked, including a failure on the second page', async t => {
  const f = await releaseFixture(t); f.state.runs = [run()];
  f.state.custom = async ({ path, url, send }) => {
    if (path === '/repos/fixture/project-101/actions/runs/800/attempts/1/jobs') { const page = Number(url.searchParams.get('page')); const jobs = Array.from({ length: 101 }, (_, n) => job({ id: n + 1, conclusion: n === 100 ? 'failure' : 'success' })); send({ total_count: 101, jobs: jobs.slice((page - 1) * 100, page * 100) }); return true; }
  };
  const r = await observe(f); assert.equal(r.stage, 'failed'); assert.equal(r.run.jobs.length, 101); assert.equal(r.run.jobs[100].conclusion, 'failure'); assert.equal(f.state.releases.length, 0);
});
test('a missing tag workflow times out diagnostically and does not create another tag', async t => {
  const f = await releaseFixture(t), r = await observe(f), row = f.h.store.get('SELECT * FROM project_releases WHERE id=?', r.id), data = JSON.parse(row.data);
  data.wait_started_at = Date.now() - 31 * 60_000; f.h.store.run('UPDATE project_releases SET data=? WHERE id=?', JSON.stringify(data), r.id);
  await f.service.worker.process(r.id); const result = (await f.admin(f.endpoint + '/' + r.id)).value.release;
  assert.equal(result.error, 'release_run_missing'); assert.equal(result.detail, '标签已存在，但没有找到该标签触发的 Release 工作流'); assert.ok(result.actions_url); assert.equal(writes(f.state).length, 2);
});
test('resume only reconciles an uncertain or rejected rerun and cannot send a new rerun', async t => {
  const f = await releaseFixture(t); f.state.runs = [run({ conclusion: 'failure' })]; f.state.jobs = [job({ conclusion: 'failure' })];
  const r = await observe(f); f.state.deny = '/repos/fixture/project-101/actions/runs/800/rerun';
  const rejected = await f.admin(f.endpoint + '/' + r.id + '/rerun', 'POST', { revision: r.revision });
  assert.equal(rejected.value.release.stage, 'waiting_permission'); const before = writes(f.state).length; f.state.deny = '';
  const resumed = await f.admin(f.endpoint + '/' + r.id + '/resume', 'POST', { revision: rejected.value.release.revision });
  assert.equal(resumed.value.release.error, 'release_rerun_not_started'); assert.equal(writes(f.state).length, before);
  const userRerun = await f.admin(f.endpoint + '/' + r.id + '/rerun', 'POST', { revision: resumed.value.release.revision });
  assert.equal(userRerun.value.release.stage, 'running'); assert.equal(f.state.runs[0].run_attempt, 2);
});
test('the server refuses both missing integration levels, excluded beta tags and illegal versions', async t => {
  const f = await releaseFixture(t);
  const submit = async version => { const p = await f.preview(version); return f.admin(f.endpoint, 'POST', { version, target_sha: p.target_sha, credential: p.credential }); };
  delete f.state.files['.github/ci-gates.json']; assert.equal((await submit('v1.2.3')).status, 409);
  f.state.files['.github/ci-gates.json'] = '{}'; delete f.state.files['.github/workflows/release.yml']; assert.equal((await submit('v1.2.3')).status, 409);
  f.state.files['.github/workflows/release.yml'] = workflow.replace("['v*']", "['v*', '!v*-beta*']"); assert.equal((await submit('v1.2.3-beta.1')).status, 409);
  assert.equal((await submit('v01.2.3')).status, 400); assert.equal(f.h.store.get('SELECT COUNT(*) n FROM project_releases').n, 0); assert.equal(writes(f.state).length, 0);
});
test('disabled and uninstalled projects and bot-account credentials cannot write releases', async t => {
  const f = await releaseFixture(t), p = await f.preview(), input = { version: p.version, target_sha: target, credential: p.credential };
  f.h.store.run('UPDATE policies SET enabled=0 WHERE repository_id=?', '101'); assert.equal((await f.preview()).error, 'release_disabled'); assert.equal((await f.admin(f.endpoint, 'POST', input)).status, 503);
  f.h.store.run('UPDATE policies SET enabled=1 WHERE repository_id=?', '101'); f.h.store.run('UPDATE installed_repositories SET installed=0 WHERE repository_id=?', '101'); assert.equal((await f.preview()).error, 'release_uninstalled');
  f.h.store.run('UPDATE installed_repositories SET installed=1 WHERE repository_id=?', '101'); f.h.store.run("UPDATE accounts SET type='bot_account'"); assert.equal((await f.preview()).error, 'release_app_required');
  assert.equal(writes(f.state).length, 0);
});

test('release notes provider outage stops for explicit retry instead of holding an automatic retry loop', async t => {
  const f = await releaseFixture(t);
  f.state.files['.agents/skills/release-notes/SKILL.md'] = 'Group verified sources.';
  const model = await f.admin('/api/models', 'POST', { repository_id: '101', api_url: f.apiUrl + '/v1', api_key: 'notes-outage-key', model_name: 'notes-outage' });
  await f.admin('/api/repositories/101/policy', 'PATCH', { model_id: model.value.model.id });
  // The task's model does not answer: the task would wait and retry, but the release fails the step for a person to retry.
  let calls = 0;
  const result = await toDraft(f, 'v1.2.3', () => { calls++; return { wait: 'model_http_503' }; });
  assert.equal(result.stage, 'failed'); assert.equal(result.error, 'release_notes_model_failed');
  assert.equal(f.state.releases.length, 0); assert.equal(calls, 1); assert.equal(f.h.store.get("SELECT status FROM tasks WHERE kind='release.notes'").status, 'cancelled');
  await f.service.worker.process(result.id); assert.equal(calls, 1);
  // Resuming the step asks for a new notes task.
  assert.equal((await f.admin(f.endpoint + '/' + result.id + '/resume', 'POST', { revision: result.revision })).status, 201);
  for (let i = 0; i < 3; i++) { await f.service.worker.process(result.id); await runEventTasks(f.h.store, 'release.notes', ({ input }) => ({ groups: [{ heading: 'Changes', source_ids: input.sources.map(s => s.id) }] })); }
  assert.equal(f.h.store.get("SELECT count(*) n FROM tasks WHERE kind='release.notes'").n, 2);
  assert.equal((await f.admin(f.endpoint + '/' + result.id)).value.release.stage, 'draft');
});

test('disabling a project during notes generation rejects the result before advancing to a draft', async t => {
  const f = await releaseFixture(t);
  f.state.files['.agents/skills/release-notes/SKILL.md'] = 'Group verified sources.';
  const model = (await f.admin('/api/models', 'POST', { repository_id: '101', api_url: f.apiUrl + '/v1', api_key: 'notes-disable-key', model_name: 'notes-disable' })).value.model;
  await f.admin('/api/repositories/101/policy', 'PATCH', { task_models: {'release.notes': model.id} });
  const result = await toDraft(f, 'v1.2.3', ({ input }) => {
    f.h.store.run("UPDATE policies SET enabled=0 WHERE repository_id='101'");
    return { groups: [{ heading: 'Changes', source_ids: input.sources.map(source => source.id) }] };
  });
  assert.equal(result.stage,'waiting_permission'); assert.equal(result.error,'release_disabled');
  assert.equal(result.body,''); assert.equal(f.state.releases.length,0);
});
