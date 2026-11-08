import type {Store,Row} from '../storage/database.js';
import type {Actor} from '../app/auth.js';
import {randomId,fail} from '../core/security.js';
import {traceEvent} from './trace.js';
import {TaskRecords} from './service.js';

/** Coordination metadata only; tasks/candidates/QA remain delivery authorities. */
export function integrationStorage(s:Store){s.db.exec(`CREATE TABLE IF NOT EXISTS task_merge_requests(
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, expected_sha TEXT NOT NULL,
 method TEXT NOT NULL, actor TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
 next_run_at INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL);`);}
export function authorizeMerge(s:Store,task:Row,actor:Actor,head:string,method:string){
 integrationStorage(s);const revision=new TaskRecords(s).get(task.id).revision,old=s.get('SELECT * FROM task_merge_requests WHERE task_id=?',task.id);
 if(old&&old.expected_sha===head&&old.revision===revision&&['waiting','integrating','queued','merged'].includes(old.state))return;
 s.run("INSERT INTO task_merge_requests VALUES(?,?,?,?,?,'waiting',?,NULL,?) ON CONFLICT(task_id) DO UPDATE SET expected_sha=excluded.expected_sha,method=excluded.method,actor=excluded.actor,revision=excluded.revision,state='waiting',next_run_at=excluded.next_run_at,error=NULL,updated_at=excluded.updated_at",task.id,head,method,JSON.stringify({...actor,csrf:undefined}),revision,Date.now()+15000,new Date().toISOString());
 traceEvent(s,task.id,'merge_requested',{head_sha:head,method,revision,actor:actor.id},null,'user:'+actor.id);
}
/** Preserve the snapshot and continuing role instances; never restart a task from bare main. */
export function requestIntegration(s:Store,task:Row,base:string,reason:string,pr?:any){
 const candidateRow=s.get('SELECT data FROM development_candidates WHERE task_id=?',task.id),candidate=candidateRow?JSON.parse(candidateRow.data):null;
 const source=candidate?.source_workspace_id??task.workspace_id;
 if(!candidate?.local_sha||!candidate.tree_sha||!candidate.source_tree||!source)fail(409,'integration_snapshot_unavailable');
 const records=new TaskRecords(s),latest=s.get('SELECT * FROM tasks WHERE id=?',task.id)!;
 const input=JSON.parse(latest.input||'{}');
 if(input.integration?.state==='pending'&&input.integration.target_base===base)return;
 if(!['pr_opened','completed','needs_replan'].includes(latest.status))fail(409,'integration_task_running');
 const integration={id:randomId(),state:'pending',reason,target_base:base,source_workspace_id:source,sha:candidate.local_sha,tree_sha:candidate.tree_sha,base_tree:candidate.source_tree,previous_base:candidate.base_sha,previous_candidate:records.get(task.id).candidate?.id,previous_head:pr?.head?.sha??null,revision:records.get(task.id).revision,requested_at:new Date().toISOString()};
 records.atomic(()=>{
  const current=s.get('SELECT status,claim_token FROM tasks WHERE id=?',task.id)!;
  if(['cancelled','superseded'].includes(current.status))fail(409,'integration_task_cancelled');
  s.run("UPDATE tasks SET input=?,status='queued',phase='prepare',workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,model_started=0,publication_started=0,error_code=NULL,next_run_at=?,attempt=attempt+1,claim_token=NULL WHERE id=?",JSON.stringify({...input,integration,recovery:undefined,...(pr?{bot_pr:pr}:{})}),Date.now()+1000,task.id);
  s.run("UPDATE task_merge_requests SET state='integrating',next_run_at=?,updated_at=? WHERE task_id=?",Date.now()+5000,new Date().toISOString(),task.id);
  traceEvent(s,task.id,'integration_requested',integration,null,'framework');
 });
}
/** Carry explicit merge intent only through the framework's same-contract integration chain. */
export function integratedPublication(s:Store,task:Row,head:string){
 const input=JSON.parse(task.input||'{}'),request=s.get('SELECT * FROM task_merge_requests WHERE task_id=?',task.id);
 if(!request||request.state!=='integrating')return;
 if(request.revision!==new TaskRecords(s).get(task.id).revision||request.expected_sha!==input.integration?.previous_head)fail(409,'merge_authorization_changed');
 s.run("UPDATE task_merge_requests SET expected_sha=?,state='waiting',next_run_at=0,error=NULL,updated_at=? WHERE task_id=?",head,new Date().toISOString(),task.id);
 traceEvent(s,task.id,'merge_candidate_revalidated',{previous_head:request.expected_sha,head_sha:head,integration_id:input.integration.id,revision:request.revision},task.trace_run_id,'framework');
}
