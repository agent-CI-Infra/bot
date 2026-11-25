import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readdir, readlink, realpath } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import type { Store } from '../storage/database.js';
import type { Manager } from '../projects/service.js';
import type { ProjectToolsService } from '../projects/tools.js';
import type { StagedToolEntry } from '../projects/tools-archive.js';
import type { AssistantHomes } from '../service-roles/assistant-computers.js';
import { DEFAULT_AGENT_TOOLS_ROOT, resolveSupportedArch } from '../harness/agent-tools.js';
import { resolveSkillStoreRoot } from '../roles/skill-store.js';
import { fail, HttpError } from '../core/security.js';
import { Notes } from '../../runner/notes.mjs';
import { withNoteDirectory } from '../../runner/note-path.mjs';
import { isBinaryBuffer } from './merge3.js';
import { SYNC_NAMESPACE_POLICIES } from './namespaces.js';
import {
  assertSha256,
  isRealDirectory,
  isReservedSyncSegment,
  isSubpathStrict,
  normalizeSyncPath,
  readRegularFileAnchored,
  validateInternalSymlinkTarget,
} from './paths.js';
import { hasPersistedSyncScope } from './storage.js';
import type {
  SyncAdapterCommitInput,
  SyncEntry,
  SyncHistoryVersion,
  SyncManifestSnapshot,
  SyncNamespaceAdapter,
  SyncNamespacePolicy,
} from './types.js';

const REPO_ID_RE = /^[1-9]\d{0,19}$/;
const PROJECT_TOOLS_SCOPE_RE = /^([1-9]\d{0,19})(?:@rev-([1-9]\d{0,9}))?$/;
const TOOL_RESULT_OWNER_RE = /^[a-zA-Z0-9_-]{1,160}$/;
const TOOL_RESULT_FILE_RE = /^[a-f0-9]{48}\.utf8$/;
const SKILL_SCOPE_RE = /^(service|projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\/sets\/([a-f0-9]{64}))?$/;
const ASSISTANT_SCOPE_RE = /^([a-f0-9]{32})(?::([1-9]\d{0,9}))?$/;
const AGENT_TOOLS_SCOPE_RE = /^(?:default|linux\/(x64|arm64)(?:\/([a-zA-Z0-9_-]+)@([0-9]+\.[0-9]+\.[0-9]+))?)$/;

const UNAVAILABLE_ERRNO_CODES = new Set(['EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'EROFS', 'ESTALE']);

function isUnavailableFsError(error: any): boolean {
  return Boolean(error && typeof error.code === 'string' && UNAVAILABLE_ERRNO_CODES.has(error.code));
}

function isNotFoundManagerError(error: any): boolean {
  if (error instanceof HttpError && error.status === 404) return true;
  if (error?.code === 'ENOENT' || error?.code === 'note_not_found' || error?.message === 'note_not_found') return true;
  return false;
}

function isRevisionRaceError(error: any): boolean {
  if (
    error instanceof HttpError &&
    error.status === 409 &&
    (error.code === 'note_revision_changed' || error.code === 'note_path_conflict')
  ) {
    return true;
  }
  const msg = String(error?.message || '');
  return msg === 'note_revision_changed' || msg === 'note_path_conflict';
}

function hasReservedSegment(relPath: string): boolean {
  return relPath.split('/').some(isReservedSyncSegment);
}

/**
 * Verifies a directory exists (not a symlink) and is readable/traversable.
 * Returns `'missing'` ONLY on `ENOENT`; fails closed with `503 sync_scope_unavailable`
 * on unreadable/unmounted/IO errors and `400 sync_symlink_forbidden` on symlinks.
 */
async function checkDirectoryReadable(dirPath: string): Promise<'ok' | 'missing'> {
  let info;
  try {
    info = await lstat(dirPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'missing';
    return fail(503, 'sync_scope_unavailable');
  }
  if (info.isSymbolicLink()) return fail(400, 'sync_symlink_forbidden');
  if (!info.isDirectory()) return fail(503, 'sync_scope_unavailable');
  try {
    await access(dirPath, constants.R_OK | constants.X_OK);
  } catch {
    return fail(503, 'sync_scope_unavailable');
  }
  return 'ok';
}

interface HashCacheEntry {
  mtimeMs: number;
  size: number;
  sha256: string;
}

class FileHashCache {
  private readonly cache = new Map<string, HashCacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  async hashFile(fullPath: string, size: number, mtimeMs: number): Promise<string> {
    const cached = this.cache.get(fullPath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.sha256;
    }
    const handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hasher = createHash('sha256');
    try {
      const buf = Buffer.alloc(64 * 1024);
      let pos = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        hasher.update(buf.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    const sha256 = hasher.digest('hex');
    if (this.cache.size >= this.maxEntries) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(fullPath, { mtimeMs, size, sha256 });
    return sha256;
  }
}

/**
 * Bounded LRU map `(scope -> (sha256 -> fullPath))` so read-only adapters never leak unbounded memory
 * across high-churn scopes or hashes in long-running control planes.
 */
class ScopedBlobPathCache {
  private readonly scopes = new Map<string, Map<string, string>>();

  constructor(
    private readonly maxScopes = 64,
    private readonly maxEntriesPerScope = 2048,
  ) {}

  get(scope: string, sha256: string): string | undefined {
    const scopeMap = this.scopes.get(scope);
    if (!scopeMap) return undefined;
    // Refresh scope LRU recency
    this.scopes.delete(scope);
    this.scopes.set(scope, scopeMap);
    return scopeMap.get(sha256);
  }

  set(scope: string, sha256: string, fullPath: string): void {
    let scopeMap = this.scopes.get(scope);
    if (scopeMap) {
      this.scopes.delete(scope);
      this.scopes.set(scope, scopeMap);
    } else {
      if (this.scopes.size >= this.maxScopes) {
        const oldest = this.scopes.keys().next().value;
        if (oldest !== undefined) this.scopes.delete(oldest);
      }
      scopeMap = new Map<string, string>();
      this.scopes.set(scope, scopeMap);
    }
    if (scopeMap.has(sha256)) {
      scopeMap.delete(sha256);
    } else if (scopeMap.size >= this.maxEntriesPerScope) {
      const oldestHash = scopeMap.keys().next().value;
      if (oldestHash !== undefined) scopeMap.delete(oldestHash);
    }
    scopeMap.set(sha256, fullPath);
  }

  replaceScope(scope: string, entries: Iterable<[string, string]>): void {
    const bounded = new Map<string, string>();
    for (const [sha, full] of entries) {
      if (bounded.size >= this.maxEntriesPerScope) {
        const oldestHash = bounded.keys().next().value;
        if (oldestHash !== undefined) bounded.delete(oldestHash);
      }
      bounded.set(sha, full);
    }
    if (this.scopes.has(scope)) {
      this.scopes.delete(scope);
    } else if (this.scopes.size >= this.maxScopes) {
      const oldest = this.scopes.keys().next().value;
      if (oldest !== undefined) this.scopes.delete(oldest);
    }
    this.scopes.set(scope, bounded);
  }
}

async function walkReadOnlyTree(
  rootDir: string,
  options: {
    allowInternalSymlinks: boolean;
    rejectSensitivePaths: boolean;
    hashCache: FileHashCache;
    skipTopLevel?: ReadonlySet<string>;
    skipName?: (name: string) => boolean;
    pathFilter?: ReadonlySet<string>;
    prefixRel?: string;
    revision?: number;
  },
): Promise<{ entries: SyncEntry[]; hashToPath: Map<string, string> }> {
  const entries: SyncEntry[] = [];
  const hashToPath = new Map<string, string>();
  const state = await checkDirectoryReadable(rootDir);
  if (state === 'missing') {
    return { entries, hashToPath };
  }
  const canonicalRoot = await realpath(rootDir);

  const walk = async (dirReal: string, relDir: string, depth: number): Promise<void> => {
    if (depth > 32) return;
    let rawDirents;
    try {
      rawDirents = await readdir(dirReal, { withFileTypes: true });
    } catch (error) {
      if (isUnavailableFsError(error)) fail(503, 'sync_scope_unavailable');
      throw error;
    }
    const dirents = rawDirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (depth === 0 && options.skipTopLevel?.has(dirent.name)) continue;
      if (options.skipName?.(dirent.name)) continue;
      if (isReservedSyncSegment(dirent.name)) continue;
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      const full = join(dirReal, dirent.name);
      let info;
      try {
        info = await lstat(full);
      } catch (error) {
        if (isUnavailableFsError(error)) fail(503, 'sync_scope_unavailable');
        continue;
      }
      if (info.isSymbolicLink()) {
        if (!options.allowInternalSymlinks) continue;
        try {
          const safeRel = normalizeSyncPath(options.prefixRel ? `${options.prefixRel}/${rel}` : rel, {
            rejectSensitivePaths: options.rejectSensitivePaths,
          });
          if (options.pathFilter && !options.pathFilter.has(safeRel)) continue;
          const linkTarget = await readlink(full);
          validateInternalSymlinkTarget(safeRel, linkTarget);
          const resolvedTarget = await realpath(full).catch(() => null);
          if (resolvedTarget && !isSubpathStrict(canonicalRoot, resolvedTarget)) continue;
          entries.push({
            path: safeRel,
            sha256: null,
            revision: options.revision ?? 1,
            size: 0,
            mode: 0o120777,
            deleted: false,
            kind: 'symlink',
            link_target: linkTarget,
            updated_at: new Date(info.mtimeMs).toISOString(),
          });
        } catch {
          continue;
        }
        continue;
      }
      if (info.isDirectory()) {
        const subReal = await realpath(full).catch(() => null);
        if (!subReal || !isSubpathStrict(canonicalRoot, subReal)) continue;
        await walk(subReal, rel, depth + 1);
      } else if (info.isFile()) {
        let safeRel: string;
        try {
          safeRel = normalizeSyncPath(options.prefixRel ? `${options.prefixRel}/${rel}` : rel, {
            rejectSensitivePaths: options.rejectSensitivePaths,
          });
        } catch {
          continue;
        }
        if (options.pathFilter && !options.pathFilter.has(safeRel)) continue;
        const sha256 = await options.hashCache.hashFile(full, info.size, info.mtimeMs);
        const mode = (info.mode & 0o111) !== 0 ? 0o755 : 0o644;
        entries.push({
          path: safeRel,
          sha256,
          revision: options.revision ?? 1,
          size: info.size,
          mode,
          deleted: false,
          kind: 'file',
          updated_at: new Date(info.mtimeMs).toISOString(),
        });
        hashToPath.set(sha256, full);
      }
    }
  };

  await walk(canonicalRoot, '', 0);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, hashToPath };
}

/**
 * Shared read-write adapter backed by a physical directory + `.write-history` (`runner/notes.mjs`).
 * Reused by BOTH `project-notes` (direct directory mode) and `assistant-homes` (`~/memory/`),
 * guaranteeing identical `.write-history` versioning, locking, and symlink protection with zero duplication.
 */
export class VersionedDirectoryAdapter implements SyncNamespaceAdapter {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly policy: SyncNamespacePolicy,
    private readonly scopeValidator: (scope: string) => void,
    private readonly resolveDirectory: (scope: string, options: { create: boolean }) => Promise<string | null>,
  ) {}

  validateScope(scope: string): void {
    this.scopeValidator(scope);
  }

  async withScopeLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(scope) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(scope, tail);
    void tail.then(() => {
      if (this.locks.get(scope) === tail) this.locks.delete(scope);
    });
    return next;
  }

  private async openNotes(scope: string, create: boolean): Promise<Notes | null> {
    this.validateScope(scope);
    const dir = await this.resolveDirectory(scope, { create });
    if (!dir) return null;
    if (!existsSync(dir)) {
      if (!create) return null;
      try {
        await mkdir(dir, { recursive: true, mode: 0o770 });
        await chmod(dir, 0o770).catch(() => {});
      } catch (error) {
        if (isUnavailableFsError(error)) fail(503, 'sync_scope_unavailable');
        throw error;
      }
    }
    const state = await checkDirectoryReadable(dir);
    if (state === 'missing') return null;
    const canonical = await realpath(dir);
    return new Notes(canonical, { canonicalRoot: canonical });
  }

  async snapshot(scope: string, options?: { paths?: readonly string[] }): Promise<SyncManifestSnapshot> {
    const notes = await this.openNotes(scope, false);
    if (!notes) return { revision: 0, entries: [] };
    let files;
    try {
      ({ files } = await notes.files(true));
    } catch (error) {
      if (isUnavailableFsError(error)) fail(503, 'sync_scope_unavailable');
      throw error;
    }
    const pathSet = options?.paths?.length ? new Set(options.paths) : null;
    const entries: SyncEntry[] = [];
    for (const file of files) {
      if (!file?.name || hasReservedSegment(file.name)) continue;
      if (pathSet && !pathSet.has(file.name)) continue;
      entries.push({
        path: file.name,
        sha256: file.deleted ? null : file.sha256,
        revision: Number(file.revision),
        size: file.deleted ? 0 : Number(file.bytes ?? 0),
        mode: 0o644,
        deleted: Boolean(file.deleted),
        kind: 'file',
        actor: file.actor ?? null,
        updated_at: file.created_at ?? null,
      });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { revision: entries.reduce((max, item) => Math.max(max, item.revision), 0), entries };
  }

  async readBlob(scope: string, sha256: string): Promise<Buffer | null> {
    assertSha256(sha256);
    const notes = await this.openNotes(scope, false);
    if (!notes) return null;
    try {
      return await notes.blob(sha256, true);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      if (isUnavailableFsError(error)) fail(503, 'sync_scope_unavailable');
      throw error;
    }
  }

  async versions(scope: string, path: string): Promise<SyncHistoryVersion[]> {
    const notes = await this.openNotes(scope, false);
    if (!notes) return [];
    try {
      const result = await notes.versions(path);
      return [...result.versions]
        .sort((a, b) => a.revision - b.revision)
        .map(v => ({
          revision: Number(v.revision),
          sha256: v.deleted ? null : (v.sha256 ?? null),
          deleted: Boolean(v.deleted),
          actor: v.actor ?? null,
          created_at: v.created_at ?? null,
          bytes: Number(v.bytes ?? 0),
          ...(v.binary ? { binary: true } : {}),
        }));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      if (isUnavailableFsError(error)) fail(503, 'sync_scope_unavailable');
      throw error;
    }
  }

  async readRevision(
    scope: string,
    path: string,
    revision: number,
  ): Promise<{ content: Buffer | null; sha256: string | null; deleted: boolean; binary?: boolean } | null> {
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    const notes = await this.openNotes(scope, false);
    if (!notes) return null;
    try {
      const view = await notes.file(path, revision);
      if (view.deleted) {
        return { content: null, sha256: null, deleted: true };
      }
      if (view.binary && view.sha256) {
        const raw = await notes.blob(view.sha256, true);
        return { content: raw, sha256: view.sha256, deleted: false, binary: true };
      }
      const textContent = view.content ?? '';
      return {
        content: Buffer.from(textContent, 'utf8'),
        sha256: view.sha256 ?? null,
        deleted: false,
        binary: false,
      };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      if (isUnavailableFsError(error)) fail(503, 'sync_scope_unavailable');
      throw error;
    }
  }

  async applyChange(scope: string, input: SyncAdapterCommitInput): Promise<SyncEntry> {
    const notes = await this.openNotes(scope, true);
    if (!notes) return fail(503, 'sync_scope_unavailable');

    try {
      if (input.deleted) {
        const removed = await notes.removeFile(input.path, input.expectedRevision, input.actor);
        return {
          path: input.path,
          sha256: null,
          revision: Number(removed.revision),
          size: 0,
          mode: 0o644,
          deleted: true,
          kind: 'file',
          actor: removed.actor ?? input.actor,
          updated_at: removed.created_at ?? new Date().toISOString(),
        };
      }

      const data = input.content ?? Buffer.alloc(0);
      if (!isBinaryBuffer(data)) {
        const saved = await notes.saveFile(input.path, data.toString('utf8'), input.expectedRevision, input.actor, {
          createParent: true,
        });
        return {
          path: input.path,
          sha256: saved.sha256 ?? input.sha256,
          revision: Number(saved.revision),
          size: Number(saved.bytes ?? data.length),
          mode: 0o644,
          deleted: false,
          kind: 'file',
          actor: saved.actor ?? input.actor,
          updated_at: saved.created_at ?? new Date().toISOString(),
        };
      }

      // Binary write with the same `.write-history` lock & atomic rename invariants.
      const saved = await notes.withLock(async check => {
        const index = await notes.observe(input.path, 'filesystem', check);
        notes.expected(index, input.expectedRevision);
        if (input.path.includes('/')) {
          const parentRel = input.path.slice(0, input.path.lastIndexOf('/'));
          await withNoteDirectory(notes.root, parentRel, () => {}, { create: true, canonicalRoot: notes.canonicalRoot });
        }
        await notes.atomic(`${notes.root}/${input.path}`, data, check);
        const updated = await notes.observe(input.path, input.actor, check);
        return notes.view(updated);
      });

      return {
        path: input.path,
        sha256: saved.sha256 ?? input.sha256,
        revision: Number(saved.revision),
        size: Number(saved.bytes ?? data.length),
        mode: 0o644,
        deleted: false,
        kind: 'file',
        actor: saved.actor ?? input.actor,
        updated_at: saved.created_at ?? new Date().toISOString(),
      };
    } catch (error: any) {
      if (isRevisionRaceError(error)) fail(409, 'sync_revision_race');
      if (error?.message === 'invalid_note_path' || error?.message === 'invalid_note_file') {
        fail(400, 'sync_invalid_path');
      }
      if (error?.code === 'ELOOP') fail(400, 'sync_symlink_forbidden');
      if (isUnavailableFsError(error)) fail(503, 'sync_scope_unavailable');
      throw error;
    }
  }
}

/**
 * `project-notes` adapter bridging to `Manager` HTTP `/v1/projects/:repo/file-tree` when the
 * project notes Docker volume is managed out-of-process by `manager` (single-host Compose mode).
 */
export class ManagerProjectNotesAdapter implements SyncNamespaceAdapter {
  readonly policy: SyncNamespacePolicy = SYNC_NAMESPACE_POLICIES['project-notes'];
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly manager: Manager) {}

  validateScope(scope: string): void {
    if (!REPO_ID_RE.test(scope)) fail(400, 'sync_invalid_scope');
  }

  async withScopeLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(scope) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(scope, tail);
    void tail.then(() => {
      if (this.locks.get(scope) === tail) this.locks.delete(scope);
    });
    return next;
  }

  private async listTree(scope: string): Promise<any[]> {
    const res = await this.manager.call(
      'GET',
      `/v1/projects/${scope}/file-tree?directory=&query=&include_deleted=1&deleted_only=0&recursive=1`,
    );
    return Array.isArray(res?.files) ? res.files : [];
  }

  async snapshot(scope: string, options?: { paths?: readonly string[] }): Promise<SyncManifestSnapshot> {
    this.validateScope(scope);
    const files = await this.listTree(scope);
    const pathSet = options?.paths?.length ? new Set(options.paths) : null;
    const entries: SyncEntry[] = [];
    for (const file of files) {
      const rel = String(file.path ?? file.name ?? '');
      if (!rel || hasReservedSegment(rel) || (pathSet && !pathSet.has(rel))) continue;
      entries.push({
        path: rel,
        sha256: file.deleted ? null : (file.sha256 ? String(file.sha256) : null),
        revision: Number(file.revision ?? 1),
        size: file.deleted ? 0 : Number(file.bytes ?? 0),
        mode: 0o644,
        deleted: Boolean(file.deleted),
        kind: 'file',
        actor: file.actor ? String(file.actor) : null,
        updated_at: file.created_at ? String(file.created_at) : null,
      });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { revision: entries.reduce((max, item) => Math.max(max, item.revision), 0), entries };
  }

  async readBlob(scope: string, sha256: string, hintPath?: string): Promise<Buffer | null> {
    this.validateScope(scope);
    assertSha256(sha256);
    const files = await this.listTree(scope);
    const candidates = hintPath
      ? files.filter(f => String(f.path ?? '') === hintPath)
      : files.filter(f => String(f.sha256 ?? '') === sha256 && !f.deleted);
    for (const candidate of candidates) {
      let file: any;
      try {
        file = await this.manager.call('GET', `/v1/projects/${scope}/file-tree/${encodeURIComponent(String(candidate.id))}`);
      } catch (error) {
        if (isNotFoundManagerError(error)) continue;
        throw error;
      }
      if (file?.deleted) continue;
      const buf = file?.binary && typeof file.download_base64 === 'string'
        ? Buffer.from(file.download_base64, 'base64')
        : Buffer.from(String(file?.content ?? ''), 'utf8');
      if (createHash('sha256').update(buf).digest('hex') === sha256) return buf;
    }
    return null;
  }

  async versions(scope: string, path: string): Promise<SyncHistoryVersion[]> {
    this.validateScope(scope);
    const files = await this.listTree(scope);
    const found = files.find(f => String(f.path ?? '') === path);
    if (!found?.id) return [];
    let res: any;
    try {
      res = await this.manager.call('GET', `/v1/projects/${scope}/file-tree/${encodeURIComponent(String(found.id))}/versions`);
    } catch (error) {
      if (isNotFoundManagerError(error)) return [];
      throw error;
    }
    const list = Array.isArray(res?.versions) ? res.versions : [];
    return [...list]
      .sort((a: any, b: any) => Number(a.revision) - Number(b.revision))
      .map((v: any) => ({
        revision: Number(v.revision),
        sha256: v.deleted ? null : (v.sha256 ? String(v.sha256) : null),
        deleted: Boolean(v.deleted),
        actor: v.actor ? String(v.actor) : null,
        created_at: v.created_at ? String(v.created_at) : null,
        bytes: Number(v.bytes ?? 0),
        ...(v.binary ? { binary: true } : {}),
      }));
  }

  async readRevision(
    scope: string,
    path: string,
    revision: number,
  ): Promise<{ content: Buffer | null; sha256: string | null; deleted: boolean; binary?: boolean } | null> {
    this.validateScope(scope);
    const files = await this.listTree(scope);
    const found = files.find(f => String(f.path ?? '') === path);
    if (!found?.id) return null;
    try {
      const file = await this.manager.call(
        'GET',
        `/v1/projects/${scope}/file-tree/${encodeURIComponent(String(found.id))}?revision=${revision}`,
      );
      if (file?.deleted) return { content: null, sha256: null, deleted: true };
      if (file?.binary && typeof file.download_base64 === 'string') {
        const buf = Buffer.from(file.download_base64, 'base64');
        return { content: buf, sha256: file.sha256 ? String(file.sha256) : null, deleted: false, binary: true };
      }
      return {
        content: Buffer.from(String(file?.content ?? ''), 'utf8'),
        sha256: file?.sha256 ? String(file.sha256) : null,
        deleted: false,
        binary: false,
      };
    } catch (error) {
      // Only treat explicit 404/not-found as missing revision; let transient 5xx/network/permission errors propagate!
      if (isNotFoundManagerError(error)) return null;
      throw error;
    }
  }

  async applyChange(scope: string, input: SyncAdapterCommitInput): Promise<SyncEntry> {
    this.validateScope(scope);
    const files = await this.listTree(scope);
    const existing = files.find(f => String(f.path ?? '') === input.path);

    try {
      if (input.deleted) {
        if (!existing?.id) fail(404, 'sync_file_not_found');
        const res = await this.manager.call(
          'DELETE',
          `/v1/projects/${scope}/file-tree/${encodeURIComponent(String(existing.id))}`,
          { expected_revision: input.expectedRevision, actor: input.actor },
        );
        return {
          path: input.path,
          sha256: null,
          revision: Number(res.revision),
          size: 0,
          mode: 0o644,
          deleted: true,
          kind: 'file',
          actor: res.actor ?? input.actor,
          updated_at: res.created_at ?? new Date().toISOString(),
        };
      }

      const content = input.content ?? Buffer.alloc(0);
      if (isBinaryBuffer(content)) fail(415, 'sync_unsupported_binary');
      const textContent = content.toString('utf8');

      let saved: any;
      if (existing?.id) {
        saved = await this.manager.call(
          'PUT',
          `/v1/projects/${scope}/file-tree/${encodeURIComponent(String(existing.id))}`,
          { content: textContent, expected_revision: input.expectedRevision, actor: input.actor },
        );
      } else {
        saved = await this.manager.call('POST', `/v1/projects/${scope}/file-tree`, {
          path: input.path,
          content: textContent,
          actor: input.actor,
          create_parents: true,
        });
      }

      return {
        path: input.path,
        sha256: saved.sha256 ? String(saved.sha256) : input.sha256,
        revision: Number(saved.revision),
        size: Number(saved.bytes ?? content.length),
        mode: 0o644,
        deleted: false,
        kind: 'file',
        actor: saved.actor ?? input.actor,
        updated_at: saved.created_at ?? new Date().toISOString(),
      };
    } catch (error) {
      if (isRevisionRaceError(error)) fail(409, 'sync_revision_race');
      throw error;
    }
  }
}

/**
 * `tool-results` namespace adapter (`/results`, immutable read-only).
 * Supports lazy single-file manifest queries via `?paths=...` without scanning unrelated files.
 */
export class ToolResultsSyncAdapter implements SyncNamespaceAdapter {
  readonly policy: SyncNamespacePolicy = SYNC_NAMESPACE_POLICIES['tool-results'];
  private readonly hashCache = new FileHashCache();
  private readonly lastBlobMap = new ScopedBlobPathCache();

  constructor(private readonly store: Store, private readonly rootDir?: string) {}

  validateScope(scope: string): void {
    if (!TOOL_RESULT_OWNER_RE.test(scope)) fail(400, 'sync_invalid_scope');
  }

  private baseRoot(): string {
    return this.rootDir ? resolve(this.rootDir) : resolve(this.store.trajectories.results.root);
  }

  private ownerRoot(scope: string): string {
    return join(this.baseRoot(), scope);
  }

  private activeResultNames(scope: string): Set<string> | null {
    if (!this.store.hasTable('tool_result_files')) return null;
    const rows = this.store.all(
      'SELECT file FROM tool_result_files WHERE owner=? AND expires_at>?',
      scope,
      new Date().toISOString(),
    );
    return new Set(rows.map(row => `${String(row.file)}.utf8`));
  }

  async snapshot(scope: string, options?: { paths?: readonly string[] }): Promise<SyncManifestSnapshot> {
    this.validateScope(scope);
    const activeInDb = this.activeResultNames(scope);
    const expectsFiles = Boolean((activeInDb && activeInDb.size > 0) || hasPersistedSyncScope(this.store, 'tool-results', scope));
    const rootState = await checkDirectoryReadable(this.baseRoot());
    if (rootState === 'missing') {
      if (expectsFiles) return fail(503, 'sync_scope_unavailable');
      return { revision: 0, entries: [] };
    }

    const ownerDir = this.ownerRoot(scope);
    const ownerState = await checkDirectoryReadable(ownerDir);
    if (ownerState === 'missing') {
      if (activeInDb && activeInDb.size > 0) return fail(503, 'sync_scope_unavailable');
      return { revision: 0, entries: [] };
    }
    const canonicalOwner = await realpath(ownerDir);
    const entries: SyncEntry[] = [];

    const candidates: string[] = [];
    if (options?.paths?.length) {
      for (const p of options.paths) {
        const clean = normalizeSyncPath(p);
        if (TOOL_RESULT_FILE_RE.test(clean)) candidates.push(clean);
      }
    } else {
      let dirents;
      try {
        dirents = await readdir(canonicalOwner, { withFileTypes: true });
      } catch (error) {
        if (isUnavailableFsError(error)) fail(503, 'sync_scope_unavailable');
        throw error;
      }
      for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
        if (dirent.isFile() && TOOL_RESULT_FILE_RE.test(dirent.name)) candidates.push(dirent.name);
      }
    }

    for (const name of candidates) {
      if (activeInDb && activeInDb.size > 0 && !activeInDb.has(name)) {
        const row = this.store.get('SELECT expires_at FROM tool_result_files WHERE owner=? AND file=?', scope, name.slice(0, -5));
        if (row && String(row.expires_at) <= new Date().toISOString()) continue;
      }
      const full = join(canonicalOwner, name);
      const info = await lstat(full).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isFile()) continue;
      const sha256 = await this.hashCache.hashFile(full, info.size, info.mtimeMs);
      this.lastBlobMap.set(scope, sha256, full);
      entries.push({
        path: name,
        sha256,
        revision: 1,
        size: info.size,
        mode: 0o444,
        deleted: false,
        kind: 'file',
        updated_at: new Date(info.mtimeMs).toISOString(),
      });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { revision: entries.length ? 1 : 0, entries };
  }

  async readBlob(scope: string, sha256: string, hintPath?: string): Promise<Buffer | null> {
    this.validateScope(scope);
    assertSha256(sha256);
    const ownerDir = this.ownerRoot(scope);
    if (hintPath && TOOL_RESULT_FILE_RE.test(hintPath)) {
      const data = await readRegularFileAnchored(ownerDir, hintPath);
      if (data && createHash('sha256').update(data).digest('hex') === sha256) return data;
    }
    let full = this.lastBlobMap.get(scope, sha256);
    if (!full) {
      await this.snapshot(scope);
      full = this.lastBlobMap.get(scope, sha256);
    }
    if (!full) return null;
    const rel = posix.basename(full);
    const data = await readRegularFileAnchored(ownerDir, rel);
    if (!data || createHash('sha256').update(data).digest('hex') !== sha256) return null;
    return data;
  }
}

/**
 * `project-tools` namespace adapter (`/opt/project-tools`, versioned read-only).
 * Directly reuses `project_tool_revisions.manifest` and per-file `sha256` digests.
 */
export class ProjectToolsSyncAdapter implements SyncNamespaceAdapter {
  readonly policy: SyncNamespacePolicy = SYNC_NAMESPACE_POLICIES['project-tools'];

  constructor(private readonly store: Store, private readonly projectTools?: ProjectToolsService, private readonly rootDir?: string) {}

  private parseScope(scope: string): { repositoryId: string; pinnedRevision: number | null } {
    const match = PROJECT_TOOLS_SCOPE_RE.exec(scope);
    if (!match) return fail(400, 'sync_invalid_scope');
    return {
      repositoryId: match[1]!,
      pinnedRevision: match[2] ? Number(match[2]) : null,
    };
  }

  validateScope(scope: string): void {
    this.parseScope(scope);
  }

  private resolveRoot(): string | null {
    if (this.rootDir) return resolve(this.rootDir);
    if (this.projectTools?.root) return this.projectTools.root;
    const fromEnv = process.env.BOT_PROJECT_TOOLS_DIR?.trim();
    return fromEnv ? resolve(fromEnv) : null;
  }

  private resolveRevisionRow(scope: string): { repositoryId: string; revision: number; files: StagedToolEntry[]; createdAt: string | null } | null {
    const { repositoryId, pinnedRevision } = this.parseScope(scope);
    if (!this.store.hasTable('project_tool_state') || !this.store.hasTable('project_tool_revisions')) return null;
    let revision = pinnedRevision;
    if (revision === null) {
      const state = this.store.get('SELECT active_revision FROM project_tool_state WHERE repository_id=?', repositoryId);
      if (!Number.isSafeInteger(state?.active_revision) || Number(state!.active_revision) < 1) return null;
      revision = Number(state!.active_revision);
    }
    const row = this.store.get(
      "SELECT revision,manifest,created_at FROM project_tool_revisions WHERE repository_id=? AND revision=? AND status IN ('active','retained')",
      repositoryId,
      revision,
    );
    if (!row) return null;
    let files: StagedToolEntry[] = [];
    try {
      const parsed = JSON.parse(String(row.manifest));
      if (Array.isArray(parsed)) files = parsed;
    } catch {
      files = [];
    }
    return { repositoryId, revision: Number(row.revision), files, createdAt: row.created_at ? String(row.created_at) : null };
  }

  async snapshot(scope: string, options?: { paths?: readonly string[] }): Promise<SyncManifestSnapshot> {
    this.validateScope(scope);
    const root = this.resolveRoot();
    if (root) {
      const rootState = await checkDirectoryReadable(root);
      if (rootState === 'missing') fail(503, 'sync_scope_unavailable');
    }
    const resolved = this.resolveRevisionRow(scope);
    if (!resolved) return { revision: 0, entries: [] };
    if (!root) return fail(503, 'sync_scope_unavailable');
    const revDir = join(root, resolved.repositoryId, `rev-${resolved.revision}`);
    if ((await checkDirectoryReadable(revDir)) === 'missing') {
      fail(503, 'sync_scope_unavailable');
    }
    const pathSet = options?.paths?.length ? new Set(options.paths) : null;
    const entries: SyncEntry[] = [];
    for (const item of resolved.files) {
      if (pathSet && !pathSet.has(item.path)) continue;
      if (item.type === 'symlink' && item.target) {
        try {
          const safePath = normalizeSyncPath(item.path, { rejectSensitivePaths: true });
          validateInternalSymlinkTarget(safePath, item.target);
          entries.push({
            path: safePath,
            sha256: null,
            revision: resolved.revision,
            size: 0,
            mode: 0o120777,
            deleted: false,
            kind: 'symlink',
            link_target: item.target,
            updated_at: resolved.createdAt,
          });
        } catch {
          continue;
        }
      } else if (item.type === 'file' && item.sha256) {
        entries.push({
          path: normalizeSyncPath(item.path, { rejectSensitivePaths: true }),
          sha256: assertSha256(item.sha256),
          revision: resolved.revision,
          size: Number(item.size ?? 0),
          mode: item.executable ? 0o755 : 0o644,
          deleted: false,
          kind: 'file',
          updated_at: resolved.createdAt,
        });
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { revision: resolved.revision, entries };
  }

  async readBlob(scope: string, sha256: string, hintPath?: string): Promise<Buffer | null> {
    this.validateScope(scope);
    assertSha256(sha256);
    const root = this.resolveRoot();
    if (!root) return null;
    const resolved = this.resolveRevisionRow(scope);
    if (!resolved) return null;
    const revDir = join(root, resolved.repositoryId, `rev-${resolved.revision}`);
    const candidates = hintPath
      ? resolved.files.filter(f => f.type === 'file' && f.path === hintPath && f.sha256 === sha256)
      : resolved.files.filter(f => f.type === 'file' && f.sha256 === sha256);
    for (const item of candidates) {
      const data = await readRegularFileAnchored(revDir, item.path);
      if (data && createHash('sha256').update(data).digest('hex') === sha256) return data;
    }
    return null;
  }
}

/**
 * `agent-tools` namespace adapter (`/opt/agent-tools`, versioned read-only scoped by `os/arch`).
 * Exposes installed CLI, Node, UV, and ACP runtime directories matching the requested architecture.
 */
export class AgentToolsSyncAdapter implements SyncNamespaceAdapter {
  readonly policy: SyncNamespacePolicy = SYNC_NAMESPACE_POLICIES['agent-tools'];
  private readonly hashCache = new FileHashCache();
  private readonly lastBlobMap = new ScopedBlobPathCache();

  constructor(private readonly rootDir?: string, private readonly store?: Store) {}

  private parseScope(scope: string): { arch: 'x64' | 'arm64'; product?: string; version?: string } {
    const match = AGENT_TOOLS_SCOPE_RE.exec(scope);
    if (!match) return fail(400, 'sync_invalid_scope');
    if (scope === 'default') {
      return { arch: resolveSupportedArch() ?? 'x64' };
    }
    return {
      arch: match[1] as 'x64' | 'arm64',
      product: match[2],
      version: match[3],
    };
  }

  validateScope(scope: string): void {
    this.parseScope(scope);
  }

  private resolveRoot(): string {
    return resolve(this.rootDir || process.env.BOT_AGENT_TOOLS_DIR || DEFAULT_AGENT_TOOLS_ROOT);
  }

  private async readJsonSafe(filePath: string): Promise<Record<string, any> | null> {
    try {
      const info = await lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 128 * 1024) return null;
      const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const raw = await handle.readFile('utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  async snapshot(scope: string, options?: { paths?: readonly string[] }): Promise<SyncManifestSnapshot> {
    const { arch, product, version } = this.parseScope(scope);
    const root = this.resolveRoot();
    if ((await checkDirectoryReadable(root)) === 'missing') {
      fail(503, 'sync_scope_unavailable');
    }
    const canonicalRoot = await realpath(root);
    const subtrees = new Set<string>();

    const collectVersionDirs = async (category: string) => {
      const catDir = join(canonicalRoot, category);
      if (!(await isRealDirectory(catDir))) return;
      for (const dirent of (await readdir(catDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!dirent.isDirectory() || dirent.isSymbolicLink() || dirent.name.startsWith('.')) continue;
        const manifest = await this.readJsonSafe(join(catDir, dirent.name, 'manifest.json'));
        if (!manifest) continue;
        if (manifest.arch && manifest.arch !== arch) continue;
        subtrees.add(`${category}/${dirent.name}`);
      }
    };

    if (product && version) {
      const cliDir = join(canonicalRoot, product, version);
      const acpDir = join(canonicalRoot, 'acp', product, version);
      if (await isRealDirectory(cliDir)) {
        const manifest = await this.readJsonSafe(join(cliDir, 'manifest.json'));
        if (!manifest?.arch || manifest.arch === arch) {
          subtrees.add(`${product}/${version}`);
          if (typeof manifest?.node_version === 'string' && manifest.node_version) {
            const nodeDir = join(canonicalRoot, 'node', manifest.node_version);
            if (await isRealDirectory(nodeDir)) subtrees.add(`node/${manifest.node_version}`);
          }
        }
      } else if (await isRealDirectory(acpDir)) {
        const manifest = await this.readJsonSafe(join(acpDir, 'manifest.json'));
        if (!manifest?.arch || manifest.arch === arch) {
          subtrees.add(`acp/${product}/${version}`);
        }
      } else if (this.store && hasPersistedSyncScope(this.store, 'agent-tools', scope)) {
        fail(503, 'sync_scope_unavailable');
      }
    } else {
      for (const category of ['claude_code', 'codex', 'node', 'uv']) {
        await collectVersionDirs(category);
      }
      const acpRoot = join(canonicalRoot, 'acp');
      if (await isRealDirectory(acpRoot)) {
        for (const prodDirent of (await readdir(acpRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!prodDirent.isDirectory() || prodDirent.isSymbolicLink() || prodDirent.name.startsWith('.')) continue;
          const prodDir = join(acpRoot, prodDirent.name);
          for (const verDirent of (await readdir(prodDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!verDirent.isDirectory() || verDirent.isSymbolicLink() || verDirent.name.startsWith('.')) continue;
            const manifest = await this.readJsonSafe(join(prodDir, verDirent.name, 'manifest.json'));
            if (manifest?.arch && manifest.arch !== arch) continue;
            subtrees.add(`acp/${prodDirent.name}/${verDirent.name}`);
          }
        }
      }
    }

    const pathFilter = options?.paths?.length ? new Set(options.paths) : undefined;
    const allEntries: SyncEntry[] = [];
    const blobEntries: [string, string][] = [];

    for (const relSubtree of [...subtrees].sort()) {
      const fullSubtree = join(canonicalRoot, relSubtree);
      const walked = await walkReadOnlyTree(fullSubtree, {
        allowInternalSymlinks: true,
        rejectSensitivePaths: false,
        hashCache: this.hashCache,
        prefixRel: relSubtree,
        pathFilter,
        skipName: name => name.startsWith('.tmp-') || name === '.staging',
      });
      allEntries.push(...walked.entries);
      for (const pair of walked.hashToPath) blobEntries.push(pair);
    }

    allEntries.sort((a, b) => a.path.localeCompare(b.path));
    this.lastBlobMap.replaceScope(scope, blobEntries);
    return { revision: allEntries.length ? 1 : 0, entries: allEntries };
  }

  async readBlob(scope: string, sha256: string, hintPath?: string): Promise<Buffer | null> {
    this.validateScope(scope);
    assertSha256(sha256);
    const root = this.resolveRoot();
    if (hintPath) {
      const data = await readRegularFileAnchored(root, hintPath);
      if (data && createHash('sha256').update(data).digest('hex') === sha256) return data;
    }
    let full = this.lastBlobMap.get(scope, sha256);
    if (!full) {
      await this.snapshot(scope);
      full = this.lastBlobMap.get(scope, sha256);
    }
    if (!full) return null;
    const canonicalRoot = await realpath(root).catch(() => null);
    if (!canonicalRoot || !isSubpathStrict(canonicalRoot, full)) return null;
    const rel = full.slice(canonicalRoot.length + 1).split(sep).join('/');
    const data = await readRegularFileAnchored(canonicalRoot, rel);
    if (!data || createHash('sha256').update(data).digest('hex') !== sha256) return null;
    return data;
  }
}

/**
 * `skill-store` namespace adapter (`/opt/bot-skills`, #1359 content-addressed read-only).
 * Supports both full scope sync (`projects/<repoId>`, `service`) and pinned `sets/<hash>` sync.
 */
export class SkillStoreSyncAdapter implements SyncNamespaceAdapter {
  readonly policy: SyncNamespacePolicy = SYNC_NAMESPACE_POLICIES['skill-store'];
  private readonly hashCache = new FileHashCache();
  private readonly lastBlobMap = new ScopedBlobPathCache();

  constructor(private readonly store: Store, private readonly rootDir?: string) {}

  validateScope(scope: string): void {
    if (!SKILL_SCOPE_RE.test(scope)) fail(400, 'sync_invalid_scope');
  }

  private resolveRoot(): string | null {
    return resolveSkillStoreRoot(this.store, this.rootDir);
  }

  private resolveScopeDir(scope: string): string | null {
    const root = this.resolveRoot();
    if (!root) return null;
    return join(root, ...scope.split('/'));
  }

  async snapshot(scope: string, options?: { paths?: readonly string[] }): Promise<SyncManifestSnapshot> {
    this.validateScope(scope);
    const root = this.resolveRoot();
    if (!root) return fail(503, 'sync_scope_unavailable');
    const expectsDir = scope.includes('/sets/') || hasPersistedSyncScope(this.store, 'skill-store', scope);
    if ((await checkDirectoryReadable(root)) === 'missing') {
      if (expectsDir) return fail(503, 'sync_scope_unavailable');
      return { revision: 0, entries: [] };
    }
    const dir = join(root, ...scope.split('/'));
    const state = await checkDirectoryReadable(dir);
    if (state === 'missing') {
      if (expectsDir) {
        return fail(503, 'sync_scope_unavailable');
      }
      return { revision: 0, entries: [] };
    }
    const pathFilter = options?.paths?.length ? new Set(options.paths) : undefined;
    const walked = await walkReadOnlyTree(dir, {
      allowInternalSymlinks: false,
      rejectSensitivePaths: true,
      hashCache: this.hashCache,
      pathFilter,
      skipName: name => name.startsWith('.tmp-'),
    });
    this.lastBlobMap.replaceScope(scope, walked.hashToPath);
    return { revision: walked.entries.length ? 1 : 0, entries: walked.entries };
  }

  async readBlob(scope: string, sha256: string, hintPath?: string): Promise<Buffer | null> {
    this.validateScope(scope);
    assertSha256(sha256);
    const dir = this.resolveScopeDir(scope);
    if (!dir) return null;
    if (hintPath) {
      const data = await readRegularFileAnchored(dir, hintPath);
      if (data && createHash('sha256').update(data).digest('hex') === sha256) return data;
    }
    let full = this.lastBlobMap.get(scope, sha256);
    if (!full) {
      await this.snapshot(scope);
      full = this.lastBlobMap.get(scope, sha256);
    }
    if (!full) return null;
    const canonicalDir = await realpath(dir).catch(() => null);
    if (!canonicalDir || !isSubpathStrict(canonicalDir, full)) return null;
    const rel = full.slice(canonicalDir.length + 1).split(sep).join('/');
    const data = await readRegularFileAnchored(canonicalDir, rel);
    if (!data || createHash('sha256').update(data).digest('hex') !== sha256) return null;
    return data;
  }
}

export function createProjectNotesDirectoryAdapter(
  projectNotesRoot: string,
  store?: Store,
  policyOverride?: SyncNamespacePolicy,
): VersionedDirectoryAdapter {
  const base = resolve(projectNotesRoot);
  return new VersionedDirectoryAdapter(
    policyOverride ?? SYNC_NAMESPACE_POLICIES['project-notes'],
    scope => {
      if (!REPO_ID_RE.test(scope)) fail(400, 'sync_invalid_scope');
    },
    async (scope, { create }) => {
      // Fail closed if the backing project-notes volume root itself is unmounted or unreadable.
      const baseState = await checkDirectoryReadable(base);
      if (baseState === 'missing') fail(503, 'sync_scope_unavailable');

      const dir = join(base, scope);
      const dirState = await checkDirectoryReadable(dir);
      if (dirState === 'missing') {
        if (!create) {
          // A previously synced scope whose directory vanished must fail closed instead of emitting an empty manifest!
          if (store && hasPersistedSyncScope(store, 'project-notes', scope)) {
            fail(503, 'sync_scope_unavailable');
          }
          return null;
        }
      }
      return dir;
    },
  );
}

export function createAssistantHomesAdapter(
  assistantHomes: AssistantHomes | undefined,
  explicitRoot?: string,
  store?: Store,
  policyOverride?: SyncNamespacePolicy,
): VersionedDirectoryAdapter {
  const effectiveStore = store ?? assistantHomes?.store;
  return new VersionedDirectoryAdapter(
    policyOverride ?? SYNC_NAMESPACE_POLICIES['assistant-homes'],
    scope => {
      if (!ASSISTANT_SCOPE_RE.test(scope)) fail(400, 'sync_invalid_scope');
    },
    async (scope, { create }) => {
      const match = ASSISTANT_SCOPE_RE.exec(scope);
      if (!match) return fail(400, 'sync_invalid_scope');
      const owner = match[1]!;
      let generation = match[2] ? Number(match[2]) : null;
      const root = explicitRoot ? resolve(explicitRoot) : assistantHomes?.root ? resolve(assistantHomes.root) : null;
      if (!root) return fail(503, 'sync_scope_unavailable');
      if ((await checkDirectoryReadable(root)) === 'missing') {
        return fail(503, 'sync_scope_unavailable');
      }

      const row = assistantHomes?.row(owner);
      if (generation === null) {
        if (row && Number.isSafeInteger(row.generation)) {
          generation = Number(row.generation);
        } else {
          generation = 1;
        }
      }
      const homeDir = join(root, owner, `home-${generation}`);
      const memoryDir = join(homeDir, 'memory');

      if (!create) {
        const homeState = await checkDirectoryReadable(homeDir);
        if (homeState === 'missing') {
          if (row || (effectiveStore && hasPersistedSyncScope(effectiveStore, 'assistant-homes', scope))) {
            fail(503, 'sync_scope_unavailable');
          }
          return null;
        }
        const memState = await checkDirectoryReadable(memoryDir);
        if (memState === 'missing') {
          if (effectiveStore && hasPersistedSyncScope(effectiveStore, 'assistant-homes', scope)) {
            fail(503, 'sync_scope_unavailable');
          }
          return null;
        }
        return memoryDir;
      }

      if (!existsSync(memoryDir)) {
        try {
          await mkdir(join(root, owner), { recursive: true, mode: 0o750 });
          await mkdir(homeDir, { recursive: true, mode: 0o700 });
          await mkdir(memoryDir, { recursive: true, mode: 0o700 });
        } catch (error) {
          if (isUnavailableFsError(error)) fail(503, 'sync_scope_unavailable');
          throw error;
        }
      }
      return memoryDir;
    },
  );
}
