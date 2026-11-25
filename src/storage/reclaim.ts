import type { Store } from './database.js';
import { retentionSettings, type RetentionCleanup } from './retention.js';
import type { Manager } from '../projects/service.js';
import type { Json } from '../core/security.js';

interface Removed { count: number; bytes?: number; failed?: number }
type Result = { status: 'running' | 'completed' | 'partial' | 'failed'; started_at: string; finished_at?: string;
  count: number; file_bytes: number; payload_bytes: number; failed: number };

/** Same shared workers as the timers. The HTTP request only admits the pass; another tab can follow it. */
export class ManualReclaim {
  private active?: Promise<void>;
  private latest?: Result;
  constructor(private store: Store, private retention: RetentionCleanup, private manager: Manager | undefined,
    private workspaces: {run(): Promise<Removed>} | undefined, private refresh: () => Promise<void>) {}

  state(): Json {
    if (this.latest) return this.latest;
    const saved = this.store.get("SELECT value FROM settings WHERE key='manual_reclaim'");
    if (!saved) return { status: 'idle' };
    const last: Result = JSON.parse(saved.value);
    return last.status === 'running' ? { ...last, status: 'interrupted' } : last;
  }
  start(actor: string): Json {
    if (this.active) return this.state();
    const result: Result = { status: 'running', started_at: new Date().toISOString(), count: 0, file_bytes: 0, payload_bytes: 0, failed: 0 };
    this.store.transaction(() => { this.store.audit(actor, 'storage.reclaim.started', 'storage'); this.save(result); });
    this.latest = result;
    this.active = this.pass(result).catch(() => { result.status = 'failed'; result.failed++; }).finally(() => {
      result.finished_at = new Date().toISOString();
      try { this.save(result); } catch { result.status = 'failed'; }
      this.active = undefined;
    });
    return result;
  }
  settle() { return this.active; }
  private save(result: Result) {
    this.store.run("INSERT INTO settings VALUES('manual_reclaim',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(result));
  }
  private async pass(result: Result) {
    const add = (part: Removed, key: 'file_bytes' | 'payload_bytes' = 'file_bytes') => {
      result.count += part.count; result[key] += part.bytes ?? 0; result.failed += part.failed ?? 0;
    };
    const daily = await this.retention.run();
    if (daily.finished_at) {
      for (const key of ['trajectories', 'evidence', 'channel_resources', 'channel_cards', 'feedback', 'skill_store', 'deliveries', 'commit_checks', 'dispatch_failures', 'dispatch_threads', 'memory_consolidation_runs', 'project_notes']) {
        const part = daily[key] as Removed | undefined;
        if (part) add(part, key === 'deliveries' ? 'payload_bytes' : 'file_bytes');
      }
    }
    if (!daily.finished_at || daily.last_error && !result.failed) result.failed++;
    if (this.manager) {
      try {
        this.store.checkAuthorization();
        const expired = await this.manager.call('POST', '/v1/storage/reclaim', { payload_days: retentionSettings(this.store).manager_payload_days }, 0);
        if (!Number.isSafeInteger(expired?.files) || !Number.isSafeInteger(expired?.bytes)) throw new Error('incomplete_manager_result');
        add({ count: expired.files, bytes: expired.bytes });
      } catch { result.failed++; }
    }
    if (this.workspaces) {
      this.store.checkAuthorization();
      add(await this.workspaces.run());
    }
    await this.refresh();
    result.status = result.failed ? 'partial' : 'completed';
  }
}
