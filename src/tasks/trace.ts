import { redactCredentials } from '../core/redaction.js';
import {childTaskContext} from './children.js';
import { ProjectMemory } from '../memory/project.js';
import { taskControllerReads, canReadMemory, memoryAuthorize, visibleMemorySnapshot, type MemoryAccess } from '../memory/access.js';
import {executionBaseline} from '../agent/common.js';
import type { Store, Row } from '../storage/database.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { randomId, fail } from '../core/security.js';
import { historyData, historyRefBytes, modelSnapshot, unreadable } from '../storage/payloads.js';

const botVersion=(()=>{try{return process.env.BOT_VERSION||execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return 'unknown';}})();
const now=()=>new Date().toISOString();
function atomic<T>(store:Store,fn:()=>T):T{const name='trace_'+randomId();store.db.exec('SAVEPOINT '+name);try{const result=fn();store.db.exec('RELEASE '+name);return result;}catch(error){store.db.exec('ROLLBACK TO '+name);store.db.exec('RELEASE '+name);throw error;}}
export function traceClean(value:any,literal=false):any {
  if(typeof value==='string'){if(!literal&&/^[\[{]/.test(value)){try{const parsed=JSON.parse(value),clean=traceClean(parsed);return JSON.stringify(clean)===JSON.stringify(parsed)?redactCredentials(value):JSON.stringify(clean);}catch{}}return redactCredentials(value);}
  if(Array.isArray(value))return value.map(v=>traceClean(v,literal));
  if(value&&typeof value==='object')return redactCredentials(Object.fromEntries(Object.entries(value).filter(([k])=>!/^(api_?key|authorization|credentials|claim_token|password|private_key|reasoning.*|thinking.*|base64)$/i.test(k)&&!(k.toLowerCase()==='analysis'&&value.role==='assistant')).map(([k,v])=>[k,traceClean(v,literal||(k==='content'&&value.encoding==='utf8'))])));
  return value;
}
export function retainedTextArtifact(path:string,version:string,data:Buffer,expectedBytes:number,redact:(text:string)=>string){
  const original=data.toString('utf8'),content=traceClean({encoding:'utf8',content:redact(original)}).content;
  const read_complete=data.length===expectedBytes,binary=!Buffer.from(original).equals(data),sanitized=content!==original;
  // codeql[js/weak-cryptographic-algorithm] Git object id must be SHA-1; not used for passwords, signatures or tokens.
  const blob=(bytes:Buffer)=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const captured=Buffer.from(content),matches=blob(data)===version,complete=read_complete&&!binary&&!sanitized&&matches;
  return {path,version,encoding:'utf8',content,read_complete,complete,binary,sanitized,captured_blob_sha:blob(captured),content_sha256:createHash('sha256').update(captured).digest('hex'),missing_reason:!read_complete?'blob_unavailable':binary?'binary_utf8_conversion':sanitized?'sanitized_representation':!matches?'blob_hash_mismatch':null};
}
export function traceSnapshot(value:any){
  const clean=traceClean(value),text=JSON.stringify(clean??null),bytes=Buffer.byteLength(text),digest=createHash('sha256').update(text).digest('hex');
  // Text limits refer to raw UTF-8 content, not its JSON escaping. Valid JSON can expand sixfold.
  const artifact=clean?.encoding==='utf8'&&typeof clean.content==='string'&&typeof clean.content_sha256==='string';
  if(artifact){const contentBytes=Buffer.byteLength(clean.content),within=contentBytes<=2*1024*1024&&bytes<=16*1024*1024;
    if(within)return JSON.stringify({schema_version:1,sha256:digest,original_bytes:bytes,content_bytes:contentBytes,complete:true,data:clean});
    const {content,...metadata}=clean;
    return JSON.stringify({schema_version:1,sha256:digest,original_bytes:bytes,content_bytes:contentBytes,complete:false,missing_reason:'capture_limit_exceeded',data:{...metadata,complete:false,body_omitted:true,content_preview:content.slice(0,32000),missing_reason:'capture_limit_exceeded'}});
  }
  return JSON.stringify({schema_version:1,sha256:digest,original_bytes:bytes,complete:bytes<=2*1024*1024,
    ...(bytes<=2*1024*1024?{data:clean}:{preview:text.slice(0,64000),missing_reason:'capture_limit_exceeded'})});
}
export function traceStorage(store:Store){
  store.db.function('trace_snapshot',(raw:any)=>{try{return traceSnapshot(JSON.parse(String(raw)));}catch{return traceSnapshot(String(raw));}});
  store.db.exec(`CREATE TABLE IF NOT EXISTS task_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,attempt INTEGER NOT NULL,revision INTEGER NOT NULL,candidate_id TEXT,parent_run_id TEXT,previous_run_id TEXT,
    started_at TEXT NOT NULL,ended_at TEXT,status TEXT NOT NULL,stop_reason TEXT,context_snapshot TEXT NOT NULL,config_snapshot TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_run_task ON task_runs(task_id,started_at,id);`);
  for(const [table,columns] of Object.entries({task_history:{run_id:'TEXT',actor:"TEXT NOT NULL DEFAULT 'legacy_unknown'",source_ref:'TEXT',caused_by:"TEXT NOT NULL DEFAULT '[]'",schema_version:'INTEGER NOT NULL DEFAULT 1'},model_requests:{run_id:'TEXT',request_snapshot:'TEXT',response_snapshot:'TEXT'}})){
    const existing=new Set(store.all(`PRAGMA table_info(${table})`).map(r=>r.name));
    for(const [name,type] of Object.entries(columns))if(!existing.has(name))store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  // Role runs read their own receipts and checkpoints by run (tool_observation, tool_started, role_run_checkpoint,
  // memory_read), and a role's usage (budget checks, the usage recorded when a run ends) counts its runs' history and
  // model requests. task_history_run starts with task_id, so those reads scanned the whole table (0.8 s each in
  // production, about 4 s for one run's usage).
  store.db.exec(`CREATE INDEX IF NOT EXISTS task_history_run_type ON task_history(run_id,type,id);
    CREATE INDEX IF NOT EXISTS model_request_run ON model_requests(run_id);`);
  store.db.exec(`CREATE INDEX IF NOT EXISTS task_history_run ON task_history(task_id,run_id,id);
    DROP TRIGGER IF EXISTS trace_history_scope;
    CREATE TRIGGER trace_history_scope AFTER INSERT ON task_history BEGIN
      UPDATE task_history SET run_id=CASE WHEN NEW.type IN ('acceptance','acceptance_staged') THEN NEW.run_id ELSE coalesce(NEW.run_id,(SELECT id FROM task_runs WHERE task_id=NEW.task_id AND (status='running' OR kind=CASE WHEN NEW.type IN ('candidate','artifact_checkpoint','checkpoint') THEN 'execution' WHEN NEW.type LIKE 'acceptance%' THEN 'verification' ELSE 'none' END) ORDER BY rowid DESC LIMIT 1)) END,actor=CASE WHEN NEW.actor NOT IN ('framework','legacy_unknown') THEN NEW.actor WHEN NEW.type='execution_evidence' THEN 'executor' WHEN NEW.type LIKE 'acceptance%' THEN 'verifier' ELSE 'framework' END,source_ref=coalesce(NEW.source_ref,'task_history:'||NEW.id) WHERE id=NEW.id;
      UPDATE task_runs SET candidate_id=json_extract(NEW.data,'$.id') WHERE id=(SELECT run_id FROM task_history WHERE id=NEW.id) AND NEW.type='candidate';
    END;`);
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS trace_audit_task AFTER INSERT ON audit WHEN EXISTS(SELECT 1 FROM tasks WHERE id=NEW.resource_id) BEGIN
    INSERT INTO task_history(task_id,type,data,created_at,actor,source_ref) VALUES(NEW.resource_id,'intervention',json_object('action',NEW.action,'resource_id',NEW.resource_id),NEW.created_at,'user:'||NEW.user_id,'audit:'||NEW.id);
  END;`);
  const capture=(table:string,kind:string,body:string,when='')=>{
    for(const action of ['INSERT','UPDATE'])store.db.exec(`CREATE TRIGGER IF NOT EXISTS trace_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} ${when} BEGIN
      INSERT INTO task_history(task_id,type,data,created_at,source_ref) VALUES(NEW.task_id,'${kind}',trace_snapshot(${body}),strftime('%Y-%m-%dT%H:%M:%fZ','now'),'${table}:'||NEW.id);
    END;`);
  };
  // An operation recorded since #436 keeps its request and result in the run's trajectory file: the row and so this
  // snapshot hold only their small fields and refs, which traceSource expands. The update trigger fires on state
  // changes only, so moving an old row's payload to a file adds no history.
  store.db.exec('DROP TRIGGER IF EXISTS trace_task_tools_insert;DROP TRIGGER IF EXISTS trace_task_tools_update;');
  const operation="trace_snapshot(CASE WHEN NEW.request_ref IS NULL THEN json_object('operation_id',NEW.id,'state',NEW.state,'request',NEW.request,'result',NEW.result) "+
    "ELSE json_object('operation_id',NEW.id,'state',NEW.state,'request',NEW.request,'result',NEW.result,'request_ref',NEW.request_ref,'result_ref',NEW.result_ref) END)";
  for(const [name,event] of [['insert','INSERT'],['update','UPDATE OF state']])store.db.exec(`CREATE TRIGGER trace_task_tools_${name} AFTER ${event} ON task_tools BEGIN
      INSERT INTO task_history(task_id,type,data,created_at,source_ref) VALUES(NEW.task_id,'operation',${operation},strftime('%Y-%m-%dT%H:%M:%fZ','now'),'task_tools:'||NEW.id);
    END;`);
  capture('github_effects','publication',"json_object('operation_id',NEW.id,'kind',NEW.kind,'state',NEW.state,'request',NEW.request,'response',NEW.response)");
  // Low-volume lifecycle logs become part of the same query; existing detailed logs stay referenced.
  // A large log's body is in its run's trajectory file (content_ref); the snapshot keeps the header and the ref.
  store.db.exec(`DROP TRIGGER IF EXISTS trace_task_log;
  CREATE TRIGGER trace_task_log AFTER INSERT ON task_logs WHEN json_valid(NEW.content) BEGIN
    INSERT INTO task_history(task_id,type,data,created_at,source_ref) VALUES(NEW.task_id,'runtime_log',trace_snapshot(CASE WHEN NEW.content_ref IS NULL THEN NEW.content ELSE json_set(NEW.content,'$.content_ref',NEW.content_ref) END),coalesce(nullif(NEW.created_at,''),strftime('%Y-%m-%dT%H:%M:%fZ','now')),'task_logs:'||NEW.id);
  END;
  CREATE TRIGGER IF NOT EXISTS trace_model_finish AFTER UPDATE OF finished_at ON model_requests WHEN NEW.task_id IS NOT NULL AND OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL BEGIN
    INSERT INTO task_history(task_id,type,data,created_at,run_id,source_ref) VALUES(NEW.task_id,'model_request',json_object('request_id',NEW.id,'state',NEW.state,'http_status',NEW.http_status,'request_source','model_requests:'||NEW.id||':request','response_source','model_requests:'||NEW.id||':response'),NEW.finished_at,NEW.run_id,'model_requests:'||NEW.id);
  END;`);
}
export function traceEvent(store:Store,taskId:string,type:string,data:any,runId?:string|null,actor='framework',causedBy:string[]=[]){
  if (!store.get('SELECT 1 FROM tasks WHERE id=?',taskId) && store.hasTable('role_conversation_turns') && store.get('SELECT 1 FROM role_conversation_turns WHERE id=?',taskId)) {
    if(store.get('SELECT state FROM role_conversation_turns WHERE id=?',taskId)?.state!=='running')return 'conversation_event:unavailable';
    store.run('INSERT INTO role_conversation_events(turn_id,type,payload,created_at) VALUES(?,?,?,?)',taskId,type,
      store.secrets.seal({data:traceClean(data),actor,caused_by:causedBy},'conversation-event:'+taskId+':'+type),Date.now());
    return 'conversation_event:'+store.get('SELECT last_insert_rowid() id')!.id;
  }
  const r=store.run('INSERT INTO task_history(task_id,type,data,created_at,run_id,actor,caused_by) VALUES(?,?,?,?,?,?,?)',taskId,type,JSON.stringify(traceClean(data)),now(),runId??null,actor,JSON.stringify(causedBy));return 'task_history:'+r.lastInsertRowid;
}
export function beginRun(store:Store,task:Row,kind:string,config:any){return atomic(store,()=>{
  if(!task.id||!store.get('SELECT 1 FROM tasks WHERE id=?',task.id))return null;
  const t=store.get('SELECT * FROM tasks WHERE id=?',task.id)!,r=store.get('SELECT * FROM task_records WHERE task_id=?',task.id)!;
  const candidate=JSON.parse(r.candidate||'null'),project=store.get('SELECT * FROM project_context WHERE repository_id=?',t.repository_id);
  const previous=store.get('SELECT id FROM task_runs WHERE task_id=? AND kind=? ORDER BY rowid DESC LIMIT 1',task.id,kind);
  const run={id:randomId(),task_id:task.id,kind,attempt:t.attempt,revision:r.revision,candidate_id:candidate?.id??null};
  store.run('INSERT INTO task_runs(id,task_id,kind,attempt,revision,candidate_id,parent_run_id,previous_run_id,started_at,ended_at,status,stop_reason,context_snapshot,config_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?,?)',run.id,task.id,kind,t.attempt,r.revision,candidate?.id??null,task.trace_run_id??null,previous?.id??null,now(),null,'running',null,
    traceSnapshot({context_files:task.trace_context??{},input_candidate:candidate,contract:JSON.parse(r.contract),input:JSON.parse(t.input||'{}'),project:project?{...project,facts:JSON.parse(project.facts)}:null,source_sha:executionBaseline(t),object_head_sha:t.head_sha,workspace_id:t.workspace_id,recovery:JSON.parse(t.input||'{}').recovery??null}),traceSnapshot({...config,execution_revision:store.get('SELECT revision FROM task_execution_configs WHERE task_id=?',task.id)?.revision??null,bot_version:botVersion,node_version:process.version,platform:process.platform,environment:store.get('SELECT generation,state,revision FROM project_environments WHERE repository_id=?',t.repository_id)??null}));
  traceEvent(store,task.id,'run_started',{...run,parent_run_id:task.trace_run_id??null,previous_run_id:previous?.id??null},run.id);return run;
});}
export function endRun(store:Store,run:Row|null,status:string,reason?:string){if(!run)return;return atomic(store,()=>{
  const result=store.run("UPDATE task_runs SET ended_at=?,status=?,stop_reason=? WHERE id=? AND status='running'",now(),status,reason??null,run.id);
  if(result.changes)traceEvent(store,run.task_id,'run_ended',{run_id:run.id,status,reason:reason??null},run.id);
  // The run's trajectory file gets its record count, size and last hash with the same commit.
  store.trajectories.close('run:'+run.id);
});}
export function interruptRuns(store:Store){for(const r of store.all("SELECT * FROM task_runs WHERE status='running'")){endRun(store,r,'interrupted','engine_restart');store.run("UPDATE model_requests SET finished_at=?,state='interrupted' WHERE run_id=? AND finished_at IS NULL",now(),r.id);}if(store.hasTable('role_assignments'))store.run("UPDATE role_assignments SET status='interrupted' WHERE status='running' AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.assignment_id=role_assignments.id AND r.status='running')");}
export function traceSource(store:Store,taskId:string,source:string,access?:MemoryAccess):any{
  const repo=store.get('SELECT repository_id FROM tasks WHERE id=?',taskId)?.repository_id;
  const manager=taskControllerReads(store,taskId,access);
  const safe=(value:any)=>manager?traceClean(value):visibleMemorySnapshot(store,repo,value,access);
  const capturedSource=(value:any)=>{
    if(manager)return value?.schema_version===1&&typeof value.sha256==='string'?traceClean(value):JSON.parse(traceSnapshot(value));
    // Filter the full source before capture limits can turn a knowledge receipt into an opaque preview.
    const scoped=safe(value);
    if(value?.schema_version===1&&typeof value.sha256==='string'&&typeof value.complete==='boolean')return traceClean(scoped);
    const original=JSON.parse(traceSnapshot(value));
    if(scoped===value)return original;
    return {...JSON.parse(traceSnapshot(scoped)),sha256:original.sha256,original_bytes:original.original_bytes,complete:false,missing_reason:'knowledge_filtered'};
  };
  const permitRun=(runId:string|undefined)=>{if(manager||!access||!runId)return;const r=store.get('SELECT role FROM task_runs WHERE id=?',runId);if(access.role){if((r?.role||'dev')!==access.role)fail(403,'trace_role_private');}else memoryAuthorize(access,repo,true);};
  if(source==='task:'+taskId){const task=store.get('SELECT id,repository_id,kind,status,phase,attempt,priority,queue_seq,head_sha,source_task_id,updated_at FROM tasks WHERE id=?',taskId),record=store.get('SELECT contract,revision,candidate,acceptance FROM task_records WHERE task_id=?',taskId);if(task&&record)return JSON.parse(traceSnapshot({mutable:true,task,revision:record.revision,contract:JSON.parse(record.contract),candidate_id:JSON.parse(record.candidate||'null')?.id??null,acceptance:JSON.parse(record.acceptance||'null')}));}
  const contract=/^contract:revision:(\d+)$/.exec(source);if(contract){const event=store.get("SELECT data FROM task_history WHERE task_id=? AND type='contract' AND json_extract(data,'$.revision')=? ORDER BY id DESC LIMIT 1",taskId,Number(contract[1]));if(event)return JSON.parse(traceSnapshot(JSON.parse(event.data)));const current=store.get('SELECT contract,revision FROM task_records WHERE task_id=? AND revision=?',taskId,Number(contract[1]));if(current)return JSON.parse(traceSnapshot({revision:current.revision,contract:JSON.parse(current.contract)}));fail(404,'trace_source_not_found');}

  const memory=/^project_memories:([^:]+):(\d+)$/.exec(source);if(memory&&store.hasTable('project_memory_versions')){if(!canReadMemory(store,repo,memory[1]!,Number(memory[2]),access))fail(404,'trace_source_not_found');const row=store.get('SELECT v.data FROM project_memory_versions v JOIN project_memories m ON m.id=v.memory_id JOIN tasks t ON t.repository_id=m.repository_id WHERE t.id=? AND m.id=? AND v.revision=?',taskId,memory[1]!,Number(memory[2]));if(row)return JSON.parse(traceSnapshot(new ProjectMemory(store,access).get(repo,memory[1]!,Number(memory[2]))));fail(404,'trace_source_not_found');}
  const model=/^model_requests:([^:]+):(request|response)$/.exec(source);
  if(model){const row=store.get(`SELECT run_id,${model[2]}_snapshot,${model[2]}_ref FROM model_requests WHERE id=? AND task_id=?`,model[1]!,taskId);permitRun(row?.run_id);
    let snapshot:string|null;try{snapshot=row?modelSnapshot(store,row,model[2] as 'request'|'response'):null;}catch(error){return unreadable(error);}
    return snapshot?safe(JSON.parse(snapshot)):{complete:false,missing_reason:'not_captured_or_unavailable'};}
  const h=/^task_history:(\d+)$/.exec(source);if(h){const row=store.get('SELECT data,run_id,type FROM task_history WHERE id=? AND task_id=?',h[1]!,taskId);if(row){if(!['long_execution_report','long_execution_decision','long_execution_notification_fault','merge_checks','retry_failure','retry_report','retry_decision','retry_resolved','retry_evidence','role_result','role_candidate','role_handoff','execution_evidence','acceptance_evidence','memory_read','memory_search','repository_evolved','publication','merge_requested','merge_version_context','merge_queue','version_reference','version_comparison','integration_result','integration_requested','integration_decision','acceptance_evaluated'].includes(row.type))permitRun(row.run_id);
    try{return capturedSource(JSON.parse(historyData(store,row)));}catch(error){return unreadable(error);}}}
  // A role run snapshot of this task's project: what a run was configured with, by its content hash.
  const role=/^role_snapshots:([a-f0-9]{64})$/.exec(source);if(role&&store.hasTable('role_snapshots')){const row=store.get('SELECT s.snapshot FROM role_snapshots s JOIN tasks t ON t.repository_id=s.repository_id WHERE t.id=? AND s.id=?',taskId,role[1]!);if(row)return safe(JSON.parse(row.snapshot));}
  const run=/^task_runs:([^:]+):(context|config)$/.exec(source);if(run){permitRun(run[1]);const row=store.get(`SELECT ${run[2]}_snapshot AS snapshot FROM task_runs WHERE id=? AND task_id=?`,run[1]!,taskId);if(row)return safe(JSON.parse(row.snapshot));}
  const entity=/^(task_tools|task_logs|github_effects):/.test(source);if(entity){const row=store.get('SELECT id,data,run_id,type FROM task_history WHERE task_id=? AND source_ref=? ORDER BY id DESC LIMIT 1',taskId,source);if(row){permitRun(row.run_id);
    let data:string;try{data=historyData(store,row);}catch(error){return {...unreadable(error),source_event_id:'task_history:'+row.id};}
    return {...capturedSource(JSON.parse(data)),source_event_id:'task_history:'+row.id};}}
  fail(404,'trace_source_not_found');
}
export function taskTrace(store:Store,taskId:string,url:URL,section:string,access?:MemoryAccess){
  const sourceView=(ref:string)=>{try{return traceSource(store,taskId,ref,access);}catch(error){if(['trace_role_private','capability_forbidden'].includes((error as any).code))return {complete:false,missing_reason:'role_private'};throw error;}};
  if(section==='runs'){
    const after=Number(url.searchParams.get('after')??0),limit=Number(url.searchParams.get('limit')??20);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail(400,'invalid_pagination');
    const rows=store.all('SELECT rowid AS sequence,* FROM task_runs WHERE task_id=? AND rowid>? ORDER BY rowid LIMIT ?',taskId,after,limit+1),more=rows.length>limit;rows.splice(limit);
    return {runs:rows.map(r=>{const {context_snapshot,config_snapshot,...metadata}=r;return {...metadata,context_source:'task_runs:'+r.id+':context',config_source:'task_runs:'+r.id+':config',...(url.searchParams.get('include_snapshots')==='1'?{context_snapshot:sourceView('task_runs:'+r.id+':context'),config_snapshot:sourceView('task_runs:'+r.id+':config')}:{})};}),next_after:more?rows.at(-1)!.sequence:null,coverage:{legacy_runs_not_reconstructed:true}};
  }
  if(section==='source')return {source:traceSource(store,taskId,url.searchParams.get('ref')||'',access)};
  if(section==='lineage'){const links=(where:string)=>store.all('SELECT * FROM task_followups WHERE '+where,taskId).map(r=>({...r,acceptance_event_id:store.get("SELECT id FROM task_history WHERE task_id=? AND type='acceptance' AND json_extract(data,'$.candidate_id')=? AND EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.followups')) WHERE value=?) ORDER BY id LIMIT 1",r.parent_id,r.candidate_id,r.task_id)?.id??null}));return {decomposition:childTaskContext(store,taskId),parents:links('task_id=?'),children:links('parent_id=?'),acceptances:store.all("SELECT id,data FROM task_history WHERE task_id=? AND type='acceptance' ORDER BY id",taskId).map(r=>({source:'task_history:'+r.id,data:JSON.parse(r.data)}))};}
  const limit=Number(url.searchParams.get('limit')??50),after=Number(url.searchParams.get('after')??0);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(after)||after<0)fail(400,'invalid_pagination');
  let sql='task_id=? AND id>?';const args:any[]=[taskId,after];
  for(const [param,col] of [['run_id','run_id'],['type','type']]){const v=url.searchParams.get(param!);if(v){sql+=` AND ${col}=?`;args.push(v);}}
  for(const field of ['revision','candidate_id']){const value=url.searchParams.get(field);if(value){const filter=field==='revision'?Number(value):value;if(field==='revision'&&(!Number.isSafeInteger(filter)||Number(filter)<1))fail(400,'invalid_task_revision');sql+=` AND (json_extract(data,'$.${field}')=? OR run_id IN(SELECT id FROM task_runs WHERE ${field}=? AND task_id=?)${field==='candidate_id'?" OR (type='candidate' AND json_extract(data,'$.id')=?)":''})`;args.push(filter,filter,taskId,...(field==='candidate_id'?[filter]:[]));}}
  const rows=store.all(`SELECT id,task_id,type,created_at,run_id,actor,source_ref,caused_by,schema_version,length(data) AS body_chars,CASE WHEN length(data)<=8192 THEN data END AS data FROM task_history WHERE ${sql} ORDER BY id LIMIT ?`,...args,limit+1),more=rows.length>limit;rows.splice(limit);
  // A snapshot whose body is in a trajectory file counts the body it stands for: a small one is expanded and shown
  // inline like before, a large one is left to the source view.
  for(const r of rows){const bytes=r.data?historyRefBytes(r):null;if(bytes===null)continue;
    if(bytes>65536){r.body_chars=bytes;r.data=null;continue;}
    try{const expanded=historyData(store,r);r.body_chars=expanded.length;if(expanded.length>8192)r.data=null;}catch{r.data=null;}}
  return {events:rows.map(r=>({...r,event_id:'task_history:'+r.id,data:r.data&&url.searchParams.get('include_data')==='1'?sourceView('task_history:'+r.id).data??{body_omitted:true,missing_reason:'role_private'}:{body_omitted:true,source:'task_history:'+r.id,characters:r.body_chars},caused_by:JSON.parse(r.caused_by)})),next_after:more?rows.at(-1)!.id:null,coverage:{legacy_run_links_may_be_missing:true}};
}
