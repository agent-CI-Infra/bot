import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Store } from '../storage/database.js';
import type { Manager } from '../projects/service.js';
import { scope, superAdmin, type Actor } from './auth.js';
import { retentionBounds, retentionDefaults, retentionSettings, saveRetention } from '../storage/retention.js';
import { fail, type Json } from '../core/security.js';
import { migrationProgress } from '../storage/migration.js';
import { diskState } from '../storage/disk.js';
import { workspaceClasses } from '../projects/workspace-cleanup.js';

// The storage page (#436, #671): every kind of storage the bot uses. Per project, what its trajectory files, records and
// blobs take on the control plane, its runner-call files in the manager, and its project computer's work volume (task
// workspaces by retention class, runner journal, git store, HOME caches, other files). For platform administrators also
// the two databases (live data, free pages, WAL), the control plane's git cache and public boards, the data disk with
// Docker's images and build cache, "other" (used less everything known), what can be reclaimed and what the last
// cleanups freed, and an alert for each data disk below its reserve, when background writes pause.
//
// A page load reads the counters added when files close (trajectory_usage, a few rows per project), one statfs and a
// snapshot the background refresh keeps: it never walks files or scans tables. The refresh (every five minutes) sizes
// the files still open, asks the manager for its numbers (which carry the computers' last volume scans and Docker's
// usage, both measured in the manager's background), classifies each newly scanned computer's task directories, and
// measures the git cache and public boards with du at most once an hour.

interface Usage { count: number; bytes: number }
interface Measured { bytes: number | null; measured_at: string }
interface Snapshot { refreshed_at: string; control: Json; manager: Json | null; open: Record<string, Usage>; computers: Record<string, Json>; cleanup: Record<string, Json> }

const hour = 3600_000;
const run = (command: string, args: string[], timeout: number) => new Promise<{ error: Error | null; stdout: string }>(resolve =>
  execFile(command, args, { timeout, maxBuffer: 65536 }, (error, stdout) => resolve({ error, stdout: String(stdout) })));
/** Disk space a directory uses, measured at the lowest CPU priority; 0 when it does not exist, null when du failed. */
export async function directoryBytes(path: string, timeoutMs = 10 * 60_000): Promise<number | null> {
  if (!existsSync(path)) return 0;
  const { error, stdout } = await run('nice', ['-n', '19', 'du', '-skx', '--', path], timeoutMs), kib = Number(stdout.split('\t')[0]);
  return error || !Number.isFinite(kib) ? null : kib * 1024;
}

export class StorageReport {
  private snapshot: Snapshot | null = null;
  private refreshing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  // The directories measured with du (at most hourly), and each computer's classification by the scan it came from.
  private directories: { at: number; values: Record<string, Measured> } = { at: 0, values: {} };
  private readonly classified = new Map<string, { scanned_at: string; value: Json | null }>();
  private readonly paths: Record<string, string>;
  constructor(private readonly store: Store, private readonly manager?: Manager, paths: { git_cache?: string; public_boards?: string } = {},
    private readonly vacuum?: { state(): unknown }) {
    const data = store.trajectories.root ? dirname(store.trajectories.root) : null;
    this.paths = Object.fromEntries(Object.entries({ git_cache: paths.git_cache ?? (data && join(data, 'git-cache')), public_boards: paths.public_boards ?? (data && join(data, 'public-boards')) })
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }

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
        if (Date.now() - this.directories.at >= hour) {
          const values: Record<string, Measured> = {};
          for (const [name, path] of Object.entries(this.paths)) values[name] = { bytes: await directoryBytes(path), measured_at: new Date().toISOString() };
          this.directories = { at: Date.now(), values };
        }
        const computers: Record<string, Json> = {};
        for (const row of (Array.isArray(manager?.computers) ? manager!.computers : []) as Record<string, any>[]) computers[String(row.repository_id)] = this.computer(row);
        let cleanup: Record<string, Json> = {}, compaction: Json | null = null;
        try { cleanup = JSON.parse(this.store.get("SELECT value FROM settings WHERE key='workspace_cleanup'")?.value ?? '{}'); } catch {}
        try { compaction = JSON.parse(this.store.get("SELECT value FROM settings WHERE key='compaction'")?.value ?? 'null'); } catch {}
        this.snapshot = { refreshed_at: new Date().toISOString(), open, manager, computers, cleanup,
          control: { database: databaseSize(this.store.db), disk: this.disk(), migration: migrationProgress(this.store), directories: this.directories.values,
            // The compaction at the last start and the incremental vacuum since (#671).
            compaction, vacuum: (this.vacuum?.state() ?? null) as Json | null } };
      } finally { this.refreshing = undefined; }
    })();
  }

  // A computer's last volume scan without its per-directory list; its task directories counted by retention class, once
  // per scan (classifying reads the records of up to 5000 directories).
  private computer(row: Record<string, any>): Json {
    const repo = String(row.repository_id), result = (row.result ?? {}) as Record<string, any>, { tasks, ...scan } = result;
    let classes = this.classified.get(repo);
    if (!classes || classes.scanned_at !== row.scanned_at) {
      let value: Json | null = null;
      try { if (Array.isArray(tasks)) value = workspaceClasses(this.store, repo, tasks) as unknown as Json; } catch (error) { console.error(`[storage] classifying project ${repo} workspaces failed:`, error); }
      this.classified.set(repo, classes = { scanned_at: String(row.scanned_at), value });
    }
    return { ...scan, generation: row.generation, scanned_at: row.scanned_at, workspaces: classes.value };
  }

  /** The control plane's data disk now (one statfs, cached for a few seconds). */
  private disk(): Json | null {
    return (this.store.disk?.check() ?? (this.store.trajectories.root ? diskState(dirname(this.store.trajectories.root)) : null)) as Json | null;
  }

  async api(user: Actor, method: string, path: string, input: Json = {}): Promise<Json | undefined> {
    if (path === '/api/storage/retention') return this.retention(user, method, input);
    if (path !== '/api/storage' || method !== 'GET') return undefined;
    // The first view after a start waits for the first refresh; later views read the last one.
    if (!this.snapshot) await this.refresh().catch(() => {});
    return this.view(user);
  }

  /**
   * Cleanup by days (#671), platform administrators only: the settings with their defaults and bounds, the projects a
   * trajectory window can be set for, the last daily cleanup, and the group chats' own retention (set per chat in the
   * channel console), shown here so every window is in one place. PUT saves a change (validated, audited).
   */
  private async retention(user: Actor, method: string, input: Json): Promise<Json> {
    superAdmin(user);
    if (method === 'PUT') {
      const saved = saveRetention(this.store, user.id, input);
      // The manager uses the new window from its next pass; the daily cleanup sends it again if this fails.
      if (input.manager_payload_days !== undefined) await this.manager?.call('PUT', '/v1/storage/retention', { payload_days: saved.manager_payload_days }).catch(() => null);
    } else if (method !== 'GET') fail(405, 'method_not_allowed');
    let cleanup: Json | null = null; try { cleanup = JSON.parse(this.store.get("SELECT value FROM settings WHERE key='retention_cleanup'")?.value ?? 'null'); } catch {}
    let chats: Json | null = null;
    if (this.store.hasTable('channel_chats')) chats = this.store.get('SELECT count(*) AS chats,count(retention_days) AS configured,min(retention_days) AS min_days,max(retention_days) AS max_days FROM channel_chats') ?? null;
    return { settings: retentionSettings(this.store), defaults: retentionDefaults, bounds: retentionBounds, last_cleanup: cleanup, chats,
      projects: this.store.all('SELECT id,full_name FROM repositories ORDER BY full_name').map(row => ({ id: String(row.id), name: String(row.full_name) })) };
  }

  /** Projects the user may see: every one for a platform administrator (plus records without a project), else their own. */
  view(user: Actor): Json {
    const platform = user.role === 'super_admin' && !user.context?.tenant_id, visible = scope(user, 'id');
    const projects = new Map<string, Record<string, any>>(), snapshot = this.snapshot;
    const project = (id: string, name: string | null) => {
      let entry = projects.get(id);
      if (!entry) projects.set(id, entry = { repository_id: id || null, name: name ?? (id ? id : '不属于项目的会话'), files: { count: 0, bytes: 0 }, records: {}, blobs: { count: 0, bytes: 0 },
        open: snapshot?.open[id] ?? { count: 0, bytes: 0 }, manager: null,
        computer: snapshot?.computers[id] ? { ...snapshot.computers[id] as object, cleanup: snapshot.cleanup[id] ?? null } : null });
      return entry;
    };
    for (const row of this.store.all(`SELECT id,full_name FROM repositories WHERE ${visible.sql} ORDER BY full_name`, ...visible.args)) project(String(row.id), String(row.full_name));
    const allowed = (id: string) => projects.has(id) || platform && !this.store.get('SELECT 1 FROM repositories WHERE id=?', id);
    const add = (target: Record<string, any>, kind: string, value: Usage) => {
      // expired: the manager's files removed after their retention window (#671).
      if (kind === 'files' || kind === 'blobs' || kind === 'open' || kind === 'expired') target[kind] = value;
      else if (kind.startsWith('records:')) target.records[kind.slice(8)] = value;
    };
    for (const row of this.store.all('SELECT repository_id,kind,count,bytes FROM trajectory_usage ORDER BY repository_id,kind')) {
      const id = String(row.repository_id);
      if (allowed(id)) add(project(id, null), String(row.kind), { count: Number(row.count), bytes: Number(row.bytes) });
    }
    const manager = snapshot?.manager as Record<string, any> | null | undefined;
    for (const row of (Array.isArray(manager?.usage) ? manager!.usage : []) as Record<string, any>[]) {
      const id = String(row.repository_id);
      if (!allowed(id)) continue;
      const entry = project(id, null);
      entry.manager ??= { files: { count: 0, bytes: 0 }, records: {}, open: { count: 0, bytes: 0 }, expired: { count: 0, bytes: 0 } };
      add(entry.manager, String(row.kind), { count: Number(row.count), bytes: Number(row.bytes) });
    }
    // A computer whose project is not listed yet (only its scan is known) still counts for platform administrators.
    for (const id of Object.keys(snapshot?.computers ?? {})) if (allowed(id)) project(id, null);
    const list = [...projects.values()];
    if (!platform) return { refreshed_at: snapshot?.refreshed_at ?? null, projects: list };
    const control = snapshot ? { ...snapshot.control as Record<string, any>, disk: this.disk() as Record<string, any> | null } : null;
    const alerts = ([['control', control?.disk], ['manager', manager?.disk]] as [string, any][]).filter(([, disk]) => disk?.low)
      .map(([where, disk]) => ({ where, free_bytes: disk.free_bytes, total_bytes: disk.total_bytes, reserve_bytes: disk.reserve_bytes }));
    return { refreshed_at: snapshot?.refreshed_at ?? null, projects: list, alerts, ...summary(list, control, manager, snapshot?.cleanup ?? {}),
      totals: { control, manager: manager ? { database: manager.database ?? null, disk: manager.disk ?? null, migration: manager.migration ?? null, expiry: manager.expiry ?? null, docker: manager.docker ?? null,
        compaction: manager.compaction ?? null, vacuum: manager.vacuum ?? null } : null } };
  }
}

const bytesOf = (value: any) => Math.max(0, Number(value) || 0);
// A size that was measured, or null when it was not (not read yet, the reader failed, or the manager did not answer).
const measured = (value: any) => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
/**
 * The host's disk split into what the bot knows and "other" (used less known), what could be reclaimed and what the last
 * cleanups freed. The control plane, the manager, the computers' volumes and Docker's data share one data disk in the
 * Compose deployment; "other" is measured against the control plane's disk. An item not measured is null and listed in
 * `unmeasured`, so "other" then includes it rather than the page showing a measured 0.
 */
function summary(projects: Record<string, any>[], control: Record<string, any> | null, manager: Record<string, any> | null | undefined, cleanup: Record<string, any>): Json {
  const sum = (pick: (project: Record<string, any>) => unknown) => projects.reduce((total, project) => total + bytesOf(pick(project)), 0);
  const database = (value: any) => value ? bytesOf(value.bytes) + bytesOf(value.wal_bytes) : null;
  // A computer whose last scan failed or did not finish counts as not fully measured.
  const scans = projects.map(p => p.computer).filter(Boolean), partial = scans.some(scan => scan.error || scan.complete === false);
  const known: Record<string, number | null> = {
    control_database: database(control?.database),
    control_trajectories: sum(p => bytesOf(p.files.bytes) + bytesOf(p.open.bytes) + bytesOf(p.blobs.bytes)),
    git_cache: measured(control?.directories?.git_cache?.bytes), public_boards: measured(control?.directories?.public_boards?.bytes),
    manager_database: database(manager?.database),
    manager_trajectories: manager ? sum(p => bytesOf(p.manager?.files?.bytes) + bytesOf(p.manager?.open?.bytes)) : null,
    computers: manager?.computers ? sum(p => p.computer?.total_bytes) : null,
    docker_images: measured(manager?.docker?.images?.bytes), docker_build_cache: measured(manager?.docker?.build_cache?.bytes),
  };
  const unmeasured = [...Object.entries(known).filter(([, value]) => value === null).map(([key]) => key), ...partial && known.computers !== null ? ['computers'] : []];
  const knownBytes = Object.values(known).reduce((total: number, value) => total + (value ?? 0), 0), disk = control?.disk;
  const used = disk && Number.isFinite(disk.used_bytes) ? disk.used_bytes : disk ? bytesOf(disk.total_bytes) - bytesOf(disk.free_bytes) : null;
  const reclaimable = [
    { key: 'control_free_pages', bytes: measured(control?.database?.free_bytes) },
    { key: 'manager_free_pages', bytes: measured(manager?.database?.free_bytes) },
    { key: 'expiring_workspaces', bytes: sum(p => p.computer?.workspaces?.expiring?.bytes), count: projects.reduce((total, p) => total + bytesOf(p.computer?.workspaces?.expiring?.count), 0) },
    { key: 'docker_build_cache', bytes: measured(manager?.docker?.build_cache?.reclaimable_bytes) },
    { key: 'docker_unused_images', bytes: measured(manager?.docker?.images?.reclaimable_bytes), count: manager?.docker ? bytesOf(manager.docker.images?.unused_count) : null },
  ];
  // The workspace cleanup sweeps project by project: its entry adds up each project's latest sweep, dated by the newest.
  const sweeps = Object.values(cleanup) as Record<string, any>[], latest = sweeps.map(sweep => String(sweep.at ?? '')).sort().at(-1) ?? null;
  const freed = [
    { key: 'manager_expiry', at: manager?.expiry?.last_pass?.finished_at ?? null, bytes: bytesOf(manager?.expiry?.last_pass?.bytes), count: bytesOf(manager?.expiry?.last_pass?.files) },
    { key: 'workspace_cleanup', at: latest, bytes: sweeps.reduce((total, sweep) => total + bytesOf(sweep.bytes), 0), count: sweeps.reduce((total, sweep) => total + bytesOf(sweep.removed), 0) },
  ];
  return { host: { disk: disk ?? null, used_bytes: used, known, known_bytes: knownBytes, unmeasured, other_bytes: used === null ? null : Math.max(0, used - knownBytes) }, reclaimable, freed };
}

/** A database's size and free pages; PRAGMAs read the header, not the tables. */
export function databaseSize(db: Store['db']): Json {
  const value = (pragma: string) => Number(Object.values(db.prepare('PRAGMA ' + pragma).get() ?? {})[0] ?? 0);
  const pageSize = value('page_size'), pages = value('page_count'), free = value('freelist_count');
  const file = String((db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find(row => row.name === 'main')?.file || '');
  let wal = 0; if (file) try { wal = statSync(file + '-wal').size; } catch {}
  return { bytes: pageSize * pages, pages, page_size: pageSize, free_pages: free, free_bytes: pageSize * free, wal_bytes: wal, auto_vacuum: value('auto_vacuum') };
}

