import type { Row, Store } from './database.js';
import { payloadHeader, segment, type RecordType, type TrajectoryScope } from './trajectories.js';
import { inlineLogBytes, inputBlobKeys, legacySnapshot, logData, storedInput } from './payloads.js';
import { createHash } from 'node:crypto';

// Moves payloads written before #436 out of SQLite rows into trajectory files, in the background after the control
// plane listens; readiness never waits for it. Each table is walked in rowid order in slices: a slice reads rows for at
// most `readMs`, appends their bodies to files, waits until the files are on disk (fdatasync, off the event loop),
// reads every record back against its hash, and then, in one short transaction, replaces the payload columns with
// headers and refs and saves the cursor. A restart resumes at the cursor. A row not reached yet still holds its payload,
// which every reader falls back to, so readers return the same content before and after.

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const migrationKey = 'trajectory_migration';

export interface PhaseState { cursor: number; migrated: number; skipped: number; failed: number; bytes: number; last_error: string | null; finished_at: string | null }
/** rate: records moved per second over the last minute. */
export interface MigrationState { started_at: string | null; updated_at: string | null; rate: number; phases: Record<string, PhaseState> }

/** One row's move: the records it appended (or blobs it stored) and the update that points the row to them. */
interface Move { refs: string[]; blobs?: string[]; bytes: number; apply: () => void }
interface Phase { name: string; table: string; move(row: Row): Move | null }

/** A per-task file for records written before their run was known. */
export function legacyScope(repositoryId: string, taskId: string): TrajectoryScope {
  return { key: 'legacy:' + taskId, path: `${segment(repositoryId)}/${segment(taskId)}/legacy`, repository_id: repositoryId, task_id: taskId, run_id: null, conversation_id: null, turn_id: null };
}
/** A per-conversation file for conversation records written before #436. */
export function legacyConversationScope(conversationId: string, repositoryId: string | null): TrajectoryScope {
  return { key: 'legacy-conversation:' + conversationId, path: `conversations/${segment(conversationId)}/legacy`, repository_id: repositoryId, task_id: null, run_id: null,
    conversation_id: conversationId, turn_id: null };
}

export class PayloadMigration {
  private stopped = false;
  private running?: Promise<void>;
  private wake?: () => void;
  // Legacy files this migration has open, oldest first; closed beyond `openFiles` so descriptors stay bounded.
  private readonly touched = new Map<string, TrajectoryScope>();
  private readonly repositories = new Map<string, string | null>();
  // Records moved per slice in the last minute: [time, records].
  private readonly recent: [number, number][] = [];
  constructor(private readonly store: Store, private readonly options: { readMs?: number; pauseMs?: number; openFiles?: number; idleMs?: number; log?: (line: string) => void } = {}) {}

  /** Starts the background work; call after the service listens. */
  start(): void { if (!this.running) this.running = this.loop().catch(error => (this.options.log ?? console.error)('[migration] stopped: ' + String(error))); }
  async stop(): Promise<void> { this.stopped = true; this.wake?.(); await this.running; }
  /** Waits ms, or less when stopped. */
  private pause(ms: number) {
    // stop() may run during a slice's file sync, before this pause has registered its wake callback.
    if (this.stopped) return Promise.resolve();
    return new Promise<void>(resolve => { const timer = setTimeout(done, ms); timer.unref?.(); function done() { clearTimeout(timer); resolve(); } this.wake = done; });
  }

  /** Progress for the storage page (see migrationProgress). */
  state() { return migrationProgress(this.store); }

  private async loop() {
    const state = readState(this.store);
    state.started_at ??= new Date().toISOString();
    try {
      for (;;) {
        for (const phase of this.phases()) {
          if (this.stopped) return;
          if (this.store.hasTable(phase.table)) await this.run(phase, state);
        }
        this.closeTouched(0);
        if (this.stopped) return;
        // Rows written later without a file (no run to file them under) are picked up on the next pass.
        await this.pause(this.options.idleMs ?? 10 * 60_000);
      }
    } finally { this.closeTouched(0); }
  }

  private async run(phase: Phase, state: MigrationState): Promise<number> {
    const progress = state.phases[phase.name] ??= { cursor: 0, migrated: 0, skipped: 0, failed: 0, bytes: 0, last_error: null, finished_at: null };
    const next = this.store.db.prepare(`SELECT rowid AS migration_rowid,* FROM ${phase.table} WHERE rowid>? ORDER BY rowid LIMIT 1`);
    let total = 0;
    while (!this.stopped) {
      const started = performance.now(), moves: Move[] = [];
      let cursor = progress.cursor, skipped = 0, failed = 0, error: string | null = null;
      // Read at least one row, then until the slice's time is used; a single row is bounded by its own size.
      for (let read = 0; read === 0 || performance.now() - started < (this.options.readMs ?? 25) && moves.length < 200; read++) {
        const row = next.get(cursor) as Row | undefined;
        if (!row) break;
        cursor = Number(row.migration_rowid);
        try { const move = phase.move(row); if (move) moves.push(move); else skipped++; }
        catch (failure) { failed++; error = `${phase.table} rowid ${cursor}: ${String((failure as Error)?.message ?? failure).slice(0, 300)}`; }
      }
      if (cursor === progress.cursor) { progress.finished_at ??= new Date().toISOString(); this.save(state); return total; }
      // The files reach the disk before any row stops holding its payload; each record is read back against its hash.
      await Promise.all([...new Set(moves.map(move => move.refs.at(-1)!).filter(Boolean))].map(ref => this.store.trajectories.sync(ref)));
      const verified = moves.filter(move => {
        try { for (const ref of move.refs) this.store.trajectories.read(ref); for (const blob of move.blobs ?? []) this.store.trajectories.getBlob(blob); return true; }
        catch (failure) { failed++; error = String((failure as Error).message).slice(0, 300); return false; }
      });
      const now = Date.now();
      this.recent.push([now, verified.length]);
      while (this.recent.length && this.recent[0]![0] < now - 60_000) this.recent.shift();
      state.rate = Math.round(this.recent.reduce((sum, [, count]) => sum + count, 0) / Math.max(1, (now - this.recent[0]![0]) / 1000));
      this.store.transaction(() => {
        for (const move of verified) move.apply();
        Object.assign(progress, { cursor, migrated: progress.migrated + verified.length, skipped: progress.skipped + skipped, failed: progress.failed + failed,
          bytes: progress.bytes + verified.reduce((sum, move) => sum + move.bytes, 0), last_error: error ?? progress.last_error, finished_at: null });
        this.save(state);
      });
      total += verified.length;
      this.closeTouched(this.options.openFiles ?? 32);
      // Leave at least as much time to everything else as this slice took.
      await this.pause(Math.max(this.options.pauseMs ?? 10, performance.now() - started));
    }
    return total;
  }

  private save(state: MigrationState) {
    state.updated_at = new Date().toISOString();
    this.store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', migrationKey, JSON.stringify(state));
  }

  private append(scope: TrajectoryScope, type: RecordType, id: string, data: unknown): string {
    this.touched.delete(scope.key); this.touched.set(scope.key, scope);
    return this.store.trajectories.append(scope, type, id, data);
  }
  private closeTouched(keep: number) {
    while (this.touched.size > keep) { const [key] = this.touched.keys(); this.touched.delete(key!); this.store.trajectories.close(key!); }
  }
  private repository(taskId: string): string | null {
    if (!this.repositories.has(taskId)) { if (this.repositories.size > 10_000) this.repositories.clear(); this.repositories.set(taskId, this.store.get('SELECT repository_id FROM tasks WHERE id=?', taskId)?.repository_id ?? null); }
    return this.repositories.get(taskId)!;
  }
  private taskScope(taskId: string | null): TrajectoryScope | null {
    const repository = taskId ? this.repository(taskId) : null;
    return taskId && repository ? legacyScope(repository, taskId) : null;
  }

  private phases(): Phase[] {
    const s = this.store;
    const operation = (table: 'task_tools' | 'role_conversation_operations' | 'service_role_operations'): Phase => ({ name: table, table, move: row => {
      // Only completed calls: a pending one may still be finished by a call in flight.
      if (row.state !== 'completed' || row.request_ref || row.result_ref) return null;
      const conversation = table !== 'task_tools';
      const request = conversation ? s.secrets.open(row.request, 'conversation-operation:' + row.id + ':request') : JSON.parse(row.request);
      const result = row.result === null ? null : conversation ? s.secrets.open(row.result, 'conversation-operation:' + row.id + ':result') : JSON.parse(row.result);
      const text = conversation ? JSON.stringify(request) : String(row.request);
      const scope = conversation ? this.conversationOf(table, row) : this.taskScope(row.task_id);
      if (!scope) return null;
      const requestRef = this.append(scope, 'tool_call', row.id, request), resultRef = this.append(scope, 'tool_result', row.id, result);
      return { refs: [requestRef, resultRef], bytes: text.length + String(row.result ?? '').length, apply: () => s.run(
        `UPDATE ${table} SET request=?,result=?,request_ref=?,result_ref=?,request_sha256=? WHERE id=? AND request_ref IS NULL AND result_ref IS NULL AND state='completed'`,
        conversation ? '{}' : JSON.stringify(payloadHeader(request)), conversation ? null : JSON.stringify(payloadHeader(result)), requestRef, resultRef, sha256(text), row.id) };
    } });
    return [
      operation('task_tools'), operation('role_conversation_operations'), operation('service_role_operations'),
      { name: 'model_requests', table: 'model_requests', move: row => {
        if (row.finished_at === null || row.request_ref || row.response_ref || (row.request_snapshot === null && row.response_snapshot === null)) return null;
        const scope = row.conversation_id ? legacyConversationScope(String(row.conversation_id), row.repository_id ?? null) : this.taskScope(row.task_id)
          ?? (row.repository_id ? legacyScope(String(row.repository_id), 'unassigned') : null);
        if (!scope) return null;
        const snapshot = (part: 'request' | 'response') => { const text = legacySnapshot(s, row, part); return text === null ? null : { $snapshot: JSON.parse(text) }; };
        const refs: string[] = [], request = snapshot('request'), response = snapshot('response');
        const requestRef = request ? this.append(scope, 'model_request', row.id, request) : null, responseRef = response ? this.append(scope, 'model_response', row.id, response) : null;
        if (requestRef) refs.push(requestRef); if (responseRef) refs.push(responseRef);
        return { refs, bytes: String(row.request_snapshot ?? '').length + String(row.response_snapshot ?? '').length, apply: () => s.run(
          'UPDATE model_requests SET request_snapshot=NULL,response_snapshot=NULL,request_ref=?,response_ref=? WHERE id=? AND request_ref IS NULL AND response_ref IS NULL', requestRef, responseRef, row.id) };
      } },
      { name: 'task_logs', table: 'task_logs', move: row => {
        if (row.content_ref || Buffer.byteLength(String(row.content)) <= inlineLogBytes) return null;
        const data = logData(String(row.content)), scope = this.taskScope(row.task_id);
        if (!scope || '$text' in (data as object)) return null;
        const ref = this.append(scope, 'log', row.id, data);
        return { refs: [ref], bytes: String(row.content).length, apply: () => s.run('UPDATE task_logs SET content=?,content_ref=? WHERE id=? AND content_ref IS NULL',
          JSON.stringify(payloadHeader(data, ['detail'])), ref, row.id) };
      } },
      { name: 'tasks', table: 'tasks', move: row => {
        // A task's large file lists become blobs (written and synced by putBlob); a task changed meanwhile keeps its input.
        const input = JSON.parse(String(row.input || '{}')), text = storedInput(s, input, String(row.repository_id));
        if (text.length === String(row.input).length) return null;
        const blobs = inputBlobKeys.map(key => JSON.parse(text)[key]?.$blob).filter((hash): hash is string => typeof hash === 'string');
        return { refs: [], blobs, bytes: String(row.input).length - text.length, apply: () => s.run('UPDATE tasks SET input=? WHERE id=? AND input=?', text, row.id, row.input) };
      } },
      { name: 'task_history', table: 'task_history', move: row => {
        // Snapshots of runner calls and logs, copied by triggers: moved as they are, the row keeps the ref.
        if (!['operation', 'runtime_log'].includes(row.type) || String(row.data).length <= inlineLogBytes) return null;
        const data = JSON.parse(String(row.data));
        if (data?.$trajectory) return null;
        const scope = this.taskScope(row.task_id);
        if (!scope) return null;
        const ref = this.append(scope, 'event', 'task_history:' + row.id, data);
        // characters: what length(data) was, which the console's event list shows for a body it leaves out.
        const text = String(row.data), characters = text.length - (text.match(/[\uD800-\uDBFF]/g)?.length ?? 0);
        return { refs: [ref], bytes: text.length, apply: () => s.run('UPDATE task_history SET data=? WHERE id=?', JSON.stringify({ $trajectory: ref, characters }), row.id) };
      } },
    ];
  }
  private conversationOf(table: string, row: Row): TrajectoryScope | null {
    if (table === 'role_conversation_operations') {
      const turn = this.store.get('SELECT conversation_id,project_id FROM role_conversation_turns WHERE id=?', row.turn_id);
      return turn ? legacyConversationScope(String(turn.conversation_id), turn.project_id ?? null) : null;
    }
    return legacyConversationScope('service-' + String(row.turn_id).split(':')[0], null);
  }
}

/** The tables the migration walks, in order. */
export const migratedTables = ['task_tools', 'role_conversation_operations', 'service_role_operations', 'model_requests', 'task_logs', 'tasks', 'task_history'];

/**
 * Progress per table (cursor, counts, bytes, last error, finished time), the rate, and the rows not examined yet per
 * table, estimated as max(rowid) minus the cursor: never counted, so reading it costs one index lookup per table.
 */
export function migrationProgress(store: Store): MigrationState & { remaining: Record<string, number> } {
  const state = readState(store), remaining: Record<string, number> = {};
  for (const table of migratedTables) {
    const last = store.hasTable(table) ? Number(store.get(`SELECT max(rowid) n FROM ${table}`)?.n ?? 0) : 0;
    remaining[table] = Math.max(0, last - (state.phases[table]?.cursor ?? 0));
  }
  return { ...state, remaining };
}

function readState(store: Store): MigrationState {
  try { return JSON.parse(store.get('SELECT value FROM settings WHERE key=?', migrationKey)?.value ?? 'null') ?? fresh(); } catch { return fresh(); }
}
const fresh = (): MigrationState => ({ started_at: null, updated_at: null, rate: 0, phases: {} });
