import {taskRelations} from '../tasks/priority.js';
import { historyData, logContent, unreadable } from '../storage/payloads.js';
import { visibleMemorySnapshot } from '../memory/access.js';
import { taskDispatch } from '../dispatch/store.js';
import { taskTrace, traceClean } from '../tasks/trace.js';
import { TaskRecords } from '../tasks/service.js';
import { type Store } from '../storage/database.js';
import { type Actor, repository, scope } from './auth.js';
import { deliveryResult, deliveryDiagnosis } from '../review/delivery.js';
import { fail, type Json } from '../core/security.js';
import { withTaskMetrics } from '../metrics/accounting.js';
import { workTypes } from '../work/catalog.js';
import { explainFailure } from '../agent/failures.js';
import { taskGroupSQL } from './project-activity.js';
import { rejectedArchiveState } from './delivery-audit.js';
// A delivery body and a management receipt reach the console, so a credential in either one must not leave the server.
// A key whose name is exactly one of these loses its value at every depth, in objects and in array elements; nothing is
// inferred from a value's shape, so a field this list does not name is returned exactly as it was stored.
const credentialKey = /^(?:token|secret|password|authorization|cookie|private_key)$/i;
export function redactEgress(value: any): any {
  if (Array.isArray(value)) return value.map(redactEgress);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, credentialKey.test(key) ? '[redacted]' : redactEgress(item)]));
  return value;
}
// A webhook body is stored as the text the sender sent: only a body that actually carries a named key is re-encoded, so
// every other body keeps its exact bytes. A body that parses but cannot be walked to the end (a nesting deep enough to
// exhaust the stack, say) is not returned raw: that would hand the caller the credential this exit exists to remove,
// so it comes back as a placeholder instead. Only a parse failure returns the raw text, because text that is not JSON
// cannot carry a named field.
const redactionFailed = JSON.stringify({redacted:true,reason:'redaction_failed'});
const redactedBody = (raw: string) => {
  let value: any;
  try { value = JSON.parse(raw); } catch { return raw; }
  if (!value || typeof value !== 'object') return raw;
  try {
    const clean = redactEgress(value);
    return JSON.stringify(clean) !== JSON.stringify(value) ? JSON.stringify(clean) : raw;
  } catch { return redactionFailed; }
};
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
    return { events: page.map(id => rows.get(id)!).map(row=>{const {payload,response,request_headers,...safe}=row;return {...safe,...deliveryResult(store,row),...deliveryDiagnosis(store,row)};}),
      // What the refused archive holds and the bounds it enforces, for the global operator only: a scoped list must not
      // turn a project's page into an all-platform count.
      ...(user.role === 'super_admin' && !user.context?.tenant_id ? { rejected_archive: rejectedArchiveState(store) } : {}) };
  }
  const event = /^\/api\/events\/([^/]+)$/.exec(path);
  if (event) {
    const row = store.get(`SELECT * FROM deliveries WHERE id=? AND ${filter.sql}`, event[1]!, ...filter.args);
    if (!row) return fail(404, 'event_not_found');
    return { event: { ...row, request_headers: redactEgress(JSON.parse(row.request_headers)),
      payload: redactedBody(Buffer.from(row.payload).toString('utf8')), response: redactEgress(JSON.parse(row.response)), ...deliveryResult(store,row), ...deliveryDiagnosis(store,row) } };
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
    // The work type a task belongs to (#238). It is the same identity the console shows and the Manager dispatches to,
    // so the console can drill into one type without re-deriving the mapping. Combining with kind is an intersection.
    const workflow=url.searchParams.get('workflow');
    if(workflow){
      const selected=workTypes.find(work=>work.id===workflow);
      if(!selected)fail(400,'invalid_task_workflow');
      // Former custom workflows run as the one 通用回复 work type (see workOf), so that id covers the whole kind prefix.
      if(workflow==='reply')clauses.push("kind LIKE 'workflow.%'");
      else {clauses.push(`kind IN (${selected!.kinds.map(()=>'?').join(',')})`);args.push(...selected!.kinds);}
    }
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
    if (task[2]) {
      const limit = Number(url.searchParams.get('limit') ?? 100), after = url.searchParams.get('after'), before = url.searchParams.get('before');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || after !== null && before !== null ||
        [after, before].some(value => value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))) fail(400, 'invalid_pagination');
      const ascending = after !== null, cursor = after ?? before;
      const rows = store.all(`SELECT rowid AS sequence,id,content,content_ref,created_at FROM task_logs WHERE task_id=?
        ${cursor === null ? '' : 'AND rowid' + (ascending ? '>' : '<') + '?'} ORDER BY rowid ${ascending ? 'ASC' : 'DESC'} LIMIT ?`, row.id, ...(cursor === null ? [] : [Number(cursor)]), limit + 1);
      const more = rows.length > limit; rows.splice(limit); if (!ascending) rows.reverse();
      // A large log's text is in its run's trajectory file; one that fails verification says so instead.
      const logs = rows.map(log => { const { content_ref, ...rest } = log; let text: string; try { text = logContent(store, log); } catch (error) { text = JSON.stringify({ type: 'log_unreadable', ...unreadable(error) }); } return { ...rest, content: text }; })
        .map(faultCause).map(log => {
        let content = visibleMemorySnapshot(store, row.repository_id, log.content, user.context ? { actor: user.context } : undefined);
        // Historical legacy model logs may contain private fields. Tool/file contents remain literal public evidence.
        try {
          const value = JSON.parse(content);
          if (value.type === 'model') {
            const clean = traceClean(value);
            if (typeof value.content === 'string') clean.content = traceClean({ encoding: 'utf8', content: value.content }).content;
            content = JSON.stringify(clean);
          }
        } catch { /* Plain output remains readable. */ }
        return { ...log, content };
      });
      return { logs, log_page: { has_older: ascending ? false : more, has_newer: ascending && more,
        first_sequence: rows[0]?.sequence ?? null, last_sequence: rows.at(-1)?.sequence ?? null } };
    }
    return { task: {...withTaskMetrics(store,[publicTask(row)])[0],origin:taskOrigin(store,row.id),structured:detailState(store,row.id),error_detail:row.error_detail||null},...detailHistory(store,row.id),publications:store.all('SELECT kind,state,response FROM github_effects WHERE task_id=?',row.id).map(p=>({...p,response:p.response?JSON.parse(p.response):null})),
      // Why the Manager created or continued this task, with the events behind it.
      dispatch:taskDispatch(store,row.id) };
  }
  if (path === '/api/audit') return { audit: store.all(`SELECT * FROM audit WHERE ${filter.sql}${repo ? ' AND repository_id=?' : ''}
    ORDER BY created_at DESC LIMIT 100`, ...filter.args, ...(repo ? [repo] : [])) };
  return undefined;
}
