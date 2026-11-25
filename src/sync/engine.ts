import type { Store } from '../storage/database.js';
import { configuredRedactor, publicText } from '../core/redaction.js';
import { fail, HttpError } from '../core/security.js';
import { sha256Buffer } from './blob-store.js';
import { isBinaryBuffer, merge3WayBuffers } from './merge3.js';
import { getSyncNamespacePolicy } from './namespaces.js';
import {
  assertSha256,
  buildConflictCopyPath,
  normalizeSyncPath,
  sanitizeActorTag,
} from './paths.js';
import {
  hasSyncBlobRef,
  listScopeEntriesSince,
  listSyncConflicts,
  reconcileScopeManifestDelta,
  recordSyncConflict,
  registerSyncBlobRef,
  removeStagedSyncBlobRef,
  syncStorage,
  touchSyncBlobRef,
} from './storage.js';
import type {
  BlobStore,
  SyncBlobFetchResponse,
  SyncBlobPutInput,
  SyncBlobPutItemResult,
  SyncBlobPutResponse,
  SyncCommitChange,
  SyncCommitItemResult,
  SyncCommitRequest,
  SyncCommitResponse,
  SyncConflictDetail,
  SyncConflictRecord,
  SyncEntry,
  SyncHistoryVersion,
  SyncManifestResponse,
  SyncNamespaceAdapter,
  SyncNamespaceName,
  SyncNamespacePolicy,
} from './types.js';

const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const MAX_COMMIT_RACE_ATTEMPTS = 3;

function isHumanActor(actor: string | null | undefined): boolean {
  if (!actor) return false;
  return actor === 'console' || actor.startsWith('user:');
}

export interface FileSyncEngineOptions {
  store: Store;
  blobStore: BlobStore;
  adapters?: Iterable<SyncNamespaceAdapter>;
  clock?: () => number;
}

/**
 * Single reusable file sync & conflict resolution engine (`FileSyncEngine`).
 *
 * All 6 platform directory namespaces (`tool-results`, `project-tools`, `agent-tools`,
 * `skill-store`, `project-notes`, `assistant-homes`) run through this single engine
 * via declarative `SyncNamespacePolicy` and thin `SyncNamespaceAdapter` bindings.
 */
export class FileSyncEngine {
  readonly store: Store;
  readonly blobStore: BlobStore;
  private readonly adapters = new Map<SyncNamespaceName, SyncNamespaceAdapter>();
  private readonly clock: () => number;

  constructor(options: FileSyncEngineOptions) {
    this.store = options.store;
    this.blobStore = options.blobStore;
    this.clock = options.clock ?? (() => Date.now());
    syncStorage(this.store);
    if (options.adapters) {
      for (const adapter of options.adapters) {
        this.register(adapter);
      }
    }
  }

  register(adapter: SyncNamespaceAdapter): void {
    this.adapters.set(adapter.policy.name, adapter);
  }

  hasAdapter(namespace: SyncNamespaceName): boolean {
    return this.adapters.has(namespace);
  }

  policy(namespace: SyncNamespaceName): SyncNamespacePolicy {
    return this.adapters.get(namespace)?.policy ?? getSyncNamespacePolicy(namespace);
  }

  private requireAdapter(namespace: unknown): SyncNamespaceAdapter {
    const policy = getSyncNamespacePolicy(namespace);
    const adapter = this.adapters.get(policy.name);
    if (!adapter) return fail(503, 'sync_namespace_unavailable');
    return adapter;
  }

  private sanitizeAndCheckContent(
    policy: SyncNamespacePolicy,
    raw: Buffer,
  ): { bytes: Buffer; sha256: string; redacted: boolean } {
    if (raw.length > policy.maxFileBytes) fail(413, 'sync_file_too_large');
    if (!policy.redact) {
      return { bytes: raw, sha256: sha256Buffer(raw), redacted: false };
    }
    const redactor = configuredRedactor(this.store);
    if (isBinaryBuffer(raw)) {
      const latin1 = raw.toString('latin1');
      const hasRegistered = [...redactor.values].some(secret => raw.includes(Buffer.from(secret, 'utf8')));
      if (hasRegistered || PEM_PRIVATE_KEY_RE.test(latin1)) {
        fail(400, 'sync_secret_detected', undefined, { reason: 'binary_secret_or_private_key' });
      }
      return { bytes: raw, sha256: sha256Buffer(raw), redacted: false };
    }

    const originalText = raw.toString('utf8');
    const cleaned = publicText(redactor.text(originalText), redactor);
    if (cleaned !== originalText) {
      if (policy.redactionPolicy === 'reject') {
        fail(400, 'sync_secret_detected', undefined, { reason: 'registered_secret_or_token_pattern' });
      }
      const nextBytes = Buffer.from(cleaned, 'utf8');
      return { bytes: nextBytes, sha256: sha256Buffer(nextBytes), redacted: true };
    }
    return { bytes: raw, sha256: sha256Buffer(raw), redacted: false };
  }

  private async putScopedBlob(
    namespace: SyncNamespaceName,
    scope: string,
    bytes: Buffer,
    sha256: string,
    staged: boolean,
  ): Promise<{ sha256: string; size: number; deduplicated: boolean }> {
    // Register scope ref BEFORE writing blob so concurrent GC sweeps never race with an in-flight write.
    registerSyncBlobRef(this.store, namespace, scope, sha256, bytes.length, staged, this.clock());
    try {
      return await this.blobStore.put(bytes, sha256);
    } catch (error) {
      if (staged) removeStagedSyncBlobRef(this.store, namespace, scope, sha256);
      throw error;
    }
  }

  async manifest(
    namespace: SyncNamespaceName,
    scope: string,
    options: { sinceRev?: number; paths?: readonly string[]; includeDeleted?: boolean } = {},
  ): Promise<SyncManifestResponse> {
    const adapter = this.requireAdapter(namespace);
    adapter.validateScope(scope);
    const sinceRev = options.sinceRev ?? 0;
    if (!Number.isSafeInteger(sinceRev) || sinceRev < 0) fail(400, 'sync_invalid_revision');

    const normalizedPaths = options.paths?.length
      ? options.paths.map(p => normalizeSyncPath(p, { rejectSensitivePaths: false }))
      : undefined;

    const snap = await adapter.snapshot(scope, normalizedPaths ? { paths: normalizedPaths } : undefined);
    const limits = {
      max_file_bytes: adapter.policy.maxFileBytes,
      max_batch_blobs: adapter.policy.maxBatchBlobs,
      max_batch_bytes: adapter.policy.maxBatchBytes,
    };

    // Lazy filtered single-path requests (e.g. tool-results) return exact matched entries directly without mutating full-scope delta state.
    if (normalizedPaths) {
      return {
        namespace: adapter.policy.name,
        scope,
        mode: adapter.policy.mode,
        immutable: adapter.policy.immutable,
        allow_internal_symlinks: adapter.policy.allowInternalSymlinks,
        limits,
        revision: snap.revision,
        since_rev: sinceRev,
        full: false,
        entries: snap.entries,
      };
    }

    const forcedRevision = adapter.policy.name === 'project-tools' ? snap.revision : undefined;
    const delta = reconcileScopeManifestDelta(this.store, adapter.policy.name, scope, snap.entries, forcedRevision);
    const currentRevision = delta.revision;

    if (sinceRev === 0 || sinceRev > currentRevision) {
      const entries = options.includeDeleted ? snap.entries : snap.entries.filter(e => !e.deleted);
      return {
        namespace: adapter.policy.name,
        scope,
        mode: adapter.policy.mode,
        immutable: adapter.policy.immutable,
        allow_internal_symlinks: adapter.policy.allowInternalSymlinks,
        limits,
        revision: currentRevision,
        since_rev: sinceRev,
        full: true,
        entries,
      };
    }

    if (sinceRev === currentRevision) {
      return {
        namespace: adapter.policy.name,
        scope,
        mode: adapter.policy.mode,
        immutable: adapter.policy.immutable,
        allow_internal_symlinks: adapter.policy.allowInternalSymlinks,
        limits,
        revision: currentRevision,
        since_rev: sinceRev,
        full: false,
        entries: [],
      };
    }

    const changed = listScopeEntriesSince(this.store, adapter.policy.name, scope, sinceRev);
    const byPath = new Map(snap.entries.map(e => [e.path, e]));
    const entries: SyncEntry[] = [];
    for (const [path, meta] of changed) {
      const current = byPath.get(path);
      if (current) {
        entries.push(current);
      } else if (meta.removed) {
        entries.push({
          path,
          sha256: null,
          revision: meta.scope_rev,
          size: 0,
          mode: 0o644,
          deleted: true,
          kind: 'file',
        });
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return {
      namespace: adapter.policy.name,
      scope,
      mode: adapter.policy.mode,
      immutable: adapter.policy.immutable,
      allow_internal_symlinks: adapter.policy.allowInternalSymlinks,
      limits,
      revision: currentRevision,
      since_rev: sinceRev,
      full: false,
      entries,
    };
  }

  async getBlob(
    namespace: SyncNamespaceName,
    scope: string,
    sha256: string,
    hintPath?: string,
  ): Promise<Buffer | null> {
    const adapter = this.requireAdapter(namespace);
    adapter.validateScope(scope);
    const cleanHash = assertSha256(sha256);

    // Ensure the requested hash is actually reachable in this scope (prevents cross-scope CAS oracle leaks!).
    const snap = await adapter.snapshot(scope, hintPath ? { paths: [normalizeSyncPath(hintPath)] } : undefined);
    const matchingEntry = snap.entries.find(e => !e.deleted && e.sha256 === cleanHash);
    if (!matchingEntry) {
      // For rw history namespaces, also allow blobs belonging to this scope's `.write-history` directly from adapter.
      if (adapter.policy.history) {
        const fromHistory = await adapter.readBlob(scope, cleanHash, hintPath);
        if (fromHistory && sha256Buffer(fromHistory) === cleanHash) return fromHistory;
      }
      return null;
    }

    const cached = await this.blobStore.get(cleanHash);
    if (cached) {
      touchSyncBlobRef(this.store, adapter.policy.name, scope, cleanHash, this.clock());
      return cached;
    }

    const fromAdapter = await adapter.readBlob(scope, cleanHash, matchingEntry.path);
    if (!fromAdapter) return null;
    if (sha256Buffer(fromAdapter) !== cleanHash) fail(409, 'sync_blob_corrupt');
    await this.putScopedBlob(adapter.policy.name, scope, fromAdapter, cleanHash, false);
    return fromAdapter;
  }

  async fetchBlobs(
    namespace: SyncNamespaceName,
    scope: string,
    hashes: readonly string[],
  ): Promise<SyncBlobFetchResponse> {
    const adapter = this.requireAdapter(namespace);
    adapter.validateScope(scope);
    if (!Array.isArray(hashes) || hashes.length > adapter.policy.maxBatchBlobs) {
      fail(400, 'sync_batch_too_large');
    }

    const unique = [...new Set(hashes.map(h => assertSha256(h)))];
    if (!unique.length) return { blobs: [], missing: [] };

    // Index current scope entries once so batch fetches never re-walk per hash and strictly enforce scope isolation.
    const snap = await adapter.snapshot(scope);
    const allowedByHash = new Map<string, SyncEntry>();
    for (const entry of snap.entries) {
      if (!entry.deleted && entry.sha256 && !allowedByHash.has(entry.sha256)) {
        allowedByHash.set(entry.sha256, entry);
      }
    }

    const blobs: SyncBlobFetchResponse['blobs'] = [];
    const missing: string[] = [];
    let totalBytes = 0;

    for (const hash of unique) {
      const entry = allowedByHash.get(hash);
      let data: Buffer | null = null;
      if (entry) {
        data = await this.blobStore.get(hash);
        if (data) {
          touchSyncBlobRef(this.store, adapter.policy.name, scope, hash, this.clock());
        } else {
          data = await adapter.readBlob(scope, hash, entry.path);
          if (data) {
            if (sha256Buffer(data) !== hash) fail(409, 'sync_blob_corrupt');
            await this.putScopedBlob(adapter.policy.name, scope, data, hash, false);
          }
        }
      } else if (adapter.policy.history) {
        const hist = await adapter.readBlob(scope, hash);
        if (hist && sha256Buffer(hist) === hash) data = hist;
      }

      if (!data) {
        missing.push(hash);
        continue;
      }
      totalBytes += data.length;
      if (totalBytes > adapter.policy.maxBatchBytes) fail(413, 'sync_batch_too_large');
      blobs.push({
        sha256: hash,
        size: data.length,
        content_base64: data.toString('base64'),
      });
    }

    return { blobs, missing };
  }

  async putBlobs(
    namespace: SyncNamespaceName,
    scope: string,
    items: readonly SyncBlobPutInput[],
  ): Promise<SyncBlobPutResponse> {
    const adapter = this.requireAdapter(namespace);
    adapter.validateScope(scope);
    if (adapter.policy.mode !== 'rw') fail(403, 'sync_namespace_readonly');
    if (!Array.isArray(items) || items.length > adapter.policy.maxBatchBlobs) {
      fail(400, 'sync_batch_too_large');
    }

    const stored: SyncBlobPutItemResult[] = [];
    let totalBytes = 0;

    for (const item of items) {
      const claimedSha = assertSha256(item?.sha256);
      if (typeof item?.content_base64 !== 'string') fail(400, 'sync_invalid_blob');
      const raw = Buffer.from(item.content_base64, 'base64');
      totalBytes += raw.length;
      if (totalBytes > adapter.policy.maxBatchBytes) fail(413, 'sync_batch_too_large');
      const actualRawSha = sha256Buffer(raw);
      if (actualRawSha !== claimedSha) fail(400, 'sync_blob_hash_mismatch');

      const sanitized = this.sanitizeAndCheckContent(adapter.policy, raw);
      const putResult = await this.putScopedBlob(
        adapter.policy.name,
        scope,
        sanitized.bytes,
        sanitized.sha256,
        true,
      );
      stored.push({
        sha256: putResult.sha256,
        original_sha256: claimedSha,
        size: putResult.size,
        redacted: sanitized.redacted,
        deduplicated: putResult.deduplicated,
        ...(sanitized.redacted ? { content_base64: sanitized.bytes.toString('base64') } : {}),
      });
    }

    return { stored };
  }

  async commit(
    namespace: SyncNamespaceName,
    scope: string,
    request: SyncCommitRequest,
  ): Promise<SyncCommitResponse> {
    const adapter = this.requireAdapter(namespace);
    adapter.validateScope(scope);
    if (adapter.policy.mode !== 'rw' || !adapter.applyChange) {
      fail(403, 'sync_namespace_readonly');
    }
    if (request.mode !== 'interactive' && request.mode !== 'background') {
      fail(400, 'sync_invalid_mode');
    }
    const actor = String(request.actor || '').trim();
    if (!actor || actor.length > 200 || /[\x00-\x1f\x7f]/.test(actor)) {
      fail(400, 'sync_invalid_actor');
    }
    if (!Array.isArray(request.changes) || request.changes.length === 0 || request.changes.length > adapter.policy.maxBatchBlobs) {
      fail(400, 'sync_invalid_changes');
    }

    const actorTag = sanitizeActorTag(request.actor_tag ?? actor);
    const seenPaths = new Set<string>();
    for (const change of request.changes) {
      const normalized = normalizeSyncPath(change.path, {
        rejectSensitivePaths: adapter.policy.rejectSensitivePaths,
      });
      if (seenPaths.has(normalized)) fail(400, 'sync_duplicate_path');
      seenPaths.add(normalized);
      if (!Number.isSafeInteger(change.base_revision) || change.base_revision < 0) {
        fail(400, 'sync_invalid_revision');
      }
      if (change.base_sha256 !== undefined && change.base_sha256 !== null) {
        assertSha256(change.base_sha256);
      }
      if (!change.deleted) {
        assertSha256(change.content_sha256);
      }
    }

    const runLocked = async (): Promise<SyncCommitResponse> => {
      const snap = await adapter.snapshot(scope);
      const currentByPath = new Map(snap.entries.map(e => [e.path, e]));
      const existingPaths = new Set(snap.entries.filter(e => !e.deleted).map(e => e.path));

      const results: SyncCommitItemResult[] = [];
      const conflicts: SyncConflictDetail[] = [];

      for (const rawChange of request.changes) {
        const result = await this.commitSingleFile(
          adapter,
          scope,
          rawChange,
          currentByPath,
          existingPaths,
          {
            mode: request.mode,
            actor,
            actorTag,
            skipIfHumanEdited: Boolean(request.skip_if_human_edited),
          },
        );
        results.push(result);
        if (result.conflict) conflicts.push(result.conflict);
      }

      const afterSnap = await adapter.snapshot(scope);
      const delta = reconcileScopeManifestDelta(this.store, adapter.policy.name, scope, afterSnap.entries);

      if (conflicts.length > 0) {
        return {
          ok: false,
          error: 'sync_conflict',
          revision: delta.revision,
          results,
          conflicts,
        };
      }
      return {
        ok: true,
        revision: delta.revision,
        results,
        conflicts: [],
      };
    };

    return adapter.withScopeLock ? adapter.withScopeLock(scope, runLocked) : runLocked();
  }

  /**
   * Loads a specific revision's bytes strictly from this scope's authoritative adapter history.
   * NEVER reads an unverified client-supplied `expectedSha` from the global `blobStore`
   * (blocking cross-scope CAS disclosure via `409 base_content`).
   */
  private async loadRevisionBytes(
    adapter: SyncNamespaceAdapter,
    scope: string,
    path: string,
    revision: number,
    expectedSha?: string | null,
  ): Promise<Buffer | null> {
    if (revision === 0) return Buffer.alloc(0);
    if (adapter.readRevision) {
      const rev = await adapter.readRevision(scope, path, revision);
      if (!rev || rev.deleted || rev.content === null) return null;
      if (expectedSha && sha256Buffer(rev.content) !== expectedSha) return null;
      return rev.content;
    }
    if (expectedSha) {
      const fromAdapter = await adapter.readBlob(scope, expectedSha, path);
      if (fromAdapter && sha256Buffer(fromAdapter) === expectedSha) return fromAdapter;
    }
    return null;
  }

  /**
   * Loads a committed/staged blob ONLY if it belongs to `(adapter.policy.name, scope)`:
   * either previously uploaded/cached for this scope (`sync_blob_refs`) or reachable in this
   * scope's authoritative files/history via `adapter.readBlob`. Prevents cross-scope CAS theft.
   */
  private async loadScopeOwnedBlob(
    adapter: SyncNamespaceAdapter,
    scope: string,
    requestedSha: string,
    currentByPath: ReadonlyMap<string, SyncEntry>,
  ): Promise<Buffer> {
    if (hasSyncBlobRef(this.store, adapter.policy.name, scope, requestedSha)) {
      const fromCas = await this.blobStore.get(requestedSha);
      if (fromCas) return fromCas;
    }
    let hintPath: string | undefined;
    for (const entry of currentByPath.values()) {
      if (!entry.deleted && entry.sha256 === requestedSha) {
        hintPath = entry.path;
        break;
      }
    }
    const fromAdapter = await adapter.readBlob(scope, requestedSha, hintPath);
    if (fromAdapter && sha256Buffer(fromAdapter) === requestedSha) {
      await this.putScopedBlob(adapter.policy.name, scope, fromAdapter, requestedSha, false);
      return fromAdapter;
    }
    return fail(400, 'sync_blob_missing');
  }

  private async refreshScopeMaps(
    adapter: SyncNamespaceAdapter,
    scope: string,
    currentByPath: Map<string, SyncEntry>,
    existingPaths: Set<string>,
  ): Promise<void> {
    const snap = await adapter.snapshot(scope);
    currentByPath.clear();
    existingPaths.clear();
    for (const entry of snap.entries) {
      currentByPath.set(entry.path, entry);
      if (!entry.deleted) existingPaths.add(entry.path);
    }
  }

  private async commitSingleFile(
    adapter: SyncNamespaceAdapter,
    scope: string,
    change: SyncCommitChange,
    currentByPath: Map<string, SyncEntry>,
    existingPaths: Set<string>,
    ctx: { mode: 'interactive' | 'background'; actor: string; actorTag: string; skipIfHumanEdited: boolean },
  ): Promise<SyncCommitItemResult> {
    const path = normalizeSyncPath(change.path, {
      rejectSensitivePaths: adapter.policy.rejectSensitivePaths,
    });
    const isDelete = Boolean(change.deleted);

    let localBytes: Buffer | null = null;
    let localSha: string | null = null;
    let redactedOnCommit = false;

    if (!isDelete) {
      const requestedSha = assertSha256(change.content_sha256);
      const rawBlob = await this.loadScopeOwnedBlob(adapter, scope, requestedSha, currentByPath);
      const sanitized = this.sanitizeAndCheckContent(adapter.policy, rawBlob);
      localBytes = sanitized.bytes;
      localSha = sanitized.sha256;
      redactedOnCommit = sanitized.redacted;
      if (redactedOnCommit) {
        await this.putScopedBlob(adapter.policy.name, scope, localBytes, localSha, true);
      }
    }

    for (let attempt = 0; attempt < MAX_COMMIT_RACE_ATTEMPTS; attempt++) {
      try {
        return await this.commitSingleFileOnce(
          adapter,
          scope,
          path,
          change,
          isDelete,
          localBytes,
          localSha,
          redactedOnCommit,
          currentByPath,
          existingPaths,
          ctx,
        );
      } catch (error) {
        if (
          error instanceof HttpError &&
          error.status === 409 &&
          error.code === 'sync_revision_race' &&
          attempt < MAX_COMMIT_RACE_ATTEMPTS - 1
        ) {
          await this.refreshScopeMaps(adapter, scope, currentByPath, existingPaths);
          continue;
        }
        throw error;
      }
    }

    return fail(409, 'sync_revision_race');
  }

  private async commitSingleFileOnce(
    adapter: SyncNamespaceAdapter,
    scope: string,
    path: string,
    change: SyncCommitChange,
    isDelete: boolean,
    localBytes: Buffer | null,
    localSha: string | null,
    redactedOnCommit: boolean,
    currentByPath: Map<string, SyncEntry>,
    existingPaths: Set<string>,
    ctx: { mode: 'interactive' | 'background'; actor: string; actorTag: string; skipIfHumanEdited: boolean },
  ): Promise<SyncCommitItemResult> {
    const current = currentByPath.get(path);
    const currentRevision = current ? current.revision : 0;
    const currentDeleted = !current || current.deleted;
    const currentSha = current && !current.deleted ? current.sha256 : null;

    // Fast path 1: convergent state (already matches server).
    if ((isDelete && currentDeleted) || (!isDelete && !currentDeleted && currentSha === localSha)) {
      if (localBytes && localSha) {
        registerSyncBlobRef(this.store, adapter.policy.name, scope, localSha, localBytes.length, false, this.clock());
      }
      return {
        path,
        status: 'unchanged',
        revision: currentRevision,
        sha256: currentSha,
        size: current && !current.deleted ? current.size : 0,
        deleted: currentDeleted,
        ...(redactedOnCommit ? { redacted: true } : {}),
      };
    }

    // Fast path 2: clean optimistic commit when client baseline matches server revision,
    // or when cleanly creating a new file (base_revision === 0) over a previously soft-deleted path.
    if (change.base_revision === currentRevision || (!isDelete && change.base_revision === 0 && currentDeleted)) {
      if (isDelete && currentDeleted) {
        return { path, status: 'unchanged', revision: currentRevision, sha256: null, size: 0, deleted: true };
      }
      const applied = await adapter.applyChange!(scope, {
        path,
        expectedRevision: currentRevision,
        content: localBytes,
        sha256: localSha,
        deleted: isDelete,
        mode: change.mode,
        actor: ctx.actor,
      });
      if (localBytes && applied.sha256) {
        await this.putScopedBlob(adapter.policy.name, scope, localBytes, applied.sha256, false);
      }
      currentByPath.set(path, applied);
      if (applied.deleted) existingPaths.delete(path);
      else existingPaths.add(path);
      return {
        path,
        status: 'committed',
        revision: applied.revision,
        sha256: applied.sha256,
        size: applied.size,
        deleted: applied.deleted,
        ...(redactedOnCommit ? { redacted: true, merged_content_base64: localBytes?.toString('base64') } : {}),
      };
    }

    // Server moved ahead (or behind). First check nightly consolidation human-edit guard.
    if (ctx.skipIfHumanEdited && adapter.versions && currentRevision > change.base_revision) {
      const history = await adapter.versions(scope, path);
      const humanEdit = history.find(v => v.revision > change.base_revision && isHumanActor(v.actor));
      if (humanEdit) {
        recordSyncConflict(this.store, {
          namespace: adapter.policy.name,
          scope,
          path,
          mode: ctx.mode,
          resolution: 'skipped_human_edited',
          actor: ctx.actor,
          base_revision: change.base_revision,
          current_revision: currentRevision,
          base_sha256: change.base_sha256 ?? null,
          current_sha256: currentSha,
          local_sha256: localSha,
          conflict_path: null,
          reason: 'human_edited_since_base',
        });
        const currentBytes = currentSha
          ? await this.loadRevisionBytes(adapter, scope, path, currentRevision, currentSha)
          : null;
        return {
          path,
          status: 'skipped_human_edited',
          revision: currentRevision,
          sha256: currentSha,
          size: current && !current.deleted ? current.size : 0,
          deleted: currentDeleted,
          current_actor: humanEdit.actor,
          ...(currentBytes ? { current_content_base64: currentBytes.toString('base64') } : {}),
        };
      }
    }

    // Load base & current contents strictly from this scope's authoritative revision history.
    const baseBytes = await this.loadRevisionBytes(adapter, scope, path, change.base_revision, change.base_sha256);
    const currentBytes = currentDeleted
      ? null
      : await this.loadRevisionBytes(adapter, scope, path, currentRevision, currentSha);

    const resolveConflict = async (
      reason: string,
      detail: { binary: boolean; conflictMarkers: string | null; hunks: SyncConflictDetail['hunks'] },
    ): Promise<SyncCommitItemResult> => {
      const baseText = baseBytes && !isBinaryBuffer(baseBytes) ? baseBytes.toString('utf8') : null;
      const currentText = currentBytes && !isBinaryBuffer(currentBytes) ? currentBytes.toString('utf8') : null;
      const localText = localBytes && !isBinaryBuffer(localBytes) ? localBytes.toString('utf8') : null;

      // Layer 2: interactive mode OR reject conflict policy -> return 409 sync_conflict with 3-way diff.
      if (ctx.mode === 'interactive' || adapter.policy.conflictPolicy === 'reject') {
        const conflictDetail: SyncConflictDetail = {
          path,
          code: 'sync_conflict',
          reason,
          base_revision: change.base_revision,
          current_revision: currentRevision,
          base_sha256: baseBytes ? sha256Buffer(baseBytes) : null,
          current_sha256: currentSha,
          local_sha256: localSha,
          binary: detail.binary,
          base_content: baseText,
          current_content: currentText,
          local_content: localText,
          conflict_markers: detail.conflictMarkers,
          hunks: detail.hunks,
        };
        recordSyncConflict(this.store, {
          namespace: adapter.policy.name,
          scope,
          path,
          mode: ctx.mode,
          resolution: 'rejected_interactive',
          actor: ctx.actor,
          base_revision: change.base_revision,
          current_revision: currentRevision,
          base_sha256: conflictDetail.base_sha256,
          current_sha256: currentSha,
          local_sha256: localSha,
          conflict_path: null,
          reason,
        });
        return {
          path,
          status: 'conflict',
          revision: currentRevision,
          sha256: currentSha,
          size: current && !current.deleted ? current.size : 0,
          deleted: currentDeleted,
          conflict: conflictDetail,
        };
      }

      // Layer 3: background mode -> preserve main file `current` untouched, write sidecar conflict copy `<stem>.conflict-<actorTag>-<ts><ext>`.
      let conflictPath: string | null = null;
      let conflictEntry: SyncEntry | null = null;
      if (localBytes !== null) {
        const candidatePath = buildConflictCopyPath(path, ctx.actorTag, this.clock(), existingPaths);
        const sanitizedCopy = this.sanitizeAndCheckContent(adapter.policy, localBytes);
        await this.putScopedBlob(adapter.policy.name, scope, sanitizedCopy.bytes, sanitizedCopy.sha256, false);
        conflictEntry = await adapter.applyChange!(scope, {
          path: candidatePath,
          expectedRevision: 0,
          content: sanitizedCopy.bytes,
          sha256: sanitizedCopy.sha256,
          deleted: false,
          mode: change.mode,
          actor: ctx.actor,
        });
        conflictPath = candidatePath;
        currentByPath.set(candidatePath, conflictEntry);
        existingPaths.add(candidatePath);
      }

      recordSyncConflict(this.store, {
        namespace: adapter.policy.name,
        scope,
        path,
        mode: ctx.mode,
        resolution: 'conflict_copy',
        actor: ctx.actor,
        base_revision: change.base_revision,
        current_revision: currentRevision,
        base_sha256: baseBytes ? sha256Buffer(baseBytes) : null,
        current_sha256: currentSha,
        local_sha256: localSha,
        conflict_path: conflictPath,
        reason,
      });

      return {
        path,
        status: 'conflict_copy',
        revision: currentRevision,
        sha256: currentSha,
        size: current && !current.deleted ? current.size : 0,
        deleted: currentDeleted,
        ...(currentBytes ? { current_content_base64: currentBytes.toString('base64') } : {}),
        ...(conflictPath ? { conflict_path: conflictPath } : {}),
        ...(conflictEntry ? { conflict_revision: conflictEntry.revision, conflict_sha256: conflictEntry.sha256 ?? undefined } : {}),
        ...(localBytes ? { conflict_content_base64: localBytes.toString('base64') } : {}),
        ...(redactedOnCommit ? { redacted: true } : {}),
      };
    };

    // Delete vs modify or modify vs delete conflicts cannot be text-merged.
    if (isDelete && !currentDeleted) {
      return resolveConflict('delete_modify_conflict', { binary: false, conflictMarkers: null, hunks: [] });
    }
    if (!isDelete && currentDeleted) {
      return resolveConflict('modify_delete_conflict', {
        binary: localBytes ? isBinaryBuffer(localBytes) : false,
        conflictMarkers: null,
        hunks: [],
      });
    }
    if (baseBytes === null || currentBytes === null || localBytes === null) {
      return resolveConflict('missing_base_blob', {
        binary: Boolean((currentBytes && isBinaryBuffer(currentBytes)) || (localBytes && isBinaryBuffer(localBytes))),
        conflictMarkers: null,
        hunks: [],
      });
    }

    // Layer 1: attempt pure-text 3-way line-level merge.
    const merged = merge3WayBuffers(baseBytes, currentBytes, localBytes);
    if (merged.conflict || merged.merged === null) {
      return resolveConflict(merged.reason ?? 'content_conflict', {
        binary: merged.binary,
        conflictMarkers: merged.conflictMarkers,
        hunks: merged.hunks,
      });
    }

    const sanitizedMerged = this.sanitizeAndCheckContent(adapter.policy, merged.merged);
    await this.putScopedBlob(adapter.policy.name, scope, sanitizedMerged.bytes, sanitizedMerged.sha256, false);

    const applied = await adapter.applyChange!(scope, {
      path,
      expectedRevision: currentRevision,
      content: sanitizedMerged.bytes,
      sha256: sanitizedMerged.sha256,
      deleted: false,
      mode: change.mode,
      actor: ctx.actor,
    });
    currentByPath.set(path, applied);
    existingPaths.add(path);

    return {
      path,
      status: 'merged',
      revision: applied.revision,
      sha256: applied.sha256,
      size: applied.size,
      deleted: false,
      merged_content_base64: sanitizedMerged.bytes.toString('base64'),
      ...(redactedOnCommit || sanitizedMerged.redacted ? { redacted: true } : {}),
    };
  }

  listConflicts(namespace: SyncNamespaceName, scope: string, limit = 50): SyncConflictRecord[] {
    const adapter = this.requireAdapter(namespace);
    adapter.validateScope(scope);
    return listSyncConflicts(this.store, adapter.policy.name, scope, limit);
  }

  async fileHistory(
    namespace: SyncNamespaceName,
    scope: string,
    path: string,
  ): Promise<{ path: string; versions: SyncHistoryVersion[] }> {
    const adapter = this.requireAdapter(namespace);
    adapter.validateScope(scope);
    if (!adapter.policy.history || !adapter.versions) return fail(400, 'sync_history_unsupported');
    const safePath = normalizeSyncPath(path, { rejectSensitivePaths: adapter.policy.rejectSensitivePaths });
    const versions = await adapter.versions(scope, safePath);
    return { path: safePath, versions };
  }
}

export function isSyncConflictError(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 409 && error.code === 'sync_conflict';
}
