import { operationResult } from '../storage/payloads.js';
import type {Store,Row} from '../storage/database.js';
import {TaskRecords} from '../tasks/service.js';
/** Upgrade recovery for a role run stopped before its first explicit checkpoint.
 * Only reconcile a snapshot already acknowledged by this task's own runner. */
export function recoverRoleCheckpoint(s:Store,task:Row,base:string){
 const input=JSON.parse(s.get('SELECT input FROM tasks WHERE id=?',task.id)!.input);if(input.recovery)return;
 const run=s.get("SELECT context_snapshot,revision FROM task_runs WHERE task_id=? AND role='dev' ORDER BY rowid DESC LIMIT 1",task.id);if(!run)return;
 const context=JSON.parse(run.context_snapshot),records=new TaskRecords(s);
 if(!context.complete||context.data?.source_sha!==base||run.revision!==records.get(task.id).revision)return;
 const stopped=s.get("SELECT content FROM task_logs WHERE task_id=? AND json_valid(content) AND json_extract(content,'$.type')='restart_attempt' ORDER BY rowid DESC LIMIT 1",task.id);if(!stopped)return;
 const workspace=JSON.parse(stopped.content).preserved_workspace;if(!workspace||workspace===task.workspace_id)return;
 const receipt=s.get("SELECT id,result,result_ref FROM task_tools WHERE task_id=? AND state='completed' AND json_extract(request,'$.request.type')='workspace_finalize' AND json_extract(request,'$.request.workspace_id')=? ORDER BY rowid DESC LIMIT 1",task.id,workspace);if(!receipt)return;
 let snapshot:any;try{snapshot=operationResult(s,'task_tools',receipt);}catch{return;}if(!/^[a-f0-9]{40}$/.test(snapshot.local_sha||'')||!/^[a-f0-9]{40}$/.test(snapshot.tree_sha||''))return;
 const recovery={source_workspace_id:workspace,base_sha:base,revision:run.revision,sha:snapshot.local_sha,tree_sha:snapshot.tree_sha,created_at:new Date().toISOString(),reconciled_from:'task_tools:'+receipt.id};
 records.atomic(()=>{s.run('UPDATE tasks SET input=? WHERE id=?',JSON.stringify({...input,recovery}),task.id);records.history(task.id,'artifact_checkpoint',recovery);});
}
