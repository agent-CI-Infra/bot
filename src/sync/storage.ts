import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Store } from '../storage/database.js';
import { digest, fail, randomId } from '../core/security.js';
import { isSyncNamespaceName } from './namespaces.js';
import { sanitizeActorTag } from './paths.js';
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
  `);
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
}

export interface IssueSyncTokenOptions {
  actor: string;
  actorTag?: string;
  grants: SyncTokenGrant[];
  ttlMs?: number;
}

export interface IssuedSyncToken {
  token: string;
  token_id: string;
  actor: string;
  actor_tag: string;
  grants: readonly SyncTokenGrant[];
  expires_at: string;
}

/**
 * Control-plane scoped bearer token broker for `/sync/:namespace/:scope/*`.
 * Tokens use the self-identifying `bsync_<id>.<secret>` format (also registered in Redactor),
 * carry explicit `(namespace, scope, mode)` grants, and are validated in constant time.
 */
export class SyncTokenService {
  private readonly tokens = new Map<string, StoredToken>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  issue(options: IssueSyncTokenOptions): IssuedSyncToken {
    const actor = String(options.actor || '').trim();
    if (!actor || actor.length > 200 || /[\x00-\x1f\x7f]/.test(actor)) fail(400, 'sync_invalid_actor');
    if (!Array.isArray(options.grants) || !options.grants.length || options.grants.length > 64) {
      fail(400, 'sync_invalid_grants');
    }
    const grants: SyncTokenGrant[] = options.grants.map(grant => {
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
    const expiresAt = this.clock() + ttl;
    this.tokens.set(id, {
      id,
      secretHash: Buffer.from(digest(secret), 'hex'),
      actor,
      actorTag,
      grants: Object.freeze(grants),
      expiresAt,
    });
    this.sweepExpired();
    return {
      token,
      token_id: id,
      actor,
      actor_tag: actorTag,
      grants,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  revoke(tokenId: string): boolean {
    return this.tokens.delete(tokenId);
  }

  revokeByActor(actor: string): number {
    let removed = 0;
    for (const [id, entry] of this.tokens) {
      if (entry.actor === actor) {
        this.tokens.delete(id);
        removed++;
      }
    }
    return removed;
  }

  sweepExpired(): void {
    const now = this.clock();
    for (const [id, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(id);
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
    const stored = this.tokens.get(id!);
    if (!stored || stored.expiresAt <= this.clock()) {
      if (stored) this.tokens.delete(id!);
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
