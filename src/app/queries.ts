import { type Store } from '../storage/database.js';
import { type Actor, repository, scope } from './auth.js';
import { fail, type Json } from '../core/security.js';

export function queries(store: Store, user: Actor, url: URL): Json | undefined {
  const path = url.pathname, repo = url.searchParams.get('repository_id');
  if (repo) repository(store, user, repo);
  const filter = scope(user, 'repository_id');
  if (path === '/api/events') {
    const clauses = [filter.sql], args = [...filter.args];
    for (const key of ['repository_id', 'account_id', 'event', 'status', 'delivery_id']) {
      const value = url.searchParams.get(key);
      if (value) { clauses.push(`${key}=?`); args.push(value); }
    }
    const owner = url.searchParams.get('owner_id');
    if (owner) { clauses.push('repository_id IN (SELECT id FROM repositories WHERE owner_id=?)'); args.push(owner); }
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) fail(400, 'invalid_pagination');
    return { events: store.all(`SELECT id,account_id,endpoint_id,repository_id,delivery_id,event,route,status,duplicate,received_at,http_status,body_complete
      FROM deliveries WHERE ${clauses.join(' AND ')} ORDER BY received_at DESC,id DESC LIMIT ? OFFSET ?`, ...args, limit, offset) };
  }
  const event = /^\/api\/events\/([^/]+)$/.exec(path);
  if (event) {
    const row = store.get(`SELECT * FROM deliveries WHERE id=? AND ${filter.sql}`, event[1]!, ...filter.args);
    if (!row) return fail(404, 'event_not_found');
    return { event: { ...row, request_headers: JSON.parse(row.request_headers),
      payload: Buffer.from(row.payload).toString('utf8'), response: JSON.parse(row.response) } };
  }
  if (path === '/api/tasks') return { tasks: store.all(`SELECT * FROM tasks WHERE ${filter.sql}${repo ? ' AND repository_id=?' : ''}`,
    ...filter.args, ...(repo ? [repo] : [])), execution_available: false };
  const task = /^\/api\/tasks\/([^/]+)(\/logs)?$/.exec(path);
  if (task) {
    const row = store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`, task[1]!, ...filter.args);
    if (!row) return fail(404, 'task_not_found');
    return task[2] ? { logs: store.all('SELECT id,content FROM task_logs WHERE task_id=? ORDER BY rowid', row.id) } : { task: row };
  }
  if (path === '/api/audit') return { audit: store.all(`SELECT * FROM audit WHERE ${filter.sql}${repo ? ' AND repository_id=?' : ''}
    ORDER BY created_at DESC LIMIT 100`, ...filter.args, ...(repo ? [repo] : [])) };
  return undefined;
}
