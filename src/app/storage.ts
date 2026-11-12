import { statSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Store } from '../storage/database.js';
import type { Manager } from '../projects/service.js';
import { scope, type Actor } from './auth.js';
import type { Json } from '../core/security.js';
import { migrationProgress } from '../storage/migration.js';

// The storage page (#436): per project, what its trajectory files, records and blobs take on the control plane and its
// runner-call files take in the manager; for platform administrators also the two databases, their disks and the
// payload migration. A page load reads the counters added when files close (trajectory_usage, a few rows per project)
// and a snapshot the background refresh keeps: it never walks files or scans tables. The refresh sizes the files still
// open (one per running task) and asks the manager for its numbers.

interface Usage { count: number; bytes: number }
interface Snapshot { refreshed_at: string; control: Json; manager: Json | null; open: Record<string, Usage> }

export class StorageReport {
  private snapshot: Snapshot | null = null;
  private refreshing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly store: Store, private readonly manager?: Manager) {}

  /** Refreshes now and then every intervalMs; call after the service listens. */
  start(intervalMs = 5 * 60_000): void {
    void this.refresh().catch(error => console.error('[storage] refresh failed:', error));
    this.timer = setInterval(() => void this.refresh().catch(error => console.error('[storage] refresh failed:', error)), intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  refresh(): Promise<void> {
    return this.refreshing ??= (async () => {
      try {
        const open: Record<string, Usage> = {};
        for (const row of this.store.all('SELECT repository_id,path FROM trajectory_files WHERE closed_at IS NULL')) {
          let bytes = 0; try { bytes = statSync(join(this.store.trajectories.root, String(row.path))).size; } catch {}
          const entry = open[row.repository_id ?? ''] ??= { count: 0, bytes: 0 }; entry.count++; entry.bytes += bytes;
        }
        const manager = this.manager ? await this.manager.call('GET', '/v1/storage').catch(() => null) as Json | null : null;
        this.snapshot = { refreshed_at: new Date().toISOString(), open, manager,
          control: { database: databaseSize(this.store.db), disk: diskSpace(dirname(this.store.trajectories.root)), migration: migrationProgress(this.store) } };
      } finally { this.refreshing = undefined; }
    })();
  }

  async api(user: Actor, method: string, path: string): Promise<Json | undefined> {
    if (path !== '/api/storage' || method !== 'GET') return undefined;
    // The first view after a start waits for the first refresh; later views read the last one.
    if (!this.snapshot) await this.refresh().catch(() => {});
    return this.view(user);
  }

  /** Projects the user may see: every one for a platform administrator (plus records without a project), else their own. */
  view(user: Actor): Json {
    const platform = user.role === 'super_admin' && !user.context?.tenant_id, visible = scope(user, 'id');
    const projects = new Map<string, Record<string, any>>();
    const project = (id: string, name: string | null) => {
      let entry = projects.get(id);
      if (!entry) projects.set(id, entry = { repository_id: id || null, name: name ?? (id ? id : '不属于项目的会话'), files: { count: 0, bytes: 0 }, records: {}, blobs: { count: 0, bytes: 0 },
        open: this.snapshot?.open[id] ?? { count: 0, bytes: 0 }, manager: null });
      return entry;
    };
    for (const row of this.store.all(`SELECT id,full_name FROM repositories WHERE ${visible.sql} ORDER BY full_name`, ...visible.args)) project(String(row.id), String(row.full_name));
    const allowed = (id: string) => projects.has(id) || platform && !this.store.get('SELECT 1 FROM repositories WHERE id=?', id);
    const add = (target: Record<string, any>, kind: string, value: Usage) => {
      if (kind === 'files' || kind === 'blobs' || kind === 'open') target[kind] = value;
      else if (kind.startsWith('records:')) target.records[kind.slice(8)] = value;
    };
    for (const row of this.store.all('SELECT repository_id,kind,count,bytes FROM trajectory_usage ORDER BY repository_id,kind')) {
      const id = String(row.repository_id);
      if (allowed(id)) add(project(id, null), String(row.kind), { count: Number(row.count), bytes: Number(row.bytes) });
    }
    const manager = this.snapshot?.manager as Record<string, any> | null | undefined;
    for (const row of (Array.isArray(manager?.usage) ? manager!.usage : []) as Record<string, any>[]) {
      const id = String(row.repository_id);
      if (!allowed(id)) continue;
      const entry = project(id, null);
      entry.manager ??= { files: { count: 0, bytes: 0 }, records: {}, open: { count: 0, bytes: 0 } };
      add(entry.manager, String(row.kind), { count: Number(row.count), bytes: Number(row.bytes) });
    }
    return { refreshed_at: this.snapshot?.refreshed_at ?? null, projects: [...projects.values()],
      ...(platform ? { totals: { control: this.snapshot?.control ?? null, manager: manager ? { database: manager.database ?? null, disk: manager.disk ?? null, migration: manager.migration ?? null } : null } } : {}) };
  }
}

/** A database's size and free pages; PRAGMAs read the header, not the tables. */
export function databaseSize(db: Store['db']): Json {
  const value = (pragma: string) => Number(Object.values(db.prepare('PRAGMA ' + pragma).get() ?? {})[0] ?? 0);
  const pageSize = value('page_size'), pages = value('page_count'), free = value('freelist_count');
  const file = String((db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find(row => row.name === 'main')?.file || '');
  let wal = 0; if (file) try { wal = statSync(file + '-wal').size; } catch {}
  return { bytes: pageSize * pages, pages, page_size: pageSize, free_pages: free, free_bytes: pageSize * free, wal_bytes: wal };
}

/** Free and total space of the file system holding path, or null. */
export function diskSpace(path: string): Json | null {
  try { const stats = statfsSync(path); return { free_bytes: stats.bavail * stats.bsize, total_bytes: stats.blocks * stats.bsize }; } catch { return null; }
}
