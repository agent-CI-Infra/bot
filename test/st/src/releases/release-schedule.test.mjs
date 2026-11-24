// A repository may release on a daily schedule instead of waiting for a person: the control plane takes the tip of the
// configured branch, moves only the minor or the patch version by what the changes contain, and publishes the Release
// directly. The manual path is untouched: a person still confirms the version and still publishes the draft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFixture, target, previous, run, writes } from '../../../fixtures/release-fixtures.mjs';

const due = f => f.h.store.run("UPDATE release_schedules SET next_run_at=0 WHERE repository_id='101'");
const save = (f, body) => f.admin('/api/repositories/101/releases/schedule', 'POST', body);
const releaseRow = f => f.h.store.get("SELECT * FROM project_releases WHERE repository_id='101'");
const job = (overrides = {}) => ({ id: 1, run_id: 800, run_attempt: 1, name: 'release lane', status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project-101/actions/runs/800/job/1', ...overrides });

test('a due schedule releases from the configured branch with the configured first version', async t => {
  const f = await releaseFixture(t);
  const saved = await save(f, { enabled: true, time: '03:15', start_version: 'v0.1.0' });
  assert.ok([200, 201].includes(saved.status), String(saved.status));
  assert.equal(saved.value.schedule.time, '03:15');
  assert.equal(saved.value.schedule.branch, 'main');
  due(f); await f.service.tick();
  const row = releaseRow(f);
  assert.ok(row, 'a due schedule creates the release record');
  assert.equal(row.version, 'v0.1.0');
  assert.equal(row.target_sha, target);
  const data = JSON.parse(row.data);
  assert.equal(data.scheduled, true);
  assert.equal(data.draft, false);
});

test('a schedule moves only the minor for a feature and only the patch otherwise', async t => {
  for (const [message, version, major] of [['feat: release on a schedule', 'v1.3.0', true], ['fix: keep the manual draft', 'v1.2.4', false]]) {
    const f = await releaseFixture(t);
    f.state.tags['v1.2.3'] = { type: 'commit', sha: previous, commit: previous };
    f.state.commits[0].commit.message = message;
    assert.ok([200, 201].includes((await save(f, { enabled: true, time: '03:15' })).status));
    due(f); await f.service.tick();
    const row = releaseRow(f);
    assert.equal(row?.version, version, message);
    assert.equal(JSON.parse(row.data).version_reason.major, major, message);
  }
});

test('a scheduled release is published, while the manual path still stops at a draft', async t => {
  const f = await releaseFixture(t);
  assert.ok([200, 201].includes((await save(f, { enabled: true, time: '03:15', start_version: 'v0.1.0' })).status));
  due(f); await f.service.tick();
  const row = releaseRow(f);
  f.state.runs = [run({ head_branch: row.version, head_sha: target })]; f.state.jobs = [job()];
  for (let i = 0; i < 5; i++) await f.service.worker.process(row.id);
  const created = writes(f.state).find(request => request.method === 'POST' && request.path.endsWith('/releases'));
  assert.equal(created?.body.draft, false);
  // The manual path is unchanged: the same fixtures still produce draft=true through the console confirmation.
  const g = await releaseFixture(t), manual = await g.create();
  g.state.runs = [run({ head_branch: manual.value.release.version, head_sha: target })]; g.state.jobs = [job()];
  for (let i = 0; i < 5; i++) await g.service.worker.process(manual.value.release.id);
  assert.equal(writes(g.state).find(request => request.method === 'POST' && request.path.endsWith('/releases'))?.body.draft, true);
});

test('a first schedule without a start version releases nothing and records why', async t => {
  const f = await releaseFixture(t);
  assert.ok([200, 201].includes((await save(f, { enabled: true, time: '03:15' })).status));
  due(f); await f.service.tick();
  assert.equal(releaseRow(f), undefined);
  const schedule = (await f.admin('/api/repositories/101/releases/schedule')).value.schedule;
  assert.equal(schedule.last_error, 'release_start_version_required');
  assert.equal(writes(f.state).length, 0);
});

test('a schedule skips a repository that is already releasing or has no new commits', async t => {
  const f = await releaseFixture(t);
  assert.ok([200, 201].includes((await save(f, { enabled: true, time: '03:15', start_version: 'v0.1.0' })).status));
  due(f); await f.service.tick();
  assert.ok(releaseRow(f));
  due(f); await f.service.tick();
  assert.equal(f.h.store.get("SELECT count(*) n FROM project_releases WHERE repository_id='101'").n, 1);
  const g = await releaseFixture(t);
  g.state.tags['v1.2.3'] = { type: 'commit', sha: target, commit: target };
  assert.ok([200, 201].includes((await save(g, { enabled: true, time: '03:15' })).status));
  due(g); await g.service.tick();
  assert.equal(releaseRow(g), undefined);
  assert.equal((await g.admin('/api/repositories/101/releases/schedule')).value.schedule.last_error, 'release_no_changes');
});
