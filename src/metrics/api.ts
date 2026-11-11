import type { Store, Row } from '../storage/database.js';
import { type Actor, repository, scope } from '../app/auth.js';
import { fail, type Json } from '../core/security.js';
import { workType, workTypes } from '../work/catalog.js';

function date(value: string): string {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail(400,'invalid_cost_date');
  return value;
}
export function costsApi(store: Store, user: Actor, url: URL): Json | undefined {
  if(url.pathname!=='/api/costs')return undefined;
  const timezone=url.searchParams.get('timezone')||'UTC';
  let calendar: Intl.DateTimeFormat;
  try { calendar=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}); }
  catch { fail(400,'invalid_statistics_timezone'); }
  const localDate=(value: string | null): string | null => {
    if(!value)return null;
    const time=new Date(value);if(!Number.isFinite(time.getTime()))return null;
    const parts=calendar.formatToParts(time),part=(type: string)=>parts.find(p=>p.type===type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  // Queries are synchronous. Each query uses the browser's calendar, including historical DST offsets.
  store.db.function('statistics_date',{deterministic:true},value=>localDate(value as string | null));
  const end=date(url.searchParams.get('to')||localDate(new Date().toISOString())!);
  const start=date(url.searchParams.get('from')||new Date(Date.parse(end+'T00:00:00Z')-29*86400000).toISOString().slice(0,10));
  const days=(Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000+1;
  if(days<1||days>366)fail(400,'cost_range_1_to_366_days');
  const currency=url.searchParams.get('currency')||'USD';if(!['USD','CNY'].includes(currency))fail(400,'invalid_pricing_currency');
  // Keep the indexed timestamp bounds; the local date predicate removes the padding on either side.
  const since=new Date(Date.parse(start+'T00:00:00Z')-86400000).toISOString();
  const until=new Date(Date.parse(end+'T00:00:00Z')+2*86400000).toISOString();
  // One scope feeds every query: the totals, the historical prices and the per-currency counts below.
  const access=scope(user,'q.repository_id'),scoped=[access.sql,'q.requested_at>=?','q.requested_at<?',
    'statistics_date(q.requested_at)>=?','statistics_date(q.requested_at)<=?'];
  const scopedArgs=[...access.args,since,until,start,end];
  const repo=url.searchParams.get('repository_id');if(repo){repository(store,user,repo);scoped.push('q.repository_id=?');scopedArgs.push(repo);}
  const clauses=[...scoped,'(q.currency=? OR q.currency IS NULL)'],args=[...scopedArgs,currency];
  const rows=store.all(`SELECT statistics_date(q.requested_at) date,q.repository_id,r.full_name,sum(q.cost) cost,count(*) requests,
    sum(CASE WHEN q.cost IS NULL THEN 1 ELSE 0 END) unpriced_requests,
    sum(CASE WHEN q.input_tokens IS NULL OR q.output_tokens IS NULL THEN 1 ELSE 0 END) usage_missing_requests,
    sum(q.input_tokens) input_tokens,sum(q.output_tokens) output_tokens,sum(q.cached_input_tokens) cached_input_tokens
    FROM model_requests q JOIN repositories r ON r.id=q.repository_id WHERE ${clauses.join(' AND ')}
    GROUP BY date,q.repository_id ORDER BY date,q.repository_id LIMIT 5001`,...args);
  if(rows.length>5000)fail(400,'cost_range_too_large');
  // Read the historical price snapshots, including priced requests whose usage is missing.
  const prices=store.all(`SELECT DISTINCT q.model_name,q.currency,q.input_per_million,q.output_per_million,q.cache_per_million
    FROM model_requests q WHERE ${clauses.join(' AND ')} AND q.currency IS NOT NULL
    AND q.input_per_million IS NOT NULL AND q.output_per_million IS NOT NULL AND q.cache_per_million IS NOT NULL
    ORDER BY q.model_name,q.currency,q.input_per_million,q.output_per_million,q.cache_per_million`,...args);
  // The currency filter keeps one currency's requests and the unpriced ones, so the requests billed in the other
  // currency would simply vanish from the page. Count them for the same scope and report them per currency; they are
  // never converted into the selected currency or subtracted from anything.
  const others=store.all(`SELECT q.currency currency,count(*) requests FROM model_requests q
    WHERE ${scoped.join(' AND ')} AND q.currency IS NOT NULL AND q.currency<>? GROUP BY q.currency ORDER BY q.currency`,...scopedArgs,currency);
  const otherCurrencies=others.map(row=>({currency:String(row.currency),requests:Number(row.requests)}));
  // Aggregate tasks separately, so the task rows never take from the cost query's 5,000-group budget. Every workflow runs
  // as a task, so every kind is counted: a custom workflow's tasks by the workflow they ran (its id), the others by kind.
  const taskAccess=scope(user,'t.repository_id'),taskClauses=[taskAccess.sql,
    '(statistics_date(t.created_at) BETWEEN ? AND ? OR statistics_date(t.created_at) IS NULL)'];
  const taskArgs=[...taskAccess.args,start,end];
  if(repo){taskClauses.push('t.repository_id=?');taskArgs.push(repo);}
  const taskRows=store.all(`SELECT statistics_date(t.created_at) date,t.repository_id,r.full_name,t.kind,
    CASE WHEN t.kind IN ('workflow.issue','workflow.pr') THEN 'reply' ELSE t.kind END workflow,count(*) count,
    sum(CASE WHEN m.task_id IS NULL OR (m.complete=0 AND m.runtime_ms=0 AND m.active_since IS NULL) THEN NULL
      ELSE m.runtime_ms+CASE WHEN m.active_since IS NOT NULL THEN max(0,?-m.active_since) ELSE 0 END END) runtime_ms,
    sum(CASE WHEN m.task_id IS NULL OR m.complete=0 THEN 1 ELSE 0 END) incomplete_tasks,
    sum(CASE WHEN m.active_since IS NOT NULL THEN 1 ELSE 0 END) running_tasks
    FROM tasks t JOIN repositories r ON r.id=t.repository_id LEFT JOIN task_metrics m ON m.task_id=t.id
    WHERE ${taskClauses.join(' AND ')} GROUP BY date,t.repository_id,t.kind,workflow ORDER BY date,t.repository_id,t.kind,workflow`,Date.now(),...taskArgs);
  // Tasks are counted per work type (`workflow` keeps its name in the response): reply tasks of former custom workflows
  // count as reply work.
  const workflowName=(row:Row)=>workType(String(row.workflow))?.name??String(row.kind);
  for(const row of taskRows)row.name=workflowName(row);
  const taskDays=taskRows.filter(r=>r.date!==null),undated=taskRows.filter(r=>r.date===null);
  const taskSummary=new Map<string,Row>();
  for(const row of taskDays){
    const total=taskSummary.get(row.workflow)||{kind:row.kind,workflow:row.workflow,name:row.name,count:0,runtime_ms:null,incomplete_tasks:0,running_tasks:0};
    for(const key of ['count','incomplete_tasks','running_tasks'])total[key]+=row[key];
    if(row.runtime_ms!==null)total.runtime_ms=(total.runtime_ms??0)+row.runtime_ms;
    taskSummary.set(row.workflow,total);
  }
  // Work types first, in the catalog's order, then the others by name.
  const order=(row:Row)=>{const at=workTypes.findIndex(w=>w.id===row.workflow);return at<0?workTypes.length:at;};
  const summaryRows=[...taskSummary.values()].sort((a,b)=>order(a)-order(b)||String(a.name).localeCompare(String(b.name)));
  return {from:start,to:end,currency,timezone,days:rows,tasks:{days:taskDays,summary:summaryRows,undated},
    prices,other_currencies:otherCurrencies,
    collection_started_at:store.get("SELECT value FROM settings WHERE key='task_metrics_v1'")?.value||null,
    summary:{cost:rows.reduce((n,r)=>n+Number(r.cost||0),0),requests:rows.reduce((n,r)=>n+r.requests,0),
      unpriced_requests:rows.reduce((n,r)=>n+r.unpriced_requests,0),usage_missing_requests:rows.reduce((n,r)=>n+r.usage_missing_requests,0),
      ...Object.fromEntries(['input_tokens','output_tokens','cached_input_tokens'].map(key=>[key,
        rows.some(r=>r[key]!==null)?rows.reduce((n,r)=>n+Number(r[key]||0),0):null]))}};
}
