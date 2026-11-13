import { closeSync, constants, fdatasyncSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TrajectoryScope } from './trajectories.js';

export function toolResultStorage(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS tool_result_files(file TEXT PRIMARY KEY,owner TEXT NOT NULL,source TEXT NOT NULL,
    repository_id TEXT,task_id TEXT,conversation_id TEXT,bytes INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(owner,source));
    CREATE INDEX IF NOT EXISTS tool_result_files_repository ON tool_result_files(repository_id);
    CREATE INDEX IF NOT EXISTS tool_result_files_conversation ON tool_result_files(conversation_id);`);
}

/** Immutable UTF-8 results share the trajectory directory and its project/conversation cleanup policy. */
export class ToolResultFiles {
  constructor(readonly db: DatabaseSync, readonly root: string) {}
  private path(file: string) { return join(this.root, 'results', file + '.utf8'); }
  private row(owner: string, source: string) {
    return this.db.prepare('SELECT file,bytes FROM tool_result_files WHERE owner=? AND source=?').get(owner, source) as { file: string; bytes: number } | undefined;
  }
  async save(owner: string, scope: TrajectoryScope, source: string, chunks: AsyncIterable<string | Buffer>, guard: () => unknown | Promise<unknown>) {
    await guard();
    const previous = this.row(owner, source); if (previous) return this.reference(previous);
    const file = randomBytes(24).toString('hex'), target = this.path(file), temporary = target + '.tmp';
    mkdirSync(join(this.root, 'results'), { recursive: true, mode: 0o700 });
    const fd = openSync(temporary, 'wx', 0o600); let bytes = 0, closed = false;
    try {
      for await (const chunk of chunks) {
        await guard(); const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        for (let offset = 0; offset < data.length;) offset += writeSync(fd, data, offset, data.length - offset);
        bytes += data.length;
      }
      await guard(); fdatasyncSync(fd); closeSync(fd); closed = true;
      renameSync(temporary, target);
      const inserted = this.db.prepare('INSERT OR IGNORE INTO tool_result_files VALUES(?,?,?,?,?,?,?,?)')
        .run(file, owner, source, scope.repository_id, scope.task_id, scope.conversation_id, bytes, new Date().toISOString()).changes;
      if (!inserted) { rmSync(target, { force: true }); return this.reference(this.row(owner, source)!); }
      return this.reference({ file, bytes });
    } catch (error) {
      if (!closed) closeSync(fd); rmSync(temporary, { force: true }); rmSync(target, { force: true }); throw error;
    }
  }
  private reference(row: { file: string; bytes: number }) {
    return { file: 'result:' + row.file, bytes: row.bytes, encoding: 'utf-8', notice: 'Read this immutable result with read_tool_result(file, position, length). Positions and lengths are UTF-8 bytes; use next_position for the following page. Reading never repeats the original operation.' };
  }
  read(owner: string, file: unknown, position: unknown = 0, length: unknown = 16384) {
    if (typeof file !== 'string' || !/^result:[a-f0-9]{48}$/.test(file)) return { error: 'tool_result_not_found' };
    const row = this.db.prepare('SELECT file,bytes FROM tool_result_files WHERE file=? AND owner=?').get(file.slice(7), owner) as { file: string; bytes: number } | undefined;
    if (!row) return { error: 'tool_result_not_found' };
    if (!Number.isSafeInteger(position) || Number(position) < 0 || Number(position) > row.bytes || !Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > 65536)
      return { error: 'tool_result_range_invalid' };
    let fd;
    try {
      fd = openSync(this.path(row.file), constants.O_RDONLY | constants.O_NOFOLLOW);
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
    const rows = this.db.prepare(`SELECT file FROM tool_result_files WHERE ${column}=?`).all(value) as { file: string }[];
    for (const row of rows) rmSync(this.path(row.file), { force: true });
    this.db.prepare(`DELETE FROM tool_result_files WHERE ${column}=?`).run(value);
  }
}
