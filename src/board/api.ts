import type { Store, Row } from '../storage/database.js';
import { type Actor, repository, scope } from '../app/auth.js';
import { fail, fields, randomId, text, type Json } from '../core/security.js';

export const boardStages = [
  { id: 'unreviewed', name: '未检视' }, { id: 'reviewing', name: '正在检视' }, { id: 'reviewed', name: '已检视' },
  { id: 'developing', name: '正在开发' }, { id: 'developed', name: '已开发' }, { id: 'attention', name: '需要处理' },
];
const successes = "('pr_opened','succeeded','completed')";
const attention = "('failed','cancelled','waiting_configuration','waiting_permission','needs_replan','retry_wait')";
const developing = "('queued','running','preparing','implementing','validating','publishing','waiting_pr_head','waiting_publication','waiting_environment','result_ready')";
const taskTime = (alias: string) => `coalesce(nullif(${alias}.updated_at,''),${alias}.created_at)`;
// A newer successful result clears an older failure, regardless of which task family produced it.
const latest = `CASE WHEN d.id IS NULL THEN r.status WHEN r.id IS NULL THEN d.status
  WHEN ${taskTime('d')}>=${taskTime('r')} THEN d.status ELSE r.status END`;
const stage = `CASE
  WHEN d.status IN ${developing} THEN 'developing'
  WHEN (${latest}) IN ${attention} THEN 'attention'
  WHEN d.status IN ${successes} THEN 'developed'
  WHEN d.id IS NULL AND r.status NOT IN ${successes} AND r.status NOT IN ${attention} AND r.status<>'superseded' THEN 'reviewing'
  WHEN r.status IN ${successes} THEN 'reviewed'
  ELSE 'unreviewed' END`;
const taskJoin = (alias: string, family: string) => `LEFT JOIN tasks ${alias} ON ${alias}.id=(SELECT t.id FROM tasks t
  WHERE t.repository_id=o.repository_id AND t.object_number=o.object_number AND t.kind='${family}.'||o.object_type
  ORDER BY ${taskTime('t')} DESC,t.created_at DESC,t.rowid DESC LIMIT 1)`;
type Filter = { field: string; value: string | boolean };
function filters(value: unknown, store: Store, user: Actor): Filter[] {
  if (!Array.isArray(value) || value.length > 20) return fail(400, 'invalid_board_filters');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(400, 'invalid_board_filter');
    fields(item, ['field','value']);
    const field = item.field, value = item.value;
    if (field === 'include_closed' && typeof value === 'boolean') return { field, value };
    if (typeof value !== 'string' || !value.trim() || value.length > 200) return fail(400, 'invalid_board_filter');
    if (field === 'repository_id') repository(store, user, value);
    else if (field === 'object_type' && ['issue','pr'].includes(value)) { /* validated */ }
    else if (field === 'bot_stage' && boardStages.some(s => s.id === value)) { /* validated */ }
    else if (field !== 'text') return fail(400, 'invalid_board_filter');
    return { field, value: value.trim() };
  });
}
function parse(value: string): unknown { try { return JSON.parse(value); } catch { return fail(400, 'invalid_board_json'); } }
function fieldFor(store: Store, user: Actor, id: string): Row {
  return store.get('SELECT * FROM board_fields WHERE id=? AND user_id=?', id, user.id) || fail(404, 'board_field_not_found');
}
function grouping(store: Store, user: Actor, value: unknown): string {
  const group = text(value, 100);
  if (group !== 'bot_stage') fieldFor(store, user, group);
  return group;
}
function hidden(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 51 || value.some(v => typeof v !== 'string' || v.length > 100)) return fail(400, 'invalid_hidden_columns');
  return [...new Set(value)];
}
const viewData = (row: Row): Json => ({ id: row.id, name: row.name, group_by: row.group_by,
  filters: JSON.parse(row.filters), hidden_columns: JSON.parse(row.hidden_columns), builtin: false });
function viewFor(store: Store, user: Actor, id: string): Json {
  if (id === 'default') {
    const row = store.get('SELECT * FROM board_views WHERE id=? AND user_id=?', `default:${user.id}`, user.id);
    return { id: 'default', name: '按 bot 执行', group_by: 'bot_stage', filters: row ? JSON.parse(row.filters) : [],
      hidden_columns: row ? JSON.parse(row.hidden_columns) : [], builtin: true };
  }
  const row = store.get('SELECT * FROM board_views WHERE id=? AND user_id=?', id, user.id);
  return row ? viewData(row) : fail(404, 'board_view_not_found');
}
function pagination(url: URL) {
  const limit = Number(url.searchParams.get('limit') || 100), offset = Number(url.searchParams.get('offset') || 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) fail(400, 'invalid_pagination');
  return { limit, offset };
}
export function boardApi(store: Store, user: Actor, method: string, url: URL, body: Json): Json | undefined {
  const path = url.pathname;
  if (!path.startsWith('/api/board')) return undefined;
  if (method === 'GET' && path === '/api/board') {
    const customFields = store.all('SELECT id,name FROM board_fields WHERE user_id=? ORDER BY rowid LIMIT 30', user.id)
      .map(f => ({ ...f, options: store.all('SELECT id,name FROM board_options WHERE field_id=? ORDER BY position,id LIMIT 50', f.id) }));
    return { stages: boardStages, fields: customFields, views: [viewFor(store,user,'default'),
      ...store.all("SELECT * FROM board_views WHERE user_id=? AND id<>? ORDER BY rowid LIMIT 50", user.id, `default:${user.id}`).map(viewData)] };
  }
  if (method === 'GET' && path === '/api/board/cards') {
    const view = viewFor(store, user, url.searchParams.get('view_id') || 'default');
    const conditions = url.searchParams.has('filters') ? filters(parse(url.searchParams.get('filters')!),store,user) : view.filters as Filter[];
    // Saved repository filters can outlive a grant. Scope is always applied independently, on every request.
    const access = scope(user,'o.repository_id'), clauses = [access.sql], args: (string | number)[] = [...access.args];
    if (!conditions.some(f => f.field === 'include_closed' && f.value === true)) clauses.push("coalesce(o.github_state,'open')<>'closed'");
    for (const f of conditions) {
      if (f.field === 'repository_id' || f.field === 'object_type') { clauses.push(`o.${f.field}=?`); args.push(String(f.value)); }
      if (f.field === 'bot_stage') { clauses.push(`(${stage})=?`); args.push(String(f.value)); }
      if (f.field === 'text') {
        const term = String(f.value), number = /^#?([1-9]\d*)$/.exec(term);
        if (number && Number.isSafeInteger(Number(number[1]))) { clauses.push('o.object_number=?'); args.push(Number(number[1])); }
        else { clauses.push("o.title LIKE ? ESCAPE '\\'"); args.push('%' + term.replace(/[\\%_]/g,'\\$&') + '%'); }
      }
    }
    const { limit, offset } = pagination(url);
    const group = grouping(store,user,url.searchParams.get('group_by') || view.group_by);
    const rows = store.all(`SELECT o.repository_id,o.object_type,o.object_number,o.title,o.github_state,o.draft,o.last_seen,
      repos.full_name,${stage} AS bot_stage,r.id AS review_task_id,r.status AS review_status,
      d.id AS development_task_id,d.status AS development_status,
      (SELECT option_id FROM board_values v WHERE v.user_id=? AND v.repository_id=o.repository_id
        AND v.object_type=o.object_type AND v.object_number=o.object_number AND v.field_id=?) AS field_value
      FROM board_objects o JOIN repositories repos ON repos.id=o.repository_id ${taskJoin('r','review')} ${taskJoin('d','development')}
      WHERE ${clauses.join(' AND ')} ORDER BY o.last_seen DESC,o.repository_id,o.object_type,o.object_number LIMIT ? OFFSET ?`,
      user.id,group,...args,limit+1,offset);
    return { cards: rows.slice(0,limit), has_more: rows.length>limit, limit, offset };
  }
  const card = /^\/api\/board\/cards\/([^/]+)\/(issue|pr)\/([1-9]\d*)(\/tasks)?$/.exec(path);
  if (card) {
    const [, repo, type, num, tasks] = card, number = Number(num);
    if (!Number.isSafeInteger(number)) fail(400,'invalid_object_number');
    repository(store,user,repo!);
    if (!store.get('SELECT 1 FROM board_objects WHERE repository_id=? AND object_type=? AND object_number=?',repo!,type!,number)) fail(404,'board_card_not_found');
    if (method === 'GET' && tasks) {
      const { limit, offset } = pagination(url);
      const rows = store.all(`SELECT id,kind,status,summary,created_at,updated_at FROM tasks
        WHERE repository_id=? AND object_number=? AND kind IN (?,?) ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`,
        repo!,number,`review.${type}`,`development.${type}`,limit+1,offset);
      return { tasks: rows.slice(0,limit), has_more: rows.length>limit };
    }
    if (method === 'PATCH' && !tasks) {
      fields(body,['field_id','option_id']);
      const field = fieldFor(store,user,text(body.field_id,100));
      if (body.option_id !== null && !store.get('SELECT 1 FROM board_options WHERE id=? AND field_id=?',text(body.option_id,100),field.id)) fail(400,'invalid_board_option');
      store.transaction(() => {
        if (body.option_id === null) store.run('DELETE FROM board_values WHERE user_id=? AND repository_id=? AND object_type=? AND object_number=? AND field_id=?',user.id,repo!,type!,number,field.id);
        else store.run(`INSERT INTO board_values VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,repository_id,object_type,object_number,field_id)
          DO UPDATE SET option_id=excluded.option_id`,user.id,repo!,type!,number,field.id,String(body.option_id));
        store.audit(user.id,'board.value.updated',field.id,repo!);
      });
      return { ok: true };
    }
  }
  if (method === 'POST' && path === '/api/board/fields') {
    fields(body,['name']);
    if (store.get('SELECT count(*) n FROM board_fields WHERE user_id=?',user.id)!.n >= 30) fail(409,'board_field_limit');
    const id = randomId(); store.run('INSERT INTO board_fields VALUES(?,?,?)',id,user.id,text(body.name,100));
    return { field: { id, name: body.name, options: [] } };
  }
  const option = /^\/api\/board\/fields\/([^/]+)\/options$/.exec(path);
  if (method === 'POST' && option) {
    fields(body,['name']); const field = fieldFor(store,user,option[1]!);
    const name = text(body.name,100), rows = store.get('SELECT count(*) n,coalesce(max(position),0)+1 position FROM board_options WHERE field_id=?',field.id)!;
    if (rows.n >= 50) fail(409,'board_option_limit');
    if (store.get('SELECT 1 FROM board_options WHERE field_id=? AND name=?',field.id,name)) fail(409,'board_option_exists');
    const id = randomId(); store.run('INSERT INTO board_options VALUES(?,?,?,?)',id,field.id,name,rows.position);
    return { option: { id, name } };
  }
  const viewMatch = /^\/api\/board\/views\/([^/]+)$/.exec(path);
  if (method === 'POST' && path === '/api/board/views' || method === 'PATCH' && viewMatch) {
    fields(body,['name','group_by','filters','hidden_columns']);
    const existing = viewMatch ? viewFor(store,user,viewMatch[1]!) : undefined;
    if (existing?.builtin && (body.name !== undefined || body.group_by !== undefined && body.group_by !== 'bot_stage')) fail(400,'builtin_board_view');
    if (!existing && store.get("SELECT count(*) n FROM board_views WHERE user_id=? AND id<>?",user.id,`default:${user.id}`)!.n >= 50) fail(409,'board_view_limit');
    const id = existing?.builtin ? `default:${user.id}` : String(existing?.id || randomId());
    const name = existing?.builtin ? '按 bot 执行' : text(body.name ?? existing?.name,100);
    const group = grouping(store,user,body.group_by ?? existing?.group_by ?? 'bot_stage');
    const condition = body.filters === undefined ? existing?.filters || [] : filters(body.filters,store,user);
    const hiddenColumns = hidden(body.hidden_columns ?? existing?.hidden_columns ?? []);
    store.run(`INSERT INTO board_views VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
      group_by=excluded.group_by,filters=excluded.filters,hidden_columns=excluded.hidden_columns`,
      id,user.id,name,group,JSON.stringify(condition),JSON.stringify(hiddenColumns));
    return { view: viewFor(store,user,existing?.builtin ? 'default' : id) };
  }
  if (method === 'DELETE' && viewMatch) {
    fields(body,[]); const view = viewFor(store,user,viewMatch[1]!);
    if (view.builtin) fail(400,'builtin_board_view');
    store.run('DELETE FROM board_views WHERE id=? AND user_id=?',String(view.id),user.id); return { ok: true };
  }
  return fail(404,'board_route_not_found');
}
