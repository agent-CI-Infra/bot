import type { Row, Store } from './database.js';
import { payloadHeader, TrajectoryError } from './trajectories.js';
import { traceSnapshot } from '../tasks/trace.js';
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
 * fields (type, phase, code, a clipped detail…) for queries and a ref for the whole text.
 */
export function insertTaskLog(store: Store, task: Row, content: string, createdAt = new Date().toISOString(), id = randomId()): string {
  const scope = Buffer.byteLength(content) > inlineLogBytes ? store.trajectories.scopeOf(task) : null, data = scope ? logData(content) : null;
  if (scope && data && !('$text' in (data as object))) {
    const ref = store.trajectories.append(scope, 'log', id, data);
    store.run('INSERT INTO task_logs(id,task_id,content,created_at,content_ref) VALUES(?,?,?,?,?)', id, task.id, JSON.stringify(payloadHeader(data, ['detail'])), createdAt, ref);
  } else store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)', id, task.id, content, createdAt);
  return id;
}

/** Task input keys whose large values (a pull request's changed files, the repository's file list) are stored as blobs. */
export const inputBlobKeys = ['files', 'snapshot_files', 'skipped_files'] as const;
/** Values whose JSON is larger than this become blobs. */
export const inputBlobBytes = 2048;

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
