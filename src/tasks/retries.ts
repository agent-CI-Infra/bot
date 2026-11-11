import type {Store,Row} from '../storage/database.js';
import {traceEvent} from './trace.js';

/** Retry facts live in the task journal; a session or new commit does not start another counter. */
export function recordRetryFailure(s:Store,task:Row,failure:{group:string;occurrence:string;code:string;detail?:string;source_ref?:string}){
 return s.transaction(()=>{
  const resolved=s.get("SELECT id FROM task_history WHERE task_id=? AND type='retry_resolved' AND json_extract(data,'$.group')=? ORDER BY id DESC LIMIT 1",task.id,failure.group)?.id??0;
  const duplicate=s.get("SELECT id FROM task_history WHERE task_id=? AND id>? AND type='retry_failure' AND json_extract(data,'$.group')=? AND json_extract(data,'$.occurrence')=?",task.id,resolved,failure.group,failure.occurrence);
  if(duplicate)return 'task_history:'+duplicate.id;
  const previous=s.get("SELECT data FROM task_history WHERE task_id=? AND id>? AND type='retry_failure' AND json_extract(data,'$.group')=? ORDER BY id DESC LIMIT 1",task.id,resolved,failure.group);
  // This follows the engine's retry_count convention: the first failed attempt is count 1.
  const count=previous?JSON.parse(previous.data).count+1:1;
  const dev=s.get("SELECT id,data FROM task_history WHERE task_id=? AND type='role_result' AND json_extract(data,'$.role')='dev' ORDER BY id DESC LIMIT 1",task.id);
  const candidate=s.get('SELECT candidate FROM task_records WHERE task_id=?',task.id)?.candidate;
  const saved=s.get('SELECT data FROM development_candidates WHERE task_id=?',task.id),lastSaved=saved?JSON.parse(saved.data):null;
  const operation=failure.code==='candidate_unavailable'?s.get("SELECT id,request,result FROM task_tools WHERE task_id=? AND state='completed' AND json_extract(request,'$.request.type')='workspace_finalize' AND json_extract(result,'$.error') IS NOT NULL ORDER BY rowid DESC LIMIT 1",task.id):null;
  const rawError=operation?JSON.parse(operation.result):null;
  const value={...failure,detail:failure.detail?.slice(0,8000),count,attempt:task.attempt,phase:task.phase,
   ...(operation?{source_ref:'task_tools:'+operation.id,operation:{type:'workspace_finalize',workspace_id:JSON.parse(operation.request).request.workspace_id,error:rawError.error,detail:rawError.detail}}:{}),
   artifacts:{dev_result_ref:dev?'task_history:'+dev.id:null,dev_input_version:dev?JSON.parse(dev.data).candidate_version:null,
    candidate_id:candidate?JSON.parse(candidate).id:null,last_saved_candidate:lastSaved?{commit:lastSaved.local_sha,tree:lastSaved.tree_sha}:null,
    collection_failed:failure.code==='candidate_unavailable',instruction:'A completed Dev report does not prove a newly collected candidate; inspect the failure and version bindings.'}};
  const ref=traceEvent(s,task.id,'retry_failure',value,null,'framework');
  if(count%3===0)traceEvent(s,task.id,'retry_report',{group:failure.group,count,failure_ref:ref,
   instruction:'Repeated attempts need your attention. You may continue automatic retries or investigate and arrange repair. This report does not require a human approval or pause other tasks.'},null,'framework',[ref]);
  return ref;
 });
}
export function resolveRetry(s:Store,taskId:string,group:string){
 const last=s.get("SELECT type FROM task_history WHERE task_id=? AND type IN ('retry_failure','retry_resolved') AND json_extract(data,'$.group')=? ORDER BY id DESC LIMIT 1",taskId,group);
 if(last?.type==='retry_failure')traceEvent(s,taskId,'retry_resolved',{group},null,'framework');
}
export function resolveExecutionRetries(s:Store,taskId:string){
 for(const row of s.all("SELECT DISTINCT json_extract(data,'$.group') value FROM task_history WHERE task_id=? AND type='retry_failure' AND json_extract(data,'$.group') LIKE 'execution:%'",taskId))resolveRetry(s,taskId,row.value);
}
export function retryContext(s:Store,taskId:string){
 return s.all("SELECT id,data,created_at FROM task_history WHERE task_id=? AND type='retry_report' ORDER BY id DESC LIMIT 3",taskId).map(row=>({ref:'task_history:'+row.id,...JSON.parse(row.data),created_at:row.created_at,
  decision:(()=>{const report=JSON.parse(row.data),d=s.get("SELECT data FROM task_history WHERE task_id=? AND id>? AND type='retry_decision' AND (json_extract(data,'$.report_ref')=? OR (json_extract(data,'$.group')=? AND json_extract(data,'$.count')>=?)) ORDER BY id DESC LIMIT 1",taskId,row.id,'task_history:'+row.id,report.group,report.count);return d?JSON.parse(d.data):null;})()}));
}
export function pendingRetryReport(s:Store,taskId:string){
 return retryContext(s,taskId).find(report=>!report.decision&& !s.get("SELECT id FROM task_history WHERE task_id=? AND type='retry_resolved' AND id>? AND json_extract(data,'$.group')=?",taskId,Number(report.ref.split(':')[1]),report.group));
}
export function retryNeedsInvestigation(s:Store,taskId:string){
 return !!s.get(`SELECT d.id FROM task_history d WHERE d.task_id=? AND d.type='retry_decision' AND json_extract(d.data,'$.action')='investigate'
  AND NOT EXISTS(SELECT 1 FROM task_history n WHERE n.task_id=d.task_id AND n.id>d.id AND n.type IN ('retry_decision','retry_resolved') AND json_extract(n.data,'$.group')=json_extract(d.data,'$.group')) LIMIT 1`,taskId);
}
