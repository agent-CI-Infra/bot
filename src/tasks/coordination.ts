import type {Store,Row} from '../storage/database.js';
import {fail,type Json} from '../core/security.js';
import {scope,type Actor} from '../app/auth.js';
import {traceEvent} from './trace.js';
import {TaskRecords} from './service.js';

/**
 * Keeps historical coordination tables readable across upgrades while retiring the advisory Task Coordinator flow (#1218).
 * Active cross-task primitives retained for Manager: `list_project_tasks`, `read_project_task`, and `wait_for_tasks`.
 */
export function coordinationStorage(s:Store){s.db.exec(`
 CREATE TABLE IF NOT EXISTS task_coordinations(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,request_key TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',
 result TEXT,claim_token TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_run_at INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(source_task_id,request_key));
 CREATE INDEX IF NOT EXISTS coordination_due ON task_coordinations(state,next_run_at);
 CREATE TABLE IF NOT EXISTS coordination_notices(id INTEGER PRIMARY KEY AUTOINCREMENT,coordination_id TEXT NOT NULL REFERENCES task_coordinations(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,message TEXT NOT NULL,action TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',reason TEXT,
 task_revision INTEGER NOT NULL,candidate_id TEXT,updated_at TEXT NOT NULL,UNIQUE(coordination_id,task_id));
`);}

const text=(v:any,max=8000)=>typeof v==='string'&&!!v.trim()&&v.length<=max;

/** Only declared task dependencies are checked; no project inactivity polling. */
export function coordinationDependencies(s:Store,id:string){
 const input=JSON.parse(s.get('SELECT input FROM tasks WHERE id=?',id)?.input||'{}');
 return (input.coordination_wait_for??[]).map((d:any)=>{
  const t=s.get('SELECT status FROM tasks WHERE id=?',d.task_id);
  const accepted=!!s.get("SELECT task_id FROM task_records WHERE task_id=? AND json_extract(acceptance,'$.outcome') IN ('pass','pass_with_issues') AND json_extract(acceptance,'$.candidate_id')=json_extract(candidate,'$.id') AND json_extract(acceptance,'$.revision')=revision",d.task_id);
  const merged=!!s.get("SELECT task_id FROM task_merge_requests WHERE task_id=? AND state='merged'",d.task_id)||!!s.get("SELECT id FROM task_history WHERE task_id=? AND type='repository_evolved'",d.task_id);
  return {...d,status:t?.status??'missing',ready:d.condition==='merged'?merged:accepted&&['completed','succeeded','pr_opened'].includes(t?.status),blocked:!t||['failed','cancelled','superseded','needs_replan','needs_help'].includes(t.status)};
 });
}

export function waitForCoordinatedTasks(s:Store,task:Row,a:any){
 if(!a||!Array.isArray(a.task_ids)||!a.task_ids.length||a.task_ids.length>20||!['delivered','merged'].includes(a.condition)||!text(a.reason))return {error:'invalid_coordination_dependency'};
 for(const id of a.task_ids)if(typeof id!=='string'||id===task.id||!s.get('SELECT id FROM tasks WHERE id=? AND repository_id=?',id,task.repository_id))return {error:'coordination_task_out_of_scope'};
 const seen=new Set<string>(),walk=(id:string):boolean=>{if(id===task.id)return true;if(seen.has(id))return false;seen.add(id);const input=JSON.parse(s.get('SELECT input FROM tasks WHERE id=?',id)?.input||'{}');return (input.coordination_wait_for??[]).some((d:any)=>walk(d.task_id));};
 if(a.task_ids.some(walk))return {error:'coordination_dependency_cycle'};
 const input=JSON.parse(s.get('SELECT input FROM tasks WHERE id=?',task.id)!.input||'{}');
 new TaskRecords(s).atomic(()=>{
  s.run('UPDATE tasks SET input=? WHERE id=?',JSON.stringify({...input,coordination_wait_for:[...new Set(a.task_ids)].map(task_id=>({task_id,condition:a.condition}))}),task.id);
  traceEvent(s,task.id,'coordination_dependency',{task_ids:a.task_ids,condition:a.condition,reason:a.reason},task.trace_run_id,'role:manager');
 });
 return {waiting:coordinationDependencies(s,task.id).some((d:any)=>!d.ready)};
}

/** Read-only view of declared task dependencies plus any historical coordination rows retained from earlier versions. */
export function coordinationContext(s:Store,id:string){
 return {
  waiting_dependencies:coordinationDependencies(s,id),
  requests:s.all('SELECT id,request,state,result,error,attempts,updated_at FROM task_coordinations WHERE source_task_id=? ORDER BY created_at',id).map(r=>({...r,request:JSON.parse(r.request),result:r.result?JSON.parse(r.result):null})),
  notices:s.all('SELECT * FROM coordination_notices WHERE task_id=? ORDER BY id',id)
 };
}

const tool=(name:string,description:string,properties:any,required:string[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});

export const coordinationTools=[
 tool('wait_for_tasks','Persist a concrete dependency wait and release this execution slot. Other tasks keep running. Only same-project tasks; cycles rejected.',{task_ids:{type:'array',items:{type:'string'}},condition:{type:'string',enum:['delivered','merged']},reason:{type:'string'}},['task_ids','condition','reason']),
 tool('list_project_tasks','List same-project task IDs, summaries, statuses and revisions; read-only.',{},[]),
 tool('read_project_task','Inspect same-project tasks read-only. Omit task_id to page same-project tasks (10/page). Pass task_id to read a compact task summary and paginated event index, or pass ref (contract:revision:<n> or task_history:<id>) to read exact records in 8000-character pages.',{task_id:{type:'string'},offset:{type:'integer'},ref:{type:'string'},type:{type:'string'}},[])
];

/** Small authoritative index; large evidence is disclosed only by scoped, bounded reads. */
export function coordinationTaskSummary(s:Store,id:string){
 const r=new TaskRecords(s).get(id),t=s.get('SELECT status,phase,summary FROM tasks WHERE id=?',id)!;
 const short=(v:any,n=1200)=>typeof v==='string'&&v.length>n?{excerpt:v.slice(0,n),truncated:true}:v;
 return {
  id,status:t.status,phase:t.phase,summary:short(t.summary,300),revision:r.revision,contract_ref:'contract:revision:'+r.revision,
  goal:short(r.contract?.goal),criteria:r.contract?.criteria?.slice(0,6).map((v:any)=>short(v,300)),criteria_count:r.contract?.criteria?.length,
  constraints:r.contract?.constraints?.slice(0,5).map((v:any)=>short(v,300)),scope:r.contract?.scope?.slice(0,10),
  instruction:'Index excerpts only; read contract_ref for complete criteria, constraints and scope before deciding.',
  candidate:r.candidate?{id:r.candidate.id,revision:r.candidate.revision,artifacts:r.candidate.artifacts.slice(0,5).map(a=>({kind:a.kind,reference:short(a.reference,300),version:a.version}))}:null,
  acceptance:r.acceptance?{outcome:r.acceptance.outcome,reason:short(r.acceptance.reason)}:null,
  recent_events:s.all('SELECT id,type,created_at FROM task_history WHERE task_id=? ORDER BY id DESC LIMIT 6',id).map(r=>({...r,ref:'task_history:'+r.id})),
 };
}

export function readCoordinationEvidence(s:Store,ids:string[],a:any){
 if(!ids.includes(a?.task_id))return {error:'coordination_task_out_of_scope'};
 const offset=Number.isSafeInteger(a.offset)&&a.offset>=0?a.offset:0;
 if(a.ref){
  const contract=/^contract:revision:(\d+)$/.exec(a.ref);
  if(contract){
   const r=new TaskRecords(s).get(a.task_id);
   if(r.revision!==Number(contract[1]))return {error:'coordination_contract_revision_changed',current_revision:r.revision};
   const data=JSON.stringify(r.contract);
   return {ref:a.ref,content:data.slice(offset,offset+8000),offset,next_offset:offset+8000<data.length?offset+8000:null,total_chars:data.length};
  }
  const match=/^task_history:(\d+)$/.exec(a.ref);
  const row=match?s.get('SELECT id,type,data FROM task_history WHERE id=? AND task_id=?',Number(match[1]),a.task_id):null;
  if(!row)return {error:'coordination_evidence_not_found'};
  return {ref:a.ref,type:row.type,content:row.data.slice(offset,offset+8000),offset,next_offset:offset+8000<row.data.length?offset+8000:null,total_chars:row.data.length};
 }
 const rows=s.all('SELECT id,type,created_at FROM task_history WHERE task_id=? AND (? IS NULL OR type=?) ORDER BY id DESC LIMIT 11 OFFSET ?',a.task_id,a.type??null,a.type??null,offset);
 return {task:coordinationTaskSummary(s,a.task_id),events:rows.slice(0,10).map(r=>({...r,ref:'task_history:'+r.id})),next_offset:rows.length>10?offset+10:null};
}

/** Same-project read-only task query exposed to Manager as `read_project_task`. */
export function readProjectTask(s:Store,repositoryId:string,a:any){
 if(!a?.task_id){
  const offset=Number.isSafeInteger(a?.offset)&&a.offset>=0?a.offset:0;
  const rows=s.all(`SELECT t.id,t.summary,t.status,t.object_number,substr(json_extract(r.contract,'$.goal'),1,500) AS goal FROM tasks t LEFT JOIN task_records r ON r.task_id=t.id WHERE t.repository_id=? ORDER BY t.created_at DESC,t.id LIMIT 11 OFFSET ?`,repositoryId,offset);
  return {tasks:rows.slice(0,10),next_offset:rows.length>10?offset+10:null};
 }
 if(typeof a.task_id!=='string'||!s.get('SELECT id FROM tasks WHERE id=? AND repository_id=?',a.task_id,repositoryId))return {error:'coordination_task_out_of_scope'};
 return readCoordinationEvidence(s,[a.task_id],a);
}

/** Wakes tasks waiting on declared `wait_for_tasks` dependencies once ready or blocked, and unblocks any pre-#1218 advisory waits. */
export function resumeCoordinatedTasks(s:Store,active:(id:string)=>boolean){
 for(const t of s.all("SELECT * FROM tasks WHERE status='waiting_coordination'")){
  if(active(t.id)||t.error_code==='task_children_pending')continue;
  const dependencies=coordinationDependencies(s,t.id);
  if(dependencies.length){
   if(dependencies.some((d:any)=>!d.ready)&&!dependencies.some((d:any)=>d.blocked))continue;
   const input=JSON.parse(t.input||'{}');
   s.run('UPDATE tasks SET input=? WHERE id=?',JSON.stringify({...input,coordination_wait_for:[],coordination_dependency_result:dependencies}),t.id);
   s.run("UPDATE tasks SET status='queued',phase='model',error_code=NULL,next_run_at=0,attempt=attempt+1,updated_at=? WHERE id=?",new Date().toISOString(),t.id);
   traceEvent(s,t.id,'coordination_resumed',{reason:'Declared task dependencies resolved; resuming task under Manager'},null,'framework');
   continue;
  }
  // Pre-#1218 task left waiting on retired Task Coordinator advice: wake cleanly so upgrades never strand active work.
  const input=JSON.parse(t.input||'{}');
  if('coordination_update' in input){delete input.coordination_update;s.run('UPDATE tasks SET input=? WHERE id=?',JSON.stringify(input),t.id);}
  s.run("UPDATE tasks SET status='queued',phase='model',error_code=NULL,next_run_at=0,attempt=attempt+1,updated_at=? WHERE id=?",new Date().toISOString(),t.id);
  traceEvent(s,t.id,'coordination_resumed',{reason:'Task Coordinator retired; resuming task under Manager'},null,'framework');
 }
}

export function coordinationApi(s:Store,user:Actor,method:string,url:URL,_input:Json):Json|undefined{
 const match=/^\/api\/tasks\/([^/]+)\/coordination(?:\/([^/]+)\/retry)?$/.exec(url.pathname);if(!match)return;
 const filter=scope(user,'repository_id'),t=s.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args);if(!t)fail(404,'task_not_found');
 if(method==='GET'&&!match[2])return coordinationContext(s,t!.id);
 if(method==='POST'&&match[2])fail(410,'coordination_retired');
 return;
}
