import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';
import { fail } from '../core/security.js';
import { isSensitiveToolPath } from '../projects/tools-archive.js';

export const SHA256_RE = /^[a-f0-9]{64}$/;
export const SYNC_BASE_FILENAME = '.sync-base.json';
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SENSITIVE_MEMORY_PATH_RE =
  /(^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|\.aws|credentials(?:\.(?!ts$|tsx$|js$|mjs$|cjs$|jsx$|py$|md$|mdx$|html$|css$|scss$|vue$|svelte$|rs$|go$|java$|kt$|rb$|php$|sh$)[^/]*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key))(?:\/|$)/i;

export function isReservedSyncSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    !segment ||
    lower === '.' ||
    lower === '..' ||
    lower === '.git' ||
    segment.startsWith('.sync-') ||
    segment.startsWith('.write-') ||
    segment.startsWith('.expired-')
  );
}

/**
 * Validates and returns a canonical POSIX relative path for FileSyncEngine.
 * Refuses traversal, absolute paths, drive letters, backslashes, control characters,
 * internal sync/history segments, and optionally credential/key paths.
 */
export function normalizeSyncPath(
  value: unknown,
  options: { rejectSensitivePaths?: boolean; allowDotGit?: boolean } = {},
): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > 4096 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    CONTROL_CHAR_RE.test(value)
  ) {
    return fail(400, 'sync_invalid_path');
  }
  const parts = value.split('/');
  if (parts.length > 32) return fail(400, 'sync_invalid_path');
  for (const part of parts) {
    if (!part || Buffer.byteLength(part) > 255) return fail(400, 'sync_invalid_path');
    if (options.allowDotGit && part.toLowerCase() === '.git') continue;
    if (isReservedSyncSegment(part)) return fail(400, 'sync_invalid_path');
  }
  if (options.rejectSensitivePaths && isSensitiveSyncPath(value)) {
    return fail(400, 'sync_sensitive_path');
  }
  return value;
}

export function isSensitiveSyncPath(relPath: string): boolean {
  if (isSensitiveToolPath(relPath) !== null) return true;
  if (SENSITIVE_MEMORY_PATH_RE.test(relPath)) return true;
  return false;
}

export function assertSha256(value: unknown, code = 'sync_invalid_sha256'): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) return fail(400, code);
  return value;
}

/**
 * Validates that a relative symlink target stays strictly inside `rootDir` when resolved from `relPath`.
 */
export function validateInternalSymlinkTarget(relPath: string, linkTarget: string): string {
  if (
    typeof linkTarget !== 'string' ||
    !linkTarget ||
    Buffer.byteLength(linkTarget) > 4096 ||
    linkTarget.startsWith('/') ||
    /^[A-Za-z]:/.test(linkTarget) ||
    linkTarget.includes('\\') ||
    CONTROL_CHAR_RE.test(linkTarget)
  ) {
    fail(400, 'sync_symlink_forbidden');
  }
  const parent = posix.dirname(relPath);
  const resolved = posix.normalize(parent === '.' ? linkTarget : `${parent}/${linkTarget}`);
  if (!resolved || resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) {
    fail(400, 'sync_symlink_forbidden');
  }
  return linkTarget;
}

/**
 * Opens a regular file strictly inside `rootDir` via O_DIRECTORY|O_NOFOLLOW ancestor handles
 * and `/proc/self/fd` containment checks so concurrent symlink swaps cannot escape.
 */
export async function readRegularFileAnchored(rootDir: string, relPath: string): Promise<Buffer | null> {
  const safeRel = normalizeSyncPath(relPath);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(rootDir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const segments = safeRel.split('/');
  const leaf = segments.pop()!;
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  try {
    const rootHandle = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(rootHandle);
    const rootLink = await readlink(`/proc/self/fd/${rootHandle.fd}`).catch(() => canonicalRoot);
    if (rootLink !== canonicalRoot) fail(400, 'sync_symlink_forbidden');

    let expected = canonicalRoot;
    for (const seg of segments) {
      const parent = handles.at(-1)!;
      const nextPath = `/proc/self/fd/${parent.fd}/${seg}`;
      let nextHandle: Awaited<ReturnType<typeof open>>;
      try {
        nextHandle = await open(nextPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') fail(400, 'sync_symlink_forbidden');
        throw error;
      }
      handles.push(nextHandle);
      expected = `${expected}/${seg}`;
      const actual = await readlink(`/proc/self/fd/${nextHandle.fd}`).catch(() => '');
      if (actual && actual !== expected && !actual.startsWith(canonicalRoot + sep)) {
        fail(400, 'sync_symlink_forbidden');
      }
    }

    const parent = handles.at(-1)!;
    const leafPath = `/proc/self/fd/${parent.fd}/${leaf}`;
    let fileHandle: Awaited<ReturnType<typeof open>>;
    try {
      fileHandle = await open(leafPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code === 'ELOOP') fail(400, 'sync_symlink_forbidden');
      if (error?.code === 'EISDIR') fail(400, 'sync_invalid_path');
      throw error;
    }
    try {
      const info = await fileHandle.stat();
      if (!info.isFile()) fail(400, 'sync_symlink_forbidden');
      const actual = await readlink(`/proc/self/fd/${fileHandle.fd}`).catch(() => '');
      if (actual && !actual.startsWith(canonicalRoot + sep)) fail(400, 'sync_symlink_forbidden');
      return await fileHandle.readFile();
    } finally {
      await fileHandle.close();
    }
  } finally {
    for (const handle of handles.reverse()) {
      await handle.close().catch(() => {});
    }
  }
}

export async function isRealDirectory(dirPath: string): Promise<boolean> {
  try {
    const info = await lstat(dirPath);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function sanitizeActorTag(raw: string | undefined | null): string {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
  return cleaned || 'client';
}

export function formatConflictTimestamp(date: Date | number = Date.now()): string {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

const MAX_CONFLICT_EXT_BYTES = 64;

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let out = '';
  for (const ch of value) {
    if (Buffer.byteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out || 'f';
}

/**
 * Generates `<dir>/<stem>.conflict-<actorTag>-<ts>[-<disambiguator>]<ext>`,
 * keeping the resulting filename strictly within the 255-byte POSIX segment limit
 * (even when the original extension is arbitrarily long) and never colliding with `existingPaths`.
 */
export function buildConflictCopyPath(
  originalPath: string,
  actorTag: string,
  timestamp: Date | number = Date.now(),
  existingPaths?: ReadonlySet<string>,
): string {
  const safePath = normalizeSyncPath(originalPath);
  const slash = safePath.lastIndexOf('/');
  const dir = slash >= 0 ? safePath.slice(0, slash) : '';
  const base = slash >= 0 ? safePath.slice(slash + 1) : safePath;
  const rawExt = posix.extname(base);
  const ext = rawExt && Buffer.byteLength(rawExt) <= MAX_CONFLICT_EXT_BYTES ? rawExt : '';
  const rawStem = ext ? base.slice(0, -ext.length) : base;
  const cleanTag = sanitizeActorTag(actorTag);
  const ts = formatConflictTimestamp(timestamp);

  const makeCandidate = (suffix: string): string => {
    const marker = `.conflict-${cleanTag}-${ts}${suffix}${ext}`;
    const maxStemBytes = Math.max(1, 255 - Buffer.byteLength(marker));
    let stem = truncateUtf8Bytes(rawStem, maxStemBytes);
    if (isReservedSyncSegment(`${stem}${marker}`)) {
      stem = 'note';
    }
    const filename = `${stem}${marker}`;
    return dir ? `${dir}/${filename}` : filename;
  };

  let candidate = makeCandidate('');
  if (!existingPaths || !existingPaths.has(candidate)) return candidate;
  for (let i = 1; i <= 1000; i++) {
    candidate = makeCandidate(`-${i}`);
    if (!existingPaths.has(candidate)) return candidate;
  }
  return makeCandidate(`-${Date.now().toString(36)}`);
}

export function isSubpathStrict(rootReal: string, candidateReal: string): boolean {
  const normalizedRoot = resolve(rootReal);
  const normalizedCandidate = resolve(candidateReal);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + sep);
}
