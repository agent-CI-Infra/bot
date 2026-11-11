import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, setup, account, repository } from './helpers.mjs';
import { managerFixture } from './project-manager-fixture.mjs';

// #232 slice 1: knowledge files are addressed by a real multi-segment path. The path is the file identity, the same
// version store keeps history across a rename or a move, and a directory that is a symlink out of the notes volume is
// refused instead of followed.
const base = '/api/repositories/101/knowledge-files';
const noteId = name => 'n:' + Buffer.from(name).toString('base64url');
const endpoint = name => base + '/' + encodeURIComponent(noteId(name));

async function project(t) {
  const f = await managerFixture(t), h = await harness(t, f.manager), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  return { f, h, admin };
}

test('a nested path is one file: create, read, save and list keep every segment', async t => {
  const { admin } = await project(t);
  const created = await admin(base, 'POST', { name: 'guides/setup.md', content: 'first' });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  assert.equal(created.value.file.id, noteId('guides/setup.md'));
  const read = await admin(endpoint('guides/setup.md'));
  assert.equal(read.status, 200);
  assert.equal(read.value.file.content, 'first');
  assert.equal(read.value.file.name, 'guides/setup.md');
  const saved = await admin(endpoint('guides/setup.md'), 'PUT', { content: 'second', expected_revision: 1 });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.equal(saved.value.file.revision, 2);
  const list = await admin(base);
  assert.ok(list.value.files.some(file => file.name === 'guides/setup.md' && file.revision === 2), JSON.stringify(list.value.files));
});

test('paths that leave the notes volume, or name internal entries, are refused', async t => {
  const { admin } = await project(t);
  for (const name of ['../escape.md', '/etc/passwd', 'a/../b.md', 'a//b.md', 'a\\b.md', '.git/config', 'docs/.write-lock/owner',
    'docs/./b.md', 'docs/.expired-token/x', 'docs/.write-history/x', 'x'.repeat(200) + '/y.md'])
    assert.equal((await admin(base, 'POST', { name, content: 'x' })).status, 400, name);
});

test('rename and move keep every version and make the old path disappear', async t => {
  const { admin } = await project(t);
  assert.equal((await admin(base, 'POST', { name: 'notes/today.md', content: 'v1' })).status, 201);
  assert.equal((await admin(endpoint('notes/today.md'), 'PUT', { content: 'v2', expected_revision: 1 })).value.file.revision, 2);

  const renamed = await admin(endpoint('notes/today.md') + '/rename', 'POST', { name: 'tomorrow.md', expected_revision: 2 });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.value));
  assert.equal(renamed.value.file.name, 'notes/tomorrow.md');
  assert.equal(renamed.value.file.id, noteId('notes/tomorrow.md'));
  assert.equal(renamed.value.file.revision, 2);
  assert.equal((await admin(endpoint('notes/today.md'))).status, 404);

  const versions = await admin(endpoint('notes/tomorrow.md') + '/versions');
  assert.deepEqual(versions.value.versions.map(version => version.revision), [2, 1]);
  assert.equal((await admin(endpoint('notes/tomorrow.md') + '?revision=1')).value.file.content, 'v1');

  const moved = await admin(endpoint('notes/tomorrow.md') + '/move', 'POST', { name: 'archive/2026/tomorrow.md', expected_revision: 2 });
  assert.equal(moved.status, 200, JSON.stringify(moved.value));
  assert.equal(moved.value.file.name, 'archive/2026/tomorrow.md');
  assert.equal(moved.value.file.revision, 2);
  assert.equal((await admin(endpoint('notes/tomorrow.md'))).status, 404);
  const listed = await admin(base);
  assert.ok(listed.value.files.some(file => file.name === 'archive/2026/tomorrow.md' && file.revision === 2));
});

test('a rename onto an occupied path, a stale revision and a missing source are refused', async t => {
  const { admin } = await project(t);
  assert.equal((await admin(base, 'POST', { name: 'a/one.md', content: 'one' })).status, 201);
  assert.equal((await admin(base, 'POST', { name: 'b/two.md', content: 'two' })).status, 201);
  assert.equal((await admin(endpoint('a/one.md') + '/move', 'POST', { name: 'b/two.md', expected_revision: 1 })).status, 409);
  assert.equal((await admin(endpoint('a/one.md') + '/rename', 'POST', { name: 'one.md', expected_revision: 2 })).status, 409);
  assert.equal((await admin(endpoint('a/one.md') + '/rename', 'POST', { name: 'missing.md' })).status, 400);
  assert.equal((await admin(endpoint('a/missing.md') + '/rename', 'POST', { name: 'x.md', expected_revision: 1 })).status, 404);
  assert.equal((await admin(endpoint('a/one.md') + '/rename', 'POST', { name: '../one.md', expected_revision: 1 })).status, 400);
  // A refused move leaves both files untouched.
  assert.equal((await admin(endpoint('a/one.md'))).value.file.content, 'one');
  assert.equal((await admin(endpoint('b/two.md'))).value.file.content, 'two');
});

test('a flat legacy file keeps its versions when it moves into a directory', async t => {
  const { admin } = await project(t);
  assert.equal((await admin(base, 'POST', { name: 'legacy.md', content: 'old flat' })).status, 201);
  assert.equal((await admin(endpoint('legacy.md'), 'PUT', { content: 'old flat v2', expected_revision: 1 })).value.file.revision, 2);
  const moved = await admin(endpoint('legacy.md') + '/move', 'POST', { name: 'docs/legacy.md', expected_revision: 2 });
  assert.equal(moved.status, 200, JSON.stringify(moved.value));
  assert.equal(moved.value.file.revision, 2);
  const versions = await admin(endpoint('docs/legacy.md') + '/versions');
  assert.deepEqual(versions.value.versions.map(version => version.revision), [2, 1]);
  assert.equal((await admin(endpoint('docs/legacy.md') + '?revision=1')).value.file.content, 'old flat');
});

test('a directory that is a symlink out of the notes volume is refused, not followed', async t => {
  const { f, admin } = await project(t);
  const notes = join(f.root, 'project-notes', '101'), outside = join(f.root, 'outside');
  await mkdir(notes, { recursive: true }); await mkdir(outside, { recursive: true }); await writeFile(join(outside, 'sentinel'), 'unchanged');
  await symlink(outside, join(notes, 'linked'));
  assert.equal((await admin(base, 'POST', { name: 'linked/escape.md', content: 'nope' })).status, 400);
  assert.deepEqual(await readdir(outside), ['sentinel']);
});
