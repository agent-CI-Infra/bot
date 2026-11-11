import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteComponent, notePath, withNoteDirectory, withNoteParent } from '../runner/note-path.mjs';
import { Notes, withNotesLock } from '../runner/notes.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'note-path-')), root = join(base, 'notes'), other = join(base, 'other');
  await mkdir(root); await mkdir(other); await writeFile(join(other, 'sentinel'), 'outside');
  t.after(() => rm(base, { recursive: true, force: true })); return { base, root, other };
}

test('note paths preserve literal names and reject traversal, absolute paths and internal storage', () => {
  for (const value of ['folder/自由 #?%.txt', '%2e%2e/file', '目录/子目录/empty.txt', 'C:old.txt']) assert.equal(notePath(value), value);
  assert.equal(notePath('', { root: true }), ''); assert.equal(noteComponent('.history'), '.history');
  for (const value of ['', '.', '..', 'a/../b', 'a/./b', 'a//b', 'a/', '/a', 'C:/a', 'a\\b', 'a/\0b', '.git/file', 'a/.write-history/blob', 'a/.expired-x/b', Array(34).fill('a').join('/')]) assert.throws(() => notePath(value), /invalid_note_path/);
  assert.equal(notePath('.write-history/blobs/hash', { internal: true }), '.write-history/blobs/hash');
});

test('real directories and descriptor-relative file reads preserve the old flat note API', async t => {
  const { root } = await fixture(t), notes = new Notes(root);
  await notes.write('C:old.txt', 'colon name'); assert.equal((await notes.read('C:old.txt')).content, 'colon name');
  await notes.write('old.txt', 'old content'); assert.equal((await notes.read('old.txt')).content, 'old content');
  await withNoteDirectory(root, 'one/two', (path, handle) => { assert.ok(handle.fd >= 0); return writeFile(path + '/file.txt', 'nested'); }, { create: true });
  const content = await withNoteParent(root, 'one/two/file.txt', path => readFile(path, 'utf8'));
  assert.equal(content, 'nested'); assert.equal(await readFile(join(root, 'one/two/file.txt'), 'utf8'), 'nested');
});

test('a symlink in any ancestor is refused for reads and parent creation', async t => {
  const { root, other } = await fixture(t); await symlink(other, join(root, 'redirect'));
  await assert.rejects(withNoteParent(root, 'redirect/sentinel', path => readFile(path, 'utf8')), /invalid_note_path/);
  await assert.rejects(withNoteDirectory(root, 'redirect/new', () => {}, { create: true }), /invalid_note_path/);
  assert.equal(await readFile(join(other, 'sentinel'), 'utf8'), 'outside');
  await assert.rejects(readFile(join(other, 'new')), { code: 'ENOENT' });
});

test('replacing a checked parent with a symlink cannot redirect the pinned file operation', async t => {
  const { root, other } = await fixture(t); await mkdir(join(root, 'sub')); await writeFile(join(root, 'sub/sentinel'), 'inside');
  await withNoteParent(root, 'sub/sentinel', async path => {
    await rename(join(root, 'sub'), join(root, 'parked')); await symlink(other, join(root, 'sub'));
    assert.equal(await readFile(path, 'utf8'), 'inside'); await writeFile(path, 'inside updated');
  });
  assert.equal(await readFile(join(other, 'sentinel'), 'utf8'), 'outside');
  assert.equal(await readFile(join(root, 'parked/sentinel'), 'utf8'), 'inside updated');
});

test('directory descriptors close when a callback fails', async t => {
  const { root } = await fixture(t); let parent;
  await assert.rejects(withNoteDirectory(root, '', (_path, handle) => { parent = handle; throw new Error('callback failed'); }), /callback failed/);
  assert.equal(parent.fd, -1);
});


test('a pinned child directory can reuse the project lease for content and its version history', async t => {
  const { root } = await fixture(t);
  await withNotesLock(root, check => withNoteDirectory(root, 'folder', async path => {
    const notes = new Notes(path + '/.', { canonicalRoot: root + '/folder', check });
    const first = await notes.saveFile('file.txt', 'one', 0, 'user:a'); assert.equal(first.revision, 1);
    await notes.saveFile('file.txt', 'two', 1, 'user:a');
    assert.equal((await notes.file('file.txt', 1)).content, 'one');
    assert.equal((await notes.versions('file.txt')).versions.length, 2);
    await notes.removeFile('file.txt', 2); assert.equal((await notes.file('file.txt')).deleted, true);
  }, { create: true }));
});

test('a history directory swapped after validation is rejected before its index is read', async t => {
  const { root, other } = await fixture(t), notes = new Notes(root); await notes.saveFile('file.txt', 'inside', 0);
  const original = notes.historyRoot.bind(notes); let swapped = false;
  notes.historyRoot = async () => {
    const path = await original();
    if (!swapped) { swapped = true; await rename(path, root + '/retained-history'); await symlink(other, path); }
    return path;
  };
  await assert.rejects(notes.file('file.txt'), /invalid_note_path/);
  assert.equal(await readFile(join(other, 'sentinel'), 'utf8'), 'outside');
});

test('atomic history writes keep the checked destination when its parent entry is replaced', async t => {
  const { root, other } = await fixture(t), notes = new Notes(root); await notes.historyRoot();
  await notes.atomic(root + '/.write-history/blobs/target', 'inside', async () => {
    await rename(root + '/.write-history/blobs', root + '/retained-blobs'); await symlink(other, root + '/.write-history/blobs');
  });
  assert.equal(await readFile(root + '/retained-blobs/target', 'utf8'), 'inside');
  await assert.rejects(readFile(join(other, 'target')), { code: 'ENOENT' });
});

test('a name carrying a control character is refused at the component and the path boundary', () => {
  // NUL was already refused; every other C0 control, DEL, the C1 range and the two line separators are as invalid in a
  // note name: they cannot be shown or typed in the console, and they break every line-oriented reader of the catalog.
  const names = ['ctl\u0001name.txt', 'tab\tname.txt', 'new\nline.txt', 'esc\u001b[31m.txt', 'del\x7fname.txt', 'c1\x85name.txt', 'line\u2028sep.txt', 'para\u2029sep.txt'];
  for (const value of names) assert.throws(() => noteComponent(value), /invalid_note_name/, JSON.stringify(value));
  for (const value of names.map(name => 'folder/' + name)) assert.throws(() => notePath(value), /invalid_note_path/, JSON.stringify(value));
  // A name without a control character is still accepted, including the separator characters a name may legitimately carry.
  for (const value of ['自由 文件.txt', 'a b.txt', 'dash-and_underscore.txt', 'emoji 🚀.txt']) assert.equal(noteComponent(value), value);
});
