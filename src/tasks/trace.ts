import type { Store, Row } from '../storage/database.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { randomId, fail } from '../core/security.js';

const botVersion=(()=>{try{return process.env.BOT_VERSION||execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return 'unknown';}})();
const now=()=>new Date().toISOString();
function atomic<T>(store:Store,fn:()=>T):T{const name='trace_'+randomId();store.db.exec('SAVEPOINT '+name);try{const result=fn();store.db.exec('RELEASE '+name);return result;}catch(error){store.db.exec('ROLLBACK TO '+name);store.db.exec('RELEASE '+name);throw error;}}
export function traceClean(value:any,literal=false):any {
  if(typeof value==='string'){if(!literal&&/^[\[{]/.test(value)){try{return JSON.stringify(traceClean(JSON.parse(value)));}catch{}}return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[REDACTED]').replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{15,}|Bearer\s+[\w.\/-]+)/gi,'[REDACTED]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[REDACTED]@');}
  if(Array.isArray(value))return value.map(v=>traceClean(v,literal));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/^(api_?key|authorization|credentials|claim_token|token|password|private_key|reasoning.*|thinking.*|analysis|base64)$/i.test(k)).map(([k,v])=>[k,traceClean(v,literal||(k==='content'&&value.encoding==='utf8'))]));
  return value;
}
export function retainedTextArtifact(path:string,version:string,data:Buffer,expectedBytes:number,redact:(text:string)=>string){
  const original=data.toString('utf8'),content=traceClean({encoding:'utf8',content:redact(original)}).content;
  const read_complete=data.length===expectedBytes,binary=!Buffer.from(original).equals(data),sanitized=content!==original;
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
  capture('task_tools','operation',"json_object('operation_id',NEW.id,'state',NEW.state,'request',NEW.request,'result',NEW.result)");
  capture('github_effects','publication',"json_object('operation_id',NEW.id,'kind',NEW.kind,'state',NEW.state,'request',NEW.request,'response',NEW.response)");
  // Low-volume lifecycle logs become part of the same query; existing detailed logs stay referenced.
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS trace_task_log AFTER INSERT ON task_logs WHEN json_valid(NEW.content) BEGIN
    INSERT INTO task_history(task_id,type,data,created_at,source_ref) VALUES(NEW.task_id,'runtime_log',trace_snapshot(NEW.content),coalesce(nullif(NEW.created_at,''),strftime('%Y-%m-%dT%H:%M:%fZ','now')),'task_logs:'||NEW.id);
  END;
  CREATE TRIGGER IF NOT EXISTS trace_model_finish AFTER UPDATE OF finished_at ON model_requests WHEN NEW.task_id IS NOT NULL AND OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL BEGIN
    INSERT INTO task_history(task_id,type,data,created_at,run_id,source_ref) VALUES(NEW.task_id,'model_request',json_object('request_id',NEW.id,'state',NEW.state,'http_status',NEW.http_status,'request_source','model_requests:'||NEW.id||':request','response_source','model_requests:'||NEW.id||':response'),NEW.finished_at,NEW.run_id,'model_requests:'||NEW.id);
  END;`);
}
export function traceEvent(store:Store,taskId:string,type:string,data:any,runId?:string|null,actor='framework',causedBy:string[]=[]){
  const r=store.run('INSERT INTO task_history(task_id,type,data,created_at,run_id,actor,caused_by) VALUES(?,?,?,?,?,?,?)',taskId,type,JSON.stringify(traceClean(data)),now(),runId??null,actor,JSON.stringify(causedBy));return 'task_history:'+r.lastInsertRowid;
}
export function beginRun(store:Store,task:Row,kind:string,config:any){return atomic(store,()=>{
  if(!task.id||!store.get('SELECT 1 FROM tasks WHERE id=?',task.id))return null;
  const t=store.get('SELECT * FROM tasks WHERE id=?',task.id)!,r=store.get('SELECT * FROM task_records WHERE task_id=?',task.id)!;
  const candidate=JSON.parse(r.candidate||'null'),project=store.get('SELECT * FROM project_context WHERE repository_id=?',t.repository_id);
  const previous=store.get('SELECT id FROM task_runs WHERE task_id=? AND kind=? ORDER BY rowid DESC LIMIT 1',task.id,kind);
  const run={id:randomId(),task_id:task.id,kind,attempt:t.attempt,revision:r.revision,candidate_id:candidate?.id??null};
  store.run('INSERT INTO task_runs(id,task_id,kind,attempt,revision,candidate_id,parent_run_id,previous_run_id,started_at,ended_at,status,stop_reason,context_snapshot,config_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?,?)',run.id,task.id,kind,t.attempt,r.revision,candidate?.id??null,task.trace_run_id??null,previous?.id??null,now(),null,'running',null,
    traceSnapshot({context_files:task.trace_context??{},input_candidate:candidate,contract:JSON.parse(r.contract),input:JSON.parse(t.input||'{}'),project:project?{...project,facts:JSON.parse(project.facts)}:null,source_sha:t.head_sha,workspace_id:t.workspace_id,recovery:JSON.parse(t.input||'{}').recovery??null}),traceSnapshot({...config,bot_version:botVersion,node_version:process.version,platform:process.platform,environment:store.get('SELECT generation,state,revision FROM project_environments WHERE repository_id=?',t.repository_id)??null}));
  traceEvent(store,task.id,'run_started',{...run,parent_run_id:task.trace_run_id??null,previous_run_id:previous?.id??null},run.id);return run;
});}
export function endRun(store:Store,run:Row|null,status:string,reason?:string){if(!run)return;return atomic(store,()=>{
  const result=store.run("UPDATE task_runs SET ended_at=?,status=?,stop_reason=? WHERE id=? AND status='running'",now(),status,reason??null,run.id);
  if(result.changes)traceEvent(store,run.task_id,'run_ended',{run_id:run.id,status,reason:reason??null},run.id);
});}
export function interruptRuns(store:Store){for(const r of store.all("SELECT * FROM task_runs WHERE status='running'")){endRun(store,r,'interrupted','engine_restart');store.run("UPDATE model_requests SET finished_at=?,state='interrupted' WHERE run_id=? AND finished_at IS NULL",now(),r.id);}if(store.hasTable('role_assignments'))store.run("UPDATE role_assignments SET status='interrupted' WHERE status='running' AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.assignment_id=role_assignments.id AND r.status='running')");}
export function traceSource(store:Store,taskId:string,source:string){
  if(source==='task:'+taskId){const task=store.get('SELECT id,repository_id,kind,status,phase,attempt,head_sha,source_task_id,updated_at FROM tasks WHERE id=?',taskId),record=store.get('SELECT contract,revision,candidate,acceptance FROM task_records WHERE task_id=?',taskId);if(task&&record)return JSON.parse(traceSnapshot({mutable:true,task,revision:record.revision,contract:JSON.parse(record.contract),candidate_id:JSON.parse(record.candidate||'null')?.id??null,acceptance:JSON.parse(record.acceptance||'null')}));}
  const contract=/^contract:revision:(\d+)$/.exec(source);if(contract){const event=store.get("SELECT data FROM task_history WHERE task_id=? AND type='contract' AND json_extract(data,'$.revision')=? ORDER BY id DESC LIMIT 1",taskId,Number(contract[1]));if(event)return JSON.parse(traceSnapshot(JSON.parse(event.data)));const current=store.get('SELECT contract,revision FROM task_records WHERE task_id=? AND revision=?',taskId,Number(contract[1]));if(current)return JSON.parse(traceSnapshot({revision:current.revision,contract:JSON.parse(current.contract)}));fail(404,'trace_source_not_found');}

  const memory=/^project_memories:([^:]+):(\d+)$/.exec(source);if(memory&&store.hasTable('project_memory_versions')){const row=store.get('SELECT v.data FROM project_memory_versions v JOIN project_memories m ON m.id=v.memory_id JOIN tasks t ON t.repository_id=m.repository_id WHERE t.id=? AND m.id=? AND v.revision=?',taskId,memory[1]!,Number(memory[2]));if(row)return JSON.parse(traceSnapshot(JSON.parse(row.data)));fail(404,'trace_source_not_found');}
  const model=/^model_requests:([^:]+):(request|response)$/.exec(source);
  if(model){const row=store.get(`SELECT ${model[2]}_snapshot AS snapshot FROM model_requests WHERE id=? AND task_id=?`,model[1]!,taskId);return row?.snapshot?JSON.parse(row.snapshot):{complete:false,missing_reason:'not_captured_or_unavailable'};}
  const h=/^task_history:(\d+)$/.exec(source);if(h){const row=store.get('SELECT data FROM task_history WHERE id=? AND task_id=?',h[1]!,taskId);if(row){const captured=JSON.parse(row.data);return captured?.schema_version===1&&typeof captured.sha256==='string'&&typeof captured.complete==='boolean'?traceClean(captured):JSON.parse(traceSnapshot(captured));}}
  // A role run snapshot of this task's project: what a run was configured with, by its content hash.
  const role=/^role_snapshots:([a-f0-9]{64})$/.exec(source);if(role&&store.hasTable('role_snapshots')){const row=store.get('SELECT s.snapshot FROM role_snapshots s JOIN tasks t ON t.repository_id=s.repository_id WHERE t.id=? AND s.id=?',taskId,role[1]!);if(row)return JSON.parse(row.snapshot);}
  const run=/^task_runs:([^:]+):(context|config)$/.exec(source);if(run){const row=store.get(`SELECT ${run[2]}_snapshot AS snapshot FROM task_runs WHERE id=? AND task_id=?`,run[1]!,taskId);if(row)return JSON.parse(row.snapshot);}
  const entity=/^(task_tools|task_logs|github_effects):/.test(source);if(entity){const row=store.get('SELECT id,data FROM task_history WHERE task_id=? AND source_ref=? ORDER BY id DESC LIMIT 1',taskId,source);if(row)return {...JSON.parse(traceSnapshot(JSON.parse(row.data))),source_event_id:'task_history:'+row.id};}
  fail(404,'trace_source_not_found');
}
export function taskTrace(store:Store,taskId:string,url:URL,section:string){
  if(section==='runs'){
    const after=Number(url.searchParams.get('after')??0),limit=Number(url.searchParams.get('limit')??20);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail(400,'invalid_pagination');
    const rows=store.all('SELECT rowid AS sequence,* FROM task_runs WHERE task_id=? AND rowid>? ORDER BY rowid LIMIT ?',taskId,after,limit+1),more=rows.length>limit;rows.splice(limit);
    return {runs:rows.map(r=>{const {context_snapshot,config_snapshot,...metadata}=r;return {...metadata,context_source:'task_runs:'+r.id+':context',config_source:'task_runs:'+r.id+':config',...(url.searchParams.get('include_snapshots')==='1'?{context_snapshot:JSON.parse(context_snapshot),config_snapshot:JSON.parse(config_snapshot)}:{})};}),next_after:more?rows.at(-1)!.sequence:null,coverage:{legacy_runs_not_reconstructed:true}};
  }
  if(section==='source')return {source:traceSource(store,taskId,url.searchParams.get('ref')||'')};
  if(section==='lineage'){const links=(where:string)=>store.all('SELECT * FROM task_followups WHERE '+where,taskId).map(r=>({...r,acceptance_event_id:store.get("SELECT id FROM task_history WHERE task_id=? AND type='acceptance' AND json_extract(data,'$.candidate_id')=? AND EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.followups')) WHERE value=?) ORDER BY id LIMIT 1",r.parent_id,r.candidate_id,r.task_id)?.id??null}));return {parents:links('task_id=?'),children:links('parent_id=?'),acceptances:store.all("SELECT id,data FROM task_history WHERE task_id=? AND type='acceptance' ORDER BY id",taskId).map(r=>({source:'task_history:'+r.id,data:JSON.parse(r.data)}))};}
  const limit=Number(url.searchParams.get('limit')??50),after=Number(url.searchParams.get('after')??0);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(after)||after<0)fail(400,'invalid_pagination');
  let sql='task_id=? AND id>?';const args:any[]=[taskId,after];
  for(const [param,col] of [['run_id','run_id'],['type','type']]){const v=url.searchParams.get(param!);if(v){sql+=` AND ${col}=?`;args.push(v);}}
  for(const field of ['revision','candidate_id']){const value=url.searchParams.get(field);if(value){const filter=field==='revision'?Number(value):value;if(field==='revision'&&(!Number.isSafeInteger(filter)||Number(filter)<1))fail(400,'invalid_task_revision');sql+=` AND (json_extract(data,'$.${field}')=? OR run_id IN(SELECT id FROM task_runs WHERE ${field}=? AND task_id=?)${field==='candidate_id'?" OR (type='candidate' AND json_extract(data,'$.id')=?)":''})`;args.push(filter,filter,taskId,...(field==='candidate_id'?[filter]:[]));}}
  const rows=store.all(`SELECT id,task_id,type,created_at,run_id,actor,source_ref,caused_by,schema_version,length(data) AS body_chars,CASE WHEN length(data)<=8192 THEN data END AS data FROM task_history WHERE ${sql} ORDER BY id LIMIT ?`,...args,limit+1),more=rows.length>limit;rows.splice(limit);
  return {events:rows.map(r=>({...r,event_id:'task_history:'+r.id,data:r.data&&url.searchParams.get('include_data')==='1'?traceClean(JSON.parse(r.data)):{body_omitted:true,source:'task_history:'+r.id,characters:r.body_chars},caused_by:JSON.parse(r.caused_by)})),next_after:more?rows.at(-1)!.id:null,coverage:{legacy_run_links_may_be_missing:true}};
}
