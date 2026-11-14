import { DatabaseSync } from 'node:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { link, rename, rm, stat, statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

// Returning the free pages of a SQLite database to the disk (#671), shared by the control plane (control.sqlite) and the
// manager (manager.sqlite). Both databases were created with auto_vacuum=NONE, so their free pages (most of each file
// after #436 moved the payloads into trajectory files) can only be returned by rewriting the file, which needs the
// database to itself: each service compacts its own database once at start, before it serves, when the free pages are a
// large share of it and the disk has room for the copy; otherwise it logs why, starts as usual and tries again at the
// next start. The copy is made with auto_vacuum=INCREMENTAL, so afterwards IncrementalVacuum returns the pages later
// cleanups free in small steps while the service runs.
//
// compactDatabase, before any other connection opens the file:
// 1. Clean up after a stopped run: a partial copy (<db>.compact) and the link to the old file (<db>.before-compact).
// 2. Measure from the header (page size, pages, free pages, auto_vacuum) and the disk (statfs).
// 3. Checkpoint the WAL into the file (TRUNCATE) and close, so no WAL of the old file can apply to the new one.
// 4. In a worker thread, VACUUM INTO <db>.compact on the same volume (temporary files there too: the containers' /tmp
//    is a small tmpfs), then PRAGMA integrity_check on the copy. The main thread logs the copy's size every 15 s.
// 5. Swap: hard-link the old file to <db>.before-compact, rename the copy over <db> (atomic; <db> always exists), open
//    it once, then remove the old file, which is when its space comes back.
const GiB = 1024 ** 3;
export const compactionDefaults = { minFreeRatio: 0.3, minFreeBytes: GiB, progressMs: 15_000 };
const pragma = (db, name) => Number(Object.values(db.prepare('PRAGMA ' + name).get() ?? {})[0] ?? 0);

/** Header numbers of a database: file bytes, live and free bytes, auto_vacuum (0 none, 1 full, 2 incremental). */
export function databasePages(db) {
  const pageSize = pragma(db, 'page_size'), pages = pragma(db, 'page_count'), free = pragma(db, 'freelist_count');
  return { page_size: pageSize, pages, free_pages: free, bytes: pageSize * pages, free_bytes: pageSize * free, live_bytes: pageSize * (pages - free), auto_vacuum: pragma(db, 'auto_vacuum') };
}

/** Free bytes the copy may use: the live data and a margin of a tenth of it, at least 1 GiB. */
export const requiredBytes = live => live + Math.max(GiB, Math.floor(live / 10));

export async function compactDatabase(path, options = {}) {
  const { minFreeRatio, minFreeBytes, progressMs } = { ...compactionDefaults, ...options }, log = options.log ?? (line => console.log(line));
  const started = Date.now(), at = new Date(started).toISOString(), copy = path + '.compact', old = path + '.before-compact';
  const done = (action, extra) => ({ action, at, duration_ms: Date.now() - started, ...extra });
  if (!existsSync(path)) return done('not_needed', { reason: 'no_database' });
  await rm(copy, { force: true }); await rm(old, { force: true });
  let before;
  const source = new DatabaseSync(path);
  try {
    before = databasePages(source);
    if (before.auto_vacuum !== 0) return done('not_needed', { reason: 'incremental', before });
    if (before.free_bytes < minFreeBytes || before.free_pages < before.pages * minFreeRatio) return done('not_needed', { reason: 'few_free_pages', before });
    const free = options.diskFree ? await options.diskFree(dirname(path)) : await statfs(dirname(path)).then(disk => disk.bavail * disk.bsize);
    if (free < requiredBytes(before.live_bytes)) {
      log(`skipped ${path}: ${gib(free)} free, the copy needs ${gib(requiredBytes(before.live_bytes))} (live data ${gib(before.live_bytes)}); retried at the next start`);
      return done('skipped', { reason: 'disk_space', before, disk_free_bytes: free, required_bytes: requiredBytes(before.live_bytes) });
    }
    const checkpoint = source.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint?.busy) return done('skipped', { reason: 'database_busy', before });
  } finally { source.close(); }
  // The WAL is empty now and goes when the last connection closes; one with frames left would apply to the new file.
  if ((await stat(path + '-wal').catch(() => null))?.size) return done('skipped', { reason: 'wal_not_empty', before });
  log(`compacting ${path}: ${gib(before.bytes)}, of which ${gib(before.free_bytes)} free pages; copying ${gib(before.live_bytes)} of live data`);
  let swapped = false;
  const timer = setInterval(() => void stat(copy).then(info => log(`compacting ${path}: copied ${gib(info.size)} of about ${gib(before.live_bytes)}, ${Math.round((Date.now() - started) / 1000)} s`), () => {}), progressMs);
  try {
    const checked = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { path, copy } });
      worker.once('message', resolve); worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`compaction worker exited with code ${code}`)));
    });
    if (checked.integrity !== 'ok') { await rm(copy, { force: true }); log(`compaction of ${path} failed its integrity check: ${checked.integrity}; the old file stays`); return done('failed', { reason: 'integrity_check', detail: String(checked.integrity).slice(0, 500), before }); }
    log(`compacting ${path}: copy written and checked in ${Math.round((Date.now() - started) / 1000)} s; swapping`);
    await rm(path + '-wal', { force: true }); await rm(path + '-shm', { force: true });
    await link(path, old); await rename(copy, path); swapped = true;
    const after = new DatabaseSync(path);
    try { after.prepare('SELECT count(*) FROM sqlite_schema').get(); } finally { after.close(); }
    await rm(old, { force: true });
    const size = (await stat(path)).size;
    log(`compacted ${path}: ${gib(before.bytes)} → ${gib(size)}, freed ${gib(before.bytes - size)} in ${Math.round((Date.now() - started) / 1000)} s`);
    return done('compacted', { before, after_bytes: size, freed_bytes: before.bytes - size });
  } catch (error) {
    // Before the swap the old file is untouched; a copy that cannot be opened after it is replaced by the old file again.
    await rm(copy, { force: true });
    if (swapped && existsSync(old)) await rename(old, path); else await rm(old, { force: true });
    log(`compaction of ${path} failed: ${error?.message ?? error}; the database stays as it was`);
    return done('failed', { reason: 'error', detail: String(error?.message ?? error).slice(0, 500), before });
  } finally { clearInterval(timer); }
}

/**
 * Returns the pages later cleanups free, in small steps while the service runs: every few minutes, while a database
 * with auto_vacuum=INCREMENTAL has more than `minPages` free pages, PRAGMA incremental_vacuum(step) truncates the file by
 * up to `step` pages at a time, with a pause between steps as long as the step took (at least pauseMs).
 */
export class IncrementalVacuum {
  constructor(db, options = {}) { this.db = db; this.options = { step: 2048, minPages: 4096, pauseMs: 50, intervalMs: 10 * 60_000, ...options }; this.stopped = false; this.last = null; }
  start() { this.running ??= this.loop().catch(error => console.error('[vacuum] incremental vacuum stopped:', error)); }
  async stop() { this.stopped = true; this.wake?.(); await this.running; }
  pause(ms, hold = false) {
    if (this.stopped) return Promise.resolve();
    return new Promise(resolve => { const timer = setTimeout(done, ms); if (!hold) timer.unref?.(); function done() { clearTimeout(timer); resolve(); } this.wake = done; });
  }
  async loop() { while (!this.stopped) { try { await this.run(); } catch (error) { console.error('[vacuum] incremental vacuum failed:', error); } await this.pause(this.options.intervalMs); } }
  /** One round: steps until few free pages are left; returns the pages returned to the disk. */
  async run() {
    if (pragma(this.db, 'auto_vacuum') !== 2) return 0;
    let returned = 0;
    const started = new Date().toISOString();
    for (let free = pragma(this.db, 'freelist_count'); free > this.options.minPages && !this.stopped; free = pragma(this.db, 'freelist_count')) {
      const began = performance.now();
      this.db.exec(`PRAGMA incremental_vacuum(${this.options.step})`);
      returned += free - pragma(this.db, 'freelist_count');
      await this.pause(Math.max(this.options.pauseMs, performance.now() - began), true);
    }
    if (returned) this.last = { started_at: started, finished_at: new Date().toISOString(), pages: returned, bytes: returned * pragma(this.db, 'page_size') };
    return returned;
  }
  state() { return { auto_vacuum: pragma(this.db, 'auto_vacuum'), last: this.last }; }
}

const gib = bytes => (bytes / GiB).toFixed(2) + ' GiB';

// The worker: the copy and its check run here, so the main thread can log progress meanwhile.
if (!isMainThread && workerData?.copy) {
  const { path, copy } = workerData, db = new DatabaseSync(path);
  let integrity;
  try {
    db.exec(`PRAGMA temp_store_directory='${dirname(path).replaceAll("'", "''")}'`);
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    db.prepare('VACUUM INTO ?').run(copy);
  } finally { db.exec("PRAGMA temp_store_directory=''"); db.close(); }
  const check = new DatabaseSync(copy);
  try { integrity = check.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]).join('; '); } finally { check.close(); }
  parentPort.postMessage({ integrity });
}
