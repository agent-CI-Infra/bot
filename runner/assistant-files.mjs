import { open, mkdir, realpath, lstat, readdir, readlink, readFile, writeFile, rename, rm, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, sep } from 'node:path';
import { fullBytes, volume as readVolume } from './disk.mjs';

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
const USAGE_CACHE_TTL_MS = 15_000;

function isReservedSegment(segment) {
  return (
    segment === '.runner-journal' ||
    segment === '.bot-bg' ||
    segment === '.sync-base.json' ||
    segment.startsWith('.sync-base.json.') ||
    segment.startsWith('.sync-tmp-') ||
    segment.startsWith('.write-') ||
    segment.startsWith('.expired-') ||
    segment.startsWith('.bot-archive-') ||
    segment.startsWith('.bot-unpack-') ||
    segment.startsWith('.bot-pack-') ||
    segment.startsWith('.bot-usage-')
  );
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

function archivePackPath(packId, tmpRoot) {
  if (!STAGE_ID_RE.test(packId || '')) throw new Error('invalid_pack_id');
  return resolve(tmpRoot, `.bot-pack-${packId}.tar.gz`);
}

async function scanPackSource(sourcePath, maxFiles, maxBytes) {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) throw new Error('unsafe_archive_symlink');
  if (info.isFile()) {
    if (info.size > maxBytes) throw new Error('archive_too_large');
    return { kind: 'file', files: 1, bytes: info.size, executable: (info.mode & 0o111) !== 0 };
  }
  if (!info.isDirectory()) throw new Error('unsafe_archive_entry_type');
  const realRoot = await realpath(sourcePath);
  let files = 0;
  let bytes = 0;
  const stack = [realRoot];
  while (stack.length) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (isReservedSegment(entry.name)) continue;
      const full = resolve(current, entry.name);
      const st = await lstat(full);
      if (st.isSymbolicLink()) {
        const linkTarget = await readlink(full);
        if (!linkTarget || linkTarget.startsWith('/')) throw new Error('unsafe_archive_symlink');
        const resolvedTarget = resolve(dirname(full), linkTarget);
        if (resolvedTarget !== realRoot && !resolvedTarget.startsWith(realRoot + sep)) throw new Error('unsafe_archive_symlink');
        files++;
      } else if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        files++;
        bytes += st.size;
      } else {
        throw new Error('unsafe_archive_entry_type');
      }
      if (files > maxFiles) throw new Error('archive_too_many_files');
      if (bytes > maxBytes) throw new Error('archive_too_large');
    }
  }
  return { kind: 'directory', files, bytes, executable: false };
}

function usageCachePath(rootDir, tmpRoot) {
  const key = createHash('sha256').update(rootDir).digest('hex').slice(0, 16);
  return resolve(tmpRoot, `.bot-usage-${key}.json`);
}

async function readCachedUsage(rootDir, tmpRoot, ttlMs = USAGE_CACHE_TTL_MS) {
  try {
    const raw = JSON.parse(await readFile(usageCachePath(rootDir, tmpRoot), 'utf8'));
    if (typeof raw?.bytes === 'number' && Number.isFinite(raw.bytes) && raw.bytes >= 0 && typeof raw?.at === 'number' && Date.now() - raw.at < ttlMs) {
      return raw.bytes;
    }
  } catch {}
  return null;
}

async function writeCachedUsage(rootDir, tmpRoot, bytes) {
  try {
    await writeFile(usageCachePath(rootDir, tmpRoot), JSON.stringify({ bytes: Math.max(0, Math.floor(bytes)), at: Date.now() }), { mode: 0o600 });
  } catch {}
}

async function invalidateCachedUsage(rootDir, tmpRoot) {
  await rm(usageCachePath(rootDir, tmpRoot), { force: true }).catch(() => {});
}

async function getRootUsageBytes(rootDir, tmpRoot, { fresh = false, measure = directoryBytes } = {}) {
  if (!fresh) {
    const cached = await readCachedUsage(rootDir, tmpRoot);
    if (cached !== null) return cached;
  }
  const bytes = await measure(rootDir);
  await writeCachedUsage(rootDir, tmpRoot, bytes);
  return bytes;
}

function configuredLimitBytes(root, workspaceRoot, env = process.env) {
  const raw = root === workspaceRoot ? env.BOT_WORKSPACE_LIMIT_MB : env.BOT_TMP_LIMIT_MB;
  const mb = Number(raw);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : null;
}

async function directoryBytes(rootDir, excludePath = null) {
  let total = 0;
  const realRoot = await realpath(rootDir).catch(() => rootDir);
  const realExclude = excludePath ? await realpath(excludePath).catch(() => resolve(excludePath)) : null;
  const stack = [realRoot];
  while (stack.length) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (isReservedSegment(entry.name)) continue;
      const fullPath = resolve(current, entry.name);
      if (realExclude && fullPath === realExclude) continue;
      const info = await lstat(fullPath).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) stack.push(fullPath);
      else if (info.isFile()) total += info.size;
    }
  }
  return total;
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
  if (input.type === 'assistant_list') {
    if (typeof input.path !== 'string' || !input.path || input.path.length > 4096 || input.path.includes('\0')) throw new Error('invalid_path');
    if (input.recursive !== undefined && typeof input.recursive !== 'boolean') throw new Error('invalid_arguments');
    const resolvedPath = resolve(workspaceRoot, input.path);
    const root = allRoots.find(r => resolvedPath === r || resolvedPath.startsWith(r + '/'));
    if (!root) throw new Error('invalid_path');
    const relParts = resolvedPath === root ? [] : resolvedPath.slice(root.length + 1).split('/');
    if (relParts.some(isReservedSegment)) throw new Error('invalid_path');
    const realRoot = await realpath(root);
    let current = realRoot;
    for (const part of relParts) {
      const candidate = resolve(current, part);
      const info = await lstat(candidate).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (!info) return { exists: false, entries: [], truncated: false };
      if (info.isSymbolicLink()) throw new Error('invalid_path');
      if (!info.isDirectory()) throw new Error('not_a_directory');
      current = candidate;
    }
    const realTarget = await realpath(current);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) throw new Error('invalid_path');
    const entries = [];
    const maxEntries = 200;
    const maxDepth = 16;
    const recursive = input.recursive === true;
    let truncated = false;
    const walk = async (dir, prefix, depth) => {
      const dirents = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (isReservedSegment(dirent.name)) continue;
        if (entries.length >= maxEntries) { truncated = true; return; }
        const fullPath = resolve(dir, dirent.name);
        const info = await lstat(fullPath).catch(() => null);
        if (!info) continue;
        const entryPath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
        if (info.isSymbolicLink()) {
          entries.push({ path: entryPath, type: 'symlink' });
          continue;
        }
        if (info.isDirectory()) {
          entries.push({ path: entryPath, type: 'directory' });
          if (recursive && depth < maxDepth) {
            const realSub = await realpath(fullPath).catch(() => null);
            if (realSub && realSub.startsWith(realRoot + sep)) await walk(fullPath, entryPath, depth + 1);
          }
        } else if (info.isFile()) {
          entries.push({ path: entryPath, type: 'file', size: info.size, modified_at: new Date(info.mtimeMs).toISOString() });
        }
      }
    };
    await walk(realTarget, '', 0);
    return { exists: true, entries, truncated };
  }
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
    const located = await target(input.path, true, { workspaceRoot, allowedRoots: allRoots });
    const volumeState = (options.volume || readVolume)(located.root);
    if (volumeState?.full) throw new Error('ENOSPC: volume free space is below the safety reserve');
    const existingInfo = await lstat(located.path).catch(() => null);
    if (existingInfo && !existingInfo.isFile()) throw new Error('regular_file_required');
    const currentTargetSize = existingInfo ? existingInfo.size : 0;
    const nextTargetSize = input.offset === 0 ? data.length : Math.max(currentTargetSize, input.offset + data.length);
    const deltaBytes = nextTargetSize - currentTargetSize;
    let projectedRootBytes = null;
    if (allowedCheckoutRoots.includes(located.root)) {
      const limitBytes = configuredLimitBytes(located.root, workspaceRoot, env);
      if (limitBytes !== null) {
        const cachedRootBytes = await getRootUsageBytes(located.root, tmpRoot, { measure: options.measureUsage || directoryBytes });
        projectedRootBytes = Math.max(0, cachedRootBytes + deltaBytes);
        if (projectedRootBytes > limitBytes) {
          throw new Error(`ENOSPC: write exceeds configured ${located.root} soft limit (${limitBytes} bytes)`);
        }
      }
    }
    const handle = await open(located.path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (input.offset === 0 ? constants.O_TRUNC : 0), 0o644);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('regular_file_required');
      if (info.size !== input.offset) throw new Error('offset_mismatch');
      await handle.write(data, 0, data.length, input.offset);
    } finally { await handle.close(); }
    if (projectedRootBytes !== null) await writeCachedUsage(located.root, tmpRoot, projectedRootBytes);
    return { written: true, size: input.offset + data.length };
  }
  if (input.type === 'assistant_delete') {
    const { path, root } = await target(input.path, false, { workspaceRoot, allowedRoots: allRoots }), info = await lstat(path).catch(() => null);
    if (!info) return { deleted: false };
    // A symlink is removed itself; a directory with everything below it (rm never follows links).
    if (info.isDirectory()) await rm(path, { recursive: true, force: true }); else await unlink(path);
    if (allowedCheckoutRoots.includes(root)) {
      if (info.isFile()) {
        const cached = await readCachedUsage(root, tmpRoot);
        if (cached !== null) await writeCachedUsage(root, tmpRoot, Math.max(0, cached - info.size));
      } else if (info.isDirectory()) {
        await invalidateCachedUsage(root, tmpRoot);
      }
    }
    return { deleted: true, directory: info.isDirectory() };
  }
  if (input.type === 'assistant_archive_stage') {
    if (typeof input.base64 !== 'string' || input.base64.length > 65536 || !Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('invalid_content');
    const data = Buffer.from(input.base64, 'base64');
    if (input.offset + data.length > MAX_ASSISTANT_ARCHIVE_COMPRESSED_BYTES) throw new Error('archive_too_large');
    const tmpVolume = (options.volume || readVolume)(tmpRoot);
    if (tmpVolume?.full) throw new Error('ENOSPC: /tmp volume free space is below the safety reserve');
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
      const volumeState = (options.volume || readVolume)(root);
      // During extraction, the staging tree coexists with any existing destination until atomic swap, so check peak space.
      if (volumeState && (volumeState.full || bytes > Math.max(0, volumeState.free_bytes - fullBytes(volumeState.total_bytes)))) {
        throw new Error(`ENOSPC: archive size (${bytes} bytes) exceeds available disk space below safety reserve`);
      }
      const measureFn = options.measureUsage || directoryBytes;
      const limitBytes = configuredLimitBytes(root, workspaceRoot, env);
      const currentTotalBytes = limitBytes !== null ? await getRootUsageBytes(root, tmpRoot, { fresh: true, measure: measureFn }) : null;
      if (limitBytes !== null && currentTotalBytes !== null) {
        // Account for peak usage (existing files including any overwritten destination + newly extracted stage tree).
        const peakBytes = currentTotalBytes + bytes;
        if (peakBytes > limitBytes) {
          throw new Error(`ENOSPC: peak usage (${peakBytes} bytes = ${currentTotalBytes} existing + ${bytes} extracted) exceeds configured ${root} soft limit (${limitBytes} bytes)`);
        }
      }
      const replacedBytes = existing ? (existing.isDirectory() ? await directoryBytes(dest) : existing.isFile() ? existing.size : 0) : 0;
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
      if (currentTotalBytes !== null) {
        await writeCachedUsage(root, tmpRoot, Math.max(0, currentTotalBytes - replacedBytes + bytes));
      } else {
        await invalidateCachedUsage(root, tmpRoot);
      }
      return { path: dest, files, bytes };
    } finally {
      await rm(stagePath, { force: true }).catch(() => {});
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (input.type === 'assistant_archive_pack') {
    const packPath = archivePackPath(input.pack_id, tmpRoot);
    const maxBytes = Number.isSafeInteger(input.max_bytes) && input.max_bytes > 0 ? input.max_bytes : 20 * 1024 * 1024 * 1024;
    const located = await target(input.path, false, { workspaceRoot, allowedRoots: allowedCheckoutRoots });
    const summary = await scanPackSource(located.path, 50_000, maxBytes);
    const tmpVolume = (options.volume || readVolume)(tmpRoot);
    if (tmpVolume?.full) throw new Error('ENOSPC: /tmp volume free space is below the safety reserve');
    await rm(packPath, { force: true }).catch(() => {});
    const tarArgs = summary.kind === 'directory'
      ? ['-czf', packPath, '-C', located.path, '.']
      : ['-czf', packPath, '-C', dirname(located.path), located.path.slice(dirname(located.path).length + 1)];
    try {
      await execFileAsync('tar', tarArgs, { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
      const packed = await lstat(packPath);
      if (packed.size > maxBytes) {
        await rm(packPath, { force: true }).catch(() => {});
        throw new Error('archive_too_large');
      }
      return {
        pack_id: input.pack_id,
        kind: summary.kind,
        name: located.path.split('/').filter(Boolean).at(-1) || 'tools',
        files: summary.files,
        uncompressed_bytes: summary.bytes,
        size: packed.size,
        executable: summary.executable,
      };
    } catch (error) {
      await rm(packPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  if (input.type === 'assistant_archive_read') {
    const packPath = archivePackPath(input.pack_id, tmpRoot);
    const offset = input.offset ?? 0, limit = input.limit ?? chunk;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > chunk) throw new Error('invalid_range');
    const handle = await open(packPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('regular_file_required');
      const buffer = Buffer.alloc(Math.max(0, Math.min(limit, info.size - offset))), { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return { base64: buffer.subarray(0, bytesRead).toString('base64'), offset, size: info.size };
    } finally { await handle.close(); }
  }
  if (input.type === 'assistant_archive_cleanup') {
    const packPath = archivePackPath(input.pack_id, tmpRoot);
    await rm(packPath, { force: true }).catch(() => {});
    return { cleaned: true };
  }
  throw new Error('unsupported_assistant_operation');
}
