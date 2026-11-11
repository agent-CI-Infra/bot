import {taskRelations} from '../tasks/priority.js';
import { visibleMemorySnapshot } from '../memory/access.js';
import { taskDispatch } from '../dispatch/store.js';
import { taskTrace } from '../tasks/trace.js';
import { TaskRecords } from '../tasks/service.js';
import { type Store } from '../storage/database.js';
import { type Actor, repository, scope } from './auth.js';
import { deliveryResult } from '../review/delivery.js';
import { fail, type Json } from '../core/security.js';
import { withTaskMetrics } from '../metrics/accounting.js';
import { explainFailure } from '../agent/failures.js';
import { taskGroupSQL } from './project-activity.js';
// Faults are classified when read, so logs written before a cause existed are explained the same way.
function faultCause(log:Record<string,any>){
  if(!String(log.content).startsWith('{"type":"fault"'))return log;
  try{const value=JSON.parse(log.content);return {...log,cause:explainFailure(value.code,value.state,value.detail,value.retry_cycle_started_at)};}catch{return log;}
}
const publicTask=(row:Record<string,any>)=>({id:row.id,repository_id:row.repository_id,full_name:row.full_name,kind:row.kind,status:row.status,summary:row.summary,priority:row.priority,queue_seq:row.queue_seq,
  object_number:row.object_number,head_sha:row.head_sha,source_task_id:row.source_task_id,generation:row.generation,phase:row.phase,
  error_code:row.error_code,error_cause:explainFailure(row.error_code,row.status,row.error_detail,row.retry_cycle_started_at),retry_count:row.retry_count,
  retry_cycle_started_at:row.retry_cycle_started_at,next_run_at:row.next_run_at,pushed_sha:row.pushed_sha||null,attempt:row.attempt,result:row.result?JSON.parse(row.result):null,created_at:row.created_at,updated_at:row.updated_at});
const taskOrigin=(store:Store,id:string)=>store.get('SELECT source_kind,source_role,executor_role,conversation_id,source_message,source_task_id FROM task_origins WHERE task_id=?',id)??null;

function detailState(store:Store,id:string){
 const state=new TaskRecords(store).get(id),candidate=state.candidate;
 if(candidate)state.candidate={...candidate,claims:{preview:JSON.stringify(candidate.claims??null).slice(0,1500),body_omitted:true},artifacts:candidate.artifacts.map(({content,...a})=>({...a,content:{body_omitted:true}})),evidence:candidate.evidence.map(({result,...e})=>({...e,result:{body_omitted:true}}))};
 return state;
}
function detailHistory(store:Store,id:string){
 const rows=store.all('SELECT id,type,created_at,run_id FROM task_history WHERE task_id=? ORDER BY id DESC LIMIT 51',id),more=rows.length>50;rows.splice(50);rows.reverse();
 return {history:rows.map(h=>({...h,event_id:'task_history:'+h.id,source_ref:'task_history:'+h.id})),history_page:{has_older:more,events_url:'/api/tasks/'+id+'/events',limit:50}};
}
const pushedSha="(SELECT json_extract(data,'$.remote_sha') FROM development_candidates WHERE task_id=tasks.id) AS pushed_sha";
const repositoryName='(SELECT full_name FROM repositories WHERE id=tasks.repository_id) AS full_name';
const faultDetail="(SELECT json_extract(content,'$.detail') FROM task_logs WHERE task_id=tasks.id AND json_valid(content) AND json_extract(content,'$.type')='fault' AND json_extract(content,'$.code')=tasks.error_code ORDER BY rowid DESC LIMIT 1)";
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
    // Page by id first: sorting whole rows sorted every archived payload (30k deliveries, ~700 MB), which held the
    // control plane's only thread for 100 s on each visit. Only the page's rows are read in full.
    const page = store.all(`SELECT id FROM deliveries WHERE ${clauses.join(' AND ')} ORDER BY received_at DESC,id DESC LIMIT ? OFFSET ?`, ...args, limit, offset).map(row => row.id);
    const rows = new Map(store.all(`SELECT *, (SELECT full_name FROM repositories WHERE id=deliveries.repository_id) AS full_name
      FROM deliveries WHERE id IN (${page.map(() => '?').join(',') || 'NULL'})`, ...page).map(row => [row.id, row]));
    return { events: page.map(id => rows.get(id)!).map(row=>{const {payload,response,request_headers,...safe}=row;return {...safe,...deliveryResult(store,row)};}) };
  }
  const event = /^\/api\/events\/([^/]+)$/.exec(path);
  if (event) {
    const row = store.get(`SELECT * FROM deliveries WHERE id=? AND ${filter.sql}`, event[1]!, ...filter.args);
    if (!row) return fail(404, 'event_not_found');
    return { event: { ...row, request_headers: JSON.parse(row.request_headers),
      payload: Buffer.from(row.payload).toString('utf8'), response: JSON.parse(row.response) } };
  }
  if (path === '/api/tasks') {
    const clauses=[filter.sql],args=[...filter.args];
    for(const [key,column] of [['repository_id','repository_id'],['account_id','account_id'],['owner_id','owner_id']]){
      const value=url.searchParams.get(key!);if(value){clauses.push(key==='repository_id'?'repository_id=?':`repository_id IN (SELECT id FROM repositories WHERE ${column}=?)`);args.push(value);}
    }
    // Filter before pagination: an old blocked task must not disappear behind newer completed work.
    const attention = url.searchParams.get('attention');
    if (attention && attention !== '1') fail(400, 'invalid_attention_filter');
    // Review and development tasks are listed on separate pages.
    const priority=url.searchParams.get('priority');if(priority){if(!['P0','P1','P2','P3'].includes(priority))fail(400,'invalid_task_priority');clauses.push('priority=?');args.push(priority);}
    const kind=url.searchParams.get('kind');if(kind){if(!['review','development'].includes(kind))fail(400,'invalid_task_kind');clauses.push('kind LIKE ?');args.push(kind+'.%');}
    const group=url.searchParams.get('group');
    if(group && group!=='all' && !Object.hasOwn(taskGroupSQL,group)) fail(400,'invalid_task_group');
    if(attention && group && group!=='attention') fail(400,'conflicting_task_filters');
    const summaryRequested=url.searchParams.get('summary');
    if(summaryRequested && summaryRequested!=='1') fail(400,'invalid_task_summary');
    const selected=attention?'attention':group;
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||50)),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset))fail(400,'invalid_pagination');
    const read=()=>{
      // Count before status filtering and pagination; the transaction keeps counts and rows in one database snapshot.
      const summary=summaryRequested ? { ...store.get(`SELECT COUNT(*) AS "all",${Object.entries(taskGroupSQL).map(([key,sql])=>`COALESCE(SUM(CASE WHEN ${sql} THEN 1 ELSE 0 END),0) AS ${key}`).join(',')}
        FROM tasks WHERE ${clauses.join(' AND ')}`,...args), sampled_at:new Date().toISOString() } : undefined;
      const selectedClauses=[...clauses];
      if(selected && selected!=='all') selectedClauses.push(taskGroupSQL[selected as keyof typeof taskGroupSQL]);
      return {tasks:withTaskMetrics(store,store.all(`SELECT *,${repositoryName},${pushedSha},CASE WHEN error_code='model_unavailable' THEN ${faultDetail} END AS error_detail FROM tasks WHERE ${selectedClauses.join(' AND ')} ORDER BY ${selected==='attention' ? 'updated_at ASC,id ASC' : 'created_at DESC,id DESC'} LIMIT ? OFFSET ?`,...args,limit,offset).map(row=>({...publicTask(row),origin:taskOrigin(store,row.id)}))),execution_available:true,...(summary?{summary}:{})};
    };
    return summaryRequested?store.transaction(read):read();
  }
  const relations=/^\/api\/tasks\/([^/]+)\/relations$/.exec(path);
  if(relations){const task=store.get(`SELECT id FROM tasks WHERE id=? AND ${filter.sql}`,relations[1]!,...filter.args);if(!task)fail(404,'task_not_found');const offset=Number(url.searchParams.get('offset')??0);if(!Number.isSafeInteger(offset)||offset<0)fail(400,'invalid_pagination');return taskRelations(store,task!.id,offset);}
  const trace=/^\/api\/tasks\/([^/]+)\/(events|runs|source|lineage)$/.exec(path);
  if(trace){const row=store.get(`SELECT id FROM tasks WHERE id=? AND ${filter.sql}`,trace[1]!,...filter.args);if(!row)fail(404,'task_not_found');return taskTrace(store,trace[1]!,url,trace[2]!,user.context?{actor:user.context}:undefined) as any;}
  const task = /^\/api\/tasks\/([^/]+)(\/logs)?$/.exec(path);
  if (task) {
    const row = store.get(`SELECT *,${repositoryName},${pushedSha},${faultDetail} AS error_detail FROM tasks WHERE id=? AND ${filter.sql}`, task[1]!, ...filter.args);
    if (!row) return fail(404, 'task_not_found');
    return task[2] ? { logs: store.all('SELECT id,content,created_at FROM task_logs WHERE task_id=? ORDER BY rowid', row.id).map(faultCause).map(log=>({...log,content:visibleMemorySnapshot(store,row.repository_id,log.content,user.context?{actor:user.context}:undefined)})) } : { task: {...withTaskMetrics(store,[publicTask(row)])[0],origin:taskOrigin(store,row.id),structured:detailState(store,row.id),error_detail:row.error_detail||null},...detailHistory(store,row.id),publications:store.all('SELECT kind,state,response FROM github_effects WHERE task_id=?',row.id).map(p=>({...p,response:p.response?JSON.parse(p.response):null})),
      // Why the Manager created or continued this task, with the events behind it.
      dispatch:taskDispatch(store,row.id) };
  }
  if (path === '/api/audit') return { audit: store.all(`SELECT * FROM audit WHERE ${filter.sql}${repo ? ' AND repository_id=?' : ''}
    ORDER BY created_at DESC LIMIT 100`, ...filter.args, ...(repo ? [repo] : [])) };
  return undefined;
}
