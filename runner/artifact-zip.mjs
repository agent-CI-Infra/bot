import { inflateRawSync, crc32 } from 'node:zlib';
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { noSpace } from './disk.mjs';

export const MAX_ARTIFACT_COMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACT_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_ARTIFACT_ENTRIES = 1000;

export class ArtifactArchiveError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
    this.detail = detail || code;
  }
}

function normalizeEntryPath(rawName) {
  if (typeof rawName !== 'string' || !rawName || rawName.length > 512) {
    throw new ArtifactArchiveError('artifact_path_invalid', 'Archive entry path is empty or exceeds 512 characters.');
  }
  if (rawName.includes('\0') || rawName.includes('\\') || rawName.startsWith('/') || /^[a-zA-Z]:/.test(rawName)) {
    throw new ArtifactArchiveError('artifact_path_traversal', `Unsafe archive entry path: ${rawName.slice(0, 120)}`);
  }
  const isDirectory = rawName.endsWith('/');
  const trimmed = isDirectory ? rawName.replace(/\/+$/, '') : rawName;
  if (!trimmed) return { path: '', directory: true, parts: [] };
  const parts = trimmed.split('/');
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (!part || part === '.' || part === '..' || lower === '.git' || part === '.runner-journal') {
      throw new ArtifactArchiveError('artifact_path_traversal', `Unsafe archive entry segment in path: ${rawName.slice(0, 120)}`);
    }
  }
  return { path: parts.join('/'), directory: isDirectory, parts };
}

function findEndOfCentralDirectory(buffer) {
  const minEocd = 22;
  if (buffer.length < minEocd) {
    throw new ArtifactArchiveError('artifact_zip_invalid', 'Archive is smaller than a valid ZIP header.');
  }
  const searchStart = Math.max(0, buffer.length - (minEocd + 0xffff));
  for (let offset = buffer.length - minEocd; offset >= searchStart; offset--) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + minEocd + commentLength === buffer.length) return offset;
  }
  throw new ArtifactArchiveError('artifact_zip_invalid', 'ZIP end-of-central-directory record was not found.');
}

export function parseArtifactZip(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new ArtifactArchiveError('artifact_zip_invalid', 'Archive buffer is required.');
  }
  const maxCompressedBytes = options.maxCompressedBytes ?? MAX_ARTIFACT_COMPRESSED_BYTES;
  const maxUncompressedBytes = options.maxUncompressedBytes ?? MAX_ARTIFACT_UNCOMPRESSED_BYTES;
  const maxEntries = options.maxEntries ?? MAX_ARTIFACT_ENTRIES;

  if (buffer.length > maxCompressedBytes) {
    throw new ArtifactArchiveError('artifact_too_large', `Compressed artifact size ${buffer.length} exceeds ${maxCompressedBytes} bytes.`);
  }

  const eocd = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  if (diskNumber !== 0 || cdDisk !== 0 || diskEntries !== totalEntries) {
    throw new ArtifactArchiveError('artifact_zip_unsupported', 'Multi-disk ZIP archives are not supported.');
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ArtifactArchiveError('artifact_zip_unsupported', 'ZIP64 archives are not supported.');
  }
  if (totalEntries > maxEntries) {
    throw new ArtifactArchiveError('artifact_entry_limit', `Archive contains ${totalEntries} entries, exceeding the limit of ${maxEntries}.`);
  }
  if (cdOffset + cdSize > eocd) {
    throw new ArtifactArchiveError('artifact_zip_invalid', 'Central directory bounds exceed archive size.');
  }

  const files = [];
  const directories = new Set();
  const seenFiles = new Set();
  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > cdOffset + cdSize || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new ArtifactArchiveError('artifact_zip_invalid', 'Malformed central directory file header.');
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const externalAttr = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const headerEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (headerEnd > cdOffset + cdSize) {
      throw new ArtifactArchiveError('artifact_zip_invalid', 'Central directory entry extends past central directory.');
    }
    if (flags & 0x0001) {
      throw new ArtifactArchiveError('artifact_zip_unsupported', 'Encrypted ZIP entries are not supported.');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ArtifactArchiveError('artifact_zip_unsupported', 'ZIP64 entry sizes are not supported.');
    }

    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor = headerEnd;

    const hostOs = versionMadeBy >> 8;
    const unixMode = hostOs === 3 ? (externalAttr >>> 16) & 0xffff : 0;
    const unixType = unixMode & 0o170000;
    if (unixType === 0o120000) {
      throw new ArtifactArchiveError('artifact_symlink_forbidden', `Symbolic link entry is forbidden in artifact archive: ${rawName.slice(0, 120)}`);
    }
    if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
      throw new ArtifactArchiveError('artifact_special_file_forbidden', `Unsupported special file entry in artifact archive: ${rawName.slice(0, 120)}`);
    }

    const normalized = normalizeEntryPath(rawName);
    const isDir = normalized.directory || unixType === 0o040000;
    if (isDir) {
      if (normalized.path) directories.add(normalized.path);
      continue;
    }

    if (seenFiles.has(normalized.path)) {
      throw new ArtifactArchiveError('artifact_duplicate_entry', `Duplicate archive entry path: ${normalized.path}`);
    }
    seenFiles.add(normalized.path);

    if (method !== 0 && method !== 8) {
      throw new ArtifactArchiveError('artifact_zip_unsupported', `Unsupported compression method ${method} for ${normalized.path}.`);
    }
    if (totalUncompressed + uncompressedSize > maxUncompressedBytes) {
      throw new ArtifactArchiveError('artifact_uncompressed_too_large', `Uncompressed artifact size exceeds ${maxUncompressedBytes} bytes.`);
    }

    if (localHeaderOffset + 30 > cdOffset || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new ArtifactArchiveError('artifact_zip_invalid', `Invalid local file header for ${normalized.path}.`);
    }
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) {
      throw new ArtifactArchiveError('artifact_zip_invalid', `Compressed payload out of bounds for ${normalized.path}.`);
    }

    const slice = buffer.subarray(dataStart, dataEnd);
    const remainingBudget = maxUncompressedBytes - totalUncompressed;
    let data;
    if (method === 0) {
      if (slice.length !== uncompressedSize) {
        throw new ArtifactArchiveError('artifact_zip_invalid', `Stored entry size mismatch for ${normalized.path}.`);
      }
      data = Buffer.from(slice);
    } else {
      try {
        data = inflateRawSync(slice, { maxOutputLength: remainingBudget });
      } catch (error) {
        if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ArtifactArchiveError('artifact_uncompressed_too_large', `Decompressed entry ${normalized.path} exceeds ${maxUncompressedBytes} bytes.`);
        }
        throw new ArtifactArchiveError('artifact_zip_invalid', `Decompression failed for ${normalized.path}: ${String(error?.message || error)}`);
      }
      if (data.length !== uncompressedSize) {
        throw new ArtifactArchiveError('artifact_zip_invalid', `Decompressed size mismatch for ${normalized.path}: expected ${uncompressedSize}, got ${data.length}.`);
      }
    }

    const actualCrc = crc32(data) >>> 0;
    if (actualCrc !== expectedCrc) {
      throw new ArtifactArchiveError('artifact_zip_invalid', `CRC32 mismatch for ${normalized.path}.`);
    }

    totalUncompressed += data.length;
    const executable = Boolean(unixMode & 0o111);
    files.push({ path: normalized.path, parts: normalized.parts, data, size: data.length, mode: executable ? 0o755 : 0o600 });
  }

  return { files, directories: [...directories], totalBytes: totalUncompressed };
}

function ensureSafeSubdirectory(baseReal, parts) {
  let current = baseReal;
  for (const part of parts) {
    current = resolve(current, part);
    if (current !== baseReal && !current.startsWith(baseReal + sep)) {
      throw new ArtifactArchiveError('artifact_path_traversal', 'Resolved directory escaped target root.');
    }
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ArtifactArchiveError('artifact_symlink_escape', `Existing path component is not a regular directory: ${part}`);
    }
    const real = realpathSync(current);
    if (real !== baseReal && !real.startsWith(baseReal + sep)) {
      throw new ArtifactArchiveError('artifact_symlink_escape', `Directory resolved outside target root: ${part}`);
    }
  }
  return current;
}

function writeAllNoFollow(filePath, data, mode) {
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try {
    let written = 0;
    while (written < data.length) {
      const chunk = writeSync(fd, data, written, data.length - written, written);
      if (chunk <= 0) throw new Error('short_write');
      written += chunk;
    }
  } finally {
    closeSync(fd);
  }
}

export function extractArtifactZip(buffer, destinationDir, options = {}) {
  const parsed = parseArtifactZip(buffer, options);
  const resolvedDest = resolve(destinationDir);
  mkdirSync(dirname(resolvedDest), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(resolvedDest, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      if (noSpace(error)) throw new ArtifactArchiveError('disk_full', String(error.message || error));
      throw error;
    }
  }
  const destStat = lstatSync(resolvedDest);
  if (destStat.isSymbolicLink() || !destStat.isDirectory()) {
    throw new ArtifactArchiveError('artifact_symlink_escape', 'Artifact destination is not a regular directory.');
  }
  const baseReal = realpathSync(resolvedDest);

  const writtenPaths = [];
  try {
    for (const dir of parsed.directories) {
      ensureSafeSubdirectory(baseReal, dir.split('/'));
    }
    for (const entry of parsed.files) {
      const parentParts = entry.parts.slice(0, -1);
      const fileName = entry.parts.at(-1);
      const parentDir = ensureSafeSubdirectory(baseReal, parentParts);
      const targetFile = resolve(parentDir, fileName);
      if (!targetFile.startsWith(baseReal + sep)) {
        throw new ArtifactArchiveError('artifact_path_traversal', `Target file escaped destination root: ${entry.path}`);
      }
      const existing = (() => {
        try { return lstatSync(targetFile); } catch (error) {
          if (error?.code === 'ENOENT') return null;
          throw error;
        }
      })();
      if (existing && (existing.isSymbolicLink() || existing.isDirectory())) {
        throw new ArtifactArchiveError('artifact_symlink_escape', `Refusing to overwrite symlink or directory at ${entry.path}`);
      }
      writeAllNoFollow(targetFile, entry.data, entry.mode);
      writtenPaths.push(targetFile);
    }
  } catch (error) {
    for (const created of writtenPaths.reverse()) {
      try { rmSync(created, { force: true }); } catch {}
    }
    if (noSpace(error)) {
      throw new ArtifactArchiveError('disk_full', String(error.message || error));
    }
    if (error?.code === 'ELOOP') {
      throw new ArtifactArchiveError('artifact_symlink_escape', `Symlink encountered while writing artifact file: ${String(error.message || error)}`);
    }
    throw error;
  }

  return {
    total_files: parsed.files.length,
    total_bytes: parsed.totalBytes,
    files: parsed.files.map(file => ({ path: file.path, size: file.size })),
  };
}
