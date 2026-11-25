import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../storage/database.js';
import { digest, fail, randomId } from '../core/security.js';
import { isSyncNamespaceName } from './namespaces.js';
import { assertSha256, sanitizeActorTag } from './paths.js';
import type {
  SyncConflictRecord,
  SyncMode,
  SyncNamespaceName,
  SyncPrincipal,
  SyncPushMode,
  SyncTokenGrant,
} from './types.js';

export const SYNC_TOKEN_PREFIX = 'bsync_';
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HEX64_RE = /^[a-f0-9]{64}$/;
const HEX64_TMP_RE = /^[a-f0-9]{64}\.tmp-/;

export function syncStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS sync_conflicts(
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      scope TEXT NOT NULL,
      path TEXT NOT NULL,
      mode TEXT NOT NULL,
      resolution TEXT NOT NULL,
      actor TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      current_revision INTEGER NOT NULL,
      base_sha256 TEXT,
      current_sha256 TEXT,
      local_sha256 TEXT,
      conflict_path TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_conflicts_ns_scope ON sync_conflicts(namespace, scope, created_at DESC);

    CREATE TABLE IF NOT EXISTS sync_scope_revisions(
      namespace TEXT NOT NULL,
      scope TEXT NOT NULL,
      digest TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(namespace, scope)
    );

    CREATE TABLE IF NOT EXISTS sync_scope_entries(
      namespace TEXT NOT NULL,
      scope TEXT NOT NULL,
      path TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      scope_rev INTEGER NOT NULL,
      PRIMARY KEY(namespace, scope, path)
    );
    CREATE INDEX IF NOT EXISTS sync_scope_entries_rev ON sync_scope_entries(namespace, scope, scope_rev);

    CREATE TABLE IF NOT EXISTS sync_blob_refs(
      namespace TEXT NOT NULL,
      scope TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      staged INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(namespace, scope, sha256)
    );
    CREATE INDEX IF NOT EXISTS sync_blob_refs_sha ON sync_blob_refs(sha256);
    CREATE INDEX IF NOT EXISTS sync_blob_refs_staged ON sync_blob_refs(staged, updated_at);

    CREATE TABLE IF NOT EXISTS sync_tokens(
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_tag TEXT NOT NULL,
      grants TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_tokens_expires ON sync_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS sync_tokens_actor ON sync_tokens(actor);
  `);
}

export function registerSyncBlobRef(
  store: Store,
  namespace: SyncNamespaceName,
  scope: string,
  sha256: string,
  bytes: number,
  staged: boolean,
  now = Date.now(),
): void {
  const clean = assertSha256(sha256);
  const ts = new Date(now).toISOString();
  store.run(
    `INSERT INTO sync_blob_refs(namespace,scope,sha256,bytes,staged,updated_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(namespace,scope,sha256) DO UPDATE SET
       bytes=excluded.bytes,
       staged=CASE WHEN sync_blob_refs.staged=0 THEN 0 ELSE excluded.staged END,
       updated_at=excluded.updated_at`,
    namespace,
    scope,
    clean,
    Math.max(0, Math.trunc(bytes)),
    staged ? 1 : 0,
    ts,
  );
}

export function removeStagedSyncBlobRef(
  store: Store,
  namespace: SyncNamespaceName,
  scope: string,
  sha256: string,
): void {
  const clean = assertSha256(sha256);
  store.run(
    'DELETE FROM sync_blob_refs WHERE namespace=? AND scope=? AND sha256=? AND staged=1',
    namespace,
    scope,
    clean,
  );
}

export function hasSyncBlobRef(
  store: Store,
  namespace: SyncNamespaceName,
  scope: string,
  sha256: string,
): boolean {
  const clean = assertSha256(sha256);
  if (!store.hasTable('sync_blob_refs')) return false;
  return Boolean(
    store.get(
      'SELECT 1 FROM sync_blob_refs WHERE namespace=? AND scope=? AND sha256=?',
      namespace,
      scope,
      clean,
    ),
  );
}

export function touchSyncBlobRef(
  store: Store,
  namespace: SyncNamespaceName,
  scope: string,
  sha256: string,
  now = Date.now(),
): void {
  if (!store.hasTable('sync_blob_refs')) return;
  const clean = assertSha256(sha256);
  store.run(
    'UPDATE sync_blob_refs SET updated_at=? WHERE namespace=? AND scope=? AND sha256=?',
    new Date(now).toISOString(),
    namespace,
    scope,
    clean,
  );
}

export function hasPersistedSyncScope(
  store: Store,
  namespace: SyncNamespaceName,
  scope: string,
): boolean {
  if (!store.hasTable('sync_scope_revisions')) return false;
  const row = store.get(
    'SELECT revision FROM sync_scope_revisions WHERE namespace=? AND scope=?',
    namespace,
    scope,
  );
  return row !== undefined && Number(row.revision) > 0;
}

export interface SyncCleanupSummary {
  count: number;
  bytes: number;
  failed: number;
}

/**
 * Sweeps unreferenced blob objects (not referenced by any row in `sync_blob_refs`)
 * and stale `.tmp-*` upload files from `<blobRoot>/blobs/sha256/`.
 * Fails closed on unreadable roots without deleting any files.
 */
export function sweepUnreferencedSyncBlobs(
  store: Store,
  blobRoot: string = store.syncBlobsDir,
  now = Date.now(),
  tmpGraceMs = 3600_000,
): SyncCleanupSummary {
  const result: SyncCleanupSummary = { count: 0, bytes: 0, failed: 0 };
  if (!blobRoot || !store.hasTable('sync_blob_refs')) return result;
  const shaRoot = join(blobRoot, 'blobs', 'sha256');
  if (!existsSync(shaRoot)) return result;

  let firstLevels: string[];
  try {
    firstLevels = readdirSync(shaRoot);
  } catch {
    return { count: 0, bytes: 0, failed: 1 };
  }

  const referenced = new Set<string>(
    store.all('SELECT DISTINCT sha256 FROM sync_blob_refs').map(row => String(row.sha256)),
  );
  const tmpCutoff = now - tmpGraceMs;

  for (const aa of firstLevels) {
    if (!/^[a-f0-9]{2}$/.test(aa)) continue;
    const aaDir = join(shaRoot, aa);
    let secondLevels: string[];
    try {
      const info = lstatSync(aaDir);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      secondLevels = readdirSync(aaDir);
    } catch {
      result.failed++;
      continue;
    }

    for (const bb of secondLevels) {
      if (!/^[a-f0-9]{2}$/.test(bb)) continue;
      const bbDir = join(aaDir, bb);
      let entries: string[];
      try {
        const info = lstatSync(bbDir);
        if (info.isSymbolicLink() || !info.isDirectory()) continue;
        entries = readdirSync(bbDir);
      } catch {
        result.failed++;
        continue;
      }

      for (const name of entries) {
        const full = join(bbDir, name);
        let info;
        try {
          info = lstatSync(full);
        } catch {
          result.failed++;
          continue;
        }
        if (info.isSymbolicLink() || !info.isFile()) continue;

        const isStaleTmp = HEX64_TMP_RE.test(name) && info.mtimeMs <= tmpCutoff;
        const isOrphanBlob = HEX64_RE.test(name) && !referenced.has(name);
        if (!isStaleTmp && !isOrphanBlob) continue;

        try {
          unlinkSync(full);
          result.count++;
          result.bytes += info.size;
        } catch {
          result.failed++;
        }
      }

      try {
        if (readdirSync(bbDir).length === 0) rmdirSync(bbDir);
      } catch { /* ignore non-empty or raced directory */ }
    }

    try {
      if (readdirSync(aaDir).length === 0) rmdirSync(aaDir);
    } catch { /* ignore non-empty or raced directory */ }
  }

  return result;
}

/**
 * Deletes all FileSyncEngine metadata rows owned by a deleted project repository.
 * When `options.files === true` (post-commit), also sweeps unreferenced blob files from `sync-blobs/`.
 */
export function deleteProjectSyncData(
  store: Store,
  repositoryId: string,
  options: { files?: boolean; blobRoot?: string } = {},
): SyncCleanupSummary {
  const tables = ['sync_conflicts', 'sync_scope_revisions', 'sync_scope_entries', 'sync_blob_refs'] as const;
  const projectToolsLike = `${repositoryId}@rev-%`;
  const skillScope = `projects/${repositoryId}`;
  const skillSetsLike = `projects/${repositoryId}/sets/%`;
  const toolResultsScope = `project_${repositoryId}`;

  for (const table of tables) {
    if (!store.hasTable(table)) continue;
    store.run(
      `DELETE FROM ${table}
       WHERE (namespace='project-notes' AND scope=?)
          OR (namespace='project-tools' AND (scope=? OR scope LIKE ?))
          OR (namespace='skill-store' AND (scope=? OR scope LIKE ?))
          OR (namespace='tool-results' AND scope=?)`,
      repositoryId,
      repositoryId,
      projectToolsLike,
      skillScope,
      skillSetsLike,
      toolResultsScope,
    );
  }

  if (options.files === true) {
    return sweepUnreferencedSyncBlobs(store, options.blobRoot ?? store.syncBlobsDir);
  }
  return { count: 0, bytes: 0, failed: 0 };
}

/**
 * Deletes FileSyncEngine metadata rows owned by an assistant HOME owner (all generations or one sealed generation).
 * When `options.files !== false`, sweeps unreferenced blob files from `sync-blobs/`.
 */
export function deleteAssistantSyncData(
  store: Store,
  owner: string,
  options: { files?: boolean; blobRoot?: string; generation?: number } = {},
): SyncCleanupSummary {
  const tables = ['sync_conflicts', 'sync_scope_revisions', 'sync_scope_entries', 'sync_blob_refs'] as const;
  for (const table of tables) {
    if (!store.hasTable(table)) continue;
    if (options.generation !== undefined) {
      store.run(
        `DELETE FROM ${table} WHERE namespace='assistant-homes' AND scope=?`,
        `${owner}:${options.generation}`,
      );
    } else {
      store.run(
        `DELETE FROM ${table}
         WHERE (namespace='assistant-homes' AND (scope=? OR scope LIKE ?))
            OR (namespace='tool-results' AND scope=?)`,
        owner,
        `${owner}:%`,
        `assistant_${owner}`,
      );
    }
  }

  if (options.files !== false) {
    return sweepUnreferencedSyncBlobs(store, options.blobRoot ?? store.syncBlobsDir);
  }
  return { count: 0, bytes: 0, failed: 0 };
}

export interface PruneSyncDataOptions {
  blobRoot?: string;
  now?: number;
  conflictRetentionDays?: number;
  maxConflictsPerScope?: number;
  stagedTtlMs?: number;
  cachedTtlDays?: number;
  expiredTokenRetentionDays?: number;
}

export interface PruneSyncDataResult extends SyncCleanupSummary {
  conflicts_pruned: number;
  refs_pruned: number;
  tokens_pruned: number;
}

/**
 * Daily & manual retention cleanup for FileSyncEngine tables and `sync-blobs/` CAS cache:
 * - Prunes `sync_conflicts` past `conflictRetentionDays` (default 30d) and caps each scope at `maxConflictsPerScope` (1000).
 * - Prunes abandoned `staged=1` blob refs past `stagedTtlMs` (default 24h) and stale cached `staged=0` refs past `cachedTtlDays` (default 30d).
 * - Prunes expired/revoked `sync_tokens` past `expiredTokenRetentionDays` (default 7d).
 * - Sweeps unreferenced blob objects & stale `.tmp-*` files from `sync-blobs/`.
 */
export function pruneSyncData(store: Store, options: PruneSyncDataOptions = {}): PruneSyncDataResult {
  const now = options.now ?? Date.now();
  const conflictCutoff = new Date(now - (options.conflictRetentionDays ?? 30) * DAY_MS).toISOString();
  const maxPerScope = Math.max(1, options.maxConflictsPerScope ?? 1000);
  const stagedCutoff = new Date(now - (options.stagedTtlMs ?? DAY_MS)).toISOString();
  const cachedCutoff = new Date(now - (options.cachedTtlDays ?? 30) * DAY_MS).toISOString();
  const tokenCutoffMs = now - (options.expiredTokenRetentionDays ?? 7) * DAY_MS;

  let conflictsPruned = 0;
  let refsPruned = 0;
  let tokensPruned = 0;

  if (store.hasTable('sync_conflicts')) {
    conflictsPruned += Number(store.run('DELETE FROM sync_conflicts WHERE created_at<?', conflictCutoff).changes ?? 0);
    const overCapScopes = store.all(
      'SELECT namespace, scope, count(*) AS cnt FROM sync_conflicts GROUP BY namespace, scope HAVING cnt > ?',
      maxPerScope,
    );
    for (const row of overCapScopes) {
      const removed = store.run(
        `DELETE FROM sync_conflicts
         WHERE id IN (
           SELECT id FROM sync_conflicts
           WHERE namespace=? AND scope=?
           ORDER BY created_at DESC, rowid DESC
           LIMIT -1 OFFSET ?
         )`,
        String(row.namespace),
        String(row.scope),
        maxPerScope,
      );
      conflictsPruned += Number(removed.changes ?? 0);
    }
  }

  if (store.hasTable('sync_blob_refs')) {
    refsPruned += Number(
      store.run('DELETE FROM sync_blob_refs WHERE staged=1 AND updated_at<?', stagedCutoff).changes ?? 0,
    );
    refsPruned += Number(
      store.run('DELETE FROM sync_blob_refs WHERE staged=0 AND updated_at<?', cachedCutoff).changes ?? 0,
    );
  }

  if (store.hasTable('sync_tokens')) {
    tokensPruned += Number(
      store.run(
        'DELETE FROM sync_tokens WHERE (revoked_at IS NOT NULL AND revoked_at<?) OR expires_at<?',
        tokenCutoffMs,
        tokenCutoffMs,
      ).changes ?? 0,
    );
  }

  const swept = sweepUnreferencedSyncBlobs(store, options.blobRoot ?? store.syncBlobsDir, now);
  return {
    count: swept.count + conflictsPruned + refsPruned + tokensPruned,
    bytes: swept.bytes,
    failed: swept.failed,
    conflicts_pruned: conflictsPruned,
    refs_pruned: refsPruned,
    tokens_pruned: tokensPruned,
  };
}

export function recordSyncConflict(
  store: Store,
  record: Omit<SyncConflictRecord, 'id' | 'created_at'> & { id?: string; created_at?: string },
): SyncConflictRecord {
  const full: SyncConflictRecord = {
    id: record.id ?? randomId().slice(0, 32),
    namespace: record.namespace,
    scope: record.scope,
    path: record.path,
    mode: record.mode,
    resolution: record.resolution,
    actor: record.actor,
    base_revision: record.base_revision,
    current_revision: record.current_revision,
    base_sha256: record.base_sha256,
    current_sha256: record.current_sha256,
    local_sha256: record.local_sha256,
    conflict_path: record.conflict_path,
    reason: record.reason,
    created_at: record.created_at ?? new Date().toISOString(),
  };
  store.run(
    `INSERT INTO sync_conflicts(
       id,namespace,scope,path,mode,resolution,actor,base_revision,current_revision,
       base_sha256,current_sha256,local_sha256,conflict_path,reason,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    full.id,
    full.namespace,
    full.scope,
    full.path,
    full.mode,
    full.resolution,
    full.actor,
    full.base_revision,
    full.current_revision,
    full.base_sha256,
    full.current_sha256,
    full.local_sha256,
    full.conflict_path,
    full.reason,
    full.created_at,
  );
  return full;
}

export function listSyncConflicts(
  store: Store,
  namespace: SyncNamespaceName,
  scope: string,
  limit = 50,
): SyncConflictRecord[] {
  const safeLimit = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 200) : 50;
  return store
    .all(
      `SELECT * FROM sync_conflicts WHERE namespace=? AND scope=? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      namespace,
      scope,
      safeLimit,
    )
    .map(row => ({
      id: String(row.id),
      namespace: String(row.namespace) as SyncNamespaceName,
      scope: String(row.scope),
      path: String(row.path),
      mode: String(row.mode) as SyncPushMode,
      resolution: String(row.resolution) as SyncConflictRecord['resolution'],
      actor: String(row.actor),
      base_revision: Number(row.base_revision),
      current_revision: Number(row.current_revision),
      base_sha256: row.base_sha256 ? String(row.base_sha256) : null,
      current_sha256: row.current_sha256 ? String(row.current_sha256) : null,
      local_sha256: row.local_sha256 ? String(row.local_sha256) : null,
      conflict_path: row.conflict_path ? String(row.conflict_path) : null,
      reason: String(row.reason),
      created_at: String(row.created_at),
    }));
}

/**
 * Tracks strictly monotonic scope revisions and per-entry change checkpoints in SQLite so
 * `GET /manifest?since_rev=N` works identically and accurately across all 6 namespaces,
 * including out-of-band console/filesystem edits and per-file revisions that advance independently.
 */
export interface ScopeDeltaResult {
  revision: number;
  changedPaths: ReadonlySet<string>;
  removedPaths: readonly string[];
}

export function reconcileScopeManifestDelta(
  store: Store,
  namespace: SyncNamespaceName,
  scope: string,
  entries: readonly {
    path: string;
    revision: number;
    sha256: string | null;
    size: number;
    mode: number;
    deleted: boolean;
    kind?: 'file' | 'symlink';
    link_target?: string | null;
  }[],
  forcedRevision?: number,
): ScopeDeltaResult {
  const canonical = entries.map(entry => [
    entry.path,
    entry.revision,
    entry.sha256 ?? '',
    entry.size,
    entry.mode,
    entry.deleted ? 1 : 0,
    entry.kind ?? 'file',
    entry.link_target ?? '',
  ]);
  const contentDigest = digest(JSON.stringify(canonical));

  return store.transaction(() => {
    const existingScope = store.get(
      'SELECT digest,revision FROM sync_scope_revisions WHERE namespace=? AND scope=?',
      namespace,
      scope,
    );
    const prevEntries = new Map<string, { fingerprint: string; scope_rev: number }>();
    for (const row of store.all(
      'SELECT path,fingerprint,scope_rev FROM sync_scope_entries WHERE namespace=? AND scope=?',
      namespace,
      scope,
    )) {
      prevEntries.set(String(row.path), {
        fingerprint: String(row.fingerprint),
        scope_rev: Number(row.scope_rev),
      });
    }

    const currentFingerprints = new Map<string, string>();
    for (let i = 0; i < entries.length; i++) {
      currentFingerprints.set(entries[i]!.path, JSON.stringify(canonical[i]));
    }

    const existingRev = existingScope ? Number(existingScope.revision) : 0;
    const unchanged =
      existingScope !== undefined &&
      String(existingScope.digest) === contentDigest &&
      (forcedRevision === undefined || forcedRevision === existingRev);

    if (unchanged) {
      return { revision: existingRev, changedPaths: new Set<string>(), removedPaths: [] };
    }

    const nextRev =
      forcedRevision !== undefined && forcedRevision > existingRev
        ? forcedRevision
        : existingScope === undefined && entries.length === 0
          ? 0
          : existingRev + 1;

    const changedPaths = new Set<string>();
    const removedPaths: string[] = [];
    const now = new Date().toISOString();

    for (const [path, fp] of currentFingerprints) {
      const prev = prevEntries.get(path);
      if (!prev || prev.fingerprint !== fp) {
        changedPaths.add(path);
        store.run(
          `INSERT INTO sync_scope_entries(namespace,scope,path,fingerprint,scope_rev) VALUES(?,?,?,?,?)
           ON CONFLICT(namespace,scope,path) DO UPDATE SET fingerprint=excluded.fingerprint,scope_rev=excluded.scope_rev`,
          namespace,
          scope,
          path,
          fp,
          nextRev,
        );
      }
    }
    for (const oldPath of prevEntries.keys()) {
      if (!currentFingerprints.has(oldPath)) {
        removedPaths.push(oldPath);
        store.run(
          `UPDATE sync_scope_entries SET fingerprint=?,scope_rev=? WHERE namespace=? AND scope=? AND path=?`,
          '__removed__',
          nextRev,
          namespace,
          scope,
          oldPath,
        );
      }
    }

    store.run(
      `INSERT INTO sync_scope_revisions(namespace,scope,digest,revision,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(namespace,scope) DO UPDATE SET digest=excluded.digest,revision=excluded.revision,updated_at=excluded.updated_at`,
      namespace,
      scope,
      contentDigest,
      nextRev,
      now,
    );

    return { revision: nextRev, changedPaths, removedPaths };
  });
}

export function listScopeEntriesSince(
  store: Store,
  namespace: SyncNamespaceName,
  scope: string,
  sinceRev: number,
): Map<string, { scope_rev: number; removed: boolean }> {
  const result = new Map<string, { scope_rev: number; removed: boolean }>();
  for (const row of store.all(
    'SELECT path,fingerprint,scope_rev FROM sync_scope_entries WHERE namespace=? AND scope=? AND scope_rev>?',
    namespace,
    scope,
    sinceRev,
  )) {
    result.set(String(row.path), {
      scope_rev: Number(row.scope_rev),
      removed: String(row.fingerprint) === '__removed__',
    });
  }
  return result;
}

interface StoredToken {
  id: string;
  secretHash: Buffer;
  actor: string;
  actorTag: string;
  grants: readonly SyncTokenGrant[];
  expiresAt: number;
  revokedAt: number | null;
  createdAt: string;
  createdBy: string;
}

export interface IssueSyncTokenOptions {
  actor: string;
  actorTag?: string;
  grants: SyncTokenGrant[];
  ttlMs?: number;
  createdBy?: string;
}

export interface IssuedSyncToken {
  token: string;
  token_id: string;
  actor: string;
  actor_tag: string;
  grants: readonly SyncTokenGrant[];
  expires_at: string;
}

export interface SyncTokenSummary {
  token_id: string;
  actor: string;
  actor_tag: string;
  grants: readonly SyncTokenGrant[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  created_by: string;
  active: boolean;
}

/**
 * Control-plane scoped bearer token broker for `/sync/:namespace/:scope/*`.
 * Tokens use the self-identifying `bsync_<id>.<secret>` format (registered in Redactor),
 * persist in SQLite `sync_tokens` (surviving restarts), audit issuance & revocation,
 * carry explicit `(namespace, scope, mode)` grants, and are validated in constant time.
 */
export class SyncTokenService {
  private readonly memoryTokens = new Map<string, StoredToken>();

  constructor(
    private readonly store?: Store,
    private readonly clock: () => number = () => Date.now(),
  ) {
    if (this.store) syncStorage(this.store);
  }

  private loadFromStore(id: string): StoredToken | null {
    if (!this.store) return this.memoryTokens.get(id) ?? null;
    const row = this.store.get('SELECT * FROM sync_tokens WHERE id=?', id);
    if (!row) return null;
    let grants: SyncTokenGrant[] = [];
    try {
      const parsed = JSON.parse(String(row.grants));
      if (Array.isArray(parsed)) grants = parsed;
    } catch {
      return null;
    }
    return {
      id: String(row.id),
      secretHash: Buffer.from(String(row.secret_hash), 'hex'),
      actor: String(row.actor),
      actorTag: String(row.actor_tag),
      grants: Object.freeze(grants),
      expiresAt: Number(row.expires_at),
      revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
      createdAt: String(row.created_at),
      createdBy: String(row.created_by),
    };
  }

  issue(options: IssueSyncTokenOptions): IssuedSyncToken {
    const actor = String(options.actor || '').trim();
    if (!actor || actor.length > 200 || /[\x00-\x1f\x7f]/.test(actor)) fail(400, 'sync_invalid_actor');
    if (!Array.isArray(options.grants) || !options.grants.length || options.grants.length > 64) {
      fail(400, 'sync_invalid_grants');
    }
    const grants: SyncTokenGrant[] = options.grants.map(grant => {
      if (!grant || typeof grant !== 'object') fail(400, 'sync_invalid_grants');
      if (grant.namespace !== '*' && !isSyncNamespaceName(grant.namespace)) {
        fail(400, 'sync_invalid_grants');
      }
      if (typeof grant.scope !== 'string' || !grant.scope.trim() || grant.scope.length > 256 || /[\x00-\x1f\x7f]/.test(grant.scope)) {
        fail(400, 'sync_invalid_grants');
      }
      if (grant.mode !== 'ro' && grant.mode !== 'rw') fail(400, 'sync_invalid_grants');
      return Object.freeze({ namespace: grant.namespace, scope: grant.scope.trim(), mode: grant.mode });
    });
    const ttl = options.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
    if (!Number.isFinite(ttl) || ttl < 1000 || ttl > MAX_TOKEN_TTL_MS) fail(400, 'sync_invalid_ttl');
    const id = randomBytes(6).toString('hex');
    const secret = randomBytes(24).toString('hex');
    const token = `${SYNC_TOKEN_PREFIX}${id}.${secret}`;
    const actorTag = sanitizeActorTag(options.actorTag ?? actor);
    const now = this.clock();
    const expiresAt = now + ttl;
    const createdAt = new Date(now).toISOString();
    const createdBy = String(options.createdBy || 'system').trim() || 'system';
    const secretHashHex = digest(secret);

    if (this.store) {
      this.store.transaction(() => {
        this.store!.run(
          `INSERT INTO sync_tokens(id,secret_hash,actor,actor_tag,grants,expires_at,revoked_at,created_at,created_by)
           VALUES(?,?,?,?,?,?,NULL,?,?)`,
          id,
          secretHashHex,
          actor,
          actorTag,
          JSON.stringify(grants),
          expiresAt,
          createdAt,
          createdBy,
        );
        this.store!.audit(createdBy, 'sync.token.issued', id);
      });
    } else {
      this.memoryTokens.set(id, {
        id,
        secretHash: Buffer.from(secretHashHex, 'hex'),
        actor,
        actorTag,
        grants: Object.freeze(grants),
        expiresAt,
        revokedAt: null,
        createdAt,
        createdBy,
      });
      this.sweepExpired();
    }

    return {
      token,
      token_id: id,
      actor,
      actor_tag: actorTag,
      grants,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  exists(tokenId: string): boolean {
    if (!/^[a-f0-9]{12}$/.test(tokenId)) return false;
    if (this.store) {
      return Boolean(this.store.get('SELECT 1 FROM sync_tokens WHERE id=?', tokenId));
    }
    return this.memoryTokens.has(tokenId);
  }

  list(options: { includeRevoked?: boolean; includeExpired?: boolean } = {}): SyncTokenSummary[] {
    const now = this.clock();
    const rows: StoredToken[] = [];
    if (this.store) {
      for (const row of this.store.all('SELECT * FROM sync_tokens ORDER BY created_at DESC, rowid DESC LIMIT 500')) {
        let grants: SyncTokenGrant[] = [];
        try {
          const parsed = JSON.parse(String(row.grants));
          if (Array.isArray(parsed)) grants = parsed;
        } catch {
          continue;
        }
        rows.push({
          id: String(row.id),
          secretHash: Buffer.alloc(0),
          actor: String(row.actor),
          actorTag: String(row.actor_tag),
          grants,
          expiresAt: Number(row.expires_at),
          revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
          createdAt: String(row.created_at),
          createdBy: String(row.created_by),
        });
      }
    } else {
      rows.push(...this.memoryTokens.values());
    }

    return rows
      .filter(entry => {
        if (!options.includeRevoked && entry.revokedAt !== null) return false;
        if (!options.includeExpired && entry.expiresAt <= now) return false;
        return true;
      })
      .map(entry => ({
        token_id: entry.id,
        actor: entry.actor,
        actor_tag: entry.actorTag,
        grants: entry.grants,
        expires_at: new Date(entry.expiresAt).toISOString(),
        revoked_at: entry.revokedAt !== null ? new Date(entry.revokedAt).toISOString() : null,
        created_at: entry.createdAt,
        created_by: entry.createdBy,
        active: entry.revokedAt === null && entry.expiresAt > now,
      }));
  }

  revoke(tokenId: string, actorId = 'system'): boolean {
    if (!/^[a-f0-9]{12}$/.test(tokenId)) return false;
    const now = this.clock();
    if (this.store) {
      return this.store.transaction(() => {
        const res = this.store!.run(
          'UPDATE sync_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL',
          now,
          tokenId,
        );
        const changed = Number(res.changes ?? 0) > 0;
        if (changed) this.store!.audit(actorId, 'sync.token.revoked', tokenId);
        return changed;
      });
    }
    const existing = this.memoryTokens.get(tokenId);
    if (!existing || existing.revokedAt !== null) return false;
    existing.revokedAt = now;
    return true;
  }

  revokeByActor(actor: string, actorId = 'system'): number {
    const now = this.clock();
    if (this.store) {
      return this.store.transaction(() => {
        const rows = this.store!.all(
          'SELECT id FROM sync_tokens WHERE actor=? AND revoked_at IS NULL',
          actor,
        );
        for (const row of rows) {
          const id = String(row.id);
          this.store!.run('UPDATE sync_tokens SET revoked_at=? WHERE id=?', now, id);
          this.store!.audit(actorId, 'sync.token.revoked', id);
        }
        return rows.length;
      });
    }
    let removed = 0;
    for (const entry of this.memoryTokens.values()) {
      if (entry.actor === actor && entry.revokedAt === null) {
        entry.revokedAt = now;
        removed++;
      }
    }
    return removed;
  }

  sweepExpired(): void {
    const now = this.clock();
    if (this.store) {
      const cutoff = now - 7 * DAY_MS;
      this.store.run(
        'DELETE FROM sync_tokens WHERE (revoked_at IS NOT NULL AND revoked_at<?) OR expires_at<?',
        cutoff,
        cutoff,
      );
      return;
    }
    for (const [id, entry] of this.memoryTokens) {
      if (entry.expiresAt <= now || entry.revokedAt !== null) this.memoryTokens.delete(id);
    }
  }

  authenticate(
    authorizationHeader: string | undefined,
    namespace: SyncNamespaceName,
    scope: string,
    requiredMode: SyncMode,
  ): SyncPrincipal {
    const raw = typeof authorizationHeader === 'string' ? authorizationHeader.trim() : '';
    const match = /^Bearer\s+(bsync_([a-f0-9]{12})\.([a-f0-9]{48}))$/.exec(raw);
    if (!match) return fail(401, 'sync_unauthorized');
    const [, , id, secret] = match;
    const stored = this.loadFromStore(id!);
    if (!stored || stored.revokedAt !== null || stored.expiresAt <= this.clock()) {
      return fail(401, 'sync_unauthorized');
    }
    const candidateHash = Buffer.from(digest(secret!), 'hex');
    if (candidateHash.length !== stored.secretHash.length || !timingSafeEqual(candidateHash, stored.secretHash)) {
      fail(401, 'sync_unauthorized');
    }

    const matchingScopeGrants = stored.grants.filter(
      g => (g.namespace === '*' || g.namespace === namespace) && (g.scope === '*' || g.scope === scope),
    );
    if (!matchingScopeGrants.length) fail(403, 'sync_scope_forbidden');
    if (requiredMode === 'rw' && !matchingScopeGrants.some(g => g.mode === 'rw')) {
      fail(403, 'sync_write_forbidden');
    }

    return {
      tokenId: stored.id,
      actor: stored.actor,
      actorTag: stored.actorTag,
      grants: stored.grants,
    };
  }
}
