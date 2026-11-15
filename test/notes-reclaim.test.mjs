import test from 'node:test';
import assert from 'node:assert/strict';
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
  return admin;
}

test('a notes volume a committed deletion could not remove is found by one reconciliation pass and deleted on retry', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager), admin = await project(h, f);
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
  const f = await managerFixture(t), h = await harness(t, f.manager, { notesOrphanThreshold: 0 }), admin = await project(h, f);
  f.docker.failVolume = true;
  assert.equal((await remove(admin, '101')).status, 200, 'the deletion is still reported as committed');
  assert.ok(f.docker.volumes.has(f.projects.notesName('101')), 'the volume stays behind');

  const ready = await fetch(h.admin + '/readyz'), value = await ready.json();
  assert.equal(ready.status, 503, 'an unreclaimed volume above the threshold fails readiness');
  assert.deepEqual(Object.keys(value.notes_volumes).sort(), ['max_age_seconds', 'oldest_seconds', 'orphans', 'threshold', 'trajectory_orphans']);
  assert.equal(value.notes_volumes.orphans, 1);
  assert.equal(value.notes_volumes.threshold, 0);
  assert.equal(typeof value.notes_volumes.oldest_seconds, 'number');

  const listed = await admin('/api/maintenance/orphans');
  assert.equal(listed.status, 200, 'the orphan listing is available to an administrator');
  assert.deepEqual(listed.value.notes_volumes.map(orphan => orphan.repository_id), ['101'], 'the listing names the volume that cannot be reclaimed');
  assert.equal(typeof listed.value.notes_volumes[0].first_failed_at, 'string');
});

test('a trajectory directory no repository row claims is reported as an orphan', async t => {
  const f = await managerFixture(t), h = await harness(t, f.manager), admin = await project(h, f);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(h.store.trajectories.root + '/999', { recursive: true });
  const ready = await fetch(h.admin + '/readyz'), value = await ready.json();
  assert.equal(value.notes_volumes.trajectory_orphans, 1, 'the stray directory is counted');
  const listed = await admin('/api/maintenance/orphans');
  assert.deepEqual(listed.value.trajectories.map(entry => entry.repository_id), ['999'], 'the listing names the stray directory');
});
