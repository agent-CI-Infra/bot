import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fdatasyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Row, Store } from '../storage/database.js';
import { fail, HttpError, type Json } from '../core/security.js';
import { configuredRedactor, publicContent, publicText, redactEgress } from '../core/redaction.js';
import { Redactor } from '../../runner/credential-redaction.mjs';
import { assertSecretFree } from '../roles/protocol.js';

export const FEEDBACK_CATEGORIES = ['skill', 'tool', 'prompt', 'workflow', 'environment', 'other'] as const;
export type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number];

export const FEEDBACK_SEVERITIES = ['low', 'medium', 'high'] as const;
export type FeedbackSeverity = typeof FEEDBACK_SEVERITIES[number];

export const FEEDBACK_STATUSES = ['open', 'triaged', 'resolved', 'dismissed'] as const;
export type FeedbackStatus = typeof FEEDBACK_STATUSES[number];

export const FEEDBACK_SOURCE_KINDS = [
  'project_role',
  'dispatch_manager',
  'role_conversation',
  'management_assistant',
  'group_assistant',
  'memory_consolidation',
] as const;
export type FeedbackSourceKind = typeof FEEDBACK_SOURCE_KINDS[number];

export interface FeedbackSettings {
  enabled: boolean;
  max_per_run: number;
}

export const feedbackDefaults: FeedbackSettings = {
  enabled: true,
  max_per_run: 3,
};

export const feedbackBounds = {
  max_per_run: [1, 20] as [number, number],
};

export const DEFAULT_FEEDBACK_HOURLY_LIMIT = 30;
const MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024;
const feedbackIdPattern = /^[a-zA-Z0-9_-]{8,120}$/;

export interface FeedbackEntryRow {
  id: string;
  status: FeedbackStatus;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  title: string;
  source_kind: FeedbackSourceKind;
  repository_id: string | null;
  repository_full_name: string | null;
  role_id: string | null;
  harness_id: string | null;
  model_name: string | null;
  task_id: string | null;
  run_id: string | null;
  conversation_id: string | null;
  untrusted_context: boolean;
  target_ref: string | null;
  idempotency_scope: string;
  idempotency_key: string | null;
  payload_relpath: string;
  payload_bytes: number;
  payload_sha256: string;
  triage_note: string | null;
  triaged_by: string | null;
  triaged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeedbackBody {
  title: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  context: string;
  problem: string;
  suggestion: string;
  target_ref: string | null;
  evidence_refs: string[];
  idempotency_key: string | null;
}

export interface FeedbackPayloadFile {
  schema_version: 1;
  id: string;
  created_at: string;
  feedback: FeedbackBody;
  environment_snapshot: Json;
}

export function feedbackStorage(store: Store): void {
  // Intentionally no REFERENCES repositories(id): historical feedback survives project deletion,
  // with repository_full_name frozen at submission time. Large bodies and environment snapshots
  // live outside SQLite as plaintext gzipped JSON files under store.feedbackDir.
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_entries(
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','triaged','resolved','dismissed')),
      category TEXT NOT NULL CHECK(category IN ('skill','tool','prompt','workflow','environment','other')),
      severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('low','medium','high')),
      title TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('project_role','dispatch_manager','role_conversation','management_assistant','group_assistant','memory_consolidation')),
      repository_id TEXT,
      repository_full_name TEXT,
      role_id TEXT,
      harness_id TEXT,
      model_name TEXT,
      task_id TEXT,
      run_id TEXT,
      conversation_id TEXT,
      untrusted_context INTEGER NOT NULL DEFAULT 0 CHECK(untrusted_context IN (0,1)),
      target_ref TEXT,
      idempotency_scope TEXT NOT NULL,
      idempotency_key TEXT,
      payload_relpath TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      payload_sha256 TEXT NOT NULL,
      triage_note TEXT,
      triaged_by TEXT,
      triaged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feedback_entries_status_created ON feedback_entries(status, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS feedback_entries_repo_created ON feedback_entries(repository_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS feedback_entries_source_created ON feedback_entries(source_kind, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS feedback_entries_created ON feedback_entries(created_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS feedback_entries_idempotency ON feedback_entries(idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS feedback_entries_scope_created ON feedback_entries(idempotency_scope, created_at DESC);
  `);
}

export function feedbackSettings(store: Store): FeedbackSettings {
  let saved: Partial<FeedbackSettings> = {};
  try {
    saved = JSON.parse(String(store.get("SELECT value FROM settings WHERE key='feedback_box'")?.value ?? '{}'));
  } catch { /* fallback to defaults */ }
  const enabled = typeof saved.enabled === 'boolean' ? saved.enabled : feedbackDefaults.enabled;
  const maxPerRun = Number.isSafeInteger(saved.max_per_run)
    && Number(saved.max_per_run) >= feedbackBounds.max_per_run[0]
    && Number(saved.max_per_run) <= feedbackBounds.max_per_run[1]
    ? Number(saved.max_per_run)
    : feedbackDefaults.max_per_run;
  return { enabled, max_per_run: maxPerRun };
}

export function saveFeedbackSettings(store: Store, userId: string, input: Json): FeedbackSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) {
    fail(400, 'feedback_settings_invalid');
  }
  for (const key of Object.keys(input)) {
    if (!['enabled', 'max_per_run'].includes(key)) fail(400, 'feedback_settings_invalid', key);
  }
  const next = feedbackSettings(store);
  if (Object.hasOwn(input, 'enabled')) {
    const enabled = input.enabled;
    if (typeof enabled !== 'boolean') return fail(400, 'feedback_settings_invalid', 'enabled');
    next.enabled = enabled;
  }
  if (Object.hasOwn(input, 'max_per_run')) {
    const [min, max] = feedbackBounds.max_per_run;
    const maxPerRun = input.max_per_run;
    if (typeof maxPerRun !== 'number' || !Number.isSafeInteger(maxPerRun) || maxPerRun < min || maxPerRun > max) {
      return fail(400, 'feedback_settings_invalid', 'max_per_run');
    }
    next.max_per_run = maxPerRun;
  }
  store.transaction(() => {
    store.run(
      "INSERT INTO settings VALUES('feedback_box',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(next),
    );
    store.audit(userId, 'feedback.settings.updated', 'feedback_box');
  });
  return next;
}

export function mapFeedbackRow(row: Row): FeedbackEntryRow {
  return {
    id: String(row.id),
    status: String(row.status) as FeedbackStatus,
    category: String(row.category) as FeedbackCategory,
    severity: String(row.severity) as FeedbackSeverity,
    title: String(row.title),
    source_kind: String(row.source_kind) as FeedbackSourceKind,
    repository_id: row.repository_id == null ? null : String(row.repository_id),
    repository_full_name: row.repository_full_name == null ? null : String(row.repository_full_name),
    role_id: row.role_id == null ? null : String(row.role_id),
    harness_id: row.harness_id == null ? null : String(row.harness_id),
    model_name: row.model_name == null ? null : String(row.model_name),
    task_id: row.task_id == null ? null : String(row.task_id),
    run_id: row.run_id == null ? null : String(row.run_id),
    conversation_id: row.conversation_id == null ? null : String(row.conversation_id),
    untrusted_context: Boolean(row.untrusted_context),
    target_ref: row.target_ref == null ? null : String(row.target_ref),
    idempotency_scope: String(row.idempotency_scope),
    idempotency_key: row.idempotency_key == null ? null : String(row.idempotency_key),
    payload_relpath: String(row.payload_relpath),
    payload_bytes: Number(row.payload_bytes),
    payload_sha256: String(row.payload_sha256),
    triage_note: row.triage_note == null ? null : String(row.triage_note),
    triaged_by: row.triaged_by == null ? null : String(row.triaged_by),
    triaged_at: row.triaged_at == null ? null : String(row.triaged_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function writeAll(fd: number, data: Buffer): void {
  for (let offset = 0; offset < data.length;) {
    offset += writeSync(fd, data, offset, data.length - offset);
  }
}

export function feedbackRelativePath(id: string): string {
  if (!feedbackIdPattern.test(id)) return fail(400, 'feedback_id_invalid');
  return `${id.slice(0, 2)}/${id}.json.gz`;
}

/** Plaintext gzipped feedback file path under feedbackDir, sharded by the first two ID characters. */
export function feedbackFilePath(store: Store, id: string): string {
  if (!feedbackIdPattern.test(id)) return fail(400, 'feedback_id_invalid');
  const root = resolve(store.feedbackDir);
  const target = resolve(root, id.slice(0, 2), `${id}.json.gz`);
  if (!target.startsWith(root + sep)) return fail(400, 'feedback_id_invalid');
  return target;
}

const extraSecretPatterns: [RegExp, string][] = [
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, '[REDACTED]'],
  [/\bBearer\s+[\w.\/-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\b(?:sk-[\w-]{12,}|rrt_[\w.-]{20,})/gi, '[REDACTED]'],
  [/\b(https?:\/\/)[^\s\/@]+:[^\s\/@]+@/gi, '$1[REDACTED]@'],
];

function scrubExtraPatterns(text: string): string {
  let out = text;
  for (const [pattern, replacement] of extraSecretPatterns) out = out.replace(pattern, replacement);
  return out;
}

function mapAllStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map(item => mapAllStrings(item, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapAllStrings(v, fn)]));
  }
  return value;
}

/** Builds a combined redactor from deployment configured secrets plus any run-scoped secrets. */
export function buildFeedbackRedactor(store: Store, extraSecrets: Iterable<string> = []): Redactor {
  const redactor = new Redactor();
  for (const value of configuredRedactor(store).values) redactor.add(value);
  for (const value of extraSecrets) redactor.add(value);
  return redactor;
}

/** Deeply redacts credentials from feedback text or JSON objects, then verifies via assertSecretFree. */
export function sanitizeFeedbackText(store: Store, value: string, redactor?: Redactor): string {
  const active = redactor ?? buildFeedbackRedactor(store);
  const cleaned = scrubExtraPatterns(publicText(value, active));
  assertSecretFree(cleaned, 'feedback_text', active.values);
  return cleaned;
}

export function sanitizeFeedbackPayload(store: Store, payload: FeedbackPayloadFile, extraSecrets: Iterable<string> = []): FeedbackPayloadFile {
  const redactor = buildFeedbackRedactor(store, extraSecrets);
  const egressCleaned = redactEgress(payload);
  const tokenCleaned = publicContent(egressCleaned, redactor);
  const deepCleaned = mapAllStrings(tokenCleaned, scrubExtraPatterns) as FeedbackPayloadFile;
  assertSecretFree(deepCleaned, 'feedback_payload', redactor.values);
  return deepCleaned;
}

/**
 * Atomically writes plaintext gzipped JSON to `<feedbackDir>/<id[:2]>/<id>.json.gz`:
 * 1) verify secret-free via assertSecretFree (fail-closed)
 * 2) gzipSync(JSON)
 * 3) open 0o600 tmp file -> writeAll -> fdatasyncSync -> close -> atomic renameSync
 * No encryption is applied on disk by design.
 */
export function writeFeedbackPayload(
  store: Store,
  id: string,
  payload: FeedbackPayloadFile,
  knownSecrets: Iterable<string> = [],
): { relpath: string; bytes: number; sha256: string; path: string } {
  const relpath = feedbackRelativePath(id);
  const target = feedbackFilePath(store, id);
  const secrets = new Set<string>(configuredRedactor(store).values);
  for (const s of knownSecrets) if (typeof s === 'string' && s.length >= 8) secrets.add(s);
  assertSecretFree(payload, 'feedback_payload', secrets);

  const gzipped = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sha256 = createHash('sha256').update(gzipped).digest('hex');

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeAll(fd, gzipped);
    fdatasyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { relpath, bytes: gzipped.length, sha256, path: target };
}

/**
 * Reads and verifies one plaintext `.json.gz` payload file with O_RDONLY | O_NOFOLLOW + fstatSync().isFile()
 * + payload_sha256 check. Fails closed with 409 feedback_payload_corrupt on missing, symlink, tampered, or corrupt files.
 */
export function readFeedbackPayload(store: Store, id: string, expectedSha256: string): FeedbackPayloadFile {
  const target = feedbackFilePath(store, id);
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
      return fail(409, 'feedback_payload_corrupt');
    }
    throw error;
  }
  let raw: Buffer;
  try {
    if (!fstatSync(fd).isFile()) return fail(409, 'feedback_payload_corrupt');
    raw = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) return fail(409, 'feedback_payload_corrupt');
  const actualSha = createHash('sha256').update(raw).digest('hex');
  if (!timingSafeEqual(Buffer.from(actualSha, 'hex'), Buffer.from(expectedSha256, 'hex'))) {
    return fail(409, 'feedback_payload_corrupt');
  }
  try {
    const decompressed = gunzipSync(raw, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    const parsed = JSON.parse(decompressed.toString('utf8')) as Partial<FeedbackPayloadFile>;
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || parsed.schema_version !== 1
      || !parsed.feedback
      || typeof parsed.feedback !== 'object'
      || !parsed.environment_snapshot
      || typeof parsed.environment_snapshot !== 'object'
    ) {
      return fail(409, 'feedback_payload_corrupt');
    }
    return parsed as FeedbackPayloadFile;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return fail(409, 'feedback_payload_corrupt');
  }
}

export function removeFeedbackFile(store: Store, id: string): { removed: boolean; bytes: number } {
  const target = feedbackFilePath(store, id);
  let bytes = 0;
  let removed = false;
  try {
    const st = lstatSync(target);
    if (st.isFile()) bytes = st.size;
    rmSync(target, { force: true });
    removed = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  try {
    rmdirSync(dirname(target));
  } catch { /* shard directory non-empty or already gone */ }
  return { removed, bytes };
}

/**
 * Sweeps unreferenced `.json.gz` payload files and stale `.tmp` files older than graceMs (default 1 hour).
 * Never removes files referenced by an existing SQLite index row or younger than graceMs.
 */
export function sweepOrphanFeedbackFiles(
  store: Store,
  now = Date.now(),
  graceMs = 3600_000,
): { count: number; bytes: number; failed: number } {
  const result = { count: 0, bytes: 0, failed: 0 };
  const root = resolve(store.feedbackDir);
  if (!existsSync(root)) return result;
  let shards;
  try {
    shards = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    result.failed++;
    console.error('[feedback] orphan sweep failed reading root:', error);
    return result;
  }
  const cutoff = now - graceMs;
  for (const shard of shards) {
    if (!shard.isDirectory() || !/^[a-zA-Z0-9_-]{2}$/.test(shard.name)) continue;
    const shardDir = join(root, shard.name);
    let entries;
    try {
      entries = readdirSync(shardDir, { withFileTypes: true });
    } catch (error) {
      result.failed++;
      console.error('[feedback] orphan sweep failed reading shard ' + shard.name + ':', error);
      continue;
    }
    for (const entry of entries) {
      const path = join(shardDir, entry.name);
      const gzMatch = /^([a-zA-Z0-9_-]{8,120})\.json\.gz$/.exec(entry.name);
      const isTmp = /^[a-zA-Z0-9_-]{8,120}\.json\.gz\.[a-f0-9]{12}\.tmp$/.test(entry.name);
      if (!gzMatch && !isTmp) continue;
      let st;
      try {
        st = lstatSync(path);
      } catch (error) {
        result.failed++;
        console.error('[feedback] orphan sweep stat failed:', error);
        continue;
      }
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      if (gzMatch && store.get('SELECT 1 FROM feedback_entries WHERE id=?', gzMatch[1]!)) continue;
      try {
        rmSync(path, { force: true });
        result.count++;
        result.bytes += st.size;
      } catch (error) {
        result.failed++;
        console.error('[feedback] orphan sweep remove failed:', error);
      }
    }
    try {
      rmdirSync(shardDir);
    } catch { /* non-empty shard stays */ }
  }
  return result;
}

/**
 * Deletes expired feedback entries older than `beforeIso` (both SQLite index row and `.json.gz` file).
 */
export function pruneExpiredFeedback(
  store: Store,
  beforeIso: string,
  batchSize = 200,
): { count: number; bytes: number; failed: number } {
  const result = { count: 0, bytes: 0, failed: 0 };
  const rows = store.all(
    'SELECT id FROM feedback_entries WHERE created_at<? ORDER BY created_at ASC, id ASC LIMIT ?',
    beforeIso,
    batchSize,
  );
  for (const row of rows) {
    const id = String(row.id);
    try {
      let removedBytes = 0;
      store.transaction(() => {
        store.run('DELETE FROM feedback_entries WHERE id=?', id);
        store.afterCommit(() => {
          try {
            const removed = removeFeedbackFile(store, id);
            removedBytes = removed.bytes;
          } catch (error) {
            result.failed++;
            console.error('[feedback] removing expired payload file failed for ' + id + ':', error);
          }
        });
      });
      result.count++;
      result.bytes += removedBytes;
    } catch (error) {
      result.failed++;
      console.error('[feedback] pruning expired entry failed for ' + id + ':', error);
    }
  }
  return result;
}

export interface FeedbackListFilter {
  status?: FeedbackStatus | 'all';
  category?: FeedbackCategory;
  severity?: FeedbackSeverity;
  source_kind?: FeedbackSourceKind;
  repository_id?: string;
  untrusted?: boolean;
  q?: string;
  offset?: number;
  limit?: number;
}

export function feedbackStatusCounts(store: Store): Record<'all' | FeedbackStatus, number> {
  const counts: Record<'all' | FeedbackStatus, number> = {
    all: 0,
    open: 0,
    triaged: 0,
    resolved: 0,
    dismissed: 0,
  };
  for (const row of store.all('SELECT status, count(*) AS n FROM feedback_entries GROUP BY status')) {
    const status = String(row.status) as FeedbackStatus;
    const n = Number(row.n ?? 0);
    if (Object.hasOwn(counts, status)) {
      counts[status] = n;
      counts.all += n;
    }
  }
  return counts;
}

export function listFeedbackRepositories(store: Store): { repository_id: string; repository_full_name: string; deleted: boolean }[] {
  const rows = store.all(`
    SELECT f.repository_id, max(coalesce(f.repository_full_name, f.repository_id)) AS repository_full_name,
      CASE WHEN r.id IS NULL THEN 1 ELSE 0 END AS deleted
    FROM feedback_entries f
    LEFT JOIN repositories r ON r.id = f.repository_id
    WHERE f.repository_id IS NOT NULL
    GROUP BY f.repository_id
    ORDER BY repository_full_name COLLATE NOCASE ASC
  `);
  return rows.map(row => ({
    repository_id: String(row.repository_id),
    repository_full_name: String(row.repository_full_name),
    deleted: Boolean(row.deleted),
  }));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function listFeedbackEntries(store: Store, filter: FeedbackListFilter = {}): {
  entries: (FeedbackEntryRow & { repository_deleted: boolean })[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
} {
  const where: string[] = [];
  const args: (string | number)[] = [];

  if (filter.status && filter.status !== 'all') {
    where.push('f.status=?');
    args.push(filter.status);
  }
  if (filter.category) {
    where.push('f.category=?');
    args.push(filter.category);
  }
  if (filter.severity) {
    where.push('f.severity=?');
    args.push(filter.severity);
  }
  if (filter.source_kind) {
    where.push('f.source_kind=?');
    args.push(filter.source_kind);
  }
  if (filter.repository_id !== undefined) {
    if (filter.repository_id === '__none__') {
      where.push('f.repository_id IS NULL');
    } else {
      where.push('f.repository_id=?');
      args.push(filter.repository_id);
    }
  }
  if (filter.untrusted !== undefined) {
    where.push('f.untrusted_context=?');
    args.push(filter.untrusted ? 1 : 0);
  }
  if (filter.q && filter.q.trim()) {
    const pattern = `%${escapeLike(filter.q.trim())}%`;
    where.push("(f.title LIKE ? ESCAPE '\\' OR coalesce(f.repository_full_name,'') LIKE ? ESCAPE '\\' OR coalesce(f.role_id,'') LIKE ? ESCAPE '\\' OR coalesce(f.target_ref,'') LIKE ? ESCAPE '\\' OR coalesce(f.task_id,'') LIKE ? ESCAPE '\\')");
    args.push(pattern, pattern, pattern, pattern, pattern);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = Math.max(0, Math.floor(filter.offset ?? 0));
  const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? 20)));

  const total = Number(store.get(`SELECT count(*) AS n FROM feedback_entries f ${clause}`, ...args)?.n ?? 0);
  const rows = store.all(
    `SELECT f.*, CASE WHEN f.repository_id IS NOT NULL AND r.id IS NULL THEN 1 ELSE 0 END AS repository_deleted
     FROM feedback_entries f
     LEFT JOIN repositories r ON r.id = f.repository_id
     ${clause}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT ? OFFSET ?`,
    ...args,
    limit,
    offset,
  );
  const entries = rows.map(row => ({
    ...mapFeedbackRow(row),
    repository_deleted: Boolean(row.repository_deleted),
  }));
  return { entries, total, offset, limit, has_more: offset + entries.length < total };
}

export function getFeedbackEntry(store: Store, id: string): FeedbackEntryRow | null {
  if (!feedbackIdPattern.test(id)) return null;
  const row = store.get('SELECT * FROM feedback_entries WHERE id=?', id);
  return row ? mapFeedbackRow(row) : null;
}

export function updateFeedbackTriage(
  store: Store,
  id: string,
  actorId: string,
  actorLabel: string,
  patch: { status?: FeedbackStatus; triage_note?: string | null },
): FeedbackEntryRow {
  const existing = getFeedbackEntry(store, id);
  if (!existing) return fail(404, 'feedback_not_found');
  const nextStatus = patch.status ?? existing.status;
  const nextNote = patch.triage_note !== undefined ? patch.triage_note : existing.triage_note;
  const now = new Date().toISOString();
  return store.transaction(() => {
    const current = getFeedbackEntry(store, id);
    if (!current) return fail(404, 'feedback_not_found');
    store.run(
      'UPDATE feedback_entries SET status=?, triage_note=?, triaged_by=?, triaged_at=?, updated_at=? WHERE id=?',
      nextStatus,
      nextNote,
      actorLabel,
      now,
      now,
      id,
    );
    store.audit(actorId, 'feedback.triaged', id, current.repository_id);
    return getFeedbackEntry(store, id)!;
  });
}

export function deleteFeedbackEntry(store: Store, id: string, actorId: string): { deleted: true; id: string } {
  const existing = getFeedbackEntry(store, id);
  if (!existing) return fail(404, 'feedback_not_found');
  store.transaction(() => {
    const current = getFeedbackEntry(store, id);
    if (!current) return fail(404, 'feedback_not_found');
    store.run('DELETE FROM feedback_entries WHERE id=?', id);
    store.audit(actorId, 'feedback.deleted', id, current.repository_id);
    store.afterCommit(() => {
      try {
        removeFeedbackFile(store, id);
      } catch (error) {
        console.error('[feedback] removing deleted payload file failed for ' + id + ':', error);
      }
    });
  });
  return { deleted: true, id };
}
