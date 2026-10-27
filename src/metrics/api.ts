import type { Store } from '../storage/database.js';
import { type Actor, repository, scope } from '../app/auth.js';
import { fail, type Json } from '../core/security.js';

function date(value: string): string {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail(400,'invalid_cost_date');
  return value;
}
export function costsApi(store: Store, user: Actor, url: URL): Json | undefined {
  if(url.pathname!=='/api/costs')return undefined;
  const end=date(url.searchParams.get('to')||new Date().toISOString().slice(0,10));
  const start=date(url.searchParams.get('from')||new Date(Date.parse(end+'T00:00:00Z')-29*86400000).toISOString().slice(0,10));
  const days=(Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000+1;
  if(days<1||days>366)fail(400,'cost_range_1_to_366_days');
  const currency=url.searchParams.get('currency')||'USD';if(!['USD','CNY'].includes(currency))fail(400,'invalid_pricing_currency');
  const until=new Date(Date.parse(end+'T00:00:00Z')+86400000).toISOString();
  const access=scope(user,'q.repository_id'),clauses=[access.sql,'q.requested_at>=?','q.requested_at<?','(q.currency=? OR q.currency IS NULL)'];
  const args=[...access.args,start+'T00:00:00.000Z',until,currency];
  const repo=url.searchParams.get('repository_id');if(repo){repository(store,user,repo);clauses.push('q.repository_id=?');args.push(repo);}
  const rows=store.all(`SELECT substr(q.requested_at,1,10) date,q.repository_id,r.full_name,sum(q.cost) cost,count(*) requests,
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
  return {from:start,to:end,currency,timezone:'UTC',days:rows,
    prices,
    collection_started_at:store.get("SELECT value FROM settings WHERE key='task_metrics_v1'")?.value||null,
    summary:{cost:rows.reduce((n,r)=>n+Number(r.cost||0),0),requests:rows.reduce((n,r)=>n+r.requests,0),
      unpriced_requests:rows.reduce((n,r)=>n+r.unpriced_requests,0),usage_missing_requests:rows.reduce((n,r)=>n+r.usage_missing_requests,0),
      ...Object.fromEntries(['input_tokens','output_tokens','cached_input_tokens'].map(key=>[key,
        rows.some(r=>r[key]!==null)?rows.reduce((n,r)=>n+Number(r[key]||0),0):null]))}};
}
