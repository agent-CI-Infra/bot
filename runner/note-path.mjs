import { open, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';

export function noteComponent(value) {
  if (typeof value !== 'string' || !value || /[/\\\0]/.test(value) || ['.', '..', '.git'].includes(value.toLowerCase()) || value.startsWith('.write-') || value.startsWith('.expired-')) throw new Error('invalid_note_name');
  return value;
}
// Paths are relative and already canonical. Do not normalize away traversal or decode names a second time.
export function notePath(value, { root = false, internal = false } = {}) {
  if (root && value === '') return '';
  if (typeof value !== 'string' || !value || value.startsWith('/') || /^[a-z]:\//i.test(value) || /[\\\0]/.test(value) || Buffer.byteLength(value) > 4096) throw new Error('invalid_note_path');
  const parts = value.split('/');
  if (parts.length > 32) throw new Error('invalid_note_path');
  for (const part of parts) {
    if (Buffer.byteLength(part) > 255) throw new Error('invalid_note_path');
    try {
      if (internal && (part.startsWith('.write-') || part.startsWith('.expired-'))) {
        if (!part || ['.', '..', '.git'].includes(part.toLowerCase())) throw new Error('invalid_note_path');
      } else noteComponent(part);
    } catch { throw new Error('invalid_note_path'); }
  }
  return value;
}
// Linux project computers and the manager use the same mounted volume. Keep every ancestor open so replacing a
// checked directory with a symlink cannot redirect later operations through the returned descriptor path.
export async function withNoteDirectory(root, relative, run, { create = false, internal = false, canonicalRoot = root } = {}) {
  notePath(relative, { root: true, internal });
  const parts = relative ? relative.split('/') : [], handles = [];
  const directory = async path => {
    try { return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) {
      if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw new Error('invalid_note_path');
      throw error;
    }
  };
  try {
    const first = await directory(root); handles.push(first);
    if (await realpath('/proc/self/fd/' + first.fd) !== canonicalRoot) throw new Error('invalid_notes_directory');
    let expected = canonicalRoot;
    for (const component of parts) {
      const parent = handles.at(-1), path = '/proc/self/fd/' + parent.fd + '/' + component;
      if (create) {
        try { await mkdir(path, { mode: 0o770 }); await parent.sync(); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const child = await directory(path); handles.push(child); expected += '/' + component;
      if (await realpath('/proc/self/fd/' + child.fd) !== expected) throw new Error('invalid_note_path');
    }
    return await run('/proc/self/fd/' + handles.at(-1).fd, handles.at(-1));
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}
// The final file is not opened here: readers also use O_NOFOLLOW, while rename/unlink act on the entry itself.
export async function withNoteParent(root, relative, run, options = {}) {
  notePath(relative, options);
  const parts = relative.split('/'), name = parts.pop();
  return withNoteDirectory(root, parts.join('/'), (path, handle) => run(path + '/' + name, handle), options);
}
