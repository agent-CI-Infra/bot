import { closeSync, existsSync, fdatasync, fdatasyncSync, close as closeAsync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { open as openAsync, rm as rmAsync } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ToolResultFiles, toolResultStorage } from './tool-results.js';

// Trajectories keep the bodies of agent work (model requests and responses, tool calls and results, large logs) in
// append-only JSONL files, one per run, instead of in SQLite rows. SQLite keeps one entry per file, inserted when the
// file is opened and updated once when it is closed, and a locator ("ref") on the rows that already exist for records
// that are looked up one by one. Appending a line never touches SQLite.
//
// A line is {"seq","at","type","id","prev","data"}: prev is the sha256 of the previous line (without its newline), so
// the file is a hash chain. The close update anchors the chain (record count, byte size, last hash): a truncated or
// edited file is reported when it is read. A ref is "<file id>:<offset>:<length>:<sha256 of the line>", so a single
// record is verified without reading its neighbours.
//
// Write order: append the line first, then commit the database row that points to it. A crash in between leaves a line
// nothing references, which is ignored; the database never points to bytes that were not written.

export const recordTypes = ['model_request', 'model_response', 'tool_call', 'tool_result', 'log', 'event'] as const;
export type RecordType = typeof recordTypes[number];

/** Which file a record goes to. key identifies the open file in this process; path is relative, without ".jsonl". */
export interface TrajectoryScope {
  key: string; path: string; repository_id: string | null; task_id: string | null; run_id: string | null;
  conversation_id: string | null; turn_id: string | null;
}

export class TrajectoryError extends Error {
  constructor(readonly code: 'trajectory_corrupt' | 'trajectory_truncated' | 'trajectory_missing' | 'trajectory_ref_invalid' | 'trajectory_expired', readonly detail: string) {
    super(code + ': ' + detail);
  }
}

export interface TrajectoryLine { seq: number; at: string; type: RecordType; id: string; prev: string | null; data: any }
interface Handle {
  id: string; scope: TrajectoryScope; path: string; fd: number; seq: number; last: string | null; bytes: number; records: number;
  counts: Partial<Record<RecordType, [number, number]>>; used: number; confirmed: boolean; closed: boolean; broken: boolean;
  // Serializes fdatasync and the final close of the descriptor.
  chain: Promise<void>;
  // The last model request written to this file and its messages' hashes, for delta encoding.
  lastRequest?: { ref: string; hashes: string[]; depth: number };
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** A path segment from an id: letters, digits, "_" and "-" only, never "." or "..". */
export const segment = (value: unknown) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || '_';
const refPattern = /^([a-f0-9]{16}):(\d+):(\d+):([a-f0-9]{64})$/;
/** The longest delta chain a model request may have before its file gets a full snapshot again. */
const maxRequestDepth = 64;

/** Parses a ref; throws trajectory_ref_invalid for anything else. */
export function parseRef(ref: string) {
  const match = refPattern.exec(ref);
  if (!match) throw new TrajectoryError('trajectory_ref_invalid', String(ref).slice(0, 120));
  return { file: match[1]!, offset: Number(match[2]), length: Number(match[3]), sha256: match[4]! };
}

/** Adds the columns that are missing; adding a column does not read the table's rows. */
export function addColumns(db: DatabaseSync, table: string, columns: Record<string, string>) {
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
  for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
/** Locators of the records a call replays: request and result lines, and the hash of the request it was recorded for. */
export const operationRefColumns = { request_ref: 'TEXT', result_ref: 'TEXT', request_sha256: 'TEXT' };

export function trajectoryStorage(db: DatabaseSync) {
  toolResultStorage(db);
  addColumns(db, 'task_tools', operationRefColumns);
  addColumns(db, 'model_requests', { request_ref: 'TEXT', response_ref: 'TEXT' });
  addColumns(db, 'task_logs', { content_ref: 'TEXT' });
  db.exec(`CREATE TABLE IF NOT EXISTS trajectory_files(id TEXT PRIMARY KEY,repository_id TEXT,task_id TEXT,run_id TEXT,conversation_id TEXT,turn_id TEXT,
      path TEXT NOT NULL,created_at TEXT NOT NULL,closed_at TEXT,bytes INTEGER,records INTEGER,last_sha256 TEXT,counts TEXT);
    -- Files left open by a stopped process, which the background sealer closes; few rows at any time.
    CREATE INDEX IF NOT EXISTS trajectory_files_open ON trajectory_files(created_at) WHERE closed_at IS NULL;
    CREATE INDEX IF NOT EXISTS trajectory_files_repository ON trajectory_files(repository_id,created_at);
    CREATE INDEX IF NOT EXISTS trajectory_files_conversation ON trajectory_files(conversation_id) WHERE conversation_id IS NOT NULL;
    -- Totals per project ('' for none), added when a file is closed: kind 'files' counts files and their bytes,
    -- 'records:<type>' counts lines and their bytes. The storage page reads these instead of walking files or tables.
    CREATE TABLE IF NOT EXISTS trajectory_usage(repository_id TEXT NOT NULL,kind TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(repository_id,kind));
    -- Content-addressed blobs (large reused values such as a task's file lists), one row per project that stored one.
    -- A blob's file is shared by content and removed with the last project that holds it.
    CREATE TABLE IF NOT EXISTS trajectory_blobs(repository_id TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(repository_id,sha256));
    CREATE INDEX IF NOT EXISTS trajectory_blobs_hash ON trajectory_blobs(sha256);`);
  // Cleanup by days (#671): expired_at: the file's records no longer resolve, refs to it read as expired; deleted_at: the
  // file is gone from disk. The partial indexes hold the closed files of tasks and dispatches that may still expire, per
  // project in closed_at order, and the expired ones whose file is still to be removed.
  addColumns(db, 'trajectory_files', { expired_at: 'TEXT', deleted_at: 'TEXT' });
  db.exec(`CREATE INDEX IF NOT EXISTS trajectory_files_expiry ON trajectory_files(repository_id,closed_at,id)
      WHERE expired_at IS NULL AND closed_at IS NOT NULL AND conversation_id IS NULL;
    CREATE INDEX IF NOT EXISTS trajectory_files_removal ON trajectory_files(expired_at) WHERE expired_at IS NOT NULL AND deleted_at IS NULL;`);
}

export class Trajectories {
  readonly root: string;
  readonly results: ToolResultFiles;
  /** Content-addressed blobs: <blobs>/sha256/<first two hex digits>/<sha256>. */
  readonly blobs: string;
  private readonly temporary: boolean;
  private readonly open = new Map<string, Handle>();
  private readonly handles = new Map<string, Handle>();
  private readonly paths = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;

  /** root: the directory that holds the files; null keeps them in a temporary directory (an in-memory database). */
  constructor(private readonly db: DatabaseSync, root: string | null, readonly idleMs = 30 * 60_000) {
    this.temporary = root === null;
    this.root = root === null ? mkdtempSync(join(tmpdir(), 'bot-trajectories-')) : resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.results = new ToolResultFiles(db, this.root);
    this.blobs = root === null ? join(this.root, '.blobs') : join(dirname(this.root), 'blobs');
    // A file nothing appended to for a while is closed; a later record opens a continuation file.
    this.timer = setInterval(() => this.closeIdle(), Math.min(idleMs, 60_000));
    this.timer.unref?.();
  }

  /** The file a task's records belong to: a conversation turn, an explicit scope, or the task's current run. */
  scopeOf(task: Record<string, any>): TrajectoryScope | null {
    if (task.trajectory) return task.trajectory as TrajectoryScope;
    if (task.conversation_id) {
      const turn = String(task.id ?? 'turn');
      return { key: `turn:${task.conversation_id}:${turn}`, path: `conversations/${segment(task.conversation_id)}/${segment(turn)}`, repository_id: task.repository_id ?? null,
        task_id: null, run_id: null, conversation_id: String(task.conversation_id), turn_id: turn };
    }
    if (task.id && task.trace_run_id && task.repository_id) return runScope(String(task.repository_id), String(task.id), String(task.trace_run_id));
    return null;
  }

  /** Appends one record and returns its ref. The line is in the page cache when this returns; sync() makes it durable. */
  append(scope: TrajectoryScope, type: RecordType, id: string, data: unknown): string {
    let handle = this.handle(scope);
    const line = JSON.stringify({ seq: handle.seq + 1, at: new Date().toISOString(), type, id: String(id), prev: handle.last, data: data ?? null });
    const bytes = Buffer.from(line + '\n');
    try { writeAll(handle.fd, bytes); }
    catch (error) {
      // A partly written line would break the chain for every later line: cut it off, or give up on this file.
      try { ftruncateSync(handle.fd, handle.bytes); } catch { handle.broken = true; this.finish(handle); }
      throw error;
    }
    const offset = handle.bytes, digest = sha256(line);
    handle.bytes += bytes.length; handle.seq++; handle.records++; handle.last = digest; handle.used = Date.now();
    const count = handle.counts[type] ?? [0, 0]; count[0]++; count[1] += bytes.length; handle.counts[type] = count;
    return `${handle.id}:${offset}:${bytes.length - 1}:${digest}`;
  }

  /** Waits until the file holding ref is on disk (fdatasync); for records a retried call replays. */
  sync(ref: string): Promise<void> {
    const handle = this.handles.get(parseRef(ref).file);
    // A closed file is synced before its descriptor closes.
    if (!handle) return Promise.resolve();
    if (handle.closed) return handle.chain;
    const done = handle.chain.then(() => new Promise<void>((ok, fail) => fdatasync(handle.fd, error => error ? fail(error) : ok())));
    handle.chain = done.catch(() => {});
    return done;
  }

  /**
   * A model request, as the messages added since the previous request in the same file. The previous request's
   * messages must be a prefix of this one's; otherwise (compaction, another conversation) the line holds them all.
   */
  appendModelRequest(scope: TrajectoryScope, id: string, body: Record<string, any>): string {
    const handle = this.handle(scope), messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const hashes = messages.map(message => sha256(JSON.stringify(message))), last = handle.lastRequest;
    const delta = !!last && last.depth < maxRequestDepth && last.hashes.length <= hashes.length && last.hashes.every((hash, i) => hash === hashes[i]);
    const data = delta ? { previous: last!.ref, from: last!.hashes.length, body: { ...body, messages: messages.slice(last!.hashes.length) } } : { body };
    const ref = this.append(scope, 'model_request', id, data);
    // append() may have replaced a broken handle; the chain state belongs to the file the line went to.
    const target = this.handles.get(parseRef(ref).file);
    if (target) target.lastRequest = { ref, hashes, depth: delta && target === handle ? last!.depth + 1 : 0 };
    return ref;
  }

  /** The full body of a model request written by appendModelRequest. */
  readModelRequest(ref: string): Record<string, any> {
    const parts: { from: number; body: Record<string, any> }[] = [];
    for (let current: string | undefined = ref, steps = 0; current; steps++) {
      if (steps > maxRequestDepth + 1) throw new TrajectoryError('trajectory_corrupt', 'model request chain too long');
      const line = this.read(current), data = line.data ?? {};
      if (line.type !== 'model_request' || !data.body) throw new TrajectoryError('trajectory_corrupt', 'not a model request: ' + current.slice(0, 40));
      parts.unshift({ from: Number(data.from ?? 0), body: data.body });
      current = data.previous;
    }
    let messages: any[] = [];
    for (const part of parts) messages = [...messages.slice(0, part.from), ...(Array.isArray(part.body.messages) ? part.body.messages : [])];
    return { ...parts.at(-1)!.body, messages };
  }

  /** One record by its ref, verified against the hash in the ref. */
  read(ref: string): TrajectoryLine {
    const { file, offset, length, sha256: expected } = parseRef(ref);
    const path = this.pathOf(file), buffer = Buffer.alloc(length + 1);
    let fd: number;
    try { fd = openSync(join(this.root, path), 'r'); }
    catch { throw new TrajectoryError('trajectory_truncated', `${path}: file is missing`); }
    try {
      const read = readSync(fd, buffer, 0, length + 1, offset);
      if (read < length + 1) throw new TrajectoryError('trajectory_truncated', `${path}: ends before offset ${offset + length + 1}`);
    } finally { closeSync(fd); }
    const text = buffer.subarray(0, length);
    if (buffer[length] !== 0x0a || sha256(text) !== expected) throw new TrajectoryError('trajectory_corrupt', `${path}: record at offset ${offset} does not match its hash`);
    return JSON.parse(text.toString('utf8')) as TrajectoryLine;
  }

  /**
   * Every record of a file, with the whole chain verified: sequence numbers, each prev against the line before it and,
   * for a closed file, the record count, size and last hash recorded when it was closed.
   */
  async lines(file: string): Promise<TrajectoryLine[]> {
    const entry = this.db.prepare('SELECT * FROM trajectory_files WHERE id=?').get(file) as Record<string, any> | undefined;
    if (!entry) throw new TrajectoryError('trajectory_missing', file);
    if (entry.expired_at) throw new TrajectoryError('trajectory_expired', `${entry.path}: removed after its retention window (${entry.expired_at})`);
    const scanned = await scan(join(this.root, String(entry.path)));
    if (scanned.error) throw scanned.error;
    if (scanned.partial) throw new TrajectoryError('trajectory_truncated', `${entry.path}: last line is incomplete`);
    if (entry.closed_at && (scanned.lines.length !== Number(entry.records) || scanned.bytes !== Number(entry.bytes) || (scanned.last ?? null) !== (entry.last_sha256 ?? null))) {
      throw new TrajectoryError(scanned.bytes < Number(entry.bytes) ? 'trajectory_truncated' : 'trajectory_corrupt',
        `${entry.path}: ${scanned.lines.length} records and ${scanned.bytes} bytes, closed with ${entry.records} and ${entry.bytes}`);
    }
    return scanned.lines;
  }

  /** Closes the file of a scope (a run ended); its entry gets the record count, size, last hash and type counts. */
  close(key: string): void {
    const handle = this.open.get(key);
    if (handle) this.finish(handle);
  }

  /** Closes every open file; for shutdown. */
  closeAll(): void {
    if (this.timer) clearInterval(this.timer);
    for (const handle of [...this.open.values()]) this.finish(handle);
  }

  /** Waits for pending fdatasync and descriptor closes; tests and shutdown. */
  async settle(): Promise<void> { await Promise.all([...this.handles.values()].map(handle => handle.chain)); }

  /**
   * Stores a value once by the sha256 of its JSON text and returns the reference that replaces it. The file is on disk
   * (fdatasync, then an atomic rename) before this returns, so a row may point to it right away.
   */
  putBlob(value: unknown, repositoryId: string): { $blob: string; bytes: number } {
    const text = JSON.stringify(value), bytes = Buffer.byteLength(text), hash = sha256(text), path = this.blobPath(hash);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`, fd = openSync(temporary, 'wx', 0o600);
      try { writeAll(fd, Buffer.from(text)); fdatasyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
    }
    atomic(this.db, () => {
      const added = this.db.prepare('INSERT OR IGNORE INTO trajectory_blobs(repository_id,sha256,bytes,created_at) VALUES(?,?,?,?)').run(repositoryId, hash, bytes, new Date().toISOString()).changes;
      if (added) this.addUsage(repositoryId, 'blobs', 1, bytes);
    });
    return { $blob: hash, bytes };
  }

  /** A stored blob's value, verified against its hash. */
  getBlob(hash: string): unknown {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new TrajectoryError('trajectory_ref_invalid', String(hash).slice(0, 80));
    let data: Buffer;
    try { data = readFileSync(this.blobPath(hash)); } catch { throw new TrajectoryError('trajectory_truncated', `blob ${hash} is missing`); }
    if (sha256(data) !== hash) throw new TrajectoryError('trajectory_corrupt', `blob ${hash} does not match its hash`);
    return JSON.parse(data.toString('utf8'));
  }

  private blobPath(hash: string) { return join(this.blobs, 'sha256', hash.slice(0, 2), hash); }

  /**
   * Marks closed files expired after their retention window (#671), in one transaction: their refs read as expired from
   * then on, and their bytes and record counts move in trajectory_usage from files and records to 'expired'. The caller
   * removes the files and marks the entries deleted (deleted()). Entries and the rows that refer to them stay.
   */
  expire(files: Record<string, any>[]): void {
    const now = new Date().toISOString();
    atomic(this.db, () => {
      for (const file of files) {
        if (!this.db.prepare('UPDATE trajectory_files SET expired_at=? WHERE id=? AND expired_at IS NULL AND closed_at IS NOT NULL').run(now, file.id).changes) continue;
        const repository = String(file.repository_id ?? ''), bytes = Number(file.bytes ?? 0);
        let counts: Record<string, any> = {}; try { counts = JSON.parse(file.counts || '{}'); } catch {}
        this.usage(repository, -1, -bytes, counts, -1);
        this.addUsage(repository, 'expired', 1, bytes);
      }
    });
    for (const file of files) this.paths.delete(String(file.id));
  }
  /** Removes the file of an expired entry from disk and records it; a file already gone is fine. */
  async deleted(file: { id: string; path: string }): Promise<void> {
    const path = resolve(this.root, file.path);
    if (!path.startsWith(this.root + sep)) throw new TrajectoryError('trajectory_ref_invalid', file.path);
    // Off the event loop: freeing a large file's blocks can take a while.
    await rmAsync(path, { force: true });
    this.db.prepare('UPDATE trajectory_files SET deleted_at=? WHERE id=?').run(new Date().toISOString(), file.id);
  }

  /** Removes the files of a deleted project or conversation and their entries; their totals are taken back. */
  remove(where: { repository_id?: string; conversation_id?: string }): void {
    const [column, value] = where.repository_id !== undefined ? ['repository_id', where.repository_id] : ['conversation_id', where.conversation_id!];
    this.results.remove(column as 'repository_id' | 'conversation_id', value);
    for (const handle of [...this.open.values()]) if ((handle.scope as any)[column] === value) this.finish(handle);
    const rows = this.db.prepare(`SELECT id,repository_id,path,bytes,counts,expired_at FROM trajectory_files WHERE ${column}=?`).all(value) as Record<string, any>[];
    for (const row of rows) {
      rmSync(join(this.root, String(row.path)), { force: true });
      this.handles.delete(String(row.id)); this.paths.delete(String(row.id));
    }
    atomic(this.db, () => {
      for (const row of rows) {
        // An expired file's totals were already moved to 'expired' (expire()); they leave from there.
        if (row.expired_at) this.addUsage(String(row.repository_id ?? ''), 'expired', -1, -Number(row.bytes ?? 0));
        else if (row.bytes !== null) this.usage(String(row.repository_id ?? ''), -1, -Number(row.bytes), JSON.parse(row.counts || '{}'), -1);
        this.db.prepare('DELETE FROM trajectory_files WHERE id=?').run(row.id);
      }
    });
    if (where.repository_id !== undefined) {
      rmSync(join(this.root, segment(where.repository_id)), { recursive: true, force: true });
      // The project's blobs; a file another project also stored stays for that project.
      const blobs = this.db.prepare('SELECT sha256,bytes FROM trajectory_blobs WHERE repository_id=?').all(where.repository_id) as { sha256: string; bytes: number }[];
      // Nothing of the project is left: its totals go too (a conversation's file only adjusts its project's totals).
      atomic(this.db, () => {
        this.db.prepare('DELETE FROM trajectory_blobs WHERE repository_id=?').run(where.repository_id!);
        this.db.prepare('DELETE FROM trajectory_usage WHERE repository_id=?').run(where.repository_id!);
      });
      for (const blob of blobs) if (!this.db.prepare('SELECT 1 FROM trajectory_blobs WHERE sha256=?').get(blob.sha256)) rmSync(this.blobPath(blob.sha256), { force: true });
    }
    else rmSync(join(this.root, 'conversations', segment(where.conversation_id)), { recursive: true, force: true });
  }

  /**
   * Closes the entries a stopped process left open: drops an incomplete last line, verifies the chain and records
   * the anchor. A file that fails verification is closed with what verified, and its entry says so in counts.
   * Runs in the background, one file at a time.
   */
  async seal(): Promise<number> {
    let sealed = 0;
    for (;;) {
      const open = new Set(this.handles.keys());
      const entry = (this.db.prepare('SELECT * FROM trajectory_files WHERE closed_at IS NULL ORDER BY created_at').all() as Record<string, any>[])
        .find(row => !open.has(String(row.id)));
      if (!entry) return sealed;
      const path = join(this.root, String(entry.path)), scanned = await scan(path);
      if (scanned.partial && !scanned.error) await truncateFile(path, scanned.bytes);
      const counts: Record<string, [number, number] | boolean> = {};
      for (const line of scanned.lines) { const count = (counts[line.type] as [number, number]) ?? [0, 0]; count[0]++; count[1] += line.bytes; counts[line.type] = count; }
      if (scanned.error) counts.unverified = true;
      atomic(this.db, () => {
        const result = this.db.prepare('UPDATE trajectory_files SET closed_at=?,bytes=?,records=?,last_sha256=?,counts=? WHERE id=? AND closed_at IS NULL')
          .run(new Date().toISOString(), scanned.bytes, scanned.lines.length, scanned.last, JSON.stringify(counts), entry.id);
        if (result.changes) this.usage(String(entry.repository_id ?? ''), 1, scanned.bytes, counts, 1);
      });
      sealed++;
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  /** Removes the temporary directory of an in-memory database. */
  dispose(): void { this.closeAll(); if (this.temporary) void this.settle().then(() => rmSync(this.root, { recursive: true, force: true })); }

  private handle(scope: TrajectoryScope): Handle {
    const current = this.open.get(scope.key);
    if (current && !current.closed && !current.broken) { this.confirm(current); return current; }
    // A new file never reuses a path: a closed run, a rolled-back open or a crash may have left one there.
    let relative = scope.path + '.jsonl';
    for (let n = 2; existsSync(join(this.root, relative)); n++) relative = `${scope.path}.${n}.jsonl`;
    const absolute = join(this.root, relative);
    if (!absolute.startsWith(this.root + sep)) throw new TrajectoryError('trajectory_ref_invalid', relative);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const fd = openSync(absolute, 'ax', 0o600), id = randomBytes(8).toString('hex');
    const handle: Handle = { id, scope, path: relative, fd, seq: 0, last: null, bytes: 0, records: 0, counts: {}, used: Date.now(), confirmed: false, closed: false, broken: false, chain: Promise.resolve() };
    this.insert(handle);
    this.open.set(scope.key, handle); this.handles.set(id, handle); this.paths.set(id, relative);
    return handle;
  }

  private insert(handle: Handle) {
    const s = handle.scope;
    this.db.prepare('INSERT OR IGNORE INTO trajectory_files(id,repository_id,task_id,run_id,conversation_id,turn_id,path,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(handle.id, s.repository_id, s.task_id, s.run_id, s.conversation_id, s.turn_id, handle.path, new Date().toISOString());
    handle.confirmed = !inTransaction(this.db);
  }

  // An entry inserted inside a transaction that later rolled back is gone; every record written before the entry is
  // seen committed checks for it, so a committed ref always has a committed entry.
  private confirm(handle: Handle) {
    if (handle.confirmed) return;
    if (!this.db.prepare('SELECT 1 FROM trajectory_files WHERE id=?').get(handle.id)) this.insert(handle);
    else handle.confirmed = !inTransaction(this.db);
  }

  private finish(handle: Handle) {
    if (handle.closed) return;
    handle.closed = true;
    if (this.open.get(handle.scope.key) === handle) this.open.delete(handle.scope.key);
    const repository = handle.scope.repository_id ?? '';
    try {
      atomic(this.db, () => {
        const closed = new Date().toISOString(), counts = JSON.stringify(handle.counts);
        let changed = this.db.prepare('UPDATE trajectory_files SET closed_at=?,bytes=?,records=?,last_sha256=?,counts=? WHERE id=? AND closed_at IS NULL')
          .run(closed, handle.bytes, handle.records, handle.last, counts, handle.id).changes;
        if (!changed && !this.db.prepare('SELECT 1 FROM trajectory_files WHERE id=?').get(handle.id)) {
          const s = handle.scope;
          changed = this.db.prepare(`INSERT INTO trajectory_files(id,repository_id,task_id,run_id,conversation_id,turn_id,path,created_at,closed_at,bytes,records,last_sha256,counts)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(handle.id, s.repository_id, s.task_id, s.run_id, s.conversation_id, s.turn_id, handle.path, closed, closed,
            handle.bytes, handle.records, handle.last, counts).changes;
        }
        if (changed) this.usage(repository, 1, handle.bytes, handle.counts, 1);
      });
    } finally {
      // The entry is closed in the database first; the descriptor closes after pending syncs. A rolled-back close is
      // found open later, and the sealer closes it from the file.
      handle.chain = handle.chain.then(() => new Promise<void>(done => fdatasync(handle.fd, () => closeAsync(handle.fd, () => done()))));
      void handle.chain.then(() => { if (this.handles.get(handle.id) === handle) this.handles.delete(handle.id); });
    }
  }

  private usage(repository: string, files: number, bytes: number, counts: Record<string, any>, sign: number) {
    this.addUsage(repository, 'files', files, bytes);
    for (const [type, value] of Object.entries(counts)) if (Array.isArray(value)) this.addUsage(repository, 'records:' + type, sign * value[0], sign * value[1]);
  }
  private addUsage(repository: string, kind: string, count: number, bytes: number) {
    this.db.prepare(`INSERT INTO trajectory_usage(repository_id,kind,count,bytes) VALUES(?,?,?,?)
      ON CONFLICT(repository_id,kind) DO UPDATE SET count=count+excluded.count,bytes=bytes+excluded.bytes`).run(repository, kind, count, bytes);
  }

  private pathOf(file: string): string {
    const known = this.paths.get(file);
    if (known) return known;
    const row = this.db.prepare('SELECT path,expired_at FROM trajectory_files WHERE id=?').get(file) as { path: string; expired_at: string | null } | undefined;
    if (!row) throw new TrajectoryError('trajectory_missing', file);
    if (row.expired_at) throw new TrajectoryError('trajectory_expired', `${row.path}: removed after its retention window (${row.expired_at})`);
    if (this.paths.size > 10_000) this.paths.clear();
    this.paths.set(file, row.path);
    return row.path;
  }

  private closeIdle() {
    const before = Date.now() - this.idleMs;
    for (const handle of [...this.open.values()]) if (handle.used < before) { try { this.finish(handle); } catch (error) { console.error('[trajectories] close failed:', error); } }
  }
}

/** The file of one task run. */
export function runScope(repositoryId: string, taskId: string, runId: string): TrajectoryScope {
  return { key: 'run:' + runId, path: `${segment(repositoryId)}/${segment(taskId)}/${segment(runId)}`, repository_id: repositoryId, task_id: taskId, run_id: runId,
    conversation_id: null, turn_id: null };
}

/** The file of one Manager dispatch attempt for an event. */
export function dispatchScope(repositoryId: string, eventId: string, attempt: number): TrajectoryScope {
  return { key: `dispatch:${eventId}:${attempt}`, path: `${segment(repositoryId)}/dispatch/${segment(eventId)}-${attempt}`, repository_id: repositoryId, task_id: null,
    run_id: null, conversation_id: null, turn_id: null };
}

/**
 * The small fields of a payload that stay in its SQLite column once the body is in a file: top-level numbers,
 * booleans, null and strings of at most 256 characters, and (one level down) the same of nested objects, so existing
 * queries on type, code, state, workspace_id, error or tree_sha keep working. `clipped` names strings kept up to 8000
 * characters (head and tail beyond that) instead of dropped: a log's detail is its reason, read by the task list.
 */
export function payloadHeader(value: any, clipped: string[] = [], depth = 1): any {
  if (Array.isArray(value)) return null;
  if (!value || typeof value !== 'object') return typeof value === 'string' && value.length > 256 ? null : value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'number' || typeof item === 'boolean') out[key] = item;
    else if (typeof item === 'string') { if (item.length <= 256) out[key] = item; else if (clipped.includes(key)) out[key] = item.length <= 8000 ? item : item.slice(0, 4000) + ' … ' + item.slice(-3997); }
    else if (depth > 0 && typeof item === 'object' && !Array.isArray(item)) out[key] = payloadHeader(item, clipped, depth - 1);
  }
  return out;
}

function writeAll(fd: number, bytes: Buffer) {
  for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written);
}

function inTransaction(db: DatabaseSync): boolean {
  const state = (db as unknown as { isTransaction?: boolean }).isTransaction;
  return state === undefined ? true : state;
}

function atomic(db: DatabaseSync, fn: () => void) {
  const name = 'trajectory_' + randomBytes(6).toString('hex');
  db.exec('SAVEPOINT ' + name);
  try { fn(); db.exec('RELEASE ' + name); }
  catch (error) { db.exec('ROLLBACK TO ' + name); db.exec('RELEASE ' + name); throw error; }
}

async function truncateFile(path: string, bytes: number) {
  const file = await openAsync(path, 'r+');
  try { await file.truncate(bytes); await file.datasync(); } finally { await file.close(); }
}

/**
 * Reads a file line by line, asynchronously, and verifies its chain. Stops at the first line that fails; error says
 * why. partial: the file ends in an incomplete line (bytes counts only complete lines).
 */
export async function scan(path: string): Promise<{ lines: (TrajectoryLine & { bytes: number })[]; bytes: number; last: string | null; partial: boolean; error?: TrajectoryError }> {
  const lines: (TrajectoryLine & { bytes: number })[] = [];
  let file;
  try { file = await openAsync(path, 'r'); }
  catch { return { lines, bytes: 0, last: null, partial: false }; }
  let bytes = 0, last: string | null = null, rest = Buffer.alloc(0);
  try {
    const chunk = Buffer.alloc(1 << 20);
    for (let position = 0; ;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      let buffer = Buffer.concat([rest, chunk.subarray(0, bytesRead)]), start = 0;
      for (let end = buffer.indexOf(0x0a); end >= 0; end = buffer.indexOf(0x0a, start)) {
        const text = buffer.subarray(start, end);
        let line: TrajectoryLine;
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
