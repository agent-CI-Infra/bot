import { open, mkdir, realpath, lstat, rm, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';

// File access of an assistant computer (#457) below its HOME (/home/assistant, the owner's persistent mount) and its
// temporary areas /workspace (the working directory, where relative paths start) and /tmp; the runner journal is never
// reachable. Everything here belongs to one conversation owner, but paths are still confined and symlinks not followed.
const roots = ['/workspace', '/tmp', '/home/assistant'], chunk = 1024 * 1024;
async function target(value, create = false) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error('invalid_path');
  const path = resolve('/workspace', value), root = roots.find(r => path === r || path.startsWith(r + '/'));
  if (!root || path === root || path.slice(root.length + 1).split('/').some(p => p === '.runner-journal')) throw new Error('invalid_path');
  if (create) await mkdir(dirname(path), { recursive: true });
  const parent = await realpath(dirname(path)), real = await realpath(root);
  if (parent !== real && !parent.startsWith(real + sep)) throw new Error('invalid_path');
  return path;
}
export async function assistantFile(input) {
  if (input.type === 'assistant_read') {
    const offset = input.offset ?? 0, limit = input.limit ?? chunk;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > chunk) throw new Error('invalid_range');
    const handle = await open(await target(input.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('regular_file_required');
      const buffer = Buffer.alloc(Math.max(0, Math.min(limit, info.size - offset))), { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return { base64: buffer.subarray(0, bytesRead).toString('base64'), offset, size: info.size, modified_ms: Math.floor(info.mtimeMs) };
    } finally { await handle.close(); }
  }
  if (input.type === 'assistant_write') {
    if (typeof input.base64 !== 'string' || input.base64.length > 56000 || !Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('invalid_content');
    const data = Buffer.from(input.base64, 'base64');
    const handle = await open(await target(input.path, true), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (input.offset === 0 ? constants.O_TRUNC : 0), 0o644);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('regular_file_required');
      if (info.size !== input.offset) throw new Error('offset_mismatch');
      await handle.write(data, 0, data.length, input.offset);
    } finally { await handle.close(); }
    return { written: true, size: input.offset + data.length };
  }
  if (input.type === 'assistant_delete') {
    const path = await target(input.path), info = await lstat(path).catch(() => null);
    if (!info) return { deleted: false };
    // A symlink is removed itself; a directory with everything below it (rm never follows links).
    if (info.isDirectory()) await rm(path, { recursive: true, force: true }); else await unlink(path);
    return { deleted: true, directory: info.isDirectory() };
  }
  throw new Error('unsupported_assistant_operation');
}
