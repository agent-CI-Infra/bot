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
