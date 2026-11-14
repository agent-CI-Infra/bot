import { createHash } from 'node:crypto';
import type { Row, Store } from './database.js';
import type { Manager } from '../projects/service.js';
import { fail, type Json } from '../core/security.js';

// Cleanup by days (#671). One set of settings for what the bot keeps and for how long, saved in settings.storage_retention
// by platform administrators (audited) and applied by a daily background job in bounded batches. A cleanup removes
// payloads and keeps the rows, accounting, audit and hashes; a reference to a removed payload reads as expired.
//
// - trajectory_days: control-plane trajectory files of finished tasks and of Manager dispatches, closed longer ago;
//   a project can override it. Records of one run share one file, so the window is per file, not per record type.
//   Conversation files are not touched (a continued conversation reads its earlier turns).
// - manager_payload_days: the manager's copies of runner-call bodies (TrajectoryExpiry, default 2), pushed to the manager.
// - workspace_finished_days / workspace_failed_days: the task workspace rules of #444 (1 and 7 days by default).
// - webhook_payload_days: the bodies of received webhook deliveries; the row, status and headers stay, with the body's
//   sha256. At least 7 days: daily reports and external executors read recent deliveries.
// Unset (null) keeps everything, as decided in #436; the manager window and the workspace rules keep their defaults.
export interface RetentionSettings {
  trajectory_days: number | null;
  trajectory_days_by_project: Record<string, number>;
  manager_payload_days: number;
  workspace_finished_days: number;
  workspace_failed_days: number;
  webhook_payload_days: number | null;
}
export const retentionDefaults: RetentionSettings = { trajectory_days: null, trajectory_days_by_project: {}, manager_payload_days: 2, workspace_finished_days: 1,
  workspace_failed_days: 7, webhook_payload_days: null };
export const retentionBounds: Record<string, [number, number]> = { trajectory_days: [1, 3650], manager_payload_days: [1, 365], workspace_finished_days: [1, 365],
  workspace_failed_days: [1, 365], webhook_payload_days: [7, 3650] };
const nullable = new Set(['trajectory_days', 'webhook_payload_days']);
const day = 24 * 3600_000;
// Statuses after which a task's files are not read again by its own execution (src/projects/workspace-cleanup.ts).
const ended = ['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded', 'failed'];

export function retentionSettings(store: Store): RetentionSettings {
  let saved: Partial<RetentionSettings> = {};
  try { saved = JSON.parse(store.get("SELECT value FROM settings WHERE key='storage_retention'")?.value ?? '{}'); } catch {}
  return { ...retentionDefaults, ...saved, trajectory_days_by_project: { ...saved.trajectory_days_by_project ?? {} } };
}

const valid = (key: string, value: unknown) => {
  const [min, max] = retentionBounds[key]!;
  return value === null ? nullable.has(key) : Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
};
/**
 * Saves a change: only the given fields, each inside its bounds (null only where it means "keep"). A project override
 * names an existing project; null removes it. Audited as storage.retention.updated.
 */
export function saveRetention(store: Store, userId: string, input: Json): RetentionSettings {
  const keys = Object.keys(retentionDefaults);
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) fail(400, 'storage_retention_invalid');
  for (const key of Object.keys(input)) if (!keys.includes(key)) fail(400, 'storage_retention_invalid', key);
  const next = retentionSettings(store);
  for (const [key, value] of Object.entries(input)) {
    if (key === 'trajectory_days_by_project') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'storage_retention_invalid', key);
      for (const [repo, days] of Object.entries(value as Record<string, unknown>)) {
        if (!store.get('SELECT 1 FROM repositories WHERE id=?', repo)) fail(400, 'storage_retention_invalid', key);
        if (days === null) delete next.trajectory_days_by_project[repo];
        else if (valid('trajectory_days', days) && days !== null) next.trajectory_days_by_project[repo] = days as number;
        else fail(400, 'storage_retention_invalid', key);
      }
    } else if (valid(key, value)) (next as any)[key] = value;
    else fail(400, 'storage_retention_invalid', key);
  }
  store.transaction(() => {
    store.run("INSERT INTO settings VALUES('storage_retention',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(next));
    store.audit(userId, 'storage.retention.updated', 'storage_retention');
  });
  return next;
}

/** The days a project's trajectory files are kept, or null to keep them. */
export function trajectoryDays(settings: RetentionSettings, repositoryId: string): number | null {
  return Object.hasOwn(settings.trajectory_days_by_project, repositoryId) ? settings.trajectory_days_by_project[repositoryId]! : settings.trajectory_days;
}

interface Removed { count: number; bytes: number; failed: number }
// Ids of deliveries whose body was kept because an external executor had not been sent them yet; revisited each pass.
const skippedLimit = 10_000;
/**
 * The daily cleanup: shortly after start, then once a day. It pushes the manager window when the manager reports
 * another, expires trajectory files and webhook payloads past their windows in batches with pauses, and records what
 * it removed and freed in settings.retention_cleanup. One file or row that cannot be handled is counted with its error
 * and left for a later pass; it never stops the rest. stop() waits for a pass in progress, which ends at its next step.
 * The task workspace rules apply in the hourly workspace sweep.
 */
export class RetentionCleanup {
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private running: Promise<Json> | null = null;
  private stopped = false;
  private wake?: () => void;
  private lastError: string | null = null;
  constructor(private readonly store: Store, private readonly manager?: Manager, private readonly options: { batch?: number; pauseMs?: number; firstDelayMs?: number; now?: () => number } = {}) {
    retentionStorage(store);
  }
  start(): void {
    this.first = setTimeout(() => void this.run(), this.options.firstDelayMs ?? 10 * 60_000); this.first.unref?.();
    this.timer = setInterval(() => void this.run(), day); this.timer.unref?.();
  }
  async stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.first); clearInterval(this.timer); this.wake?.();
    await this.running;
  }
  /** One cleanup; one already running is returned instead of starting another. Never rejects. */
  run(): Promise<Json> {
    if (this.stopped) return Promise.resolve({});
    return this.running ??= this.pass().catch(error => {
      if (this.stopped) return {};
      console.error('[retention] cleanup failed:', error);
      try { return this.record({ last_error: String((error as Error)?.message ?? error).slice(0, 300) }); } catch { return {}; }
    }).finally(() => { this.running = null; });
  }
  /** What the last cleanup did, for the storage page. */
  state(): Json {
    try { return JSON.parse(this.store.get("SELECT value FROM settings WHERE key='retention_cleanup'")?.value ?? 'null') ?? {}; } catch { return {}; }
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  // The pause between batches holds the process like the pass awaiting it; stop() ends it at once.
  private pause(ms: number) {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>(resolve => { const timer = setTimeout(done, ms); const wake = () => { clearTimeout(timer); resolve(); }; function done() { resolve(); } this.wake = wake; });
  }
  private record(value: Json): Json {
    const next = { ...this.state(), ...value };
    this.store.run("INSERT INTO settings VALUES('retention_cleanup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(next));
    return next;
  }
  private failure(what: string, error: unknown) {
    this.lastError = `${what}: ${String((error as Error)?.message ?? error).slice(0, 300)}`;
    console.error('[retention] ' + this.lastError);
  }

  private async pass(): Promise<Json> {
    this.lastError = null;
    const started = new Date(this.now()).toISOString(), settings = retentionSettings(this.store);
    const manager = await this.syncManager(settings.manager_payload_days);
    const trajectories = await this.trajectories(settings), deliveries = await this.deliveries(settings.webhook_payload_days);
    if (this.stopped) return {};
    return this.record({ started_at: started, finished_at: new Date(this.now()).toISOString(), trajectories, deliveries, manager_window: manager, last_error: this.lastError });
  }

  /** Tells the manager its window when it reports another; null when the manager did not answer. */
  async syncManager(days: number): Promise<number | null> {
    if (!this.manager) return null;
    try {
      const current = await this.manager.call('GET', '/v1/storage');
      if (current?.expiry?.window_days !== days) await this.manager.call('PUT', '/v1/storage/retention', { payload_days: days });
      return days;
    } catch (error) { console.error('[retention] setting the manager window failed:', (error as Error)?.message ?? error); return null; }
  }

  // Closed files of tasks that ended and of dispatches, older than their project's window, oldest first per project; a
  // task still going (a retry, a follow-up) keeps its files. The files are removed off the event loop after the entries
  // are marked; a stopped run's marked files are removed first. A file that cannot be removed stays marked for later.
  private async trajectories(settings: RetentionSettings): Promise<Removed> {
    const removed: Removed = { count: 0, bytes: 0, failed: 0 }, trajectories = this.store.trajectories;
    const remove = async (file: { id: string; path: string }) => {
      try { await trajectories.deleted(file); return true; } catch (error) { removed.failed++; this.failure(`trajectory file ${file.id}`, error); return false; }
    };
    for (const file of this.store.all('SELECT id,path FROM trajectory_files WHERE expired_at IS NOT NULL AND deleted_at IS NULL ORDER BY expired_at LIMIT 1000') as { id: string; path: string }[]) {
      if (this.stopped) return removed;
      await remove(file);
    }
    const next = this.store.db.prepare(`SELECT id,repository_id,task_id,path,bytes,counts,closed_at FROM trajectory_files
      WHERE repository_id=? AND expired_at IS NULL AND closed_at IS NOT NULL AND conversation_id IS NULL AND closed_at<? AND (closed_at,id)>(?,?) ORDER BY closed_at,id LIMIT ?`);
    for (const { id: repo } of this.store.all('SELECT id FROM repositories ORDER BY id')) {
      const days = trajectoryDays(settings, String(repo));
      if (days === null) continue;
      const before = new Date(this.now() - days * day).toISOString();
      let after: [string, string] = ['', ''];
      while (!this.stopped) {
        const batch = next.all(String(repo), before, ...after, this.options.batch ?? 50) as Row[];
        if (!batch.length) break;
        after = [String(batch.at(-1)!.closed_at), String(batch.at(-1)!.id)];
        const tasks = [...new Set(batch.map(file => file.task_id).filter(Boolean))];
        const finished = new Set(this.store.all(`SELECT id FROM tasks WHERE id IN (SELECT value FROM json_each(?)) AND status IN (${ended.map(() => '?').join(',')})`,
          JSON.stringify(tasks), ...ended).map(row => String(row.id)));
        const expiring = batch.filter(file => !file.task_id || finished.has(String(file.task_id)));
        trajectories.expire(expiring);
        for (const file of expiring) {
          if (this.stopped) return removed;
          if (await remove({ id: String(file.id), path: String(file.path) })) { removed.count++; removed.bytes += Number(file.bytes ?? 0); }
        }
        await this.pause(this.options.pauseMs ?? 50);
      }
    }
    return removed;
  }

  // Bodies of webhook deliveries received before the window, in received_at order from where the last cleanup stopped
  // (settings.retention_cleanup.deliveries_after; rows behind it are never read again, a body sits before every column
  // after it): the body becomes empty, its sha256 and size are kept with the time it was removed. A delivery an external
  // executor has not been sent yet keeps its body until it has been: its id is kept (deliveries_skipped) and looked at
  // again at the start of each pass.
  private async deliveries(days: number | null): Promise<Removed> {
    const removed: Removed = { count: 0, bytes: 0, failed: 0 };
    if (days === null) return removed;
    const before = new Date(this.now() - days * day).toISOString();
    const pending = () => new Set(this.store.all("SELECT DISTINCT source_id FROM external_deliveries WHERE state IN ('pending','retry','sending')").map(row => String(row.source_id)));
    const clear = (rows: Row[], waiting: Set<string>, skipped: Set<string>) => {
      const now = new Date(this.now()).toISOString();
      for (const row of rows) {
        if (waiting.has(String(row.id))) { skipped.add(String(row.id)); continue; }
        try {
          const body = Buffer.from(row.payload as Uint8Array);
          this.store.run("UPDATE deliveries SET payload=x'',payload_sha256=?,payload_bytes=?,payload_removed_at=? WHERE id=? AND payload_removed_at IS NULL",
            createHash('sha256').update(body).digest('hex'), body.length, now, row.id);
          skipped.delete(String(row.id)); removed.count++; removed.bytes += body.length;
        } catch (error) { removed.failed++; this.failure(`delivery ${row.id}`, error); }
      }
    };
    const saved = this.state(), skipped = new Set<string>((saved.deliveries_skipped as string[] | undefined) ?? []);
    if (skipped.size) {
      const rows = this.store.all("SELECT id,payload FROM deliveries WHERE id IN (SELECT value FROM json_each(?)) AND payload_removed_at IS NULL", JSON.stringify([...skipped]));
      const present = new Set(rows.map(row => String(row.id)));
      for (const id of [...skipped]) if (!present.has(id)) skipped.delete(id);
      this.store.transaction(() => { clear(rows, pending(), skipped); this.record({ deliveries_skipped: [...skipped] }); });
    }
    const next = this.store.db.prepare('SELECT id,received_at,payload FROM deliveries WHERE received_at<? AND (received_at,id)>(?,?) ORDER BY received_at,id LIMIT ?');
    let after = (saved.deliveries_after as [string, string] | undefined) ?? ['', ''];
    while (!this.stopped) {
      const batch = next.all(before, ...after, this.options.batch ?? 200) as Row[];
      if (!batch.length) break;
      after = [String(batch.at(-1)!.received_at), String(batch.at(-1)!.id)];
      const waiting = pending();
      this.store.transaction(() => {
        clear(batch, waiting, skipped);
        // Past the limit the oldest kept bodies are no longer tracked; they stay, as with no window.
        this.record({ deliveries_after: after, deliveries_skipped: [...skipped].slice(-skippedLimit) });
      });
      await this.pause(this.options.pauseMs ?? 50);
    }
    return removed;
  }
}

/** Columns the cleanup keeps for a delivery whose body it removed. */
export function retentionStorage(store: Store): void {
  for (const [column, type] of [['payload_sha256', 'TEXT'], ['payload_bytes', 'INTEGER'], ['payload_removed_at', 'TEXT']] as const)
    if (!store.all('PRAGMA table_info(deliveries)').some(row => row.name === column)) store.db.exec(`ALTER TABLE deliveries ADD COLUMN ${column} ${type}`);
}
