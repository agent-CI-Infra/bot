// #774: the notes volume name is fixed per repository (manager/projects.mjs:214, notesName), so a deletion whose notes
// removal failed (manager/projects.mjs:649-651) leaves a volume — and the notes directory it binds — behind. Enabling the
// same repository again must never hand that old content to the new project: each of the three entries (create a project,
// re-enable a deleted one, reconnect a repository whose manager row is gone) is checked for "the first notes read is
// empty", and a residue that cannot be cleared fails the enable instead of exposing it. The assertions are about what a
// reader sees, never about the volume itself: deleting it is only the means.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { managerFixture } from './project-manager-fixture.mjs';

const id = () => randomBytes(24).toString('hex');

// The residue exactly as a failed notes removal leaves it: the volume under the name the manager derives from the repo id,
// carrying the notes labels, and the old note inside the directory the volume binds. Created through the manager's own
// naming, never a hand-written volume name.
async function leftover(fixture, repo) {
  const { root, docker, projects } = fixture;
  docker.volumes.set(projects.notesName(repo), { Labels: projects.notesLabels(repo), Options: {} });
  await mkdir(join(root, 'project-notes', repo), { recursive: true });
  await writeFile(join(root, 'project-notes', repo, 'repository.md'), 'old-' + repo);
  return fixture;
}

// A project that had notes and then a deletion whose notes removal failed: the manager row is deleted, the volume and the
// old note stay.
async function deletedWithResidue(t, repo = '7001') {
  const fixture = await managerFixture(t), { docker, projects } = fixture;
  assert.equal((await projects.register(repo)).state, 'ready');
  await projects.notes(repo, 'PUT', 'repository.md', { content: 'old-' + repo });
  docker.failVolume = true;
  await assert.rejects(projects.operate(repo, 'delete', { operation_id: id(), generation: 1, request: { delete_notes: true } }));
  docker.failVolume = false;
  return { ...fixture, repo };
}

test('a notes removal that failed keeps the deletion itself committed, so a re-enable can tell residue from a live project', async t => {
  const { projects, repo } = await deletedWithResidue(t);
  assert.equal(projects.get(repo).state, 'deleted', 'the rows and the computer are gone; only the cleanup is owed');
  assert.equal(projects.get(repo).desired, 'deleted');
});

test('creating a project for a repository with a leftover notes volume starts with empty notes', async t => {
  const fixture = await managerFixture(t), repo = '7002';
  await leftover(fixture, repo);
  assert.equal((await fixture.projects.register(repo)).state, 'ready');
  assert.deepEqual((await fixture.projects.notes(repo, 'GET')).files, [], 'the new project never reads the previous notes');
  await assert.rejects(fixture.projects.notes(repo, 'GET', 'repository.md'), /note_not_found/);
});

test('re-enabling a deleted project never hands the leftover notes to the new project', async t => {
  const { projects, repo } = await deletedWithResidue(t);
  await projects.operate(repo, 'start', { operation_id: id(), generation: 1 });
  assert.equal(projects.get(repo).state, 'ready');
  assert.deepEqual((await projects.notes(repo, 'GET')).files, [], 'the first read of the re-enabled project is empty');
  await assert.rejects(projects.notes(repo, 'GET', 'repository.md'), /note_not_found/, 'the old note is gone');
});

test('reconnecting a repository whose manager row is gone never serves the previous notes', async t => {
  const fixture = await managerFixture(t), repo = '7003';
  await leftover(fixture, repo); // the manager restarted or lost its row; the volume and its directory stayed
  assert.equal(fixture.projects.get(repo), undefined, 'no manager row: this is the reconnect entry');
  assert.deepEqual((await fixture.projects.notes(repo, 'GET')).files, [], 'the first notes read of the reconnected repository is empty');
  await assert.rejects(fixture.projects.notes(repo, 'GET', 'repository.md'), /note_not_found/, 'the old note is not readable');
  assert.notEqual(fixture.projects.get(repo).state, 'ready', 'reading notes does not enable the project');
});

test('a leftover notes volume that cannot be cleared fails the enable and is never served', async t => {
  const { docker, projects, repo } = await deletedWithResidue(t);
  docker.failVolume = true;
  await assert.rejects(projects.operate(repo, 'start', { operation_id: id(), generation: 1 }), /notes_residue_unclearable/,
    'an enable that cannot clear the residue fails instead of starting on top of it');
  await assert.rejects(projects.notes(repo, 'GET'), /notes_residue_unclearable/,
    'a notes listing must not be served from the residue when it cannot be cleared');
  await assert.rejects(projects.notes(repo, 'GET', 'repository.md'), /notes_residue_unclearable/,
    'a notes read must not fall back to the old content when the residue cannot be cleared');
});

// #783: the marker alone says a purge is owed. A stop after the committed deletion, or a pending reset that ended
// reset_failed, moves the state away from deleted while the cleanup is still outstanding; the guard must still hit.
test('a purge marker whose state moved away from deleted still clears the residue before any notes are served', async t => {
  const { projects, docker, repo } = await deletedWithResidue(t);
  projects.db.prepare("UPDATE projects SET state='stopped',desired='stopped' WHERE repository_id=?").run(repo);
  assert.equal(Number(projects.get(repo).notes_purge), 1, 'the cleanup is still owed');
  // The marker outlives the state, so the first read clears the old notes instead of serving them.
  assert.deepEqual((await projects.notes(repo, 'GET')).files, [], 'the old notes are not served from a row that left deleted');
  await assert.rejects(projects.notes(repo, 'GET', 'repository.md'), /note_not_found/);
  assert.equal(Number(projects.get(repo).notes_purge), 0, 'the purge is done once the volume and its directory are gone');
  assert.ok(docker.volumes.has(projects.notesName(repo)), 'the read rebuilds an empty volume to serve from, not the one it cleared');
});

test('a residue that is only the notes directory, with no volume left, is cleared without failing the entry', async t => {
  const fixture = await managerFixture(t), repo = '7004';
  await mkdir(join(fixture.root, 'project-notes', repo), { recursive: true });
  await writeFile(join(fixture.root, 'project-notes', repo, 'repository.md'), 'old-' + repo);
  assert.equal(fixture.docker.volumes.has(fixture.projects.notesName(repo)), false, 'the volume is already gone');
  // The directory alone is residue too: the first read creates the volume empty rather than serving what the directory holds.
  assert.deepEqual((await fixture.projects.notes(repo, 'GET')).files, []);
  await assert.rejects(fixture.projects.notes(repo, 'GET', 'repository.md'), /note_not_found/);
  assert.equal(fixture.projects.get(repo).state, 'stopped', 'reading notes only registers the stopped metadata');
});

test('a leftover volume whose labels are not this repository is refused, and its notes stay where they are', async t => {
  const fixture = await managerFixture(t), repo = '7005', { docker, projects, root } = fixture;
  docker.volumes.set(projects.notesName(repo), { Labels: { 'department.bot.kind': 'someone-else' }, Options: {} });
  await mkdir(join(root, 'project-notes', repo), { recursive: true });
  await writeFile(join(root, 'project-notes', repo, 'repository.md'), 'old-' + repo);
  await assert.rejects(projects.register(repo), /resource_ownership_mismatch/, 'a volume this repository does not own is never deleted');
  assert.equal(projects.get(repo), undefined, 'the refused reconnect registers nothing');
  assert.ok(docker.volumes.has(projects.notesName(repo)), 'the volume stays');
  await assert.rejects(projects.notes(repo, 'GET'), /resource_ownership_mismatch/, 'a notes entry is refused the same way');
  await assert.rejects(projects.notes(repo, 'GET', 'repository.md'), /resource_ownership_mismatch/);
  assert.equal(projects.get(repo), undefined, 'neither entry registered the project');
});

test('a notes volume Docker refuses to delete keeps the deletion committed and the purge owed', async t => {
  const { docker, projects, repo } = await deletedWithResidue(t);
  assert.equal(projects.get(repo).state, 'deleted', 'the committed deletion still reads as deleted');
  assert.equal(projects.get(repo).desired, 'deleted');
  assert.equal(Number(projects.get(repo).notes_purge), 1, 'the removal that failed is still owed');
  docker.failVolume = true;
  await assert.rejects(projects.operate(repo, 'start', { operation_id: id(), generation: 1 }), /notes_residue_unclearable/);
  assert.equal(projects.get(repo).state, 'deleted', 'a refused enable does not turn the committed deletion into a failure');
  assert.equal(Number(projects.get(repo).notes_purge), 1, 'and does not drop the purge it still owes');
});

test('the paths that never asked for a notes removal keep the notes they were left with', async t => {
  const fixture = await managerFixture(t), repo = '7006', { projects, docker } = fixture;
  assert.equal((await projects.register(repo)).state, 'ready');
  await projects.notes(repo, 'PUT', 'repository.md', { content: 'keep-' + repo });
  // Deleting only the computer keeps project notes, and neither that nor a stop sets the purge marker.
  await projects.operate(repo, 'delete', { operation_id: id(), generation: 1 });
  assert.equal(Number(projects.get(repo).notes_purge), 0);
  await projects.operate(repo, 'stop', { operation_id: id(), generation: 1 });
  assert.equal(Number(projects.get(repo).notes_purge), 0);
  assert.equal((await projects.notes(repo, 'GET', 'repository.md')).content, 'keep-' + repo, 'the notes are still there');
  assert.ok(docker.volumes.has(projects.notesName(repo)), 'and so is the volume');
});
