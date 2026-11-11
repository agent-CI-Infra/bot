import type { Store, Row } from '../storage/database.js';
import { fail } from '../core/security.js';

const columns = 'id,type,source,object_type,object_number,summary,state,decision,reason,brief,result,model,attempts,error,created_at,decided_at';
const parsed = (value: unknown) => { try { return JSON.parse(String(value)); } catch { return null; } };
const project = (row: Row) => ({ ...row, brief: parsed(row.brief), result: parsed(row.result), error: parsed(row.error) });

/** Cursor paging keeps a newer event from pushing an already-read event into the next page. */
export function dispatchList(store: Store, repositoryId: string, params: URLSearchParams) {
  const integer = (name: string, fallback: number, max: number) => {
    const value = params.get(name); if (value === null) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) fail(400, 'invalid_dispatch_filter');
    return Number(value);
  };
  const limit = Math.min(100, Math.max(1, integer('limit', 50, Number.MAX_SAFE_INTEGER))), offset = integer('offset', 0, Number.MAX_SAFE_INTEGER);
  const filters: Record<string, string> = {};
  for (const [name, options] of [['state', ['pending', 'dispatching', 'decided', 'failed']], ['decision', ['create', 'continue', 'ignore']]] as const) {
    const value = params.get(name); if (!value) continue;
    if (!(options as readonly string[]).includes(value)) fail(400, 'invalid_dispatch_filter');
    filters[name] = value;
  }
  const type = params.get('type');
  if (type) { if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(type)) fail(400, 'invalid_dispatch_filter'); filters.type = type; }
  for (const name of ['from', 'until']) {
    const value = params.get(name); if (!value) continue;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, 'invalid_dispatch_filter');
    const normalized = new Date(value).toISOString();
    if (normalized !== value && normalized.replace('.000Z', 'Z') !== value) fail(400, 'invalid_dispatch_filter');
    filters[name] = normalized;
  }
  if (filters.from && filters.until && filters.from >= filters.until) fail(400, 'invalid_dispatch_filter');
  const scope = JSON.stringify([repositoryId, filters]), where = ['repository_id=?'], args: (string | number)[] = [repositoryId];
  for (const [name, value] of Object.entries(filters)) { where.push(name === 'from' ? 'created_at>=?' : name === 'until' ? 'created_at<?' : `${name}=?`); args.push(value); }
  const cursor = params.get('cursor');
  if (cursor) {
    if (cursor.length > 1500) return fail(400, 'invalid_dispatch_cursor');
    let value: unknown;
    try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { fail(400, 'invalid_dispatch_cursor'); }
    if (offset || !Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'string' || !Number.isFinite(Date.parse(value[0])) || !Number.isSafeInteger(value[1]) || value[1] < 1 || value[2] !== scope) return fail(400, 'invalid_dispatch_cursor');
    where.push('(created_at<? OR (created_at=? AND rowid<?))'); args.push(value[0], value[0], value[1]);
  }
  const rows = store.all(`SELECT ${columns},rowid AS cursor_row FROM dispatch_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`, ...args, limit + 1, offset);
  const page = rows.slice(0, limit), last = page.at(-1), hasMore = rows.length > limit;
  return { events: page.map(({ cursor_row, ...row }) => project(row)), has_more: hasMore, offset, limit,
    next_cursor: hasMore && last ? Buffer.from(JSON.stringify([last.created_at, last.cursor_row, scope])).toString('base64url') : null };
}

/** Deliberately excludes raw facts, candidate task inputs, credentials and the dispatch lease. */
export function dispatchDetail(store: Store, repositoryId: string, id: string) {
  const row = store.get(`SELECT ${columns},delivery_id,next_run_at FROM dispatch_events WHERE id=? AND repository_id=?`, id, repositoryId);
  if (!row) return fail(404, 'dispatch_event_not_found');
  return { event: project(row), tasks: store.all(`SELECT t.id,t.kind,t.status,e.relation FROM task_events e JOIN tasks t ON t.id=e.task_id
      WHERE e.event_id=? AND t.repository_id=? ORDER BY e.created_at,t.id`, id, repositoryId),
    retries: store.all('SELECT requested_at,previous_attempts,previous_error FROM dispatch_retries WHERE event_id=? ORDER BY rowid DESC LIMIT 50', id)
      .map(row => ({ ...row, previous_error: parsed(row.previous_error) })) };
}
