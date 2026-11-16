import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { managerFixture } from './project-manager-fixture.mjs';
import { harness, setup, account, repository } from './helpers.mjs';

// #771 pins two things before any implementation exists: a notes volume that a committed deletion could not remove is
// found by one reconciliation pass and deleted on retry, and the volumes that stay behind are counted where the
// deployment's readiness sees them, with a threshold that turns it red.
const remove = (admin, id) => admin('/api/projects/' + id, 'DELETE', { confirm: true });

async function project(h, f) {
  const { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await f.projects.register('101');
  await f.projects.notes('101', 'PUT', 'repository.md', { content: 'keep-101' });
  return { admin, a };
}

test('a notes volume a committed deletion could not remove is found by one reconciliation pass and deleted on retry', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager), { admin } = await project(h, f);
  // The manager cannot delete the volume: the deletion still commits (logical delete) and records the intent.
  f.docker.failVolume = true;
  assert.equal((await remove(admin, '101')).status, 200, 'a volume the manager cannot delete does not fail the deletion');
  assert.equal(h.store.get("SELECT 1 FROM repositories WHERE id='101'"), undefined, 'the rows are gone');
  assert.ok(f.docker.volumes.has(f.projects.notesName('101')), 'the volume is still on the manager');
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE repository_id='101' AND action='repository.notes_removal_failed'"), 'the intent is durable');

  const reclaim = await import('../dist/projects/reclaim.js').catch(() => undefined);
  assert.ok(reclaim, 'the reconciliation module exists');
  // The manager works again: one sweep reclaims the volume and closes the intent.
  f.docker.failVolume = false;
  const reclaimer = new reclaim.NotesReclaimer(h.store, h.projects, { baseDelayMs: 0 });
  const left = await reclaimer.sweep();
  assert.deepEqual(left, [], 'nothing is left after the retry succeeded');
  assert.equal(f.docker.volumes.has(f.projects.notesName('101')), false, 'the retry deleted the volume');
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE repository_id='101' AND action='repository.notes_volume_reclaimed'"), 'the reclaim is recorded');
  assert.equal((await fetch(h.admin + '/readyz')).status, 200, 'no orphan is left to report');
});

test('unreclaimed notes volumes are counted in /readyz and fail it above the threshold', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager, { notesOrphanThreshold: 0 }), { admin } = await project(h, f);
  f.docker.failVolume = true;
  assert.equal((await remove(admin, '101')).status, 200, 'the deletion is still reported as committed');
  assert.ok(f.docker.volumes.has(f.projects.notesName('101')), 'the volume stays behind');

  const ready = await fetch(h.admin + '/readyz'), value = await ready.json();
  assert.equal(ready.status, 503, 'an unreclaimed volume above the threshold fails readiness');
  assert.deepEqual(Object.keys(value.notes_volumes).sort(), ['abandoned', 'max_age_seconds', 'oldest_seconds', 'orphans', 'over_age', 'over_threshold', 'retrying', 'threshold', 'trajectory_orphans', 'warn_age_seconds']);
  assert.equal(value.notes_volumes.orphans, 1);
  assert.equal(value.notes_volumes.threshold, 0);
  assert.equal(typeof value.notes_volumes.oldest_seconds, 'number');

  const listed = await admin('/api/maintenance/orphans');
  assert.equal(listed.status, 200, 'the orphan listing is available to an administrator');
  assert.deepEqual(listed.value.notes_volumes.map(orphan => orphan.repository_id), ['101'], 'the listing names the volume that cannot be reclaimed');
  assert.equal(typeof listed.value.notes_volumes[0].first_failed_at, 'string');
});

test('a trajectory directory no repository row claims is reported as an orphan', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager), { admin } = await project(h, f);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(h.store.trajectories.root + '/999', { recursive: true });
  const ready = await fetch(h.admin + '/readyz'), value = await ready.json();
  assert.equal(value.notes_volumes.trajectory_orphans, 1, 'the stray directory is counted');
  const listed = await admin('/api/maintenance/orphans');
  assert.deepEqual(listed.value.trajectories.map(entry => entry.repository_id), ['999'], 'the listing names the stray directory');
});

test('a repository connected again starts from empty notes even when the old volume outlived its deletion', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager), { admin, a } = await project(h, f);
  // The deletion left the volume behind, and the repository is connected again: the old notes must not be readable.
  f.docker.failVolume = true;
  assert.equal((await remove(admin, '101')).status, 200);
  assert.ok(f.docker.volumes.has(f.projects.notesName('101')), 'the old volume is still there');
  f.docker.failVolume = false;
  // The repository is connected again: the control plane registers the project again and reconciles it, which reclaims
  // the stale notes volume before the project can start against it.
  const before = f.docker.calls.length, volume = f.projects.notesName('101');
  await repository(admin, a.id, '101');
  await h.projects.reconcile();
  const calls = f.docker.calls.slice(before), removed = calls.indexOf('DELETE /volumes/' + volume);
  assert.ok(removed >= 0, 'the stale volume is deleted, not merely left unmounted');
  const started = calls.findIndex(call => call.startsWith('POST /containers/create') && call.includes('101'));
  assert.ok(started < 0 || removed < started, 'the stale volume is deleted before the project container is created');
  // The project that starts afterwards gets a new, empty volume; the old one is gone before it can be mounted.
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE repository_id='101' AND action='repository.notes_volume_reclaimed'"), 'the reclaim is recorded');
  // The volume the project gets is a fresh one: the stale volume was reclaimed before it could be mounted, so nothing the
  // old project wrote is readable and the notes directory starts empty.
  await assert.rejects(readFile(join(f.projects.notesRoot, '101', 'repository.md')), /ENOENT/, 'the old notes file is gone');
  const listed = await f.projects.notes('101', 'GET', undefined, {});
  assert.deepEqual(listed.files ?? listed, [], 'the reconnected project starts with empty notes');
});

test('a post-commit cleanup failure is audited for projects and conversations alike, and never escapes', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager), { admin } = await project(h, f);
  const results = h.store.trajectories.results, realRemove = results.remove.bind(results);
  results.remove = () => { throw new Error('injected_cleanup_failure'); };
  t.after(() => { results.remove = realRemove; });
  // Both owner kinds go through one hook, so both leave one audit row and neither throws back into the caller.
  h.store.trajectories.remove({ repository_id: '101' });
  h.store.trajectories.remove({ conversation_id: 'chat-1' });
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE repository_id='101' AND action='repository.evidence_removal_failed'"), 'the project files left behind are audited');
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE resource_id='chat-1' AND action='channel.history_cleanup_failed'"), 'the conversation files left behind are audited');
  assert.equal((await remove(admin, '101')).status, 200, 'the deletion still reports the committed rows');
});

test('the conversation directory is not reported as an orphan trajectory directory', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(h.store.trajectories.root, 'conversations', 'c1'), { recursive: true });
  const reclaim = await import('../dist/projects/reclaim.js');
  assert.deepEqual(reclaim.orphanTrajectoryDirectories(h.store), [], 'per-conversation trajectories are not per-project orphans');
});

test('a second failed deletion of the same repository is a new intent even when an earlier reclaim answered the first', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager);
  const audit = (action, at) => h.store.run("INSERT INTO audit(id,user_id,repository_id,action,resource_id,created_at) VALUES(?,?,?,?,?,?)",
    action + at, 'system', '101', action, '101', at);
  audit('repository.notes_removal_failed', '2026-01-01T00:00:00.000Z');
  audit('repository.notes_volume_reclaimed', '2026-01-01T00:01:00.000Z');
  audit('repository.notes_removal_failed', '2026-01-02T00:00:00.000Z');
  const reclaim = await import('../dist/projects/reclaim.js');
  assert.deepEqual(reclaim.notesOrphanIntents(h.store), [{ repository_id: '101', first_failed_at: '2026-01-02T00:00:00.000Z' }],
    'only the failure no later reclaim answers is an open intent');
});

test('a manager that cannot list notes volumes leaves the maintenance listing at the durable intents', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager), { admin } = await project(h, f);
  f.docker.failVolume = true;
  assert.equal((await remove(admin, '101')).status, 200, 'the deletion commits and records what it could not remove');
  const name = f.projects.notesName('101');
  assert.ok(f.docker.volumes.has(name), 'the volume stays behind');
  const { HttpError } = await import('../dist/core/security.js');
  const real = h.projects.notesVolumes.bind(h.projects);
  t.after(() => { h.projects.notesVolumes = real; });
  // docs/api.md promises the audit intents and the report when the manager cannot be read; the listing must not turn
  // that into a 503 of its own.
  for (const failure of [
    () => { throw new HttpError(503, 'docker_operation_failed'); },
    async () => null,
  ]) {
    h.projects.notesVolumes = failure;
    const listed = await admin('/api/maintenance/orphans');
    assert.equal(listed.status, 200, 'the listing still answers');
    assert.deepEqual(listed.value.notes_volumes.map(orphan => orphan.repository_id), ['101'], 'the durable intent is listed instead');
    assert.equal(listed.value.notes_volumes[0].name, '', 'the volume name is unknown without the manager');
    assert.equal(typeof listed.value.notes_volumes[0].first_failed_at, 'string', 'the intent keeps its age');
    assert.equal(listed.value.report.orphans, 1, 'the report counts exactly what the listing shows');
    assert.equal(listed.value.notes_volumes_unreadable, true, 'the answer says the manager could not be read');
  }
  h.projects.notesVolumes = real;
  const listed = await admin('/api/maintenance/orphans');
  assert.equal(listed.status, 200);
  assert.equal(listed.value.notes_volumes[0].name, name, 'the manager names the volume again once it answers');
  assert.equal(listed.value.notes_volumes_unreadable, false, 'a read answer clears the flag');
});

test('a sweep treats an unreadable notes-volume list as a failure, not as nothing to reclaim', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager), { admin } = await project(h, f);
  f.docker.failVolume = true;
  assert.equal((await remove(admin, '101')).status, 200, 'the deletion leaves its intent behind');
  const reclaim = await import('../dist/projects/reclaim.js');
  const { ProjectService } = await import('../dist/projects/service.js');
  // The same normalization the endpoint uses: an answer without a volume list fails the read, so a sweep cannot claim
  // that nothing is left behind and skip the volume it never saw.
  const unreadable = new ProjectService(h.store, { call: async () => null });
  const blind = new reclaim.NotesReclaimer(h.store, unreadable, { baseDelayMs: 0 });
  await assert.rejects(blind.sweep(), { status: 503, code: 'manager_notes_volumes_unavailable' },
    'a sweep does not mistake an unreadable list for an empty one');
  assert.equal(h.store.get("SELECT 1 FROM audit WHERE action='repository.notes_volume_reclaimed'"), undefined, 'nothing is recorded as reclaimed');
  // The next sweep with a manager that answers reclaims the volume the failed one left alone.
  f.docker.failVolume = false;
  const reclaimer = new reclaim.NotesReclaimer(h.store, h.projects, { baseDelayMs: 0 });
  assert.deepEqual(await reclaimer.sweep(), [], 'the volume is reclaimed once the manager answers');
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE repository_id='101' AND action='repository.notes_volume_reclaimed'"), 'the reclaim is recorded');
});

test('the notes-volume list reads a bare array and a volumes envelope, and refuses an answer it cannot read', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager);
  const { ProjectService } = await import('../dist/projects/service.js');
  const volume = { name: 'dbot-1-101-notes', repository_id: '101', created_at: null };
  const service = answer => new ProjectService(h.store, { call: async () => answer });
  assert.deepEqual(await service([volume]).notesVolumes(), [volume], 'a bare array is the manager answer today');
  assert.deepEqual(await service({ volumes: [volume] }).notesVolumes(), [volume], 'an envelope is read the same way');
  for (const unreadable of [null, { volumes: 'nope' }, undefined])
    await assert.rejects(service(unreadable).notesVolumes(), { status: 503, code: 'manager_notes_volumes_unavailable' },
      'an answer without a volume list is unreadable, not an empty list');
});
