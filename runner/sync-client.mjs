import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';

export const SYNC_BASE_FILENAME = '.sync-base.json';
export const SYNC_BASE_SCHEMA = 'bot.sync-base/1';
const SHA256_RE = /^[a-f0-9]{64}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const DEFAULT_BATCH_BLOBS = 64;

export class SyncClientError extends Error {
  constructor(code, status = 400, detail = null) {
    super(code);
    this.name = 'SyncClientError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function sha256Bytes(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function isReservedSyncName(name) {
  const lower = name.toLowerCase();
  return (
    !name ||
    lower === '.' ||
    lower === '..' ||
    lower === '.git' ||
    name === SYNC_BASE_FILENAME ||
    name.startsWith(SYNC_BASE_FILENAME + '.') ||
    name.startsWith('.sync-tmp-') ||
    name.startsWith('.write-') ||
    name.startsWith('.expired-')
  );
}

export function validateRelativeSyncPath(raw) {
  if (
    typeof raw !== 'string' ||
    !raw ||
    Buffer.byteLength(raw) > 4096 ||
    raw.startsWith('/') ||
    raw.endsWith('/') ||
    /^[A-Za-z]:/.test(raw) ||
    raw.includes('\\') ||
    CONTROL_CHAR_RE.test(raw)
  ) {
    throw new SyncClientError('sync_invalid_path', 400);
  }
  const parts = raw.split('/');
  if (parts.length > 32) throw new SyncClientError('sync_invalid_path', 400);
  for (const part of parts) {
    if (!part || Buffer.byteLength(part) > 255 || isReservedSyncName(part)) {
      throw new SyncClientError('sync_invalid_path', 400);
    }
  }
  return raw;
}

function validateInternalSymlink(relPath, linkTarget) {
  if (
    typeof linkTarget !== 'string' ||
    !linkTarget ||
    Buffer.byteLength(linkTarget) > 4096 ||
    linkTarget.startsWith('/') ||
    /^[A-Za-z]:/.test(linkTarget) ||
    linkTarget.includes('\\') ||
    CONTROL_CHAR_RE.test(linkTarget)
  ) {
    throw new SyncClientError('sync_symlink_forbidden', 400);
  }
  const parent = posix.dirname(relPath);
  const resolved = posix.normalize(parent === '.' ? linkTarget : `${parent}/${linkTarget}`);
  if (!resolved || resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) {
    throw new SyncClientError('sync_symlink_forbidden', 400);
  }
  return linkTarget;
}

function assertSha256(value) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new SyncClientError('sync_invalid_sha256', 400);
  }
  return value;
}

/**
 * Local content-addressed object cache pool indexed by `sha256` (`<cacheDir>/sha256/<aa>/<bb>/<hash>`).
 * Shared across namespaces and scopes on the same node so identical objects transfer at most once.
 */
export class CasCache {
  constructor(cacheDir) {
    if (typeof cacheDir !== 'string' || !cacheDir.trim()) {
      throw new SyncClientError('sync_invalid_cache_dir', 400);
    }
    this.root = resolve(cacheDir);
  }

  objectPath(sha256) {
    const clean = assertSha256(sha256);
    return join(this.root, 'sha256', clean.slice(0, 2), clean.slice(2, 4), clean);
  }

  async has(sha256) {
    const target = this.objectPath(sha256);
    try {
      const info = await lstat(target);
      return info.isFile() && !info.isSymbolicLink();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async get(sha256) {
    const clean = assertSha256(sha256);
    const target = this.objectPath(clean);
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new SyncClientError('sync_cas_corrupt', 500);
      const data = await handle.readFile();
      if (sha256Bytes(data) !== clean) throw new SyncClientError('sync_cas_corrupt', 500);
      return data;
    } finally {
      await handle.close();
    }
  }

  async put(data, expectedSha256) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const actual = sha256Bytes(buf);
    if (expectedSha256 !== undefined && assertSha256(expectedSha256) !== actual) {
      throw new SyncClientError('sync_blob_hash_mismatch', 400);
    }
    if (await this.has(actual)) {
      return { sha256: actual, size: buf.length, deduplicated: true };
    }
    const target = this.objectPath(actual);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
    try {
      await handle.writeFile(buf);
      await handle.datasync();
    } finally {
      await handle.close();
    }
    try {
      await chmod(tmp, 0o444).catch(() => {});
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      if (await this.has(actual)) return { sha256: actual, size: buf.length, deduplicated: true };
      throw error;
    }
    return { sha256: actual, size: buf.length, deduplicated: false };
  }

  /**
   * Materializes a cached object into `destPath` atomically.
   * Uses hardlink only when `allowHardlink === true` and `mode` is non-executable (0o444/0o644)
   * so read-write edits or executable chmods never mutate shared CAS inodes.
   */
  async materialize(sha256, destPath, { mode = 0o644, allowHardlink = false } = {}) {
    const src = this.objectPath(sha256);
    const parent = dirname(destPath);
    const tmp = join(parent, `.sync-tmp-${randomBytes(8).toString('hex')}`);
    const executable = (mode & 0o111) !== 0;
    let hardlinked = false;

    try {
      if (allowHardlink && !executable) {
        try {
          await link(src, tmp);
          hardlinked = true;
        } catch (error) {
          if (!['EXDEV', 'EPERM', 'EMLINK', 'EACCES', 'EOPNOTSUPP'].includes(error?.code)) {
            throw error;
          }
        }
      }
      if (!hardlinked) {
        await copyFile(src, tmp);
        await chmod(tmp, mode).catch(() => {});
      }
      await rename(tmp, destPath);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
    return { hardlinked };
  }
}

async function ensureNoSymlinkAncestors(rootReal, relPath, { create = false } = {}) {
  const parts = relPath.split('/');
  parts.pop();
  let current = rootReal;
  for (const part of parts) {
    const next = join(current, part);
    let info = null;
    try {
      info = await lstat(next);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!info) {
      if (!create) return null;
      await mkdir(next, { mode: 0o755 });
    } else if (info.isSymbolicLink()) {
      throw new SyncClientError('sync_symlink_forbidden', 400);
    } else if (!info.isDirectory()) {
      throw new SyncClientError('sync_path_conflict', 409);
    }
    const resolved = await realpath(next);
    if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
      throw new SyncClientError('sync_symlink_forbidden', 400);
    }
    current = resolved;
  }
  return current;
}

async function pruneEmptyParents(rootReal, fileFullPath) {
  let cursor = dirname(fileFullPath);
  while (cursor !== rootReal && cursor.startsWith(rootReal + sep)) {
    try {
      const remaining = await readdir(cursor);
      if (remaining.length > 0) break;
      await rmdir(cursor);
      cursor = dirname(cursor);
    } catch {
      break;
    }
  }
}

async function hashFileIfRegular(fullPath) {
  let handle;
  try {
    handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP') throw new SyncClientError('sync_symlink_forbidden', 400);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const data = await handle.readFile();
    return { sha256: sha256Bytes(data), size: info.size, mode: (info.mode & 0o111) !== 0 ? 0o755 : 0o644, data };
  } finally {
    await handle.close();
  }
}

async function writeAtomicFile(destPath, data, mode = 0o644) {
  const tmp = join(dirname(destPath), `.sync-tmp-${randomBytes(8).toString('hex')}`);
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(data);
    await handle.datasync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(tmp, mode).catch(() => {});
    await rename(tmp, destPath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Reusable FileSyncEngine client (`runner/sync-client.mjs`).
 *
 * Works identically across all 6 platform directory namespaces (`tool-results`, `project-tools`,
 * `agent-tools`, `skill-store`, `project-notes`, `assistant-homes`) using:
 * - local `sha256` CAS object cache pool (0-byte transfer for unchanged/cached files)
 * - `.sync-base.json` baseline manifest in writable working directories
 * - single-file incremental push with 3-layer conflict handling (`interactive` 409 / `background` conflict copies)
 */
export class SyncClient {
  constructor(options) {
    if (!options || typeof options !== 'object') throw new SyncClientError('sync_invalid_options', 400);
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    if (!this.baseUrl) throw new SyncClientError('sync_invalid_base_url', 400);
    this.token = String(options.token || '');
    this.namespace = String(options.namespace || '');
    this.scope = String(options.scope || '');
    if (!this.namespace || !this.scope) throw new SyncClientError('sync_invalid_scope', 400);
    this.targetDir = resolve(String(options.targetDir || ''));
    this.cas = options.cas instanceof CasCache ? options.cas : new CasCache(options.cacheDir);
    this.actorTag = options.actorTag ? String(options.actorTag) : undefined;
    this.preferHardlink = options.preferHardlink !== false;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.explicitBaseFile = options.baseFile ? resolve(String(options.baseFile)) : null;
    this.maxBatchBlobs = Number.isSafeInteger(options.maxBatchBlobs) && options.maxBatchBlobs > 0
      ? options.maxBatchBlobs
      : DEFAULT_BATCH_BLOBS;
  }

  routePrefix() {
    return `${this.baseUrl}/sync/${encodeURIComponent(this.namespace)}/${encodeURIComponent(this.scope)}`;
  }

  baseFilePath(mode = 'rw') {
    if (this.explicitBaseFile) return this.explicitBaseFile;
    if (mode === 'rw') return join(this.targetDir, SYNC_BASE_FILENAME);
    const key = sha256Bytes(Buffer.from(`${this.namespace}\0${this.scope}\0${this.targetDir}`)).slice(0, 24);
    return join(this.cas.root, 'state', `${key}.sync-base.json`);
  }

  async readBaseline(mode = 'rw') {
    const file = this.baseFilePath(mode);
    if (!existsSync(file)) {
      return {
        schema: SYNC_BASE_SCHEMA,
        namespace: this.namespace,
        scope: this.scope,
        mode,
        revision: 0,
        updated_at: null,
        files: {},
      };
    }
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (!raw || raw.schema !== SYNC_BASE_SCHEMA || typeof raw.files !== 'object' || Array.isArray(raw.files)) {
      throw new SyncClientError('sync_base_corrupt', 500);
    }
    return raw;
  }

  async writeBaseline(base, mode = 'rw') {
    const file = this.baseFilePath(mode);
    await mkdir(dirname(file), { recursive: true, mode: 0o755 });
    const next = {
      schema: SYNC_BASE_SCHEMA,
      namespace: this.namespace,
      scope: this.scope,
      mode,
      revision: Number(base.revision ?? 0),
      updated_at: new Date().toISOString(),
      files: base.files ?? {},
    };
    await writeAtomicFile(file, JSON.stringify(next, null, 2) + '\n', 0o644);
    return next;
  }

  async requestJson(method, pathSuffix, body, { allowStatuses = [] } = {}) {
    const headers = {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };
    const res = await this.fetchImpl(`${this.routePrefix()}${pathSuffix}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new SyncClientError('sync_invalid_response', res.status || 502);
    }
    if (!res.ok && !allowStatuses.includes(res.status)) {
      throw new SyncClientError(
        typeof parsed?.error === 'string' ? parsed.error : `http_${res.status}`,
        res.status,
        parsed,
      );
    }
    return { status: res.status, data: parsed };
  }

  async fetchMissingBlobs(hashes) {
    const unique = [...new Set(hashes.map(assertSha256))];
    const missingFromCache = [];
    let cachedHits = 0;

    for (const sha of unique) {
      if (await this.cas.has(sha)) {
        cachedHits++;
      } else {
        missingFromCache.push(sha);
      }
    }

    let fetchedBlobs = 0;
    let fetchedBytes = 0;

    for (let i = 0; i < missingFromCache.length; i += this.maxBatchBlobs) {
      const batch = missingFromCache.slice(i, i + this.maxBatchBlobs);
      const { data } = await this.requestJson('POST', '/blobs/fetch', { hashes: batch });
      const blobs = Array.isArray(data?.blobs) ? data.blobs : [];
      for (const item of blobs) {
        const sha = assertSha256(item.sha256);
        const bytes = Buffer.from(String(item.content_base64 || ''), 'base64');
        await this.cas.put(bytes, sha);
        fetchedBlobs++;
        fetchedBytes += bytes.length;
      }
      if (Array.isArray(data?.missing) && data.missing.length) {
        throw new SyncClientError('sync_blob_missing', 404, { missing: data.missing });
      }
    }

    return { cachedHits, fetchedBlobs, fetchedBytes };
  }

  /**
   * Incrementally pulls manifest & missing CAS blobs from the control plane and materializes into `targetDir`.
   * Unchanged files and CAS-cached blobs transfer 0 bytes over the network.
   */
  async pull(options = {}) {
    await mkdir(this.targetDir, { recursive: true, mode: 0o755 });
    const rootReal = await realpath(this.targetDir);

    // Peek existing baseline (try rw .sync-base.json first, fallback to ro state).
    let prevBase = null;
    if (existsSync(this.baseFilePath('rw'))) {
      prevBase = await this.readBaseline('rw');
    } else if (existsSync(this.baseFilePath('ro'))) {
      prevBase = await this.readBaseline('ro');
    }

    const lazyPaths = Array.isArray(options.paths) && options.paths.length
      ? options.paths.map(validateRelativeSyncPath)
      : null;
    const sinceRev = options.full || options.force || lazyPaths ? 0 : Number(prevBase?.revision ?? 0);
    const params = new URLSearchParams();
    if (sinceRev > 0) params.set('since_rev', String(sinceRev));
    if (lazyPaths) params.set('paths', lazyPaths.join(','));
    const qs = params.toString();

    const { data: manifest } = await this.requestJson('GET', `/manifest${qs ? `?${qs}` : ''}`);
    const mode = manifest.mode === 'rw' ? 'rw' : 'ro';
    const allowInternalSymlinks = mode === 'ro' && manifest.allow_internal_symlinks === true;
    const base = prevBase && prevBase.mode === mode ? prevBase : await this.readBaseline(mode);

    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    const neededHashes = [];
    for (const entry of entries) {
      validateRelativeSyncPath(entry.path);
      if (entry.deleted) continue;
      if (entry.kind === 'symlink') {
        if (!allowInternalSymlinks) throw new SyncClientError('sync_symlink_forbidden', 400);
        validateInternalSymlink(entry.path, entry.link_target);
        continue;
      }
      if (entry.sha256) neededHashes.push(entry.sha256);
    }

    const { cachedHits, fetchedBlobs, fetchedBytes } = await this.fetchMissingBlobs(neededHashes);

    const nextFiles = manifest.full && !lazyPaths ? {} : { ...(base.files ?? {}) };
    const manifestPathSet = new Set(entries.map(e => e.path));
    const skippedDirty = [];
    let writtenFiles = 0;
    let hardlinkedFiles = 0;
    let deletedFiles = 0;
    let symlinksWritten = 0;

    const removeLocalPath = async relPath => {
      const full = join(rootReal, relPath);
      const info = await lstat(full).catch(err => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
      if (!info) return false;
      if (mode === 'rw' && !options.force && info.isFile() && !info.isSymbolicLink()) {
        const local = await hashFileIfRegular(full);
        const prev = base.files?.[relPath];
        if (local && prev && local.sha256 !== prev.sha256) {
          skippedDirty.push(relPath);
          nextFiles[relPath] = prev;
          return false;
        }
      }
      await unlink(full);
      await pruneEmptyParents(rootReal, full);
      return true;
    };

    // For a full manifest pull, remove previously synced files that are no longer present on server.
    if (manifest.full && !lazyPaths) {
      for (const oldPath of Object.keys(base.files ?? {})) {
        if (!manifestPathSet.has(oldPath)) {
          if (await removeLocalPath(oldPath)) deletedFiles++;
        }
      }
    }

    for (const entry of entries) {
      const rel = validateRelativeSyncPath(entry.path);
      if (entry.deleted) {
        if (await removeLocalPath(rel)) deletedFiles++;
        if (!skippedDirty.includes(rel)) delete nextFiles[rel];
        continue;
      }

      const full = join(rootReal, rel);
      const existingInfo = await lstat(full).catch(err => (err?.code === 'ENOENT' ? null : Promise.reject(err)));

      if (entry.kind === 'symlink') {
        if (!allowInternalSymlinks) throw new SyncClientError('sync_symlink_forbidden', 400);
        const linkTarget = validateInternalSymlink(rel, entry.link_target);
        await ensureNoSymlinkAncestors(rootReal, rel, { create: true });
        if (existingInfo) {
          if (existingInfo.isDirectory() && !existingInfo.isSymbolicLink()) {
            throw new SyncClientError('sync_path_conflict', 409);
          }
          await unlink(full);
        }
        await symlink(linkTarget, full);
        symlinksWritten++;
        nextFiles[rel] = {
          revision: Number(entry.revision ?? 1),
          sha256: null,
          size: 0,
          mode: 0o120777,
          kind: 'symlink',
          link_target: linkTarget,
        };
        continue;
      }

      const sha = assertSha256(entry.sha256);
      const desiredMode = Number.isSafeInteger(entry.mode) ? entry.mode : 0o644;

      if (existingInfo) {
        if (existingInfo.isSymbolicLink()) {
          if (mode === 'rw') throw new SyncClientError('sync_symlink_forbidden', 400);
          await unlink(full);
        } else if (existingInfo.isDirectory()) {
          throw new SyncClientError('sync_path_conflict', 409);
        } else if (existingInfo.isFile()) {
          const local = await hashFileIfRegular(full);
          const prev = base.files?.[rel];
          if (local && local.sha256 === sha) {
            nextFiles[rel] = {
              revision: Number(entry.revision ?? 1),
              sha256: sha,
              size: Number(entry.size ?? local.size),
              mode: desiredMode,
            };
            continue;
          }
          if (mode === 'rw' && !options.force && local && prev && local.sha256 !== prev.sha256) {
            skippedDirty.push(rel);
            nextFiles[rel] = prev;
            continue;
          }
        }
      }

      await ensureNoSymlinkAncestors(rootReal, rel, { create: true });
      const mat = await this.cas.materialize(sha, full, {
        mode: desiredMode,
        allowHardlink: mode === 'ro' && this.preferHardlink,
      });
      writtenFiles++;
      if (mat.hardlinked) hardlinkedFiles++;
      nextFiles[rel] = {
        revision: Number(entry.revision ?? 1),
        sha256: sha,
        size: Number(entry.size ?? 0),
        mode: desiredMode,
      };
    }

    const updatedRevision = lazyPaths || skippedDirty.length > 0
      ? Number(base.revision ?? 0)
      : Number(manifest.revision ?? 0);
    await this.writeBaseline({ revision: updatedRevision, files: nextFiles }, mode);

    return {
      namespace: this.namespace,
      scope: this.scope,
      mode,
      revision: Number(manifest.revision ?? 0),
      full: Boolean(manifest.full),
      entries_count: entries.length,
      cached_hits: cachedHits,
      fetched_blobs: fetchedBlobs,
      fetched_bytes: fetchedBytes,
      written_files: writtenFiles,
      hardlinked_files: hardlinkedFiles,
      symlinks_written: symlinksWritten,
      deleted_files: deletedFiles,
      skipped_dirty: skippedDirty,
    };
  }

  async scanLocalTree(rootReal) {
    const files = new Map();
    const walk = async (dirReal, relPrefix, depth) => {
      if (depth > 32) throw new SyncClientError('sync_invalid_path', 400);
      const dirents = (await readdir(dirReal, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (isReservedSyncName(dirent.name)) continue;
        const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
        const full = join(dirReal, dirent.name);
        const info = await lstat(full);
        if (info.isSymbolicLink()) {
          throw new SyncClientError('sync_symlink_forbidden', 400, { path: rel });
        }
        if (info.isDirectory()) {
          const subReal = await realpath(full);
          if (subReal !== rootReal && !subReal.startsWith(rootReal + sep)) {
            throw new SyncClientError('sync_symlink_forbidden', 400, { path: rel });
          }
          await walk(subReal, rel, depth + 1);
        } else if (info.isFile()) {
          validateRelativeSyncPath(rel);
          const hashed = await hashFileIfRegular(full);
          if (hashed) files.set(rel, hashed);
        }
      }
    };
    await walk(rootReal, '', 0);
    return files;
  }

  /**
   * Advances the local `.sync-base.json` baseline for a single file after an online agent
   * semantically merges a `409 sync_conflict` in-place and is ready to resubmit.
   */
  async acceptServerBase(relPath, serverRevision, serverSha256) {
    const safe = validateRelativeSyncPath(relPath);
    const base = await this.readBaseline('rw');
    base.files[safe] = {
      ...(base.files[safe] ?? {}),
      revision: Number(serverRevision),
      sha256: serverSha256 ? assertSha256(serverSha256) : null,
    };
    await this.writeBaseline(base, 'rw');
  }

  /**
   * Diffs `targetDir` against `.sync-base.json`, uploads only changed/new blobs via CAS,
   * and commits changes at single-file granularity using `interactive` or `background` mode.
   */
  async push(options = {}) {
    const pushMode = options.mode ?? 'interactive';
    if (pushMode !== 'interactive' && pushMode !== 'background') {
      throw new SyncClientError('sync_invalid_mode', 400);
    }
    await mkdir(this.targetDir, { recursive: true, mode: 0o755 });
    const rootReal = await realpath(this.targetDir);
    const base = await this.readBaseline('rw');
    const localFiles = await this.scanLocalTree(rootReal);
    const pathFilter = Array.isArray(options.paths) && options.paths.length
      ? new Set(options.paths.map(validateRelativeSyncPath))
      : null;

    const changes = [];
    const blobsToUpload = new Map();

    for (const [rel, file] of localFiles) {
      if (pathFilter && !pathFilter.has(rel)) continue;
      const prev = base.files?.[rel];
      if (prev && prev.sha256 === file.sha256) continue;
      changes.push({
        path: rel,
        base_revision: prev ? Number(prev.revision) : 0,
        base_sha256: prev ? (prev.sha256 ?? null) : null,
        content_sha256: file.sha256,
        deleted: false,
        mode: file.mode,
      });
      blobsToUpload.set(file.sha256, file.data);
    }

    for (const [rel, prev] of Object.entries(base.files ?? {})) {
      if (pathFilter && !pathFilter.has(rel)) continue;
      if (!localFiles.has(rel)) {
        changes.push({
          path: rel,
          base_revision: Number(prev.revision),
          base_sha256: prev.sha256 ?? null,
          content_sha256: null,
          deleted: true,
        });
      }
    }

    if (changes.length === 0) {
      return {
        ok: true,
        status: 200,
        revision: Number(base.revision ?? 0),
        uploaded_blobs: 0,
        uploaded_bytes: 0,
        results: [],
        conflicts: [],
      };
    }

    // Upload changed/new blobs to control plane CAS and remember any server-side redactions.
    const uploadEntries = [...blobsToUpload.entries()];
    const redactedMap = new Map();
    let uploadedBlobs = 0;
    let uploadedBytes = 0;

    for (let i = 0; i < uploadEntries.length; i += this.maxBatchBlobs) {
      const batch = uploadEntries.slice(i, i + this.maxBatchBlobs);
      const payload = batch.map(([sha256, data]) => ({
        sha256,
        content_base64: data.toString('base64'),
      }));
      const { data } = await this.requestJson('POST', '/blobs/put', { blobs: payload });
      const stored = Array.isArray(data?.stored) ? data.stored : [];
      for (const item of stored) {
        const origSha = assertSha256(item.original_sha256 ?? item.sha256);
        const storedSha = assertSha256(item.sha256);
        uploadedBlobs++;
        uploadedBytes += Number(item.size ?? 0);
        if (item.redacted && typeof item.content_base64 === 'string') {
          const cleanBytes = Buffer.from(item.content_base64, 'base64');
          await this.cas.put(cleanBytes, storedSha);
          redactedMap.set(origSha, { sha256: storedSha, bytes: cleanBytes });
        } else {
          const origBytes = blobsToUpload.get(origSha);
          if (origBytes) await this.cas.put(origBytes, storedSha);
        }
      }
    }

    // Remap commit changes to redacted blob hashes when control-plane Redactor scrubbed secrets.
    const redactedPaths = new Map();
    const commitChanges = changes.map(change => {
      if (!change.deleted && change.content_sha256 && redactedMap.has(change.content_sha256)) {
        const mapped = redactedMap.get(change.content_sha256);
        redactedPaths.set(change.path, mapped);
        return { ...change, content_sha256: mapped.sha256 };
      }
      return change;
    });

    const { status, data: commitRes } = await this.requestJson(
      'POST',
      '/commit',
      {
        mode: pushMode,
        ...(options.actorTag ?? this.actorTag ? { actor_tag: options.actorTag ?? this.actorTag } : {}),
        ...(options.skipIfHumanEdited ? { skip_if_human_edited: true } : {}),
        changes: commitChanges,
      },
      { allowStatuses: [409] },
    );

    const nextFiles = { ...(base.files ?? {}) };
    const results = Array.isArray(commitRes?.results) ? commitRes.results : [];

    for (const item of results) {
      const rel = validateRelativeSyncPath(item.path);
      const full = join(rootReal, rel);
      const putRedacted = redactedPaths.get(rel);
      if (putRedacted && !item.redacted) item.redacted = true;
      if (item.status === 'committed' || item.status === 'unchanged') {
        if (item.deleted) {
          delete nextFiles[rel];
        } else {
          if (item.redacted || putRedacted || typeof item.merged_content_base64 === 'string') {
            const bytes = typeof item.merged_content_base64 === 'string'
              ? Buffer.from(item.merged_content_base64, 'base64')
              : putRedacted
                ? putRedacted.bytes
                : item.sha256
                  ? await this.cas.get(item.sha256)
                  : null;
            if (bytes) {
              await ensureNoSymlinkAncestors(rootReal, rel, { create: true });
              await writeAtomicFile(full, bytes, 0o644);
            }
          }
          nextFiles[rel] = {
            revision: Number(item.revision),
            sha256: item.sha256 ?? null,
            size: Number(item.size ?? 0),
            mode: 0o644,
          };
        }
      } else if (item.status === 'merged') {
        const mergedBytes = typeof item.merged_content_base64 === 'string'
          ? Buffer.from(item.merged_content_base64, 'base64')
          : null;
        if (mergedBytes && item.sha256) {
          await this.cas.put(mergedBytes, item.sha256);
          await ensureNoSymlinkAncestors(rootReal, rel, { create: true });
          await writeAtomicFile(full, mergedBytes, 0o644);
        }
        nextFiles[rel] = {
          revision: Number(item.revision),
          sha256: item.sha256 ?? null,
          size: Number(item.size ?? 0),
          mode: 0o644,
        };
      } else if (item.status === 'conflict_copy') {
        // Restore main file to authoritative server `current` and materialize the conflict copy locally.
        if (item.deleted) {
          await unlink(full).catch(err => { if (err?.code !== 'ENOENT') throw err; });
          delete nextFiles[rel];
        } else if (typeof item.current_content_base64 === 'string' && item.sha256) {
          const curBytes = Buffer.from(item.current_content_base64, 'base64');
          await this.cas.put(curBytes, item.sha256);
          await ensureNoSymlinkAncestors(rootReal, rel, { create: true });
          await writeAtomicFile(full, curBytes, 0o644);
          nextFiles[rel] = {
            revision: Number(item.revision),
            sha256: item.sha256,
            size: curBytes.length,
            mode: 0o644,
          };
        }
        if (item.conflict_path && typeof item.conflict_content_base64 === 'string' && item.conflict_sha256) {
          const copyRel = validateRelativeSyncPath(item.conflict_path);
          const copyFull = join(rootReal, copyRel);
          const copyBytes = Buffer.from(item.conflict_content_base64, 'base64');
          await this.cas.put(copyBytes, item.conflict_sha256);
          await ensureNoSymlinkAncestors(rootReal, copyRel, { create: true });
          await writeAtomicFile(copyFull, copyBytes, 0o644);
          nextFiles[copyRel] = {
            revision: Number(item.conflict_revision ?? 1),
            sha256: item.conflict_sha256,
            size: copyBytes.length,
            mode: 0o644,
          };
        }
      } else if (item.status === 'skipped_human_edited') {
        if (item.deleted) {
          await unlink(full).catch(err => { if (err?.code !== 'ENOENT') throw err; });
          delete nextFiles[rel];
        } else if (typeof item.current_content_base64 === 'string' && item.sha256) {
          const curBytes = Buffer.from(item.current_content_base64, 'base64');
          await this.cas.put(curBytes, item.sha256);
          await ensureNoSymlinkAncestors(rootReal, rel, { create: true });
          await writeAtomicFile(full, curBytes, 0o644);
          nextFiles[rel] = {
            revision: Number(item.revision),
            sha256: item.sha256,
            size: curBytes.length,
            mode: 0o644,
          };
        }
      }
      // For `status === 'conflict'` (interactive 409): keep local file & its old baseline intact for resolution.
    }

    const nextScopeRev = commitRes?.ok
      ? Number(commitRes.revision ?? base.revision ?? 0)
      : Number(base.revision ?? 0);
    await this.writeBaseline({ revision: nextScopeRev, files: nextFiles }, 'rw');

    return {
      ok: Boolean(commitRes?.ok),
      status,
      ...(commitRes?.error ? { error: commitRes.error } : {}),
      revision: Number(commitRes?.revision ?? base.revision ?? 0),
      uploaded_blobs: uploadedBlobs,
      uploaded_bytes: uploadedBytes,
      results,
      conflicts: Array.isArray(commitRes?.conflicts) ? commitRes.conflicts : [],
    };
  }
}
