import { configuredRedactor } from '../core/redaction.js';
import type { Row, Store } from './database.js';
import { payloadHeader, TrajectoryError } from './trajectories.js';
import { currentRunTrace, traceSnapshot } from '../tasks/trace.js';
import { randomId } from '../core/security.js';

// Readers of payloads that moved to trajectory files. A row written since #436 keeps a small header in its old column
// and a ref to its record; a row not migrated yet still holds the whole payload in the old column. Every reader that
// needs the whole payload goes through these, so migrated and not yet migrated rows read the same.

export type OperationTable = 'task_tools' | 'role_conversation_operations' | 'service_role_operations';
const sealed = (table: OperationTable) => table !== 'task_tools';

/** The whole request of a recorded runner call, as the JSON text it was recorded with. */
export function operationRequestText(store: Store, table: OperationTable, row: Row): string {
  if (row.request_ref) return JSON.stringify(store.trajectories.read(row.request_ref).data);
  return sealed(table) ? JSON.stringify(store.secrets.open(row.request, 'conversation-operation:' + row.id + ':request')) : String(row.request);
}

/** The whole result of a completed runner call, or null while it has none. */
export function operationResult(store: Store, table: OperationTable, row: Row): any {
  if (row.result_ref) return store.trajectories.read(row.result_ref).data;
  if (row.result === null || row.result === undefined) return null;
  return sealed(table) ? store.secrets.open(row.result, 'conversation-operation:' + row.id + ':result') : JSON.parse(row.result);
}

/** A log record's data: the parsed JSON object when it serializes back to the same text, otherwise {$text}. */
export function logData(content: string): unknown {
  try { const value = JSON.parse(content); if (value && typeof value === 'object' && !Array.isArray(value) && !('$text' in value) && JSON.stringify(value) === content) return value; } catch {}
  return { $text: content };
}

/** The whole content of a task log, the same text it was inserted with. */
export function logContent(store: Store, row: Row): string {
  if (!row.content_ref) return String(row.content);
  const data = store.trajectories.read(row.content_ref).data;
  return data && typeof data.$text === 'string' && Object.keys(data).length === 1 ? data.$text : JSON.stringify(data);
}

/** The trace snapshot of a model request or response, as stored before #436 (traceSnapshot JSON), or null. */
export function modelSnapshot(store: Store, row: Row, part: 'request' | 'response'): string | null {
  const ref = row[part + '_ref'];
  if (!ref) return legacySnapshot(store, row, part);
  // A snapshot moved from its column by the background migration is kept as it was stored.
  const data = store.trajectories.read(ref).data;
  if (data && typeof data === 'object' && '$snapshot' in data) return JSON.stringify(data.$snapshot);
  return traceSnapshot(part === 'request' ? store.trajectories.readModelRequest(ref) : data);
}

/** A snapshot still in its column: a conversation's was sealed as {snapshot}, any other is the snapshot JSON itself. */
export function legacySnapshot(store: Store, row: Row, part: 'request' | 'response'): string | null {
  const value = row[part + '_snapshot'];
  if (value === null || value === undefined || String(value).startsWith('{')) return value ?? null;
  return String((store.secrets.open(String(value), 'conversation-model-' + part + ':' + row.id) as { snapshot: string }).snapshot);
}

/** A reader's answer for a record whose file is missing or fails verification. */
export function unreadable(error: unknown) {
  if (error instanceof TrajectoryError) return { complete: false, missing_reason: error.code, detail: error.detail };
  throw error;
}

/**
 * A task_history row's data. The snapshot an operation or a large log left there since #436 holds small fields and
 * refs; it is rebuilt from the trajectory file exactly as the full snapshot was stored before.
 */
export function historyData(store: Store, row: Row): string {
  if (row.type !== 'operation' && row.type !== 'runtime_log') return row.data;
  const stored = JSON.parse(row.data), data = stored?.data;
  // A snapshot the background migration moved to a file as it was.
  if (typeof stored?.$trajectory === 'string') return JSON.stringify(store.trajectories.read(stored.$trajectory).data);
  if (row.type === 'operation' && typeof data?.request_ref === 'string') {
    const request = JSON.stringify(store.trajectories.read(data.request_ref).data);
    const result = typeof data.result_ref === 'string' ? JSON.stringify(store.trajectories.read(data.result_ref).data) : null;
    return traceSnapshot({ operation_id: data.operation_id, state: data.state, request, result });
  }
  if (row.type === 'runtime_log' && typeof data?.content_ref === 'string') return traceSnapshot(JSON.parse(logContent(store, { content_ref: data.content_ref })));
  return row.data;
}

/** The size of the body a history snapshot refers to (characters when recorded, else record bytes), or null for one that holds its own data. */
export function historyRefBytes(row: Row): number | null {
  if (row.type !== 'operation' && row.type !== 'runtime_log') return null;
  let stored: any; try { stored = JSON.parse(row.data); } catch { return null; }
  if (typeof stored?.$trajectory === 'string' && Number.isSafeInteger(stored.characters)) return stored.characters;
  const data = stored?.data, refs = [stored?.$trajectory, data?.request_ref, data?.result_ref, data?.content_ref].filter((ref): ref is string => typeof ref === 'string');
  return refs.length ? refs.reduce((sum, ref) => sum + Number(ref.split(':')[2] ?? 0), 0) : null;
}

/** Logs larger than this go to the run's trajectory file; the row keeps their small fields. */
export const inlineLogBytes = 2048;

/**
 * Inserts a task log. A large log of a task inside a run goes to the run's trajectory file: the row keeps its small
 * fields (type, phase, code, a clipped detail…) for queries and a ref for the whole text. Callers mask registered credentials before serializing the log.
 */
export function insertTaskLog(store: Store, task: Row, content: string, createdAt = new Date().toISOString(), id = randomId()): string {
  content = configuredRedactor(store).text(content);
  const { runId, role } = currentRunTrace(task);
  const scopedTask = runId && runId !== task.trace_run_id ? { ...task, trace_run_id: runId } : task;
  const scope = Buffer.byteLength(content) > inlineLogBytes ? store.trajectories.scopeOf(scopedTask) : null, data = scope ? logData(content) : null;
  if (scope && data && !('$text' in (data as object))) {
    const ref = store.trajectories.append(scope, 'log', id, data);
    store.run('INSERT INTO task_logs(id,task_id,content,created_at,content_ref,run_id,role) VALUES(?,?,?,?,?,?,?)', id, task.id, JSON.stringify(payloadHeader(data, ['detail'])), createdAt, ref, runId, role);
  } else store.run('INSERT INTO task_logs(id,task_id,content,created_at,run_id,role) VALUES(?,?,?,?,?,?)', id, task.id, content, createdAt, runId, role);
  return id;
}

/** Task input keys whose large values (a pull request's changed files, the repository's file list) are stored as blobs. */
export const inputBlobKeys = ['files', 'snapshot_files', 'skipped_files'] as const;
/** Development candidate keys whose large file arrays are stored as content-addressed blobs outside SQLite (#1304). */
export const candidateBlobKeys = ['files', 'snapshot_files', 'skipped_files'] as const;
/** Values whose JSON is larger than this become blobs. */
export const inputBlobBytes = 2048;

const candidateBlobRefs = new WeakMap<object, Map<string, { value: unknown; ref: { $blob: string; bytes: number } }>>();

/**
 * The JSON text a task's input is stored as: its large file lists replaced by blob references. Readers of those keys
 * resolve them with blobValue; every other key, and code that copies the input forward, sees the input as before.
 */
export function storedInput(store: Store, input: Record<string, any>, repositoryId: string): string {
  const stored = { ...input };
  for (const key of inputBlobKeys) {
    const value = stored[key];
    if (Array.isArray(value) && JSON.stringify(value).length > inputBlobBytes) stored[key] = store.trajectories.putBlob(value, repositoryId);
  }
  return JSON.stringify(stored);
}

/** A task input value that may be a blob reference. */
export function blobValue<T = any>(store: Store, value: T | { $blob: string }): T {
  return value && typeof value === 'object' && typeof (value as { $blob?: unknown }).$blob === 'string' ? store.trajectories.getBlob((value as { $blob: string }).$blob) as T : value as T;
}

/**
 * The JSON text a development_candidates row is stored as: large file/snapshot lists become content-addressed blobs so
 * hot metadata reads (`base_sha`, `tree_sha`, `branch`, `published`, `remote_sha`) never parse multi-megabyte SQLite rows.
 */
export function storedCandidate(store: Store, candidate: Record<string, any>, repositoryId: string): string {
  const stored = { ...candidate };
  const cached = candidateBlobRefs.get(candidate);
  for (const key of candidateBlobKeys) {
    const value = stored[key];
    if (!Array.isArray(value)) continue;
    const hit = cached?.get(key);
    if (hit && hit.value === value) { stored[key] = hit.ref; continue; }
    if (JSON.stringify(value).length > inputBlobBytes) {
      const ref = store.trajectories.putBlob(value, repositoryId);
      stored[key] = ref;
      let map = candidateBlobRefs.get(candidate);
      if (!map) { map = new Map(); candidateBlobRefs.set(candidate, map); }
      map.set(key, { value, ref });
    }
  }
  return JSON.stringify(stored);
}

/** Persists a development candidate with its large file arrays externalized to the blob store. */
export function saveDevelopmentCandidate(store: Store, taskId: string, candidate: Record<string, any>, repositoryId?: string): void {
  const repoId = repositoryId || String(store.get('SELECT repository_id FROM tasks WHERE id=?', taskId)?.repository_id ?? '');
  const text = repoId ? storedCandidate(store, candidate, repoId) : JSON.stringify(candidate);
  store.run('INSERT INTO development_candidates VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data', taskId, text);
}

/** Reads a development candidate and expands any externalized blob arrays, caching their refs for fast metadata saves. */
export function loadDevelopmentCandidate(store: Store, taskId: string): any {
  const row = store.get('SELECT data FROM development_candidates WHERE task_id=?', taskId);
  if (!row?.data) return null;
  const candidate = JSON.parse(String(row.data));
  if (!candidate || typeof candidate !== 'object') return candidate;
  const refs = new Map<string, { value: unknown; ref: { $blob: string; bytes: number } }>();
  for (const key of candidateBlobKeys) {
    const raw = candidate[key];
    if (raw && typeof raw === 'object' && typeof raw.$blob === 'string') {
      const resolved = blobValue(store, raw);
      candidate[key] = resolved;
      refs.set(key, { value: resolved, ref: raw });
    }
  }
  if (refs.size) candidateBlobRefs.set(candidate, refs);
  return candidate;
}

/**
 * Reads only the lightweight metadata of a development candidate without loading externalized blobs.
 * Strips raw `{ $blob }` placeholders from file-array keys so metadata-only callers can never treat a blob ref as an array.
 */
export function loadDevelopmentCandidateMeta(store: Store, taskId: string): any {
  const row = store.get('SELECT data FROM development_candidates WHERE task_id=?', taskId);
  if (!row?.data) return null;
  const candidate = JSON.parse(String(row.data));
  if (!candidate || typeof candidate !== 'object') return candidate;
  for (const key of candidateBlobKeys) {
    const raw = candidate[key];
    if (raw && typeof raw === 'object' && typeof raw.$blob === 'string') delete candidate[key];
  }
  return candidate;
}

/** Drops inline base64 file bodies from a confirmed-published candidate while keeping its path/sha/mode manifest. */
export function stripPublishedCandidateBodies(store: Store, taskId: string, candidate: Record<string, any>, repositoryId?: string): void {
  if (!Array.isArray(candidate?.files) || !candidate.files.some((f: any) => typeof f?.base64 === 'string')) return;
  const slim = { ...candidate, files: candidate.files.map(({ base64: _b, ...rest }: any) => rest) };
  saveDevelopmentCandidate(store, taskId, slim, repositoryId);
}
