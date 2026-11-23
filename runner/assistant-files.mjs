import { open, mkdir, realpath, lstat, readdir, readlink, rename, rm, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, sep } from 'node:path';

const execFileAsync = promisify(execFile);

// File access of an assistant computer (#457, #1279) below its HOME (/home/assistant, the owner's persistent mount) and its
// temporary areas /workspace (the working directory, where relative paths start) and /tmp; the runner journal is never
// reachable. Everything here belongs to one conversation owner, but paths are still confined and symlinks not followed.
const roots = ['/workspace', '/tmp', '/home/assistant'], chunk = 1024 * 1024;
const checkoutRoots = ['/workspace', '/tmp'];
const STAGE_ID_RE = /^[a-f0-9]{48}$/;
export const MAX_ASSISTANT_ARCHIVE_COMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ASSISTANT_ARCHIVE_FILES = 200_000;
const MAX_ASSISTANT_ARCHIVE_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;

function isReservedSegment(segment) {
  return segment === '.runner-journal' || segment === '.bot-bg' || segment.startsWith('.bot-archive-') || segment.startsWith('.bot-unpack-');
}

function resolveRoots(options = {}) {
  const workspaceRoot = options.workspaceRoot || '/workspace';
  const tmpRoot = options.tmpRoot || '/tmp';
  const homeRoot = options.homeRoot || '/home/assistant';
  return {
    workspaceRoot,
    tmpRoot,
    homeRoot,
    allRoots: [workspaceRoot, tmpRoot, homeRoot],
    checkoutRoots: [workspaceRoot, tmpRoot],
  };
}

async function target(value, create = false, { workspaceRoot, allowedRoots }) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error('invalid_path');
  const path = resolve(workspaceRoot, value), root = allowedRoots.find(r => path === r || path.startsWith(r + '/'));
  if (!root || path === root || path.slice(root.length + 1).split('/').some(isReservedSegment)) throw new Error('invalid_path');
  if (create) await mkdir(dirname(path), { recursive: true });
  const parent = await realpath(dirname(path)), real = await realpath(root);
  if (parent !== real && !parent.startsWith(real + sep)) throw new Error('invalid_path');
  return { path, root, realRoot: real };
}

function archiveStagePath(stageId, tmpRoot) {
  if (!STAGE_ID_RE.test(stageId || '')) throw new Error('invalid_stage_id');
  return resolve(tmpRoot, `.bot-archive-${stageId}.tar.gz`);
}

function configuredLimitBytes(root, workspaceRoot, env = process.env) {
  const raw = root === workspaceRoot ? env.BOT_WORKSPACE_LIMIT_MB : env.BOT_TMP_LIMIT_MB;
  const mb = Number(raw);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : null;
}

async function inspectTarArchive(archivePath) {
  const { stdout } = await execFileAsync('tar', ['-tzf', archivePath], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  const entries = stdout.split('\n').filter(Boolean);
  if (entries.length > MAX_ASSISTANT_ARCHIVE_FILES) throw new Error('archive_too_many_files');
  for (const rawEntry of entries) {
    const entry = rawEntry.replace(/^\.\//, '');
    if (!entry) continue;
    if (entry.startsWith('/') || entry.includes('\0')) throw new Error('unsafe_archive_path');
    const parts = entry.split('/').filter(Boolean);
    if (parts.some(part => part === '..')) throw new Error('unsafe_archive_path');
  }
  const verbose = await execFileAsync('tar', ['-tvzf', archivePath], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  let files = 0;
  let bytes = 0;
  for (const line of verbose.stdout.split('\n')) {
    if (!line) continue;
    const typeChar = line[0];
    // Allow only regular files (-), directories (d), and symlinks (l); reject hardlinks (h), devices (b/c), FIFOs (p).
    if (!['-', 'd', 'l'].includes(typeChar)) throw new Error('unsafe_archive_entry_type');
    if (typeChar === '-') {
      files++;
      const fields = line.trim().split(/\s+/);
      const size = Number(fields[2]);
      if (Number.isFinite(size) && size > 0) bytes += size;
    }
  }
  if (bytes > MAX_ASSISTANT_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error('archive_too_large');
  return { files, bytes };
}

async function verifyExtractedTree(stageDir) {
  const realStage = await realpath(stageDir);
  const stack = [realStage];
  while (stack.length) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(current, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) {
        const linkTarget = await readlink(fullPath);
        if (!linkTarget || linkTarget.startsWith('/')) throw new Error('unsafe_archive_symlink');
        const resolvedTarget = resolve(dirname(fullPath), linkTarget);
        if (resolvedTarget !== realStage && !resolvedTarget.startsWith(realStage + sep)) {
          throw new Error('unsafe_archive_symlink');
        }
      } else if (info.isDirectory()) {
        stack.push(fullPath);
      } else if (!info.isFile()) {
        throw new Error('unsafe_archive_entry_type');
      }
    }
  }
}

export async function assistantFile(input, options = {}) {
  const { workspaceRoot, tmpRoot, allRoots, checkoutRoots: allowedCheckoutRoots } = resolveRoots(options);
  const env = options.env || process.env;
  if (input.type === 'assistant_read') {
    const offset = input.offset ?? 0, limit = input.limit ?? chunk;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > chunk) throw new Error('invalid_range');
    const handle = await open((await target(input.path, false, { workspaceRoot, allowedRoots: allRoots })).path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    const handle = await open((await target(input.path, true, { workspaceRoot, allowedRoots: allRoots })).path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (input.offset === 0 ? constants.O_TRUNC : 0), 0o644);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('regular_file_required');
      if (info.size !== input.offset) throw new Error('offset_mismatch');
      await handle.write(data, 0, data.length, input.offset);
    } finally { await handle.close(); }
    return { written: true, size: input.offset + data.length };
  }
  if (input.type === 'assistant_delete') {
    const { path } = await target(input.path, false, { workspaceRoot, allowedRoots: allRoots }), info = await lstat(path).catch(() => null);
    if (!info) return { deleted: false };
    // A symlink is removed itself; a directory with everything below it (rm never follows links).
    if (info.isDirectory()) await rm(path, { recursive: true, force: true }); else await unlink(path);
    return { deleted: true, directory: info.isDirectory() };
  }
  if (input.type === 'assistant_archive_stage') {
    if (typeof input.base64 !== 'string' || input.base64.length > 65536 || !Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('invalid_content');
    const data = Buffer.from(input.base64, 'base64');
    if (input.offset + data.length > MAX_ASSISTANT_ARCHIVE_COMPRESSED_BYTES) throw new Error('archive_too_large');
    const stagePath = archiveStagePath(input.stage_id, tmpRoot);
    const handle = await open(stagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (input.offset === 0 ? constants.O_TRUNC : 0), 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('regular_file_required');
      if (info.size !== input.offset) throw new Error('offset_mismatch');
      await handle.write(data, 0, data.length, input.offset);
    } finally { await handle.close(); }
    return { staged: true, size: input.offset + data.length };
  }
  if (input.type === 'assistant_archive_extract') {
    const stagePath = archiveStagePath(input.stage_id, tmpRoot);
    const overwrite = input.overwrite === true;
    let stageDir = null;
    try {
      const archiveInfo = await lstat(stagePath).catch(() => null);
      if (!archiveInfo || !archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error('archive_missing');
      if (archiveInfo.size > MAX_ASSISTANT_ARCHIVE_COMPRESSED_BYTES) throw new Error('archive_too_large');
      const { path: dest, root } = await target(input.destination, true, { workspaceRoot, allowedRoots: allowedCheckoutRoots });
      const existing = await lstat(dest).catch(() => null);
      if (existing && !overwrite) throw new Error('destination_exists');
      const { files, bytes } = await inspectTarArchive(stagePath);
      const limitBytes = configuredLimitBytes(root, workspaceRoot, env);
      if (limitBytes !== null && bytes > limitBytes) {
        throw new Error(`ENOSPC: archive size (${bytes} bytes) exceeds configured ${root} limit (${limitBytes} bytes)`);
      }
      stageDir = resolve(dirname(dest), `.bot-unpack-${input.stage_id}`);
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
      await mkdir(stageDir, { recursive: true, mode: 0o700 });
      await execFileAsync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', stagePath, '-C', stageDir], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      await verifyExtractedTree(stageDir);
      if (existing) {
        if (existing.isDirectory()) await rm(dest, { recursive: true, force: true });
        else await unlink(dest);
      }
      await rename(stageDir, dest);
      stageDir = null;
      return { path: dest, files, bytes };
    } finally {
      await rm(stagePath, { force: true }).catch(() => {});
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw new Error('unsupported_assistant_operation');
}
