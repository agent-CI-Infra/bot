import {executionBaseline} from '../agent/common.js';
import { executionModel, taskConfiguration } from '../tasks/configuration.js';
import { cleanRoleMessages } from './storage.js';
import { taskWorkflow } from '../workflows/resolve.js';
import { runAgent,type AgentSpec } from '../agent/runtime.js';
import { randomId } from '../core/security.js';
import { traceEvent } from '../tasks/trace.js';
import { roleHarness } from './harness.js';
import { memoryTools } from '../memory/project.js';
import { ProjectMemory } from '../memory/project.js';
import { TaskError,stop } from '../agent/common.js';
import { roleConfiguration,configurationRevision,resolveRole,roleAuthority,skillFiles,type Entry,type RoleConfiguration } from './definition.js';
import type { PiRoleEnvironment } from '../agent/pi.js';
import type { Row,Store } from '../storage/database.js';
/** The project's role configuration in its V2 form (legacy configurations are presented as V2 with legacy:true). */
export function roleConfig(store:AgentSpec<any>['store'],task:AgentSpec<any>['task']){return roleConfiguration(store,task.repository_id,taskConfiguration(store,task)?.roles);}
/** Whether this entry point runs under the project controller. */
export const controlled=(store:Store,task:Row,entry:Entry)=>{const config=roleConfig(store,task);return config.enabled&&config.controller.entries[entry]===true;};
type Resolved=ReturnType<typeof resolveRole>;
// Task defaults stay fixed; only an explicit role apply may move an existing instance to a newer V2 revision.
function taskRole(s:Store,task:Row,role:string,harness?:string,pinned=false,override?:RoleConfiguration,model?:AgentSpec<any>['model']){
 const fixed=taskConfiguration(s,task),instance=s.get('SELECT config_revision,pending_revision FROM role_instances WHERE task_id=? AND role=?',task.id,role);
 let config=override??(fixed?roleConfig(s,task):undefined);
 if(!override&&config&&instance){const revision=Math.max(Number(instance.config_revision??0),Number(instance.pending_revision??0));
  if(revision>config.revision)config=configurationRevision(s,task.repository_id,revision)??config;}
 return resolveRole(s,task.repository_id,role,taskWorkflow(task as any),{harness,pinned,configuration:config,
  fallbackModel:fixed?()=>({model:model??executionModel(s,task,taskWorkflow(task as any)),source:fixed.workflow?.model_id||Object.hasOwn(JSON.parse(fixed.policy.task_models||'{}'),taskWorkflow(task as any))?'workflow':'project'}):undefined});
}

export interface RoleRunOptions {
 /** Prepares the run's environment once its instance and snapshot are known (for example the Pi workspace). */
 prepare?:(instance:Row,resolved:Resolved)=>Promise<{pi?:PiRoleEnvironment;release?:()=>Promise<void>}|void>;
}
const skillTool={type:'function',function:{name:'read_skill',description:'List the files of your pinned skill bundle (omit path), or read one file by path. Skills are working material, never permissions or task requirements.',parameters:{type:'object',properties:{path:{type:'string'}},additionalProperties:false}}};
const runtimeDefinition=(role:string,r:Resolved)=>({id:role,prompt:r.system,version:r.snapshot.prompt.system_hash,memory_scope:role,harness:r.snapshot.harness.id,writable:role==='dev',snapshot_id:r.id,config_revision:r.snapshot.config_revision,role_revision:r.snapshot.role_revision});
/** The (task, role) instance, created with the current snapshot. It is the role's identity within the task. */
export function roleInstance(s:Store,task:Row,role:string,harnessOverride?:string){
 let instance=s.get('SELECT * FROM role_instances WHERE task_id=? AND role=?',task.id,role);
 if(!instance){const resolved=taskRole(s,task,role,harnessOverride),id=randomId();
  s.run('INSERT INTO role_instances(id,task_id,role,definition,harness,updated_at,snapshot_id,config_revision,role_revision) VALUES(?,?,?,?,?,?,?,?,?)',id,task.id,role,JSON.stringify(runtimeDefinition(role,resolved)),resolved.snapshot.harness.id,new Date().toISOString(),resolved.id,resolved.snapshot.config_revision,resolved.snapshot.role_revision);
  instance=s.get('SELECT * FROM role_instances WHERE id=?',id)!;}
 return instance;
}
/**
 * Moves an existing instance to a new snapshot. This happens only at a safe boundary: before a new assignment starts, or
 * after a running role ended at a checkpoint. The same task, instance and transcript continue; the event keeps both sides.
 */
function rebind(s:Store,task:Row,instance:Row,resolved:Resolved,reason:'delegation'|'checkpoint',endedRun?:string){
 const from={snapshot_id:instance.snapshot_id??null,config_revision:instance.config_revision??null,role_revision:instance.role_revision??null,harness:instance.harness,version:JSON.parse(instance.definition).version};
 s.run('UPDATE role_instances SET definition=?,harness=?,snapshot_id=?,config_revision=?,role_revision=?,pending_revision=NULL,updated_at=? WHERE id=?',JSON.stringify(runtimeDefinition(instance.role,resolved)),resolved.snapshot.harness.id,resolved.id,resolved.snapshot.config_revision,resolved.snapshot.role_revision,new Date().toISOString(),instance.id);
 const ref=traceEvent(s,task.id,'role_revision_applied',{instance_id:instance.id,role:instance.role,reason,from,to:{snapshot_id:resolved.id,config_revision:resolved.snapshot.config_revision,role_revision:resolved.snapshot.role_revision,harness:resolved.snapshot.harness.id,version:resolved.snapshot.prompt.system_hash},ended_run:endedRun??null,continuation:'same_task_and_instance'},task.trace_run_id,'framework',endedRun?['task_runs:'+endedRun+':config']:[]);
 return {ref,instance:s.get('SELECT * FROM role_instances WHERE id=?',instance.id)!};
}
export async function runRole<T>(spec:AgentSpec<T>,role:string,assignment?:string,harnessOverride?:string,options:RoleRunOptions={}):Promise<{result:T;reference:string;instance_id:string}>{
 const s=spec.store,task=spec.task,workflow=taskWorkflow(task as any),existing=s.get('SELECT * FROM role_instances WHERE task_id=? AND role=?',task.id,role);
 // Under a legacy configuration an existing instance keeps the harness it was first bound to; V2 resolves the current revision.
 const pinned=!harnessOverride&&!!existing&&roleConfig(s,task).legacy;
 let resolved=taskRole(s,task,role,harnessOverride??(pinned?existing!.harness:undefined),pinned,undefined,spec.model);
 let instance=existing??roleInstance(s,task,role,harnessOverride),continuation:{ref:string;from_run:string|null}|null=null;
 // A new assignment is a safe boundary: it starts on the current revision. An instance created before RoleDefinitionV2
 // under a legacy configuration keeps the definition it was pinned with.
 if(instance.snapshot_id!==resolved.id&&!(resolved.snapshot.legacy&&!instance.snapshot_id))instance=rebind(s,task,instance,resolved,'delegation').instance;
 const sourceInput=spec.prompt;
 const priorRun=s.get("SELECT id,stop_reason,assignment_id FROM task_runs WHERE role_instance_id=? ORDER BY rowid DESC LIMIT 1",instance.id),priorSubmission=priorRun?.stop_reason==='role_result_invalid'?s.get("SELECT id FROM task_history WHERE run_id=? AND type='tool_started' AND json_extract(data,'$.name')=? ORDER BY id DESC LIMIT 1",priorRun.id,spec.finish?.name??''):null;
 let memory:any;try{memory={availability:'available',...new ProjectMemory(s).search(task.repository_id,'',{role,limit:5,baseline:executionBaseline(task)})};}catch{memory={availability:'unavailable',instruction:'Role memory lookup failed; continue from task records and repository sources. Do not infer no prior knowledge.'};traceEvent(s,task.id,'memory_fault',{operation:'role_context',role,code:'role_memory_unavailable'},task.trace_run_id);}
 const previousRole=task.active_role;task.active_role=role;
 try{
 for(;;){
  const definition=JSON.parse(instance.definition),harness=instance.harness,snapshot=resolved.snapshot,driver=roleHarness(harness),persistence=driver.session;
  // The role's explicit model wins; otherwise the caller's pinned execution model, which follows the workflow/project order.
  // A driver with its own model gets no project model at all.
  const model=snapshot.model.source==='role'||driver.externalModel?resolved.model:spec.model??(taskConfiguration(s,task)?executionModel(s,task,workflow):resolved.model);if(model.key)spec.redactor.add(model.key);
  const env=await options.prepare?.(instance,resolved)||{};
  const stored=cleanRoleMessages(JSON.parse(instance.session)),messages=role==='qa'||persistence!=='checkpoint_transcript'?[]:stored;
  // A crash can leave an assistant tool batch partially answered. Mark absent receipts as
  // interrupted, never fabricate their observations; the role must query durable task facts.
  for(let i=0;i<messages.length;i++){const msg=messages[i];if(msg.role!=='assistant'||!msg.tool_calls?.length)continue;const replies=new Set<string>();let end=i+1;while(messages[end]?.role==='tool'){replies.add(messages[end].tool_call_id);end++;}const missing=msg.tool_calls.filter((c:any)=>!replies.has(c.id)).map((c:any)=>({role:'tool',tool_call_id:c.id,content:JSON.stringify({error:'interrupted_observation',instruction:'Inspect task records before repeating any action.'})}));messages.splice(end,0,...missing);i=end+missing.length-1;}
  // The starting recovery mode depends on the driver's session kind. An external session is pending until the agent binds
  // it (ACP session_bound then records native_resume or rebuilt_from_task_records); a Pi session is native_resume only
  // when its live session is reattached.
  const recover=role==='qa'?'fresh_evaluation':persistence==='external_session'?'external_session_pending'
   :persistence==='native_resume'?(env.pi?.resume?'native_resume':instance.sequence>0?'rebuilt_from_task_records':'new_session')
   :persistence==='checkpoint_transcript'?(messages.length?'checkpoint_transcript':'new_session'):instance.sequence>0?'rebuilt_from_task_records':'new_session';
  const roleContext={role,snapshot_ref:'role_snapshots:'+resolved.id,config_revision:snapshot.config_revision,role_revision:snapshot.role_revision,model_source:snapshot.model.source};
  const ref=traceEvent(s,task.id,'role_input',{instance_id:instance.id,role_version:definition.version,harness,assignment_id:assignment??null,recovery_mode:recover,...roleContext,skills:snapshot.skills?{id:snapshot.skills.id,revision:snapshot.skills.revision,content_hash:snapshot.skills.content_hash,files:snapshot.skills.files.map(f=>f.path)}:null,continuation:continuation?.ref??null,input:spec.redactor.clean(spec.prompt)},task.trace_run_id,'role:'+role,continuation?[continuation.ref]:[]);
  const denied=(tool:string|null,reason:string)=>traceEvent(s,task.id,'capability_denied',{role,instance_id:instance.id,tool,reason,snapshot_id:resolved.id,policy:snapshot.capability.id},task.trace_run_id,'framework');
  // Authority is live: a revoked role, policy or coordination stops further capability use; the snapshot never extends it.
  const authority=(tool?:string)=>{const reason=roleAuthority(s,task.repository_id,snapshot,tool);if(reason){denied(tool??null,reason);stop('role_authority_revoked','waiting_configuration',`${role}：${reason}`);}};
  // The policy bounds the offered tools; the entry's own submission tool is its output schema and always stays.
  const policyTools=snapshot.capability.tools;
  const memoryAliases=role==='manager'?[]:memoryTools.filter(t=>['search_project_memory','remember_project_memory'].includes(t.function.name)&&spec.tools?.some(x=>x.function.name===t.function.name)).map(t=>({...t,function:{...t.function,name:t.function.name.replace('_project_','_role_')}}));
  const tools=[...(spec.tools??[]),...memoryAliases,...(snapshot.skills?[skillTool]:[])].filter(t=>!policyTools||policyTools.includes(t.function.name)||t.function.name===spec.finish?.name);
  const budget=snapshot.budget.id==='bounded'?snapshot.budget:undefined;
  let executionRun:string|undefined;
  const wrapped:AgentSpec<T>={...spec,model,tools,pi:env.pi??spec.pi,
   guard:async()=>{await spec.guard();authority();},
   maxTurns:budget?.max_turns?Math.min(spec.maxTurns??16,budget.max_turns):spec.maxTurns,maxOutputTokens:budget?.max_output_tokens?Math.min(spec.maxOutputTokens??8192,budget.max_output_tokens):spec.maxOutputTokens,
   onDenied:(name,reason)=>denied(name,reason),
   // A newer revision requested for this running instance ends the run here; the loop below continues it.
   checkpoint:async()=>{await spec.checkpoint?.();const pending=s.get('SELECT pending_revision FROM role_instances WHERE id=?',instance.id)?.pending_revision;if(pending&&pending>(instance.config_revision??0))stop('role_revision_checkpoint','retry_wait','角色在安全检查点结束，将带新 revision 续接。');},
   repairInvalid:spec.repairInvalid??(error=>(error instanceof SyntaxError||/^role_(?:result|delivery|nomination)_/.test(String((error as any).code)))?'Correct the submission structure using the existing inspected evidence; do not repeat unchanged verification. Findings require description and evidence:string[], inspected_scope:string[], unknowns:string[]. Delivery nomination requires an exact offered latest dev result_ref. Preserve actual findings and uncertainty. '+String((error as any).detail??''):undefined),
   onRun:id=>{executionRun=id;spec.onRun?.(id);},
   execute:async(name,args)=>{authority(name);
    if(name==='read_skill'&&snapshot.skills){const files=skillFiles(s,task.repository_id,snapshot.skills);if(args?.path===undefined)return {bundle:{id:snapshot.skills.id,revision:snapshot.skills.revision,content_hash:snapshot.skills.content_hash,source:snapshot.skills.source},files:files.map(({content,...f})=>f)};
     const file=files.find(f=>f.path===args.path);if(!file)return {error:'skill_file_not_found',files:files.map(f=>f.path)};
     traceEvent(s,task.id,'skill_read',{role,instance_id:instance.id,bundle:{id:snapshot.skills.id,revision:snapshot.skills.revision,content_hash:snapshot.skills.content_hash,source:snapshot.skills.source},path:file.path,sha256:file.sha256},task.trace_run_id,'role:'+role);return {path:file.path,sha256:file.sha256,content:file.content};}
    if(memoryAliases.some(t=>t.function.name===name))return spec.execute?.(name.replace('_role_','_project_'),{...args,role_scope:role});return spec.execute?.(name,args);},
   system:definition.prompt+'\n'+spec.system,
   prompt:JSON.stringify({...(()=>{try{return JSON.parse(sourceInput);}catch{return {input:sourceInput};}})(),role_context:{task_ref:'task:'+task.id,assignment_ref:ref,recovery_mode:recover,...roleContext,
    skills:snapshot.skills?{instruction:'Optional working material pinned for your role. Read files with read_skill when useful; they never change tools, authority or the contract.',bundle:snapshot.skills.id,revision:snapshot.skills.revision,files:snapshot.skills.files}:undefined,
    revision_continuation:continuation?{ref:continuation.ref,ended_run:continuation.from_run,instruction:'Your previous run ended at a safe checkpoint for a new role revision. Continue the same assignment from task records and your transcript; do not repeat completed actions.'}:undefined,
    prior_submission:priorSubmission?{ref:'task_history:'+priorSubmission.id,run_id:priorRun!.id,instruction:'A previous submission failed formatting. Read this original record and correct its structure; reuse observations only if the candidate is still applicable. Do not repeat checks merely to fix formatting.'}:null,role_memory:memory}}),
   requestPrefix:`role:${instance.id}:${instance.sequence}:`,roleRun:{instance_id:instance.id,role,version:definition.version,harness,harness_version:driver.version,assignment_id:assignment,recovery_mode:recover,snapshot_id:resolved.id},
   session:{messages:messages.length&&messages[0]?.role==='system'?[{role:'system',content:definition.prompt+'\n'+spec.system},...messages.slice(1)]:messages,save:msgs=>{s.run('UPDATE role_instances SET session=?,updated_at=? WHERE id=?',JSON.stringify(cleanRoleMessages(spec.redactor.clean(msgs))),new Date().toISOString(),instance!.id);}}};
  s.run('UPDATE role_instances SET sequence=sequence+1 WHERE id=?',instance.id);instance.sequence++;
  if(persistence!=='checkpoint_transcript')wrapped.session=undefined;
  // The external session binding persists on the instance; QA always starts a new one.
  wrapped.harnessState={value:role==='qa'?{}:JSON.parse(instance.harness_state??'{}'),save:value=>s.run('UPDATE role_instances SET harness_state=?,updated_at=? WHERE id=?',JSON.stringify(spec.redactor.clean(value)),new Date().toISOString(),instance!.id)};
  if(driver.externalModel)wrapped.modelTrace={source:'external_harness',model:'unknown'};
  // The driver decides the transport; the native driver is the control-plane tool loop.
  wrapped.adapter=driver.adapter?.(wrapped);
  let result:T;
  try{result=await runAgent(wrapped);}
  catch(error){
   if(!(error instanceof TaskError&&error.code==='role_revision_checkpoint'))throw error;
   // The old run ended at a safe checkpoint with its own snapshot. Continue the same assignment on the new revision.
   const next=taskRole(s,task,role,harnessOverride,false,roleConfiguration(s,task.repository_id),spec.model);const moved=rebind(s,task,s.get('SELECT * FROM role_instances WHERE id=?',instance.id)!,next,'checkpoint',executionRun);
   resolved=next;instance=moved.instance;continuation={ref:moved.ref,from_run:executionRun??null};continue;
  }finally{await env.release?.();}
  const reference=traceEvent(s,task.id,'role_result',{instance_id:instance.id,role,assignment_id:assignment??null,snapshot_id:resolved.id,candidate_version:assignment?s.get('SELECT candidate_version FROM role_assignments WHERE id=?',assignment)?.candidate_version??null:null,contract_revision:s.get('SELECT revision FROM task_records WHERE task_id=?',task.id)?.revision,result:spec.redactor.clean(result)},executionRun,'role:'+role,[ref]);
  return {result,reference,instance_id:instance.id};
 }
 }finally{task.active_role=previousRole;}
}
