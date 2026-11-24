import { taskOriginsForDisplay } from '../tasks/origin-display.js';
import {taskRelations} from '../tasks/priority.js';
import { historyData, logContent, unreadable } from '../storage/payloads.js';
import { taskDispatch } from '../dispatch/store.js';
import { taskWritesDetail } from '../tasks/grants.js';
import { taskBasis } from '../dispatch/basis.js';
import { sourcePolicies } from '../tasks/management.js';
import { taskTrace, traceClean } from '../tasks/trace.js';
import { TaskRecords } from '../tasks/service.js';
import { type Store } from '../storage/database.js';
import { type Actor, repository, scope } from './auth.js';
import { authorize } from '../identity/authorization.js';
import { deliveryResult, deliveryDiagnosis } from '../review/delivery.js';
import { fail, type Json } from '../core/security.js';
import { redactEgress } from '../core/redaction.js';
import { withTaskMetrics } from '../metrics/accounting.js';
import { legacyTaskCategories } from '../projects/legacy-kinds.js';
import { explainFailure } from '../agent/failures.js';
import { taskGroupSQL } from './project-activity.js';
import { rejectedArchiveState } from './delivery-audit.js';
import { listBrowserEvidence } from '../browser/evidence.js';
import { attachExternalLinks, parseTaskTargetMeta, taskTargetSelectSQL } from '../tasks/external-links.js';
import { attachTaskRoleFlows, taskRoleTrace } from '../roles/flow.js';
import { taskEventSubscriptionsDetail } from '../tasks/event-subscriptions.js';

const completedGroupSQL = "status IN ('succeeded','pr_opened','completed')";
const taskListGroups: Record<string, string> = { ...taskGroupSQL, completed: completedGroupSQL };
// The console exits and the outbound subscriber copy share one rule for a credential-named field (see core/redaction.ts).
export { redactEgress } from '../core/redaction.js';
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
const safeResult = (raw: unknown) => {
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
};
const publicTask=(row:Record<string,any>)=>({id:row.id,repository_id:row.repository_id,full_name:row.full_name,kind:row.kind,status:row.status,summary:row.summary,priority:row.priority,queue_seq:row.queue_seq,
  object_number:row.object_number,target:parseTaskTargetMeta(row.target_meta),head_sha:row.head_sha,source_task_id:row.source_task_id,generation:row.generation,phase:row.phase,
  error_code:row.error_code,error_cause:explainFailure(row.error_code,row.status,row.error_detail,row.retry_cycle_started_at),retry_count:row.retry_count,
  retry_cycle_started_at:row.retry_cycle_started_at,next_run_at:row.next_run_at,pushed_sha:row.pushed_sha||null,attempt:row.attempt,result:safeResult(row.result),created_at:row.created_at,updated_at:row.updated_at});


function detailState(store:Store,id:string){
 const state=new TaskRecords(store).get(id),candidate=state.candidate;
 if(candidate)state.candidate={...candidate,claims:{preview:JSON.stringify(candidate.claims??null).slice(0,1500),body_omitted:true},artifacts:candidate.artifacts.map(({content,...a})=>({...a,content:{body_omitted:true}})),evidence:candidate.evidence.map(({result,...e})=>({...e,result:{body_omitted:true}}))};
 return state;
}
function detailHistory(store:Store,id:string){
 const rows=store.all('SELECT id,type,created_at,run_id FROM task_history WHERE task_id=? ORDER BY id DESC LIMIT 51',id),more=rows.length>50;rows.splice(50);rows.reverse();
 return {history:rows.map(h=>({...h,event_id:'task_history:'+h.id,source_ref:'task_history:'+h.id})),history_page:{has_older:more,events_url:'/api/tasks/'+id+'/events',limit:50}};
}
const publicTaskColumns='id,repository_id,kind,status,summary,priority,queue_seq,object_number,head_sha,source_task_id,generation,phase,error_code,retry_count,retry_cycle_started_at,next_run_at,attempt,result,created_at,updated_at';
const pushedSha="(SELECT json_extract(data,'$.remote_sha') FROM development_candidates WHERE task_id=tasks.id) AS pushed_sha";
const repositoryName='(SELECT full_name FROM repositories WHERE id=tasks.repository_id) AS full_name';
const taskTargetMeta=`${taskTargetSelectSQL()} AS target_meta`;
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
    const clauses=[filter.sql],args:(string|number)[]=[...filter.args];
    for(const [key,column] of [['repository_id','repository_id'],['account_id','account_id'],['owner_id','owner_id']]){
      const value=url.searchParams.get(key!);if(value){clauses.push(key==='repository_id'?'repository_id=?':`repository_id IN (SELECT id FROM repositories WHERE ${column}=?)`);args.push(value);}
    }
    // Filter before pagination: an old blocked task must not disappear behind newer completed work.
    const attention = url.searchParams.get('attention');
    if (attention && attention !== '1') fail(400, 'invalid_attention_filter');
    // Review and development tasks are listed on separate pages.
    const priority=url.searchParams.get('priority');if(priority){if(!['P0','P1','P2','P3'].includes(priority))fail(400,'invalid_task_priority');clauses.push('priority=?');args.push(priority);}
    const kind=url.searchParams.get('kind');if(kind){if(!['review','development'].includes(kind))fail(400,'invalid_task_kind');clauses.push('kind LIKE ?');args.push(kind+'.%');}
    const workflow=url.searchParams.get('workflow');
    if(workflow){
      const selected=legacyTaskCategories.find(work=>work.id===workflow);
      if(!selected)fail(400,'invalid_task_workflow');
      if(workflow==='reply')clauses.push("kind LIKE 'workflow.%'");
      else {clauses.push(`kind IN (${selected!.kinds.map(()=>'?').join(',')})`);args.push(...selected!.kinds);}
    }
    const group=url.searchParams.get('group');
    if(group && group!=='all' && !Object.hasOwn(taskListGroups,group)) fail(400,'invalid_task_group');
    if(attention && group && group!=='attention') fail(400,'conflicting_task_filters');
    const summaryRequested=url.searchParams.get('summary');
    if(summaryRequested && summaryRequested!=='1') fail(400,'invalid_task_summary');
    const flowRequested=url.searchParams.get('flow');
    if(flowRequested && flowRequested!=='1') fail(400,'invalid_task_flow');
    const rawSearch=url.searchParams.get('q')?.trim().slice(0,200) ?? '';
    if(rawSearch){
      const escaped=rawSearch.replace(/[\\%_]/g,ch=>'\\'+ch);
      const num=/^#?(\d+)$/.exec(rawSearch)?.[1] ?? null;
      clauses.push(`(summary LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'${num ? " OR object_number=? OR (json_valid(result) AND json_extract(result,'$.pr_number')=?)" : ''})`);
      args.push(`%${escaped}%`,`%${escaped}%`,...(num ? [Number(num),Number(num)] : []));
    }
    const selected=attention?'attention':group;
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||50)),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset))fail(400,'invalid_pagination');
    const read=()=>{
      // Count before status filtering and pagination; the transaction keeps counts and rows in one database snapshot.
      const summary=summaryRequested ? { ...store.get(`SELECT COUNT(*) AS "all",${Object.entries(taskGroupSQL).map(([key,sql])=>`COALESCE(SUM(CASE WHEN ${sql} THEN 1 ELSE 0 END),0) AS ${key}`).join(',')}
        FROM tasks WHERE ${clauses.join(' AND ')}`,...args), sampled_at:new Date().toISOString() } : undefined;
      const completedCount=flowRequested ? Number(store.get(`SELECT COUNT(*) AS n FROM tasks WHERE ${[...clauses,completedGroupSQL].join(' AND ')}`,...args)?.n ?? 0) : undefined;
      const selectedClauses=[...clauses];
      if(selected && selected!=='all') selectedClauses.push(taskListGroups[selected]!);
      const rows=store.all(`SELECT ${publicTaskColumns},${repositoryName},${pushedSha},${taskTargetMeta},CASE WHEN error_code='model_unavailable' THEN ${faultDetail} END AS error_detail FROM tasks WHERE ${selectedClauses.join(' AND ')} ORDER BY ${selected==='attention' ? 'updated_at ASC,id ASC' : 'created_at DESC,id DESC'} LIMIT ? OFFSET ?`,...args,limit,offset);
      const origins = taskOriginsForDisplay(store, rows.map(row => row.id), true);
      const baseTasks = withTaskMetrics(store, rows.map(row => ({ ...publicTask(row), origin: origins.get(row.id) ?? null })));
      const tasks=flowRequested ? attachTaskRoleFlows(store,attachExternalLinks(store,baseTasks)) : baseTasks;
      return {tasks,execution_available:true,...(summary?{summary}:{}),...(completedCount!==undefined?{completed_count:completedCount}:{})};
    };
    return (summaryRequested || flowRequested)?store.transaction(read):read();
  }
  const relations=/^\/api\/tasks\/([^/]+)\/relations$/.exec(path);
  if(relations){const task=store.get(`SELECT id FROM tasks WHERE id=? AND ${filter.sql}`,relations[1]!,...filter.args);if(!task)fail(404,'task_not_found');const offset=Number(url.searchParams.get('offset')??0);if(!Number.isSafeInteger(offset)||offset<0)fail(400,'invalid_pagination');return taskRelations(store,task!.id,offset);}
  const trace=/^\/api\/tasks\/([^/]+)\/(events|runs|source|lineage)$/.exec(path);
  if(trace){const row=store.get(`SELECT id FROM tasks WHERE id=? AND ${filter.sql}`,trace[1]!,...filter.args);if(!row)fail(404,'task_not_found');return taskTrace(store,trace[1]!,url,trace[2]!,user.context?{actor:user.context}:undefined) as any;}
  const task = /^\/api\/tasks\/([^/]+)(\/logs)?$/.exec(path);
  if (task) {
    const row = store.get(`SELECT *,${repositoryName},${pushedSha},${taskTargetMeta},${faultDetail} AS error_detail FROM tasks WHERE id=? AND ${filter.sql}`, task[1]!, ...filter.args);
    if (!row) return fail(404, 'task_not_found');
    if (task[2]) {
      const limit = Number(url.searchParams.get('limit') ?? 100), after = url.searchParams.get('after'), before = url.searchParams.get('before');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || after !== null && before !== null ||
        [after, before].some(value => value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))) fail(400, 'invalid_pagination');
      const ascending = after !== null, cursor = after ?? before;
      const rows = store.all(`SELECT rowid AS sequence,id,content,content_ref,created_at,run_id,role FROM task_logs WHERE task_id=?
        ${cursor === null ? '' : 'AND rowid' + (ascending ? '>' : '<') + '?'} ORDER BY rowid ${ascending ? 'ASC' : 'DESC'} LIMIT ?`, row.id, ...(cursor === null ? [] : [Number(cursor)]), limit + 1);
      const more = rows.length > limit; rows.splice(limit); if (!ascending) rows.reverse();
      // A large log's text is in its run's trajectory file; one that fails verification says so instead.
      const logs = rows.map(log => { const { content_ref, ...rest } = log; let text: string; try { text = logContent(store, log); } catch (error) { text = JSON.stringify({ type: 'log_unreadable', ...unreadable(error) }); } return { ...rest, content: text }; })
        .map(faultCause).map(log => {
        let content = log.content;
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
    const state=detailState(store,row.id),base=withTaskMetrics(store,[publicTask(row)])[0]!,blocked=row.status==='waiting_coordination'&&row.error_code==='task_children_pending'?state.children?.blocked:null;
    // The parent itself waits on task_children_pending. When every unreturned child is blocked on the environment or
    // configuration, the parent's summary comes from the aggregate each child's own failure cause produced; the callout
    // carries the aggregate action, so the progress sentence keeps only the short label.
    const baseTask = {...base,origin:taskOriginsForDisplay(store, [row.id], true).get(row.id) ?? null,structured:state,error_detail:row.error_detail||null,
      ...(blocked?{error_cause:{...(base.error_cause||{}),cause:blocked.cause??base.error_cause?.cause??null,label:blocked.label,action:''}}:{})};
    const taskWithLinks = attachExternalLinks(store, [baseTask])[0]!;
    const roleTrace = taskRoleTrace(store, taskWithLinks, user.context ? { actor: user.context } : undefined);
    const canManage = (() => { try { if (user.context) authorize(user.context, 'tasks.write', { project_id: row.repository_id }); return true; } catch { return false; } })();
    return { task: taskWithLinks, can_manage: canManage, ...roleTrace, ...detailHistory(store,row.id),publications:store.all('SELECT kind,state,response FROM github_effects WHERE task_id=?',row.id).map(p=>({...p,response:p.response?JSON.parse(p.response):null})),
      // Why the Manager created or continued this task, with the events behind it.
      dispatch:taskDispatch(store,row.id),
      // Active and recent webhook event subscriptions registered by this task (#1168).
      event_subscriptions:taskEventSubscriptionsDetail(store,row.id),
      browser_evidence:listBrowserEvidence(store,row.id),
      // The writes a generic task holds and the delivery tools each run had (#814); null for older tasks.
      writes:taskWritesDetail(store,row,sourcePolicies(store,row)),
      // Why this development was allowed to start (#815); null when none was recorded.
      basis:taskBasis(store,row.id) };
  }
  if (path === '/api/audit') return { audit: store.all(`SELECT * FROM audit WHERE ${filter.sql}${repo ? ' AND repository_id=?' : ''}
    ORDER BY created_at DESC LIMIT 100`, ...filter.args, ...(repo ? [repo] : [])) };
  return undefined;
}
