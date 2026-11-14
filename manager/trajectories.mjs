import { closeSync, existsSync, fdatasync, close as closeAsync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { open as openAsync, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { diskFull } from './disk.mjs';

// The manager's trajectory files: the input and result of every runner call it records, appended to JSONL files under
// its data volume, one per project and task workspace (lifecycle calls without one share the project's file). The
// ledger (operations) keeps the call's state and a ref "<file>:<offset>:<length>:<sha256 of the line>" per body. The
// format and rules are those of the control plane's src/storage/trajectories.ts (docs/trajectories.md): a line is
// {"seq","at","type","id","prev","data"} with prev the sha256 of the line before it; trajectory_files gets one insert
// when a file is opened and one update when it is closed; appending never writes SQLite; the line is written (and, for
// a result a repeated call replays, synced) before the row that points to it is committed.

const sha256 = value => createHash('sha256').update(value).digest('hex');
export const segment = value => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || '_';
const refPattern = /^([a-f0-9]{16}):(\d+):(\d+):([a-f0-9]{64})$/;

export class TrajectoryError extends Error {
  constructor(code, detail) { super(code + ': ' + detail); this.code = code; this.detail = detail; }
}
export function parseRef(ref) {
  const match = refPattern.exec(String(ref));
  if (!match) throw new TrajectoryError('trajectory_ref_invalid', String(ref).slice(0, 120));
  return { file: match[1], offset: Number(match[2]), length: Number(match[3]), sha256: match[4] };
}

export function trajectoryStorage(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS trajectory_files(id TEXT PRIMARY KEY,repository_id TEXT,workspace_id TEXT,path TEXT NOT NULL,created_at TEXT NOT NULL,
      closed_at TEXT,bytes INTEGER,records INTEGER,last_sha256 TEXT,counts TEXT);
    CREATE INDEX IF NOT EXISTS trajectory_files_open ON trajectory_files(created_at) WHERE closed_at IS NULL;
    CREATE INDEX IF NOT EXISTS trajectory_files_repository ON trajectory_files(repository_id,created_at);
    CREATE TABLE IF NOT EXISTS trajectory_usage(repository_id TEXT NOT NULL,kind TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(repository_id,kind));`);
  // #671: expired_at: the file's records no longer resolve, refs to it read as expired; deleted_at: the file is gone from
  // disk. The partial indexes hold the files that may expire and the expired ones whose file is still to be removed.
  const columns = new Set(db.prepare('PRAGMA table_info(trajectory_files)').all().map(row => row.name));
  for (const column of ['expired_at', 'deleted_at']) if (!columns.has(column)) db.exec(`ALTER TABLE trajectory_files ADD COLUMN ${column} TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS trajectory_files_expiry ON trajectory_files(closed_at,id) WHERE expired_at IS NULL AND closed_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS trajectory_files_removal ON trajectory_files(expired_at) WHERE expired_at IS NOT NULL AND deleted_at IS NULL;`);
}

export class Trajectories {
  constructor(db, root, idleMs = 30 * 60_000) {
    this.db = db; this.root = resolve(root); this.idleMs = idleMs;
    this.open = new Map(); this.handles = new Map(); this.paths = new Map();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => this.closeIdle(), Math.min(idleMs, 60_000)); this.timer.unref?.();
  }
  /** The file of a project's runner calls for one task workspace; lifecycle calls go to the project's file. */
  static scope(repositoryId, workspaceId) {
    const own = workspaceId ? segment(workspaceId) : 'project';
    return { key: `${repositoryId}:${own}`, path: `${segment(repositoryId)}/${own}`, repository_id: String(repositoryId), workspace_id: workspaceId ?? null };
  }
  append(scope, type, id, data) {
    const handle = this.handle(scope);
    const line = JSON.stringify({ seq: handle.seq + 1, at: new Date().toISOString(), type, id: String(id), prev: handle.last, data: data ?? null });
    const bytes = Buffer.from(line + '\n');
    try { for (let written = 0; written < bytes.length;) written += writeSync(handle.fd, bytes, written, bytes.length - written); }
    catch (error) { try { ftruncateSync(handle.fd, handle.bytes); } catch { handle.broken = true; this.finish(handle); } throw error; }
    const offset = handle.bytes, digest = sha256(line);
    handle.bytes += bytes.length; handle.seq++; handle.records++; handle.last = digest; handle.used = Date.now();
    const count = handle.counts[type] ?? [0, 0]; count[0]++; count[1] += bytes.length; handle.counts[type] = count;
    return `${handle.id}:${offset}:${bytes.length - 1}:${digest}`;
  }
  sync(ref) {
    const handle = this.handles.get(parseRef(ref).file);
    if (!handle) return Promise.resolve();
    if (handle.closed) return handle.chain;
    const done = handle.chain.then(() => new Promise((ok, fail) => fdatasync(handle.fd, error => error ? fail(error) : ok())));
    handle.chain = done.catch(() => {});
    return done;
  }
  read(ref) {
    const { file, offset, length, sha256: expected } = parseRef(ref), path = this.pathOf(file), buffer = Buffer.alloc(length + 1);
    let fd;
    try { fd = openSync(join(this.root, path), 'r'); } catch { throw new TrajectoryError('trajectory_truncated', `${path}: file is missing`); }
    try { if (readSync(fd, buffer, 0, length + 1, offset) < length + 1) throw new TrajectoryError('trajectory_truncated', `${path}: ends before offset ${offset + length + 1}`); }
    finally { closeSync(fd); }
    const text = buffer.subarray(0, length);
    if (buffer[length] !== 0x0a || sha256(text) !== expected) throw new TrajectoryError('trajectory_corrupt', `${path}: record at offset ${offset} does not match its hash`);
    return JSON.parse(text.toString('utf8'));
  }
  close(key) { const handle = this.open.get(key); if (handle) this.finish(handle); }
  closeAll() { clearInterval(this.timer); for (const handle of [...this.open.values()]) this.finish(handle); }
  async settle() { await Promise.all([...this.handles.values()].map(handle => handle.chain)); }
  /** Closes the entries a stopped process left open: drops an incomplete last line, verifies the chain, anchors it. */
  async seal() {
    let sealed = 0;
    for (;;) {
      const open = new Set(this.handles.keys());
      const entry = this.db.prepare('SELECT * FROM trajectory_files WHERE closed_at IS NULL ORDER BY created_at').all().find(row => !open.has(row.id));
      if (!entry) return sealed;
      const path = join(this.root, entry.path), scanned = await scan(path);
      if (scanned.partial && !scanned.error) { const file = await openAsync(path, 'r+'); try { await file.truncate(scanned.bytes); await file.datasync(); } finally { await file.close(); } }
      const counts = {};
      for (const line of scanned.lines) { const count = counts[line.type] ?? [0, 0]; count[0]++; count[1] += line.bytes; counts[line.type] = count; }
      if (scanned.error) counts.unverified = true;
      this.atomic(() => {
        const changed = this.db.prepare('UPDATE trajectory_files SET closed_at=?,bytes=?,records=?,last_sha256=?,counts=? WHERE id=? AND closed_at IS NULL')
          .run(new Date().toISOString(), scanned.bytes, scanned.lines.length, scanned.last, JSON.stringify(counts), entry.id).changes;
        if (changed) this.usage(entry.repository_id ?? '', scanned.bytes, counts);
      });
      sealed++;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  handle(scope) {
    const current = this.open.get(scope.key);
    if (current && !current.closed && !current.broken) { this.confirm(current); return current; }
    let relative = scope.path + '.jsonl';
    for (let n = 2; existsSync(join(this.root, relative)); n++) relative = `${scope.path}.${n}.jsonl`;
    const absolute = join(this.root, relative);
    if (!absolute.startsWith(this.root + sep)) throw new TrajectoryError('trajectory_ref_invalid', relative);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const handle = { id: randomBytes(8).toString('hex'), scope, path: relative, fd: openSync(absolute, 'ax', 0o600), seq: 0, last: null, bytes: 0, records: 0, counts: {},
      used: Date.now(), confirmed: false, closed: false, broken: false, chain: Promise.resolve() };
    this.insert(handle);
    this.open.set(scope.key, handle); this.handles.set(handle.id, handle); this.paths.set(handle.id, relative);
    return handle;
  }
  insert(handle) {
    this.db.prepare('INSERT OR IGNORE INTO trajectory_files(id,repository_id,workspace_id,path,created_at) VALUES(?,?,?,?,?)')
      .run(handle.id, handle.scope.repository_id, handle.scope.workspace_id, handle.path, new Date().toISOString());
    handle.confirmed = this.db.isTransaction === false;
  }
  confirm(handle) {
    if (handle.confirmed) return;
    if (!this.db.prepare('SELECT 1 FROM trajectory_files WHERE id=?').get(handle.id)) this.insert(handle);
    else handle.confirmed = this.db.isTransaction === false;
  }
  finish(handle) {
    if (handle.closed) return;
    handle.closed = true;
    if (this.open.get(handle.scope.key) === handle) this.open.delete(handle.scope.key);
    try {
      this.atomic(() => {
        const closed = new Date().toISOString(), counts = JSON.stringify(handle.counts);
        let changed = this.db.prepare('UPDATE trajectory_files SET closed_at=?,bytes=?,records=?,last_sha256=?,counts=? WHERE id=? AND closed_at IS NULL')
          .run(closed, handle.bytes, handle.records, handle.last, counts, handle.id).changes;
        if (!changed && !this.db.prepare('SELECT 1 FROM trajectory_files WHERE id=?').get(handle.id))
          changed = this.db.prepare('INSERT INTO trajectory_files(id,repository_id,workspace_id,path,created_at,closed_at,bytes,records,last_sha256,counts) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(handle.id, handle.scope.repository_id, handle.scope.workspace_id, handle.path, closed, closed, handle.bytes, handle.records, handle.last, counts).changes;
        if (changed) this.usage(handle.scope.repository_id ?? '', handle.bytes, handle.counts);
      });
    } finally {
      handle.chain = handle.chain.then(() => new Promise(done => fdatasync(handle.fd, () => closeAsync(handle.fd, () => done()))));
      void handle.chain.then(() => { if (this.handles.get(handle.id) === handle) this.handles.delete(handle.id); });
    }
  }
  usage(repository, bytes, counts) {
    const add = this.db.prepare(`INSERT INTO trajectory_usage(repository_id,kind,count,bytes) VALUES(?,?,?,?)
      ON CONFLICT(repository_id,kind) DO UPDATE SET count=count+excluded.count,bytes=bytes+excluded.bytes`);
    add.run(repository, 'files', 1, bytes);
    for (const [type, value] of Object.entries(counts)) if (Array.isArray(value)) add.run(repository, 'records:' + type, value[0], value[1]);
  }
  pathOf(file) {
    const known = this.paths.get(file);
    if (known) return known;
    const row = this.db.prepare('SELECT path,expired_at FROM trajectory_files WHERE id=?').get(file);
    if (!row) throw new TrajectoryError('trajectory_missing', file);
    if (row.expired_at) throw new TrajectoryError('trajectory_expired', `${row.path}: removed after its retention window (${row.expired_at})`);
    if (this.paths.size > 10_000) this.paths.clear();
    this.paths.set(file, row.path);
    return row.path;
  }
  /** Drops a file from the path cache once it expired, so the next read sees its entry. */
  forget(file) { this.paths.delete(file); }
  closeIdle() {
    const before = Date.now() - this.idleMs;
    for (const handle of [...this.open.values()]) if (handle.used < before) { try { this.finish(handle); } catch (error) { console.error('[manager] closing a trajectory file failed:', error); } }
  }
  atomic(fn) {
    const name = 'trajectory_' + randomBytes(6).toString('hex');
    this.db.exec('SAVEPOINT ' + name);
    try { fn(); this.db.exec('RELEASE ' + name); } catch (error) { this.db.exec('ROLLBACK TO ' + name); this.db.exec('RELEASE ' + name); throw error; }
  }
}

/**
 * Moves the bodies of ledger rows written before trajectory files into them, in the background after the manager is
 * ready (the same slicing as the control plane's src/storage/migration.ts): read rows in rowid order for about 25 ms,
 * append, fdatasync off the event loop, read each record back against its hash, then in one short transaction replace
 * input and result with a header and refs and save the cursor in settings. Only finished calls (completed or
 * interrupted) move; a running one is left to its call. A restart resumes at the cursor.
 */
export class LedgerMigration {
  constructor(db, trajectories, options = {}) { this.db = db; this.trajectories = trajectories; this.options = options; this.stopped = false; this.touched = new Map(); this.recent = []; }
  start() { this.running ??= this.loop().catch(error => console.error('[manager] ledger migration stopped:', error)); }
  async stop() { this.stopped = true; this.wake?.(); await this.running; }
  /** Progress for the storage page; remaining is estimated from max(rowid), never counted. */
  state() {
    const state = JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='trajectory_migration'").get()?.value ?? 'null') ?? { started_at: null, updated_at: null, rate: 0, phases: {} };
    const last = Number(this.db.prepare('SELECT max(rowid) n FROM operations').get()?.n ?? 0);
    return { ...state, remaining: { operations: Math.max(0, last - (state.phases.operations?.cursor ?? 0)) } };
  }
  pause(ms) {
    // stop() may run during a slice's file sync, before this pause has registered its wake callback.
    if (this.stopped) return Promise.resolve();
    return new Promise(resolve => { const timer = setTimeout(done, ms); timer.unref?.(); function done() { clearTimeout(timer); resolve(); } this.wake = done; });
  }
  async loop() {
    const { remaining: _, ...state } = this.state();
    state.started_at ??= new Date().toISOString();
    const progress = state.phases.operations ??= { cursor: 0, migrated: 0, skipped: 0, failed: 0, bytes: 0, last_error: null, finished_at: null };
    const next = this.db.prepare('SELECT rowid AS migration_rowid,* FROM operations WHERE rowid>? ORDER BY rowid LIMIT 1');
    // A slice writes the bodies once more before the rows give them up, so it waits while the disk is below its reserve
    // (#671) or became full during the slice: the rows not reached keep their bodies and move once there is space again.
    const wait = async reason => {
      if (state.paused !== reason) { state.paused = reason; try { this.save(state); } catch {} }
      this.closeTouched(0);
      await this.pause(this.options.lowDiskMs ?? 60_000);
    };
    try {
      while (!this.stopped) {
        if (this.options.guard?.check()?.low) { await wait('low_disk'); continue; }
        if (state.paused) { state.paused = null; this.save(state); }
        const started = performance.now(), moves = [];
        let cursor = progress.cursor, skipped = 0, failed = 0, error = null, full = false;
        for (let read = 0; read === 0 || performance.now() - started < (this.options.readMs ?? 25) && moves.length < 200; read++) {
          const row = next.get(cursor);
          if (!row) break;
          const rowid = Number(row.migration_rowid);
          try { const move = this.move(row); if (move) moves.push(move); else skipped++; }
          catch (failure) {
            // A full disk is not the row's fault: the slice ends before it.
            if (diskFull(failure)) { full = true; break; }
            failed++; error = `operations rowid ${rowid}: ${String(failure?.message ?? failure).slice(0, 300)}`;
          }
          cursor = rowid;
        }
        if (cursor === progress.cursor) {
          if (full) { await wait('disk_full'); continue; }
          if (!progress.finished_at) { progress.finished_at = new Date().toISOString(); this.save(state); }
          this.closeTouched(0);
          // Calls finished since (their rows were running when passed) are picked up on the next look.
          await this.pause(this.options.idleMs ?? 10 * 60_000);
          continue;
        }
        // Lines written before a failed sync are never referenced: the rows keep their bodies.
        try { await Promise.all([...new Set(moves.map(move => move.refs.at(-1)))].map(ref => this.trajectories.sync(ref))); }
        catch (failure) { if (!diskFull(failure)) throw failure; await wait('disk_full'); continue; }
        const verified = moves.filter(move => { try { for (const ref of move.refs) this.trajectories.read(ref); return true; } catch (failure) { failed++; error = String(failure.message).slice(0, 300); return false; } });
        const now = Date.now();
        this.recent.push([now, verified.length]); while (this.recent[0][0] < now - 60_000) this.recent.shift();
        state.rate = Math.round(this.recent.reduce((sum, [, count]) => sum + count, 0) / Math.max(1, (now - this.recent[0][0]) / 1000));
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const move of verified) move.apply();
          Object.assign(progress, { cursor, migrated: progress.migrated + verified.length, skipped: progress.skipped + skipped, failed: progress.failed + failed,
            bytes: progress.bytes + verified.reduce((sum, move) => sum + move.bytes, 0), last_error: error ?? progress.last_error, finished_at: null });
          this.save(state);
          this.db.exec('COMMIT');
        } catch (failure) {
          if (this.db.isTransaction) this.db.exec('ROLLBACK');
          if (!diskFull(failure)) throw failure;
          // The cursor in memory moved with the rolled back slice; the saved one did not.
          Object.assign(progress, this.state().phases.operations ?? { cursor: 0 });
          await wait('disk_full'); continue;
        }
        this.closeTouched(this.options.openFiles ?? 32);
        if (full) { await wait('disk_full'); continue; }
        await this.pause(Math.max(this.options.pauseMs ?? 10, performance.now() - started));
      }
    } finally { this.closeTouched(0); }
  }
  move(row) {
    if (row.input_ref || !['completed', 'interrupted'].includes(row.state)) return null;
    const input = JSON.parse(row.input), scope = Trajectories.scope(row.repository_id, input?.request?.workspace_id);
    this.touched.delete(scope.key); this.touched.set(scope.key, scope);
    const refs = [this.trajectories.append(scope, 'tool_call', row.id, input)];
    if (row.result !== null) refs.push(this.trajectories.append(scope, 'tool_result', row.id, JSON.parse(row.result)));
    return { refs, bytes: String(row.input).length + String(row.result ?? '').length, apply: () => this.db.prepare(
      'UPDATE operations SET input=?,result=NULL,input_ref=?,result_ref=?,input_sha256=? WHERE id=? AND input_ref IS NULL AND state=?')
      .run(JSON.stringify(inputHeader(input)), refs[0], refs[1] ?? null, sha256(String(row.input)), row.id, row.state) };
  }
  save(state) {
    state.updated_at = new Date().toISOString();
    this.db.prepare("INSERT INTO settings VALUES('trajectory_migration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(state));
  }
  closeTouched(keep) { while (this.touched.size > keep) { const [key] = this.touched.keys(); this.touched.delete(key); this.trajectories.close(key); } }
}

const day = 24 * 3600_000;
/** How long a closed file of runner calls is kept unless the settings say otherwise (#671). */
export const defaultRetentionDays = 2;

/**
 * Removes the manager's copies of runner-call bodies once nothing replays them (#671). The manager reads a stored result
 * only to answer a call repeated with the same operation id, which happens while the calling task runs (the runner's
 * journal also covers the first day), and the control plane keeps the same request and result in its own trajectories
 * (task_tools). A file goes once its entry closed longer ago than the window (settings payload_retention, default 2
 * days) and it holds the input of no call still running: one short transaction marks the entry expired, so a ref to it
 * reads as expired from then on (a repeated call is answered operation_result_expired, never with another result), and
 * moves its bytes in trajectory_usage from files and records to 'expired'; then the file is removed off the event loop
 * and the entry marked deleted. Ledger rows stay as they are, with their header, hash and refs: finding the rows of a
 * file would scan the ledger, its entry is one row. Files are walked in closed_at order in bounded batches with pauses;
 * a pass runs after the start and every hour, and first removes the files a stopped pass had marked.
 */
export class TrajectoryExpiry {
  constructor(db, trajectories, options = {}) { this.db = db; this.trajectories = trajectories; this.options = options; this.stopped = false; }
  start() { this.running ??= this.loop().catch(error => console.error('[manager] trajectory expiry stopped:', error)); }
  async stop() { this.stopped = true; this.wake?.(); await this.running; }
  // The pause between batches holds the process like the pass awaiting it; the hour between passes does not.
  pause(ms, hold = false) {
    if (this.stopped) return Promise.resolve();
    return new Promise(resolve => { const timer = setTimeout(done, ms); if (!hold) timer.unref?.(); function done() { clearTimeout(timer); resolve(); } this.wake = done; });
  }
  /** The retention window in whole days. */
  windowDays() {
    let days; try { days = JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='payload_retention'").get()?.value ?? 'null')?.days; } catch {}
    return Number.isSafeInteger(days) && days >= 1 ? days : defaultRetentionDays;
  }
  /** For the storage page: the window and the last pass; the totals removed are in trajectory_usage kind 'expired'. */
  state() {
    let saved = null; try { saved = JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='trajectory_expiry'").get()?.value ?? 'null'); } catch {}
    return { window_days: this.windowDays(), last_pass: saved?.last_pass ?? null, last_error: saved?.last_error ?? null };
  }
  save(value) {
    const { last_pass, last_error } = { ...this.state(), ...value };
    this.db.prepare("INSERT INTO settings VALUES('trajectory_expiry',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ last_pass, last_error }));
  }
  async loop() {
    while (!this.stopped) {
      try { await this.pass(); }
      catch (error) {
        console.error('[manager] trajectory expiry pass failed:', error);
        try { this.save({ last_error: String(error?.message ?? error).slice(0, 300) }); } catch {}
      }
      await this.pause(this.options.idleMs ?? 3600_000);
    }
  }
  /** One pass over the files closed before the window; returns what it removed. */
  async pass() {
    const started = new Date().toISOString(), removed = { files: 0, bytes: 0 };
    await this.removeMarked();
    const before = new Date((this.options.now?.() ?? Date.now()) - this.windowDays() * day).toISOString();
    const next = this.db.prepare(`SELECT id,repository_id,path,bytes,counts,closed_at FROM trajectory_files
      WHERE expired_at IS NULL AND closed_at IS NOT NULL AND closed_at<? AND (closed_at,id)>(?,?) ORDER BY closed_at,id LIMIT ?`);
    const running = this.db.prepare("SELECT input_ref FROM operations WHERE state='running' AND input_ref IS NOT NULL");
    let after = ['', ''];
    while (!this.stopped) {
      const began = performance.now(), batch = next.all(before, ...after, this.options.batch ?? 20);
      if (!batch.length) break;
      after = [batch.at(-1).closed_at, batch.at(-1).id];
      // A file with the input of a call still running stays (its result may still be written elsewhere); the calls
      // running now are few and held in the partial index operations_running. A closed file never gets new lines.
      const busy = new Set(running.all().map(row => String(row.input_ref).slice(0, 16)));
      const expiring = batch.filter(file => !busy.has(file.id) && !this.trajectories.handles.has(file.id));
      this.mark(expiring);
      await this.remove(expiring);
      removed.files += expiring.length; removed.bytes += expiring.reduce((sum, file) => sum + Number(file.bytes ?? 0), 0);
      await this.pause(Math.max(this.options.pauseMs ?? 50, performance.now() - began), true);
    }
    this.save({ last_pass: { started_at: started, finished_at: new Date().toISOString(), ...removed }, last_error: null });
    return removed;
  }
  mark(files) {
    if (!files.length) return;
    const now = new Date().toISOString(), expire = this.db.prepare('UPDATE trajectory_files SET expired_at=? WHERE id=? AND expired_at IS NULL');
    const add = this.db.prepare(`INSERT INTO trajectory_usage(repository_id,kind,count,bytes) VALUES(?,?,?,?)
      ON CONFLICT(repository_id,kind) DO UPDATE SET count=count+excluded.count,bytes=bytes+excluded.bytes`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const file of files) {
        if (!expire.run(now, file.id).changes) continue;
        const repository = file.repository_id ?? '', bytes = Number(file.bytes ?? 0);
        add.run(repository, 'files', -1, -bytes); add.run(repository, 'expired', 1, bytes);
        let counts = {}; try { counts = JSON.parse(file.counts || '{}'); } catch {}
        for (const [type, value] of Object.entries(counts)) if (Array.isArray(value)) add.run(repository, 'records:' + type, -value[0], -value[1]);
      }
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    for (const file of files) this.trajectories.forget(file.id);
  }
  /** Removes the files of marked entries, oldest first, and records that they are gone. */
  async remove(files) {
    const done = this.db.prepare('UPDATE trajectory_files SET deleted_at=? WHERE id=?');
    for (const file of files) {
      const path = resolve(this.trajectories.root, file.path);
      if (!path.startsWith(this.trajectories.root + sep)) throw new TrajectoryError('trajectory_ref_invalid', file.path);
      await rm(path, { force: true });
      done.run(new Date().toISOString(), file.id);
    }
  }
  async removeMarked() {
    const marked = this.db.prepare('SELECT id,path FROM trajectory_files WHERE expired_at IS NOT NULL AND deleted_at IS NULL ORDER BY expired_at LIMIT 100');
    for (let batch = marked.all(); batch.length && !this.stopped; batch = marked.all()) await this.remove(batch);
  }
}

/** What a ledger row keeps of a call's input once its body is in a file: the call's identity and type. */
export function inputHeader(input) {
  return { operation_id: input?.operation_id ?? null, generation: input?.generation ?? null, ...(input?.request?.type ? { request: { type: input.request.type, workspace_id: input.request.workspace_id ?? null } } : {}) };
}

async function scan(path) {
  const lines = [];
  let file;
  try { file = await openAsync(path, 'r'); } catch { return { lines, bytes: 0, last: null, partial: false }; }
  let bytes = 0, last = null, rest = Buffer.alloc(0);
  try {
    const chunk = Buffer.alloc(1 << 20);
    for (let position = 0; ;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const buffer = Buffer.concat([rest, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (let end = buffer.indexOf(0x0a); end >= 0; end = buffer.indexOf(0x0a, start)) {
        const text = buffer.subarray(start, end);
        let line;
        try { line = JSON.parse(text.toString('utf8')); } catch { return { lines, bytes, last, partial: false, error: new TrajectoryError('trajectory_corrupt', `${path}: line ${lines.length + 1} is not JSON`) }; }
        if (line.seq !== lines.length + 1 || (line.prev ?? null) !== last) return { lines, bytes, last, partial: false, error: new TrajectoryError('trajectory_corrupt', `${path}: line ${lines.length + 1} breaks the chain`) };
        last = sha256(text); bytes += end - start + 1; lines.push({ ...line, bytes: end - start + 1 });
        start = end + 1;
      }
      rest = Buffer.from(buffer.subarray(start));
    }
  } finally { await file.close(); }
  return { lines, bytes, last, partial: rest.length > 0 };
}
