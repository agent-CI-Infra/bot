import { closeSync, constants, copyFileSync, fdatasyncSync, fstatSync, mkdirSync, chmodSync, existsSync, lstatSync, readdirSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { DatabaseSync } from 'node:sqlite';
import { computerResultOwner } from '../../runner/result-owner.mjs';
import type { TrajectoryScope } from './trajectories.js';
import { credentialShapeStream, redactCredentialShapes } from '../core/redaction.js';

export function toolResultStorage(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS tool_result_files(file TEXT PRIMARY KEY,owner TEXT NOT NULL,source TEXT NOT NULL,
    repository_id TEXT,task_id TEXT,conversation_id TEXT,bytes INTEGER NOT NULL,created_at TEXT NOT NULL,source_context TEXT NOT NULL,UNIQUE(owner,source));
    CREATE INDEX IF NOT EXISTS tool_result_files_repository ON tool_result_files(repository_id);
    CREATE INDEX IF NOT EXISTS tool_result_files_conversation ON tool_result_files(conversation_id);`);
  const columns = db.prepare('PRAGMA table_info(tool_result_files)').all();
  if (!columns.some(c => c.name === 'expires_at')) db.exec("ALTER TABLE tool_result_files ADD COLUMN expires_at TEXT; UPDATE tool_result_files SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+1 day');");
  db.exec('CREATE INDEX IF NOT EXISTS tool_result_files_expiry ON tool_result_files(expires_at);');
}

/** Temporary immutable UTF-8 results, separate from the backed-up trajectory archive. */
export class ToolResultFiles {
  constructor(readonly db: DatabaseSync, readonly root: string, readonly legacyRoot?: string) {}
  private ownerPath(owner: string) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(owner)) throw new Error('tool_result_owner_invalid');
    return join(this.root,owner);
  }
  directory(owner: string) {
    const path = this.ownerPath(owner); mkdirSync(path,{recursive:true,mode:0o755}); chmodSync(path,0o755); return path;
  }
  path(file: string, owner: string) { return join(this.ownerPath(owner),file+'.utf8'); }
  migrateLegacy() {
    if (!this.legacyRoot) return;
    for (const row of this.db.prepare('SELECT * FROM tool_result_files').all()) {
      const source = join(this.legacyRoot, 'results', String(row.file) + '.utf8');
      if (!existsSync(source)) continue;
      let owner = String(row.owner);
      if (row.repository_id) owner = computerResultOwner('project',row.repository_id);
      else if (row.conversation_id) {
        const chat = this.db.prepare('SELECT id,installation_tenant FROM channel_chats WHERE id=?').get(row.conversation_id);
        const person = this.db.prepare('SELECT principal_id,tenant_id FROM management_conversations WHERE id=?').get(row.conversation_id);
        if (chat) owner = computerResultOwner('assistant',createHash('sha256').update(`assistant-computer:group:${chat.installation_tenant??''}:${chat.id}`).digest('hex').slice(0,32));
        else if (person) owner = computerResultOwner('assistant',createHash('sha256').update(`assistant-computer:person:${person.tenant_id}:${person.principal_id}`).digest('hex').slice(0,32));
      }
      this.directory(owner); const target = this.path(String(row.file),owner);
      // Copy before the metadata switch: an interrupted upgrade always has a complete source to retry.
      copyFileSync(source,target+'.migration'); chmodSync(target+'.migration',0o444); renameSync(target+'.migration',target);
      this.db.prepare('UPDATE tool_result_files SET owner=?,source=? WHERE file=?').run(owner,'run_command:legacy:'+row.file,String(row.file));
      rmSync(source,{force:true});
    }
  }

  private row(owner: string, source: string) {
    return this.db.prepare("SELECT file,bytes,expires_at FROM tool_result_files WHERE owner=? AND source=? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')").get(owner, source) as { file: string; bytes: number; expires_at: string } | undefined;
  }
  // A result file is read back by the agent: it loses credential shapes, as the tool results it is cut from do (#1087).
  async save(owner: string, scope: TrajectoryScope, source: string, chunks: AsyncIterable<string | Buffer>, guard: () => unknown | Promise<unknown>) {
    await guard();
    const previous = this.row(owner, source); if (previous) return this.reference(previous);
    this.directory(owner);
    const file = randomBytes(24).toString('hex'), target = this.path(file, owner), temporary = target + '.tmp';
    const fd = openSync(temporary, 'wx', 0o600); let bytes = 0, closed = false;
    const decoder = new StringDecoder('utf8'), ready: string[] = [], shapes = credentialShapeStream(text => ready.push(text));
    const write = () => {
      for (const text of ready.splice(0)) {
        const data = Buffer.from(text);
        for (let offset = 0; offset < data.length;) offset += writeSync(fd, data, offset, data.length - offset);
        bytes += data.length;
      }
    };
    try {
      for await (const chunk of chunks) { await guard(); shapes.data(typeof chunk === 'string' ? chunk : decoder.write(chunk)); write(); }
      shapes.data(decoder.end()); shapes.end(); write();
      await guard(); fdatasyncSync(fd); closeSync(fd); closed = true;
      renameSync(temporary, target); chmodSync(target, 0o444);
      const created = new Date().toISOString(), expires_at = new Date(Date.now() + 86400_000).toISOString();
      this.db.prepare("UPDATE tool_result_files SET source='expired:'||file WHERE owner=? AND source=? AND expires_at<=?").run(owner, source, created);
      const inserted = this.db.prepare('INSERT OR IGNORE INTO tool_result_files(file,owner,source,repository_id,task_id,conversation_id,bytes,created_at,source_context,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(file, owner, source, scope.repository_id, scope.task_id, scope.conversation_id, bytes, created, '[]', expires_at).changes;
      if (!inserted) { rmSync(target, { force: true }); return this.reference(this.row(owner, source)!); }
      return this.reference({ file, bytes, expires_at });
    } catch (error) {
      if (!closed) closeSync(fd); rmSync(temporary, { force: true }); rmSync(target, { force: true }); throw error;
    }
  }
  saveText(owner: string, scope: TrajectoryScope, source: string, text: string) {
    const previous = this.row(owner, source); if (previous) return this.reference(previous);
    this.directory(owner);
    const file = randomBytes(24).toString('hex'), target = this.path(file, owner), temporary = target + '.tmp';
    const expires_at = new Date(Date.now() + 86400_000).toISOString(), created = new Date().toISOString();
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600); const data = Buffer.from(redactCredentialShapes(text));
      for (let offset = 0; offset < data.length;) offset += writeSync(fd, data, offset, data.length - offset);
      fdatasyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, target); chmodSync(target, 0o444);
      this.db.prepare("UPDATE tool_result_files SET source='expired:'||file WHERE owner=? AND source=? AND expires_at<=?").run(owner, source, created);
      this.db.prepare('INSERT INTO tool_result_files(file,owner,source,repository_id,task_id,conversation_id,bytes,created_at,source_context,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(file, owner, source, scope.repository_id, scope.task_id, scope.conversation_id, data.length, created, '[]', expires_at);
      return this.reference({ file, bytes: data.length, expires_at });
    } catch (error) { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); rmSync(target, { force: true }); throw error; }
  }
  recent(owner: string) {
    return this.db.prepare("SELECT file,bytes,source,created_at,expires_at FROM tool_result_files WHERE owner=? AND expires_at>? ORDER BY created_at DESC LIMIT 10").all(owner, new Date().toISOString())
      .map(row => ({ tool: String(row.source).split(':')[0], file: 'result:' + row.file, bytes: row.bytes, created_at: row.created_at }));
  }
  sweep(now = Date.now()) {
    // Keep expired metadata for seven days so a stale model handle explains why it stopped working.
    const rows = this.db.prepare('SELECT file,owner FROM tool_result_files WHERE expires_at<=?').all(new Date(now).toISOString());
    for (const row of rows) rmSync(this.path(String(row.file), String(row.owner)), { force: true });
    this.db.prepare('DELETE FROM tool_result_files WHERE expires_at<?').run(new Date(now - 7 * 86400_000).toISOString());
    // A process interrupted before registration can leave a temporary or orphan file; it has the same maximum lifetime.
    for (const owner of existsSync(this.root) ? readdirSync(this.root,{withFileTypes:true}) : []) {
      if (!owner.isDirectory() || !/^[a-zA-Z0-9_-]{1,160}$/.test(owner.name)) continue;
      for (const entry of readdirSync(join(this.root,owner.name),{withFileTypes:true})) {
        if (!entry.isFile() || !/^[a-f0-9]{48}\.utf8(?:\.tmp|\.migration)?$/.test(entry.name)) continue;
        const path=join(this.root,owner.name,entry.name);
        if (lstatSync(path).mtimeMs < now-86400_000) rmSync(path,{force:true});
      }
    }
  }
  removeOwner(owner: string) {
    this.db.prepare('DELETE FROM tool_result_files WHERE owner=?').run(owner);
    rmSync(join(this.root, owner), { recursive: true, force: true });
  }
  private reference(row: { file: string; bytes: number; expires_at?: string }) {
    return { file: 'result:' + row.file, bytes: row.bytes, encoding: 'utf-8', expires_at: row.expires_at, notice: 'Read this immutable result with read_tool_result(file, position, length). Positions and lengths are UTF-8 bytes; use next_position for the following page. Reading never repeats the original operation.' };
  }
  read(owner: string, file: unknown, position: unknown = 0, length: unknown = 16384) {
    if (typeof file !== 'string' || !/^result:[a-f0-9]{48}$/.test(file)) return { error: 'tool_result_not_found' };
    const row = this.db.prepare('SELECT file,bytes,expires_at FROM tool_result_files WHERE file=? AND owner=?').get(file.slice(7), owner) as { file: string; bytes: number;expires_at:string } | undefined;
    if (!row) return { error: 'tool_result_not_found' };
    if (row.expires_at <= new Date().toISOString()) { try { rmSync(this.path(row.file, owner),{force:true}); } catch { /* The background sweep retries failed removals. */ } return {error:'tool_result_expired'}; }
    if (!Number.isSafeInteger(position) || Number(position) < 0 || Number(position) > row.bytes || !Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > 65536)
      return { error: 'tool_result_range_invalid' };
    let fd;
    try {
      fd = openSync(this.path(row.file, owner), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!fstatSync(fd).isFile() || fstatSync(fd).size !== row.bytes) return { error: 'tool_result_unavailable' };
      const data = Buffer.alloc(Math.min(Number(length), row.bytes - Number(position)));
      if (readSync(fd, data, 0, data.length, Number(position)) !== data.length) return { error: 'tool_result_unavailable' };
      if (data.length && (data[0]! & 0xc0) === 0x80) return { error: 'tool_result_range_invalid' };
      let end = data.length;
      if (Number(position) + end < row.bytes) for (let back = 1; back <= 3 && end - back >= 0; back++) {
        const byte = data[end - back]!; if ((byte & 0xc0) === 0x80) continue;
        const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1; if (need > back) end -= back; break;
      }
      if (data.length && !end) return { error: 'tool_result_range_invalid', notice: 'The length splits a UTF-8 character; request at least 4 bytes.' };
      return { file, content: data.subarray(0, end).toString('utf8'), position, next_position: Number(position) + end, eof: Number(position) + end === row.bytes, bytes: row.bytes, encoding: 'utf-8' };
    } catch { return { error: 'tool_result_unavailable' }; } finally { if (fd !== undefined) closeSync(fd); }
  }
  remove(column: 'repository_id' | 'conversation_id', value: string) {
    const rows = this.db.prepare(`SELECT file,owner FROM tool_result_files WHERE ${column}=?`).all(value) as { file: string; owner: string }[];
    // Rows first: a failure between the two steps leaves an unreferenced file to sweep, never a row whose content is gone.
    // A file that cannot be removed throws once the rows are gone; the caller (Trajectories) records it through the
    // store's cleanup hook and keeps cleaning the rest, so no post-commit cleanup failure escapes as a request error.
    this.db.prepare(`DELETE FROM tool_result_files WHERE ${column}=?`).run(value);
    for (const row of rows) rmSync(this.path(row.file, row.owner), { force: true });
    if (column==='repository_id') this.removeOwner(computerResultOwner('project',value));
    for (const owner of new Set(rows.map(row=>row.owner))) if (!this.db.prepare('SELECT 1 FROM tool_result_files WHERE owner=?').get(owner)) rmSync(join(this.root,owner),{recursive:true,force:true});
  }
}
