import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, readdir, readlink, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createGunzip, createInflateRaw } from 'node:zlib';
import { fail, HttpError } from '../core/security.js';
import { githubTokenSource } from '../core/redaction.js';
import { isSensitiveToolPath } from '../../runner/sensitive-paths.mjs';

export { isSensitiveToolPath };

export const MAX_TOOL_FILES = 50_000;
export const MAX_TOOL_PATH_LENGTH = 1024;
export const MAX_TOOL_DEPTH = 32;
export const MAX_SYMLINK_TARGET_LENGTH = 4096;

const PROVIDER_TOKEN_SOURCE = String.raw`\b(?:sk-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|rrt_(?:[\w-]{12}\.[\w-]{43}|[\w-]{16,}))`;
const SECRET_TOKEN_RE = new RegExp(githubTokenSource + '|' + PROVIDER_TOKEN_SOURCE);
const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

/** Normalizes and validates a relative path inside a project tools snapshot. */
export function normalizeToolRelativePath(raw: string, options: { allowBackslash?: boolean } = {}): string {
  if (typeof raw !== 'string') fail(400, 'invalid_tool_path');
  let cleaned = options.allowBackslash ? raw.replace(/\\/g, '/') : raw;
  if (cleaned.includes('\0') || cleaned.includes('\\') || /[\x00-\x1f\x7f]/.test(cleaned)) fail(400, 'invalid_tool_path');
  while (cleaned.startsWith('./')) cleaned = cleaned.slice(2);
  if (cleaned.endsWith('/')) cleaned = cleaned.replace(/\/+$/, '');
  if (!cleaned || cleaned.length > MAX_TOOL_PATH_LENGTH) fail(400, 'invalid_tool_path');
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) fail(400, 'unsafe_tool_path');
  const parts = cleaned.split('/');
  if (parts.length > MAX_TOOL_DEPTH) fail(400, 'invalid_tool_path');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') fail(400, 'unsafe_tool_path');
  }
  return parts.join('/');
}

/** Streams a regular file in bounded chunks to detect PEM private keys, self-identifying tokens, and registered secrets. */
export async function scanFileForSecrets(filePath: string, registeredSecrets: Iterable<string>): Promise<string | null> {
  const literals = [...registeredSecrets]
    .filter((v): v is string => typeof v === 'string' && v.length >= 8)
    .map(v => Buffer.from(v, 'utf8'));
  const maxLiteralLen = literals.reduce((max, buf) => Math.max(max, buf.length), 0);
  const overlapSize = Math.min(64 * 1024, Math.max(4096, maxLiteralLen));
  const chunkSize = 64 * 1024;
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const readBuf = Buffer.alloc(chunkSize);
    let tail = Buffer.alloc(0);
    let position = 0;
    while (position < info.size) {
      const { bytesRead } = await handle.read(readBuf, 0, Math.min(chunkSize, info.size - position), position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const chunk = readBuf.subarray(0, bytesRead);
      const window = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      for (const secret of literals) {
        if (window.indexOf(secret) !== -1) return 'registered_secret_detected';
      }
      const text = window.toString('latin1');
      if (PEM_PRIVATE_KEY_RE.test(text)) return 'private_key_detected';
      if (SECRET_TOKEN_RE.test(text)) return 'credential_token_detected';
      tail = window.length > overlapSize ? Buffer.from(window.subarray(window.length - overlapSize)) : Buffer.from(window);
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** Verifies every ancestor inside stageRoot is a real non-symlink directory, creating missing ones with mode 0o755. */
async function ensureAnchoredParent(stageRoot: string, realStageRoot: string, relPath: string): Promise<string> {
  const parts = relPath.split('/');
  let current = realStageRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = join(current, parts[i]!);
    const existing = await lstat(next).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!existing) {
      await mkdir(next, { mode: 0o755 });
    } else if (existing.isSymbolicLink()) {
      fail(400, 'unsafe_archive_symlink');
    } else if (!existing.isDirectory()) {
      fail(400, 'tool_path_conflict');
    }
    const resolved = await realpath(next);
    if (resolved !== realStageRoot && !resolved.startsWith(realStageRoot + sep)) fail(400, 'unsafe_tool_path');
    current = resolved;
  }
  return join(current, parts.at(-1)!);
}

/** Ensures a directory entry exists inside stageRoot without traversing symlinks. */
async function ensureAnchoredDir(stageRoot: string, realStageRoot: string, relPath: string): Promise<void> {
  const full = await ensureAnchoredParent(stageRoot, realStageRoot, relPath);
  const existing = await lstat(full).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!existing) {
    await mkdir(full, { mode: 0o755 });
    return;
  }
  if (existing.isSymbolicLink()) fail(400, 'unsafe_archive_symlink');
  if (!existing.isDirectory()) fail(400, 'tool_path_conflict');
}

/** Writes a regular file stream into stageRoot via anchored O_NOFOLLOW fd, breaking any pre-existing hardlink first. */
export async function writeStreamToStagedFile(
  stageRoot: string,
  relPath: string,
  stream: AsyncIterable<Buffer>,
  options: { executable: boolean; maxBytes: number; currentBytes?: number },
): Promise<{ size: number; sha256: string }> {
  const normalized = normalizeToolRelativePath(relPath);
  const realStageRoot = await realpath(stageRoot);
  const target = await ensureAnchoredParent(stageRoot, realStageRoot, normalized);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) {
    if (existing.isDirectory()) fail(400, 'tool_path_conflict');
    await unlink(target);
  }
  const mode = options.executable ? 0o755 : 0o644;
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  const hash = createHash('sha256');
  let written = 0;
  const baseBytes = options.currentBytes ?? 0;
  try {
    const actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => '');
    if (actual && !actual.startsWith(realStageRoot + sep)) fail(400, 'unsafe_tool_path');
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (!chunk.length) continue;
      written += chunk.length;
      if (baseBytes + written > options.maxBytes) fail(413, 'project_tools_quota_exceeded');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const res = await handle.write(chunk, offset, chunk.length - offset);
        offset += res.bytesWritten;
      }
    }
    await handle.chmod(mode);
    return { size: written, sha256: hash.digest('hex') };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(target).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

interface PendingSymlink {
  path: string;
  target: string;
}

function validateRelativeSymlinkTarget(realStageRoot: string, relPath: string, linkTarget: string): void {
  if (!linkTarget || linkTarget.length > MAX_SYMLINK_TARGET_LENGTH || linkTarget.includes('\0') || linkTarget.startsWith('/') || /^[A-Za-z]:/.test(linkTarget)) {
    fail(400, 'unsafe_archive_symlink');
  }
  const fullEntry = resolve(realStageRoot, relPath);
  const resolved = resolve(dirname(fullEntry), linkTarget);
  if (resolved !== realStageRoot && !resolved.startsWith(realStageRoot + sep)) {
    fail(400, 'unsafe_archive_symlink');
  }
}

async function applyPendingSymlinks(stageRoot: string, realStageRoot: string, symlinks: PendingSymlink[]): Promise<void> {
  for (const item of symlinks) {
    validateRelativeSymlinkTarget(realStageRoot, item.path, item.target);
    const full = await ensureAnchoredParent(stageRoot, realStageRoot, item.path);
    const existing = await lstat(full).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) {
      if (existing.isDirectory()) fail(400, 'tool_path_conflict');
      await unlink(full);
    }
    await symlink(item.target, full);
  }
}

function parseTarOctalOrBase256(buf: Buffer): number {
  if (buf.length > 0 && (buf[0]! & 0x80) !== 0) {
    // GNU base-256 big-endian positive integer encoding for >8 GiB files
    if ((buf[0]! & 0x40) !== 0) fail(400, 'invalid_archive');
    let value = buf[0]! & 0x7f;
    for (let i = 1; i < buf.length; i++) {
      value = value * 256 + buf[i]!;
      if (!Number.isSafeInteger(value)) fail(413, 'project_tools_quota_exceeded');
    }
    return value;
  }
  const str = buf.toString('ascii').replace(/\0.*$/, '').trim();
  if (!str) return 0;
  if (!/^[0-7]+$/.test(str)) fail(400, 'invalid_archive');
  const parsed = parseInt(str, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(400, 'invalid_archive');
  return parsed;
}

function parseTarString(buf: Buffer): string {
  const zero = buf.indexOf(0);
  return buf.subarray(0, zero === -1 ? buf.length : zero).toString('utf8');
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space <= offset) break;
    const len = Number(data.subarray(offset, space).toString('ascii'));
    if (!Number.isSafeInteger(len) || len <= 0 || offset + len > data.length) break;
    const record = data.subarray(space + 1, offset + len).toString('utf8');
    const trimmed = record.endsWith('\n') ? record.slice(0, -1) : record;
    const eq = trimmed.indexOf('=');
    if (eq > 0) out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    offset += len;
  }
  return out;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

function verifyTarChecksum(header: Buffer): boolean {
  const expected = parseTarOctalOrBase256(header.subarray(148, 156));
  let unsignedSum = 0;
  let signedSum = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 32 : header[i]!;
    unsignedSum += b;
    signedSum += b < 128 ? b : b - 256;
  }
  return expected === unsignedSum || expected === signedSum;
}

/**
 * Pure Node streaming .tar.gz / .tgz extractor.
 * Enforces quota bytes & file count while streaming; rejects absolute paths, `..`, hardlinks, devices, FIFOs, and escaping symlinks.
 */
export async function extractTarGzToStaging(
  source: string | AsyncIterable<Buffer>,
  stageRoot: string,
  limits: { maxBytes: number; maxFiles: number },
): Promise<{ files: number; bytes: number }> {
  const realStageRoot = await realpath(stageRoot);
  const gunzip = createGunzip();
  const inputStream = typeof source === 'string' ? createReadStream(source) : null;
  let sourceError: Error | null = null;

  const pump = (async () => {
    try {
      const iterable = inputStream ?? (source as AsyncIterable<Buffer>);
      for await (const chunk of iterable) {
        if (gunzip.destroyed) break;
        const ok = gunzip.write(chunk);
        if (!ok) await new Promise<void>(resolve => gunzip.once('drain', resolve));
      }
      if (!gunzip.destroyed) gunzip.end();
    } catch (error) {
      sourceError = error as Error;
      gunzip.destroy(error as Error);
    }
  })();

  let files = 0;
  let totalBytes = 0;
  const pendingSymlinks: PendingSymlink[] = [];
  let globalPax: Record<string, string> = {};
  let nextPax: Record<string, string> | null = null;
  let nextLongName: string | null = null;

  let mode: 'header' | 'data' | 'pad' | 'meta' = 'header';
  let headerBuf = Buffer.alloc(0);
  let zeroBlocks = 0;
  let dataRemaining = 0;
  let padRemaining = 0;
  let currentHandle: Awaited<ReturnType<typeof open>> | null = null;
  let currentTargetPath = '';
  let currentFileMode = 0o644;
  let metaType = '';
  let metaChunks: Buffer[] = [];
  let metaSize = 0;
  let sawAnyHeader = false;
  let rawDecompressedBytes = 0;
  // Cap raw tar overhead (headers + padding) so a tar bomb of zero-byte entries or empty blocks cannot spin forever.
  const maxRawTarBytes = limits.maxBytes + (limits.maxFiles + 1024) * 2048;

  const closeCurrentFile = async (abort = false) => {
    const h = currentHandle;
    const p = currentTargetPath;
    currentHandle = null;
    currentTargetPath = '';
    if (h) {
      if (!abort) await h.chmod(currentFileMode).catch(() => {});
      await h.close().catch(() => {});
    }
    if (abort && p) await unlink(p).catch(() => {});
  };

  try {
    for await (const rawChunk of gunzip) {
      let chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      rawDecompressedBytes += chunk.length;
      if (rawDecompressedBytes > maxRawTarBytes) fail(413, 'project_tools_quota_exceeded');
      let pos = 0;
      while (pos < chunk.length) {
        if (mode === 'header') {
          const need = 512 - headerBuf.length;
          const take = Math.min(need, chunk.length - pos);
          headerBuf = headerBuf.length ? Buffer.concat([headerBuf, chunk.subarray(pos, pos + take)]) : Buffer.from(chunk.subarray(pos, pos + take));
          pos += take;
          if (headerBuf.length < 512) continue;
          const header = headerBuf;
          headerBuf = Buffer.alloc(0);
          if (isZeroBlock(header)) {
            zeroBlocks++;
            if (zeroBlocks >= 2) {
              // End of archive; drain any trailing zero padding safely.
              continue;
            }
            continue;
          }
          zeroBlocks = 0;
          sawAnyHeader = true;
          if (!verifyTarChecksum(header)) fail(400, 'invalid_archive');
          const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
          const fileMode = parseTarOctalOrBase256(header.subarray(100, 108));
          const headerSize = parseTarOctalOrBase256(header.subarray(124, 136));
          const pax = nextPax ? { ...globalPax, ...nextPax } : globalPax;
          const size = pax.size !== undefined ? Number(pax.size) : headerSize;
          if (!Number.isSafeInteger(size) || size < 0) fail(400, 'invalid_archive');
          padRemaining = (512 - (size % 512)) % 512;

          if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'L') {
            if (size > 1024 * 1024) fail(400, 'invalid_archive');
            metaType = typeFlag;
            metaChunks = [];
            metaSize = size;
            dataRemaining = size;
            mode = size > 0 ? 'meta' : (padRemaining > 0 ? 'pad' : 'header');
            continue;
          }
          if (typeFlag === 'K') fail(400, 'unsafe_archive_entry_type');

          const ustarPrefix = parseTarString(header.subarray(345, 500));
          const ustarName = parseTarString(header.subarray(0, 100));
          const rawName = pax.path ?? nextLongName ?? (ustarPrefix ? `${ustarPrefix}/${ustarName}` : ustarName);
          const rawLinkName = pax.linkpath ?? parseTarString(header.subarray(157, 257));
          nextPax = null;
          nextLongName = null;

          // Ignore top-level '.' directory entry commonly emitted by `tar -czf out.tar.gz .`
          const stripped = rawName.replace(/^\.\/+/, '').replace(/\/+$/, '');
          if (typeFlag === '5' && (!stripped || stripped === '.')) {
            mode = padRemaining > 0 ? 'pad' : 'header';
            continue;
          }

          if (typeFlag === '5') {
            const norm = normalizeToolRelativePath(rawName);
            await ensureAnchoredDir(stageRoot, realStageRoot, norm);
            mode = padRemaining > 0 ? 'pad' : 'header';
            continue;
          }
          if (typeFlag === '2') {
            const norm = normalizeToolRelativePath(rawName);
            files++;
            if (files > limits.maxFiles) fail(400, 'archive_too_many_files');
            validateRelativeSymlinkTarget(realStageRoot, norm, rawLinkName);
            pendingSymlinks.push({ path: norm, target: rawLinkName });
            mode = padRemaining > 0 ? 'pad' : 'header';
            continue;
          }
          if (typeFlag !== '0' && typeFlag !== '\0') {
            fail(400, 'unsafe_archive_entry_type');
          }

          const norm = normalizeToolRelativePath(rawName);
          files++;
          if (files > limits.maxFiles) fail(400, 'archive_too_many_files');
          totalBytes += size;
          if (totalBytes > limits.maxBytes) fail(413, 'project_tools_quota_exceeded');

          const target = await ensureAnchoredParent(stageRoot, realStageRoot, norm);
          const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (existing) {
            if (existing.isDirectory()) fail(400, 'tool_path_conflict');
            await unlink(target);
          }
          currentFileMode = (fileMode & 0o111) !== 0 ? 0o755 : 0o644;
          currentHandle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, currentFileMode);
          currentTargetPath = target;
          const actual = await readlink(`/proc/self/fd/${currentHandle.fd}`).catch(() => '');
          if (actual && !actual.startsWith(realStageRoot + sep)) fail(400, 'unsafe_tool_path');

          dataRemaining = size;
          if (dataRemaining === 0) {
            await closeCurrentFile(false);
            mode = padRemaining > 0 ? 'pad' : 'header';
          } else {
            mode = 'data';
          }
        } else if (mode === 'meta') {
          const take = Math.min(dataRemaining, chunk.length - pos);
          metaChunks.push(Buffer.from(chunk.subarray(pos, pos + take)));
          pos += take;
          dataRemaining -= take;
          if (dataRemaining === 0) {
            const metaBuf = Buffer.concat(metaChunks, metaSize);
            if (metaType === 'x') nextPax = parsePaxRecords(metaBuf);
            else if (metaType === 'g') globalPax = { ...globalPax, ...parsePaxRecords(metaBuf) };
            else if (metaType === 'L') nextLongName = parseTarString(metaBuf);
            metaChunks = [];
            mode = padRemaining > 0 ? 'pad' : 'header';
          }
        } else if (mode === 'data') {
          const take = Math.min(dataRemaining, chunk.length - pos);
          const slice = chunk.subarray(pos, pos + take);
          pos += take;
          dataRemaining -= take;
          let off = 0;
          while (off < slice.length) {
            const res = await currentHandle!.write(slice, off, slice.length - off);
            off += res.bytesWritten;
          }
          if (dataRemaining === 0) {
            await closeCurrentFile(false);
            mode = padRemaining > 0 ? 'pad' : 'header';
          }
        } else {
          // pad
          const skip = Math.min(padRemaining, chunk.length - pos);
          pos += skip;
          padRemaining -= skip;
          if (padRemaining === 0) mode = 'header';
        }
      }
    }
    await pump;
    if (sourceError) throw sourceError;
    if (!sawAnyHeader || mode !== 'header' || headerBuf.length > 0) fail(400, 'invalid_archive');
    await applyPendingSymlinks(stageRoot, realStageRoot, pendingSymlinks);
    return { files, bytes: totalBytes };
  } catch (error) {
    gunzip.destroy();
    inputStream?.destroy();
    await closeCurrentFile(true);
    await pump.catch(() => {});
    if (error instanceof HttpError) throw error;
    return fail(400, 'invalid_archive');
  }
}

// IEEE 802.3 CRC-32 table for streaming ZIP integrity verification.
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC32_TABLE[i] = c >>> 0;
}
function crc32Update(crc: number, chunk: Buffer): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < chunk.length; i++) c = CRC32_TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntryMeta {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttr: number;
  versionMadeBy: number;
}

function readZip64Extra(extra: Buffer, entry: { uncompressedSize: number; compressedSize: number; localHeaderOffset: number }): void {
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const len = extra.readUInt16LE(off + 2);
    off += 4;
    if (off + len > extra.length) break;
    if (id === 0x0001) {
      let cur = off;
      if (entry.uncompressedSize === 0xffffffff && cur + 8 <= off + len) {
        const val = Number(extra.readBigUInt64LE(cur));
        if (!Number.isSafeInteger(val)) fail(413, 'project_tools_quota_exceeded');
        entry.uncompressedSize = val;
        cur += 8;
      }
      if (entry.compressedSize === 0xffffffff && cur + 8 <= off + len) {
        const val = Number(extra.readBigUInt64LE(cur));
        if (!Number.isSafeInteger(val)) fail(413, 'project_tools_quota_exceeded');
        entry.compressedSize = val;
        cur += 8;
      }
      if (entry.localHeaderOffset === 0xffffffff && cur + 8 <= off + len) {
        const val = Number(extra.readBigUInt64LE(cur));
        if (!Number.isSafeInteger(val)) fail(400, 'invalid_archive');
        entry.localHeaderOffset = val;
      }
      return;
    }
    off += len;
  }
}

/**
 * Pure Node file-descriptor streaming ZIP extractor (supports standard ZIP & ZIP64).
 * Reads only the EOCD + Central Directory metadata into memory and streams each entry directly to disk.
 */
export async function extractZipFileToStaging(
  zipFilePath: string,
  stageRoot: string,
  limits: { maxBytes: number; maxFiles: number },
): Promise<{ files: number; bytes: number }> {
  const realStageRoot = await realpath(stageRoot);
  const handle = await open(zipFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileSize = (await handle.stat()).size;
    if (fileSize < 22) fail(400, 'invalid_archive');
    const tailLen = Math.min(fileSize, 65557);
    const tailBuf = Buffer.alloc(tailLen);
    await handle.read(tailBuf, 0, tailLen, fileSize - tailLen);

    // Locate End of Central Directory (EOCD: 0x06054b50)
    let eocdOffsetInTail = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tailBuf.readUInt32LE(i) === 0x06054b50) {
        const commentLen = tailBuf.readUInt16LE(i + 20);
        if (i + 22 + commentLen === tailLen) {
          eocdOffsetInTail = i;
          break;
        }
      }
    }
    if (eocdOffsetInTail < 0) fail(400, 'invalid_archive');
    const eocdDisk = tailBuf.readUInt16LE(eocdOffsetInTail + 4);
    const cdDisk = tailBuf.readUInt16LE(eocdOffsetInTail + 6);
    if (eocdDisk !== 0 || cdDisk !== 0) fail(400, 'invalid_archive');
    let entryCount = tailBuf.readUInt16LE(eocdOffsetInTail + 10);
    let cdSize = tailBuf.readUInt32LE(eocdOffsetInTail + 12);
    let cdOffset = tailBuf.readUInt32LE(eocdOffsetInTail + 16);

    // Check ZIP64 EOCD Locator (0x07064b50) immediately preceding EOCD
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locatorPos = fileSize - tailLen + eocdOffsetInTail - 20;
      if (locatorPos < 0) fail(400, 'invalid_archive');
      const loc = Buffer.alloc(20);
      await handle.read(loc, 0, 20, locatorPos);
      if (loc.readUInt32LE(0) !== 0x07064b50) fail(400, 'invalid_archive');
      const z64Offset = Number(loc.readBigUInt64LE(8));
      if (!Number.isSafeInteger(z64Offset) || z64Offset < 0 || z64Offset + 56 > fileSize) fail(400, 'invalid_archive');
      const z64 = Buffer.alloc(56);
      await handle.read(z64, 0, 56, z64Offset);
      if (z64.readUInt32LE(0) !== 0x06064b50) fail(400, 'invalid_archive');
      entryCount = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }

    if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > limits.maxFiles * 2) fail(400, 'archive_too_many_files');
    // Cap central directory buffer at 64 MiB to prevent metadata memory exhaustion
    if (!Number.isSafeInteger(cdSize) || cdSize < 0 || cdSize > 64 * 1024 * 1024 || cdOffset < 0 || cdOffset + cdSize > fileSize) {
      fail(400, 'invalid_archive');
    }

    const cdBuf = Buffer.alloc(cdSize);
    let cdRead = 0;
    while (cdRead < cdSize) {
      const { bytesRead } = await handle.read(cdBuf, cdRead, cdSize - cdRead, cdOffset + cdRead);
      if (bytesRead <= 0) fail(400, 'invalid_archive');
      cdRead += bytesRead;
    }

    const entries: ZipEntryMeta[] = [];
    let pos = 0;
    for (let idx = 0; idx < entryCount; idx++) {
      if (pos + 46 > cdBuf.length || cdBuf.readUInt32LE(pos) !== 0x02014b50) fail(400, 'invalid_archive');
      const versionMadeBy = cdBuf.readUInt16LE(pos + 4);
      const flags = cdBuf.readUInt16LE(pos + 8);
      const method = cdBuf.readUInt16LE(pos + 10);
      const crc32 = cdBuf.readUInt32LE(pos + 16);
      const compressedSize = cdBuf.readUInt32LE(pos + 20);
      const uncompressedSize = cdBuf.readUInt32LE(pos + 24);
      const nameLen = cdBuf.readUInt16LE(pos + 28);
      const extraLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      const externalAttr = cdBuf.readUInt32LE(pos + 38);
      const localHeaderOffset = cdBuf.readUInt32LE(pos + 42);
      if (pos + 46 + nameLen + extraLen + commentLen > cdBuf.length) fail(400, 'invalid_archive');
      const name = cdBuf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
      const extra = cdBuf.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);
      const meta: ZipEntryMeta = {
        name, flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset, externalAttr, versionMadeBy,
      };
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        readZip64Extra(extra, meta);
      }
      entries.push(meta);
      pos += 46 + nameLen + extraLen + commentLen;
    }

    let files = 0;
    let totalBytes = 0;
    const pendingSymlinks: PendingSymlink[] = [];
    const lfh = Buffer.alloc(30);

    for (const entry of entries) {
      if ((entry.flags & 0x01) !== 0) fail(400, 'encrypted_archive_unsupported');
      if (entry.method !== 0 && entry.method !== 8) fail(400, 'unsupported_archive_compression');

      const hostOs = entry.versionMadeBy >> 8;
      const unixMode = hostOs === 3 ? (entry.externalAttr >>> 16) : 0;
      const unixType = unixMode & 0o170000;
      const isDir = entry.name.endsWith('/') || unixType === 0o040000;
      const isSymlink = unixType === 0o120000;
      if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000 && unixType !== 0o120000) {
        fail(400, 'unsafe_archive_entry_type');
      }

      const stripped = entry.name.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
      if (isDir && (!stripped || stripped === '.')) continue;
      const norm = normalizeToolRelativePath(entry.name, { allowBackslash: true });
      if (isDir) {
        await ensureAnchoredDir(stageRoot, realStageRoot, norm);
        continue;
      }

      files++;
      if (files > limits.maxFiles) fail(400, 'archive_too_many_files');

      if (entry.localHeaderOffset + 30 > fileSize) fail(400, 'invalid_archive');
      await handle.read(lfh, 0, 30, entry.localHeaderOffset);
      if (lfh.readUInt32LE(0) !== 0x04034b50) fail(400, 'invalid_archive');
      const localNameLen = lfh.readUInt16LE(26);
      const localExtraLen = lfh.readUInt16LE(28);
      const dataStart = entry.localHeaderOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > fileSize) fail(400, 'invalid_archive');

      const makeDataStream = (): AsyncIterable<Buffer> => {
        if (entry.compressedSize === 0) {
          return (async function* () {})();
        }
        const raw = createReadStream(zipFilePath, { start: dataStart, end: dataEnd - 1 });
        if (entry.method === 0) return raw;
        const inflate = createInflateRaw();
        raw.pipe(inflate);
        raw.on('error', err => inflate.destroy(err));
        return inflate;
      };

      if (isSymlink) {
        if (entry.uncompressedSize > MAX_SYMLINK_TARGET_LENGTH) fail(400, 'unsafe_archive_symlink');
        const chunks: Buffer[] = [];
        let got = 0;
        let crc = 0;
        for await (const chunk of makeDataStream()) {
          got += chunk.length;
          if (got > MAX_SYMLINK_TARGET_LENGTH) fail(400, 'unsafe_archive_symlink');
          crc = crc32Update(crc, chunk);
          chunks.push(chunk);
        }
        if (got !== entry.uncompressedSize || crc !== entry.crc32) fail(400, 'invalid_archive');
        const linkTarget = Buffer.concat(chunks).toString('utf8');
        validateRelativeSymlinkTarget(realStageRoot, norm, linkTarget);
        pendingSymlinks.push({ path: norm, target: linkTarget });
        continue;
      }

      if (totalBytes + entry.uncompressedSize > limits.maxBytes) fail(413, 'project_tools_quota_exceeded');
      const target = await ensureAnchoredParent(stageRoot, realStageRoot, norm);
      const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (existing) {
        if (existing.isDirectory()) fail(400, 'tool_path_conflict');
        await unlink(target);
      }
      const executable = hostOs === 3 ? (unixMode & 0o111) !== 0 : false;
      const fileMode = executable ? 0o755 : 0o644;
      const out = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, fileMode);
      let written = 0;
      let crc = 0;
      try {
        const actual = await readlink(`/proc/self/fd/${out.fd}`).catch(() => '');
        if (actual && !actual.startsWith(realStageRoot + sep)) fail(400, 'unsafe_tool_path');
        for await (const rawChunk of makeDataStream()) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          written += chunk.length;
          if (totalBytes + written > limits.maxBytes || written > entry.uncompressedSize) {
            fail(413, 'project_tools_quota_exceeded');
          }
          crc = crc32Update(crc, chunk);
          let off = 0;
          while (off < chunk.length) {
            const res = await out.write(chunk, off, chunk.length - off);
            off += res.bytesWritten;
          }
        }
        if (written !== entry.uncompressedSize || crc !== entry.crc32) fail(400, 'invalid_archive');
        await out.chmod(fileMode);
      } catch (error) {
        await out.close().catch(() => {});
        await unlink(target).catch(() => {});
        throw error;
      } finally {
        await out.close().catch(() => {});
      }
      totalBytes += written;
    }

    await applyPendingSymlinks(stageRoot, realStageRoot, pendingSymlinks);
    return { files, bytes: totalBytes };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return fail(400, 'invalid_archive');
  } finally {
    await handle.close();
  }
}

/** Clones an existing immutable revision into a fresh staging tree using hardlinks for regular files (never mutating source). */
export async function cloneRevisionToStaging(sourceDir: string, stageRoot: string): Promise<void> {
  const realSource = await realpath(sourceDir);
  const realStage = await realpath(stageRoot);
  const walk = async (relPrefix: string): Promise<void> => {
    const srcCur = relPrefix ? join(realSource, relPrefix) : realSource;
    const dstCur = relPrefix ? join(realStage, relPrefix) : realStage;
    const dirents = await readdir(srcCur, { withFileTypes: true });
    for (const dirent of dirents) {
      const childRel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
      const srcPath = join(srcCur, dirent.name);
      const dstPath = join(dstCur, dirent.name);
      const info = await lstat(srcPath);
      if (info.isDirectory()) {
        await mkdir(dstPath, { mode: 0o755 });
        await walk(childRel);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(srcPath);
        validateRelativeSymlinkTarget(realStage, childRel, target);
        await symlink(target, dstPath);
      } else if (info.isFile()) {
        try {
          await link(srcPath, dstPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
            await copyFile(srcPath, dstPath);
            await chmod(dstPath, (info.mode & 0o111) !== 0 ? 0o755 : 0o644);
          } else {
            throw error;
          }
        }
      }
    }
  };
  await walk('');
}

/** Removes relative paths inside stageRoot and prunes any empty parent directories left behind. */
export async function deletePathsInStaging(stageRoot: string, paths: string[]): Promise<number> {
  const realStage = await realpath(stageRoot);
  let removed = 0;
  for (const raw of paths) {
    const rel = normalizeToolRelativePath(raw);
    const full = resolve(realStage, rel);
    if (!full.startsWith(realStage + sep)) fail(400, 'unsafe_tool_path');
    const info = await lstat(full).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) continue;
    if (info.isDirectory()) await rm(full, { recursive: true, force: true });
    else await unlink(full);
    removed++;
    // Prune empty ancestor directories up to stageRoot
    let parent = dirname(full);
    while (parent !== realStage && parent.startsWith(realStage + sep)) {
      const entries = await readdir(parent).catch(() => null);
      if (!entries || entries.length > 0) break;
      await rm(parent, { recursive: true, force: true }).catch(() => {});
      parent = dirname(parent);
    }
  }
  return removed;
}

/** Resolves a symlink chain component-by-component inside realStageRoot, failing even on dangling escaping chains. */
async function assertSymlinkChainStaysInside(realStageRoot: string, startRelPath: string): Promise<void> {
  let currentDir = dirname(resolve(realStageRoot, startRelPath));
  let pendingSegments = [basename(startRelPath)];
  let hops = 0;
  while (pendingSegments.length > 0) {
    const seg = pendingSegments.shift()!;
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (currentDir === realStageRoot) fail(400, 'unsafe_archive_symlink');
      currentDir = dirname(currentDir);
      if (currentDir !== realStageRoot && !currentDir.startsWith(realStageRoot + sep)) fail(400, 'unsafe_archive_symlink');
      continue;
    }
    const candidate = join(currentDir, seg);
    if (candidate !== realStageRoot && !candidate.startsWith(realStageRoot + sep)) fail(400, 'unsafe_archive_symlink');
    const info = await lstat(candidate).catch(() => null);
    if (!info) {
      // Dangling tail component: verify remaining relative segments never escape realStageRoot.
      currentDir = candidate;
      continue;
    }
    if (info.isSymbolicLink()) {
      if (++hops > 16) fail(400, 'unsafe_archive_symlink');
      const target = await readlink(candidate);
      if (!target || target.length > MAX_SYMLINK_TARGET_LENGTH || target.includes('\0') || target.startsWith('/') || /^[A-Za-z]:/.test(target)) {
        fail(400, 'unsafe_archive_symlink');
      }
      pendingSegments = [...target.split('/'), ...pendingSegments];
      continue;
    }
    currentDir = candidate;
  }
}

export interface StagedToolEntry {
  path: string;
  type: 'file' | 'symlink';
  size: number;
  executable: boolean;
  sha256?: string;
  target?: string;
}

/**
 * Walks the complete staging tree before sealing:
 * - enforces non-escaping symlinks and regular-file/dir/symlink-only entries
 * - blocks sensitive filenames and embedded credentials / registered secrets
 * - normalizes POSIX permissions (0755 dirs, 0755/0644 files)
 * - returns deterministic manifest, file count, total logical bytes, and tree SHA-256
 */
export async function finalizeAndValidateStaging(
  stageRoot: string,
  options: { maxBytes: number; maxFiles: number; registeredSecrets: Iterable<string> },
): Promise<{ files: StagedToolEntry[]; filesCount: number; totalBytes: number; sha256: string }> {
  const realStage = await realpath(stageRoot);
  const manifest: StagedToolEntry[] = [];
  let totalBytes = 0;

  const hashFile = async (fullPath: string): Promise<string> => {
    const h = createHash('sha256');
    const handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(64 * 1024);
      let pos = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        h.update(buf.subarray(0, bytesRead));
      }
      return h.digest('hex');
    } finally {
      await handle.close();
    }
  };

  const walk = async (relPrefix: string, depth: number): Promise<void> => {
    if (depth > MAX_TOOL_DEPTH) fail(400, 'invalid_tool_path');
    const dirPath = relPrefix ? join(realStage, relPrefix) : realStage;
    const dirents = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const childRel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
      const sensitive = isSensitiveToolPath(childRel);
      if (sensitive) fail(400, 'sensitive_tool_file_blocked', undefined, { detail: `Refused sensitive path: ${childRel}` });
      const fullPath = join(dirPath, dirent.name);
      const info = await lstat(fullPath);
      if (info.isDirectory()) {
        await chmod(fullPath, 0o755);
        await walk(childRel, depth + 1);
      } else if (info.isSymbolicLink()) {
        if (manifest.length + 1 > options.maxFiles) fail(400, 'archive_too_many_files');
        const linkTarget = await readlink(fullPath);
        validateRelativeSymlinkTarget(realStage, childRel, linkTarget);
        await assertSymlinkChainStaysInside(realStage, childRel);
        // Verify resolved realpath (if target exists) stays inside stageRoot so chained symlinks cannot escape.
        const resolved = await realpath(fullPath).catch(() => null);
        if (resolved && resolved !== realStage && !resolved.startsWith(realStage + sep)) {
          fail(400, 'unsafe_archive_symlink');
        }
        manifest.push({ path: childRel, type: 'symlink', size: 0, executable: false, target: linkTarget });
      } else if (info.isFile()) {
        if (manifest.length + 1 > options.maxFiles) fail(400, 'archive_too_many_files');
        totalBytes += info.size;
        if (totalBytes > options.maxBytes) fail(413, 'project_tools_quota_exceeded');
        const secretHit = await scanFileForSecrets(fullPath, options.registeredSecrets);
        if (secretHit) {
          fail(400, 'sensitive_tool_content_blocked', undefined, { detail: `Blocked sensitive content (${secretHit}) in ${childRel}` });
        }
        const executable = (info.mode & 0o111) !== 0;
        await chmod(fullPath, executable ? 0o755 : 0o644);
        const digest = await hashFile(fullPath);
        manifest.push({ path: childRel, type: 'file', size: info.size, executable, sha256: digest });
      } else {
        fail(400, 'unsafe_archive_entry_type');
      }
    }
  };

  await chmod(realStage, 0o755);
  await walk('', 0);

  const treeHash = createHash('sha256');
  for (const item of manifest) {
    treeHash.update(`${item.type}\0${item.path}\0${item.size}\0${item.executable ? 1 : 0}\0${item.sha256 ?? item.target ?? ''}\n`);
  }
  return {
    files: manifest,
    filesCount: manifest.length,
    totalBytes,
    sha256: treeHash.digest('hex'),
  };
}
