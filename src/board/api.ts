import type { Store, Row } from '../storage/database.js';
import { type Actor, repository, scope } from '../app/auth.js';
import { fail, fields, randomId, text, type Json } from '../core/security.js';
import { withTaskMetrics } from '../metrics/accounting.js';
import { workType } from '../work/catalog.js';
// Saved views and links from before #207 may name a custom workflow; its cards are reply cards now.
const customWorkflowId = /^custom\.[a-f0-9]{12}$/;

// `pr` overrides the wording on the PR board: development of a PR is the bot revising its own PR after a review.
export const boardStages = [
  { id: 'unreviewed', name: '未检视', hint: 'bot 还没有检视过', pr: { hint: 'bot 还没有检视过；草稿 PR 不触发检视' } },
  { id: 'reviewing', name: '正在检视', hint: '检视任务正在排队或执行' },
  { id: 'reviewed', name: '已检视', hint: '最近一次检视已完成' },
  { id: 'developing', name: '正在开发', hint: '开发任务正在准备、实现、测试或发布', pr: { name: '正在跟进', hint: 'bot 正按检视意见修改自己开出的 PR' } },
  { id: 'developed', name: '已开发', hint: '开发已完成或已开出 PR', pr: { name: '已跟进', hint: '按检视意见的修改已完成' } },
  { id: 'attention', name: '需要处理', hint: '最近一次任务失败、被取消，或在等待配置、权限、重试、重新规划' },
];
const successes = "('pr_opened','succeeded','completed')";
const attention = "('paused','failed','cancelled','waiting_configuration','waiting_permission','needs_replan','retry_wait')";
const developing = "('queued','running','preparing','implementing','validating','publishing','waiting_pr_head','waiting_publication','waiting_environment','result_ready')";
const taskTime = (alias: string) => `coalesce(nullif(${alias}.updated_at,''),${alias}.created_at)`;
// The newest task of each work type on each object, read from the covering index board_task_cover alone. A tasks row
// stores the task input (about 1 MB on average in production) before updated_at and result, so reading those columns
// from the row walks every overflow page of the input. Doing that for every card made the card list take 0.8 s with a
// warm cache and 9 s with a cold one in production.
const latestTasks = `latest AS MATERIALIZED (SELECT id,repository_id,object_number,kind,status,time FROM (
    SELECT id,repository_id,object_number,kind,status,${taskTime('t')} AS time,row_number() OVER (
      PARTITION BY repository_id,object_number,kind ORDER BY ${taskTime('t')} DESC,created_at DESC,rowid DESC) AS newest
    FROM tasks t WHERE kind IN ('review.issue','review.pr','development.issue','development.pr','workflow.issue','workflow.pr')
      AND object_number IS NOT NULL)
  WHERE newest=1)`;
const taskJoin = (alias: string, family: string) => `LEFT JOIN latest ${alias} ON ${alias}.repository_id=o.repository_id
  AND ${alias}.object_number=o.object_number AND ${alias}.kind='${family}.'||o.object_type`;
export const boardExecutionStatuses = [
  { id: 'running', name: '正在执行' }, { id: 'queued', name: '排队' }, { id: 'failed', name: '失败' },
  { id: 'completed', name: '已完成' }, { id: 'waiting', name: '等待处理' }, { id: 'other', name: '其他 / 未开始' },
];
const standardGroups = ['bot_stage','repository','execution_status','category'];
// A card is one work type's work on one object: reviews and development of Issues and PRs, reply tasks, and the release
// process (whose cards come from the release page). The `category` filter and grouping name these work type ids.
const objectWorkflows = ['review.issue','review.pr','development.issue','development.pr'];
// Views saved before the board listed work types filter a family: every review, or every development.
const families = ['review','development'];
const categoryOf = (value: string) => customWorkflowId.test(value) ? 'reply' : value;
const knownCategory = (value: string) => objectWorkflows.includes(value) || families.includes(value) || ['release', 'reply', 'task.request'].includes(value) || customWorkflowId.test(value);
const execution = (status: string) => `CASE
  WHEN ${status} IN ('running','preparing','implementing','validating','publishing') THEN 'running'
  WHEN ${status}='queued' THEN 'queued'
  WHEN ${status}='failed' THEN 'failed'
  WHEN ${status} IN ${successes} THEN 'completed'
  WHEN ${status} IN ('paused','waiting_configuration','waiting_environment','waiting_permission','waiting_pr_head','waiting_publication','retry_wait','needs_replan','result_ready') THEN 'waiting'
  ELSE 'other' END`;
const objectStage = (category: string) => {
  if (category === 'review') return `CASE WHEN r.status IN ${attention} THEN 'attention' WHEN r.status IN ${successes} THEN 'reviewed'
    WHEN r.id IS NOT NULL AND r.status<>'superseded' THEN 'reviewing' ELSE 'unreviewed' END`;
  if (category === 'development') return `CASE WHEN d.status IN ${developing} THEN 'developing' WHEN d.status IN ${attention} THEN 'attention'
    WHEN d.status IN ${successes} THEN 'developed' ELSE 'unreviewed' END`;
  return "'unreviewed'";
};
const releaseStage = `CASE WHEN p.stage IN ('tagging','waiting_run','running','preparing_notes','creating_draft','publishing') THEN 'developing'
  WHEN p.stage IN ('published','externally_published') THEN 'developed' ELSE 'attention' END`;
const releaseExecution = `CASE WHEN p.stage IN ('tagging','running','preparing_notes','creating_draft','publishing') THEN 'running'
  WHEN p.stage IN ('waiting_run','draft','waiting_permission','write_unknown') THEN 'waiting'
  WHEN p.stage='failed' THEN 'failed' WHEN p.stage IN ('published','externally_published') THEN 'completed' ELSE 'other' END`;
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
    else if (field === 'object_type' && ['all','issue','pr','task'].includes(value)) { /* validated */ }
    else if (field === 'bot_stage' && boardStages.some(s => s.id === value)) { /* validated */ }
    else if (field === 'category' && knownCategory(value)) { /* validated */ }
    else if (field === 'execution_status' && boardExecutionStatuses.some(s => s.id === value)) { /* validated */ }
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
  if (!standardGroups.includes(group)) fieldFor(store, user, group);
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
    return { id: 'default', name: '默认看板', group_by: row?.group_by || 'bot_stage', filters: row ? JSON.parse(row.filters) : [],
      hidden_columns: row ? JSON.parse(row.hidden_columns) : [], builtin: true };
  }
  const row = store.get('SELECT * FROM board_views WHERE id=? AND user_id=?', id, user.id);
  return row ? viewData(row) : fail(404, 'board_view_not_found');
}
// The work types with cards, under their fixed names; `workflows` keeps its name in the API for older clients.
function boardWorkflows(_store: Store, _user: Actor) {
  const list = [...objectWorkflows, 'reply'].map(id => ({ id, name: workType(id)!.name }));
  const name = (_repository: string, id: string) => id === 'task.request' ? '通用任务' : id === 'release' ? '发版本' : workType(categoryOf(id))?.name ?? '已删除的工作类型';
  return { list: [...list, { id: 'task.request', name: '通用任务' }, { id: 'release', name: '发版本' }], name };
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
    return { stages: boardStages, fields: customFields, workflows: boardWorkflows(store,user).list, views: [viewFor(store,user,'default'),
      ...store.all("SELECT * FROM board_views WHERE user_id=? AND id<>? ORDER BY rowid LIMIT 50", user.id, `default:${user.id}`).map(viewData)] };
  }
  if (method === 'GET' && path === '/api/board/cards') {
    const view = viewFor(store, user, url.searchParams.get('view_id') || 'default');
    const conditions = url.searchParams.has('filters') ? filters(parse(url.searchParams.get('filters')!),store,user) : view.filters as Filter[];
    const category = categoryOf(String(conditions.find(f => f.field === 'category')?.value || 'all'));
    const { limit, offset } = pagination(url);
    const group = grouping(store,user,url.searchParams.get('group_by') || view.group_by);
    // Each branch projects the work of one workflow on an object. Grouping never changes its status or task identity.
    const fieldValue = `(SELECT option_id FROM board_values v WHERE v.user_id=? AND v.repository_id=o.repository_id
          AND v.object_type=o.object_type AND v.object_number=o.object_number AND v.field_id=?) AS field_value`;
    const objectSql = (family: 'review' | 'development') => {
      const task = family === 'review' ? 'r' : 'd';
      return `SELECT 'object' AS card_type,'${family}.'||o.object_type AS card_category,o.repository_id,o.object_type,o.object_number,
        o.title,o.github_state,o.draft,coalesce(${task}.time,o.last_seen) AS last_seen,repos.full_name,
        ${objectStage(family)} AS bot_stage,${execution(task+'.status')} AS execution_status,
        ${task}.id AS task_id,${task}.status AS task_status,r.id AS review_task_id,r.status AS review_status,
        d.id AS development_task_id,d.status AS development_status,
        ${fieldValue},
        NULL AS release_id,NULL AS version,NULL AS release_stage,NULL AS release_url
        FROM board_objects o JOIN repositories repos ON repos.id=o.repository_id ${taskJoin('r','review')} ${taskJoin('d','development')}
        WHERE ${family === 'review' ? '(r.id IS NOT NULL OR d.id IS NULL)' : 'd.id IS NOT NULL'}`;
    };
    // A reply task answers on its object like a review, so its card moves through the review stages.
    const customSql = `SELECT 'object' AS card_type,'reply' AS card_category,o.repository_id,o.object_type,o.object_number,
        o.title,o.github_state,o.draft,coalesce(c.time,o.last_seen) AS last_seen,repos.full_name,
        CASE WHEN c.status IN ${attention} THEN 'attention' WHEN c.status IN ${successes} THEN 'reviewed'
          WHEN c.status<>'superseded' THEN 'reviewing' ELSE 'unreviewed' END AS bot_stage,${execution('c.status')} AS execution_status,
        c.id AS task_id,c.status AS task_status,NULL AS review_task_id,NULL AS review_status,NULL AS development_task_id,NULL AS development_status,
        ${fieldValue},NULL AS release_id,NULL AS version,NULL AS release_stage,NULL AS release_url
        FROM latest c JOIN board_objects o ON o.repository_id=c.repository_id AND o.object_number=c.object_number AND c.kind='workflow.'||o.object_type
        JOIN repositories repos ON repos.id=o.repository_id
        WHERE c.kind IN ('workflow.issue','workflow.pr')`;
    const releaseSql = `SELECT 'release' AS card_type,'release' AS card_category,p.repository_id,'release' AS object_type,
      NULL AS object_number,p.version AS title,NULL AS github_state,0 AS draft,p.updated_at AS last_seen,repos.full_name,
      ${releaseStage} AS bot_stage,${releaseExecution} AS execution_status,NULL AS task_id,NULL AS task_status,
      NULL AS review_task_id,NULL AS review_status,NULL AS development_task_id,NULL AS development_status,NULL AS field_value,
      p.id AS release_id,p.version AS version,p.stage AS release_stage,
      CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.release_url') END AS release_url
      FROM project_releases p JOIN repositories repos ON repos.id=p.repository_id`;
    const requestedSql = `SELECT 'task' AS card_type,'task.request' AS card_category,t.repository_id,'task' AS object_type,NULL AS object_number,
      t.summary AS title,NULL AS github_state,0 AS draft,${taskTime('t')} AS last_seen,repos.full_name,
      CASE WHEN t.status IN ${attention} THEN 'attention' WHEN t.status IN ${successes} THEN 'developed' ELSE 'developing' END AS bot_stage,
      ${execution('t.status')} AS execution_status,t.id AS task_id,t.status AS task_status,NULL AS review_task_id,NULL AS review_status,
      NULL AS development_task_id,NULL AS development_status,NULL AS field_value,
      NULL AS release_id,t.id AS version,NULL AS release_stage,NULL AS release_url
      FROM tasks t JOIN repositories repos ON repos.id=t.repository_id WHERE t.kind='task.request'`;
    const cte = `WITH ${latestTasks}, work AS (${objectSql('review')} UNION ALL ${objectSql('development')} UNION ALL ${customSql} UNION ALL ${releaseSql} UNION ALL ${requestedSql})`;
    // A built-in object workflow already names its object type, like the release process.
    const typed = !['release','task.request'].includes(category) && !objectWorkflows.includes(category);
    const access = scope(user,'w.repository_id');
    const clauses: { sql: string; args: (string | number)[]; type?: boolean }[] = [{ sql: access.sql, args: access.args }];
    if (!conditions.some(f => f.field === 'include_closed' && f.value === true)) clauses.push({sql:"coalesce(w.github_state,'open')<>'closed'",args:[]});
    for (const f of conditions) {
      if (f.field === 'repository_id') clauses.push({sql:'w.repository_id=?',args:[String(f.value)]});
      if (f.field === 'category') clauses.push(families.includes(String(f.value)) ? {sql:'w.card_category LIKE ?',args:[f.value+'.%']} : {sql:'w.card_category=?',args:[categoryOf(String(f.value))]});
      // A release-only or single-workflow view keeps the previous object choice for when the person returns to all work.
      if (f.field === 'object_type' && f.value !== 'all' && typed) clauses.push({sql:'w.object_type=?',args:[String(f.value)],type:true});
      if (f.field === 'bot_stage' || f.field === 'execution_status') clauses.push({sql:`w.${f.field}=?`,args:[String(f.value)]});
      if (f.field === 'text') {
        const term = String(f.value), number = /^#?([1-9]\d*)$/.exec(term), pattern = '%' + term.replace(/[\\%_]/g,'\\$&') + '%';
        clauses.push(number && Number.isSafeInteger(Number(number[1]))
          ? {sql:"(w.object_number=? OR (w.card_type='release' AND w.version LIKE ? ESCAPE '\\'))",args:[Number(number[1]),pattern]}
          : {sql:"w.title LIKE ? ESCAPE '\\'",args:[pattern]});
      }
    }
    const select = (list = clauses) => ({sql:`${cte} SELECT * FROM work w WHERE ${list.map(c=>c.sql).join(' AND ')}`,
      args:[user.id,group,user.id,group,user.id,group,...list.flatMap(c=>c.args)]});
    const selected = select(), untyped = select(clauses.filter(c=>!c.type));
    const rows = store.all(`${selected.sql} ORDER BY last_seen DESC,repository_id,object_type,object_number,card_category,version LIMIT ? OFFSET ?`,...selected.args,limit+1,offset);
    // These are distinct GitHub objects, separate from the number of work cards.
    const totals = new Map(store.all(`SELECT object_type,count(*) n FROM
      (SELECT DISTINCT repository_id,object_type,object_number FROM (${untyped.sql}) WHERE card_type='object') GROUP BY object_type`,...untyped.args)
      .map(row=>[row.object_type,Number(row.n)]));
    const column = group === 'repository' ? 'repository_id' : group === 'category' ? 'card_category'
      : group === 'execution_status' ? 'execution_status' : group === 'bot_stage' ? 'bot_stage' : "coalesce(field_value,'unassigned')";
    const columnCounts = Object.fromEntries(store.all(`SELECT ${column} id,count(*) n FROM (${selected.sql}) GROUP BY 1`,...selected.args).map(row=>[String(row.id),Number(row.n)]));
    const counts = store.get(`SELECT count(*) n,sum(card_type='release') releases FROM (${selected.sql})`,...selected.args)!;
    const { name } = boardWorkflows(store,user), page = rows.slice(0,limit);
    // A development's PR number lives in its task result, behind the input: read it for this page's cards only.
    const developments = [...new Set(page.map(row => row.development_task_id).filter(Boolean).map(String))];
    const prNumbers = new Map(developments.length ? store.all(`SELECT id,CASE WHEN json_valid(result) AND typeof(json_extract(result,'$.pr_number'))='integer'
      THEN json_extract(result,'$.pr_number') END AS pr_number FROM tasks WHERE id IN (${developments.map(() => '?').join(',')})`, ...developments)
      .map(row => [String(row.id), row.pr_number ?? null]) : []);
    return { cards: page.map(row => ({ ...row, development_pr_number: row.development_task_id ? prNumbers.get(String(row.development_task_id)) ?? null : null,
      card_category_name: name(String(row.repository_id), String(row.card_category)),
      origin:row.task_id?store.get('SELECT source_kind,source_role,executor_role,conversation_id,source_message FROM task_origins WHERE task_id=?',row.task_id)??null:null })), has_more: rows.length>limit, limit, offset,
      counts: { issue: totals.get('issue') || 0, pr: totals.get('pr') || 0 }, release_count: Number(counts.releases || 0),
      work_count: Number(counts.n), column_counts: columnCounts };
  }

  const card = /^\/api\/board\/cards\/([^/]+)\/(issue|pr)\/([1-9]\d*)(\/tasks)?$/.exec(path);
  if (card) {
    const [, repo, type, num, tasks] = card, number = Number(num);
    if (!Number.isSafeInteger(number)) fail(400,'invalid_object_number');
    repository(store,user,repo!);
    if (!store.get('SELECT 1 FROM board_objects WHERE repository_id=? AND object_type=? AND object_number=?',repo!,type!,number)) fail(404,'board_card_not_found');
    if (method === 'GET' && tasks) {
      const { limit, offset } = pagination(url), conditions = url.searchParams.has('filters') ? filters(parse(url.searchParams.get('filters')!),store,user) : [];
      const clauses = ['repository_id=?','object_number=?','kind IN (?,?,?)'], args: (string | number)[] = [repo!,number,`review.${type}`,`development.${type}`,`workflow.${type}`];
      for (const f of conditions) {
        const value = String(f.value);
        if (f.field === 'category' && families.includes(value)) { clauses.push('kind LIKE ?'); args.push(value + '.%'); }
        if (f.field === 'category' && objectWorkflows.includes(value)) { clauses.push('kind=?'); args.push(value); }
        if (f.field === 'category' && categoryOf(value) === 'reply') { clauses.push("kind LIKE 'workflow.%'"); }
        if (f.field === 'execution_status') { clauses.push(`(${execution('status')})=?`); args.push(String(f.value)); }
      }
      const rows = store.all(`SELECT id,kind,status,summary,created_at,updated_at FROM tasks
        WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`,...args,limit+1,offset);
      return { tasks: withTaskMetrics(store,rows.slice(0,limit)), has_more: rows.length>limit };
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
    if (existing?.builtin && (body.name !== undefined || body.group_by !== undefined && !standardGroups.includes(String(body.group_by)))) fail(400,'builtin_board_view');
    if (!existing && store.get("SELECT count(*) n FROM board_views WHERE user_id=? AND id<>?",user.id,`default:${user.id}`)!.n >= 50) fail(409,'board_view_limit');
    const id = existing?.builtin ? `default:${user.id}` : String(existing?.id || randomId());
    const name = existing?.builtin ? '默认看板' : text(body.name ?? existing?.name,100);
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
