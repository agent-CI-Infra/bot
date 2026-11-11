import {versionTools} from '../tasks/versions.js';
import {setTaskPriority,priorityInstructions} from '../tasks/priority.js';
import {relateTasks} from '../tasks/followups.js';
import { planTask, reconcileAssignments, bindStageAssignment, latestRoleCandidate, candidateKey, evaluateRequiredStages, assertStageWaits } from './schedule.js';
import {coordinationTools,requestCoordination,waitForCoordinatedTasks} from '../tasks/coordination.js';
import { taskTraceAccess } from '../memory/access.js';
import type { AgentSpec } from '../agent/runtime.js';
import { randomId } from '../core/security.js';
import { sha,stop,TaskError } from '../agent/common.js';
import { traceEvent,traceSource } from '../tasks/trace.js';
import { TaskRecords } from '../tasks/service.js';
import { taskTools,playbookInstructions,playbooks } from '../tasks/playbooks.js';
import { runRole,roleConfig,roleInstance,type RoleRunOptions } from './run.js';
import { findingsSchema,nominationSchema,environmentProfiles } from './catalog.js';
const tool=(name:string,description:string,properties:any,required:string[]=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const readRecord=tool('read_task_record','Read a durable record from THIS task by offered reference; use offset to page its JSON.',{ref:{type:'string'},offset:{type:'integer'}},['ref']);
export interface TeamEnvironment {
 withRole?:<R>(role:string,work:()=>Promise<R>)=>Promise<R>;
 withObservers?:<R>(work:()=>Promise<R>)=>Promise<R>;
 bindRun?:(runId:string)=>void;
 snapshot?:RoleRunOptions['snapshot'];
 prepare:(role:string)=>Promise<(()=>Promise<void>)|void>;
 /** Candidate finalization belongs only to a writer, never the controller or an inspection checkout. */
 writerSnapshot?:AgentSpec<any>['candidateSnapshot'];
 /** The restricted workspace of the controller's Pi session (a fresh one per run, or the live one to resume). */
 controller?:RoleRunOptions['prepare'];
 /** Backend session preparation; product tools retain the workspace selected by prepare(role). */
 worker?:RoleRunOptions['prepare'];
 /** The roles this entry can delegate to; by default every enabled worker role. */
 workers?:string[];
 /** The entry's own executor runs the dev assignment once per call, keeping the entry's harness and tools. round
  * identifies the call: a review that continues after new discussion runs its executor again instead of reusing a result. */
 executor?:{harness?:string;round:string;prepare:RoleRunOptions['prepare']};
 /** The entry point recorded with this coordination (development, request, review, actions). */
 entry?:string;
 /** A container of its own per run for roles whose environment profile requires run isolation. */
 isolated?:RoleRunOptions['prepare'];
}
/** The controller has no executor callback, publication tool or completion authority. */
export async function runTeam<T>(spec:AgentSpec<T>,environment:TeamEnvironment):Promise<T>{
 const records=new TaskRecords(spec.store),s=spec.store,task=spec.task,config=roleConfig(s,task),controller=config.controller.role;
 planTask(s,task.id,records.get(task.id).revision);
 assertStageWaits(s,task.id,evaluateRequiredStages(s,task.id,latestRoleCandidate(s,task.id)).waiting);
 const pool=config.roles.filter(r=>r.enabled),workers=environment.workers??pool.filter(r=>r.kind==='writer'||r.kind==='observer').map(r=>r.role_id),devDefinition=pool.find(r=>r.role_id==='dev');
 // One record per distinct refused call: the model output is screened, and the call is checked again when executed.
 const recorded=new Set<string>(),denied=(reason:string,detail:any,args:any)=>{const key=sha(reason+JSON.stringify(args??null));if(recorded.has(key))return;recorded.add(key);traceEvent(s,task.id,'capability_denied',{role:controller,tool:'delegate_role',reason,...detail},task.trace_run_id,'framework');};
 // Delegation cannot carry authority: only an offered worker role, a purpose and task record references.
 const delegationProblem=(args:any):[string,any]|null=>!args||typeof args!=='object'||Object.keys(args).some(k=>!['role','purpose','refs','stage_id'].includes(k))?['delegation_scope_invalid',{fields:args&&typeof args==='object'?Object.keys(args):null}]
  :!workers.includes(args.role)?['delegation_not_allowed',{requested_role:typeof args.role==='string'?args.role.slice(0,64):null}]:null;
 let executed:string|undefined;
 // Which entry point ran under which configuration revision: the task keeps its id, contract, candidate and history.
 traceEvent(s,task.id,'controller_entry',{entry:environment.entry??(task.kind==='task.request'?'request':'development'),controller,config_revision:config.revision,legacy:!!config.legacy,workers,executor:environment.executor?{role:'dev',harness:environment.executor.harness??(devDefinition?.entry_harness_source==='role'?devDefinition.harness_ref.id:'pi')}:null,attempt:task.attempt},task.trace_run_id,'framework');
 const resolve=(ref:string)=>traceSource(s,task.id,ref,taskTraceAccess(s,task));
 const read=async(args:any)=>{if(!Number.isSafeInteger(args.offset??0)||(args.offset??0)<0)return {error:'invalid_offset'};let source;try{source=resolve(String(args.ref));}catch{return {error:'task_record_not_found',ref:args.ref,instruction:'Use an offered task_history source, task:'+task.id+' or contract:revision:'+records.get(task.id).revision};}const text=JSON.stringify(source),offset=args.offset??0;traceEvent(s,task.id,'role_record_read',{role:task.active_role,ref:args.ref,offset},task.trace_run_id,'role:'+task.active_role,[args.ref]);return {ref:args.ref,content:text.slice(offset,offset+16000),next_offset:offset+16000<text.length?offset+16000:null};};
 const commonExecute=async(name:string,args:any)=>{if(name==='wait_for_tasks'){const result=waitForCoordinatedTasks(s,task,args);if(result.waiting)stop('task_coordination_requested','waiting_coordination','Waiting for declared task dependencies; no execution slot held.');return result;}if(name==='list_project_tasks')return s.all("SELECT t.id,t.summary,t.status,r.revision FROM tasks t JOIN task_records r ON r.task_id=t.id WHERE t.repository_id=? ORDER BY t.created_at DESC,t.id LIMIT 100",task.repository_id);if(['read_coordination','acknowledge_coordination'].includes(name))return records.tool(task.id,name,args);if(name==='request_task_coordination'){let request;try{request=requestCoordination(s,task,args);}catch(e){return {error:(e as Error).message};}if(['queued','running'].includes(request.state))return stop('task_coordination_requested','waiting_coordination',request.coordination_id);return request;}if(name==='read_task_record')return read(args);return spec.execute?.(name,args);};
 const findings={type:'function',function:{name:'submit_role_result',description:'Persist findings for the fixed inspected candidate. This cannot approve or finish the task.',parameters:findingsSchema}};
 const validateFindings=(v:any)=>{if(Array.isArray(v?.findings)&&v.findings.some((f:any)=>typeof f?.evidence==='string')){v={...v,findings:v.findings.map((f:any)=>typeof f?.evidence==='string'?{...f,evidence:[f.evidence]}:f)};traceEvent(s,task.id,'role_result_normalized',{role:task.active_role,field:'findings.evidence',from:'string',to:'string_array'},task.trace_run_id,'framework');}if(!v||typeof v.summary!=='string'||!v.summary.trim()||!Array.isArray(v.findings)||v.findings.some((f:any)=>!f||typeof f.description!=='string'||!f.description.trim()||!Array.isArray(f.evidence)||f.evidence.some((e:any)=>typeof e!=='string'))||!Array.isArray(v.inspected_scope)||v.inspected_scope.some((x:any)=>typeof x!=='string')||!Array.isArray(v.unknowns)||v.unknowns.some((x:any)=>typeof x!=='string'))return stop('role_result_invalid','retry_wait','Expected summary, findings with string-array evidence, inspected_scope string[] and unknowns string[].');return spec.redactor.clean(v);};
 const delegate=tool('delegate_role','Ask dev/test/reviewer/ux to work. Handoff uses persistent references, not copied conversations. Reuse dev for fixes. Returns ONLY a result reference; read it before deciding the next coordination step.',{role:{type:'string',enum:workers},purpose:{type:'string'},refs:{type:'array',items:{type:'string'}},stage_id:{type:'string'}},['role','purpose','refs']);
 const nominate={type:'function',function:{name:'nominate_delivery',description:'Nominate a completed dev role result for mandatory independent QA. This does not approve, finish, publish or merge.',parameters:nominationSchema}};
 const plan=tool('plan_task','Persist optional stages using an optimistic plan revision. Project required stages must be preserved exactly. Omit stages to read/ensure the configured plan.',{expected_revision:{type:'integer'},expected_plan_revision:{type:'integer'},stages:{type:'array',items:{type:'object'}}},['expected_revision']);
 const reconcile=tool('read_stage_schedule','Read stage inputs, evidence, dependencies, waits and runnable next stages.',{});
 const parallel=tool('delegate_roles','Run independent read-only stages on the same fixed candidate concurrently. Never include a writer. Returns one result reference per assignment.',{assignments:{type:'array',items:delegate.function.parameters}},['assignments']);
 const priority=tool('set_task_priority','Task Manager ranks same-project tasks from evidence using P0-P3. Changed priority joins its new level tail; never preempts running work.',{task_id:{type:'string'},priority:{type:'string',enum:['P0','P1','P2','P3']},reason:{type:'string'}},['priority','reason']);
 const relation=tool('relate_task','Record your judgment: same_problem, related, or recurrence. Cite evidence. Running similar tasks trigger Coordinator; do not duplicate execution.',{task_id:{type:'string'},key:{type:'string'},relationship:{type:'string',enum:['same_problem','related','recurrence']},reason:{type:'string'},evidence:{type:'string'}},['task_id','key','relationship','reason','evidence']);
 const disposition=tool('finish_coordination','Finish this coordination turn without delivery: continue later, wait for an external condition, or explicitly request human help. Never nominates, publishes or completes the task.',{action:{type:'string',enum:['continue','wait','needs_help']},reason:{type:'string'},delay_seconds:{type:'integer',minimum:5,maximum:86400},help_from:{type:'string'},resume_condition:{type:'string'}},['action','reason']);
 const managerTools=[disposition,...(spec.tools??[]).filter(t=>versionTools.some(v=>v.function.name===t.function.name)),priority,relation,delegate,...(environment.withRole?[parallel]:[]),plan,reconcile,nominate,readRecord,...taskTools.filter(t=>!coordinationTools.some(c=>c.function.name===t.function.name)),...coordinationTools];
 const managerSpec:AgentSpec<T>={...spec,guard:async()=>{await spec.guard();assertStageWaits(s,task.id,evaluateRequiredStages(s,task.id,latestRoleCandidate(s,task.id)).waiting);},candidateSnapshot:undefined,adapter:undefined,session:undefined,pi:undefined,system:'Task Manager. '+priorityInstructions+' '+playbookInstructions,prompt:JSON.stringify({version_context:(()=>{try{return JSON.parse(spec.prompt).version_context;}catch{return undefined;}})(),task_id:task.id,task_ref:'task:'+task.id,contract_ref:'contract:revision:'+records.get(task.id).revision,contract:records.get(task.id).contract,current_state:{...records.get(task.id),candidate:records.get(task.id).candidate?{id:records.get(task.id).candidate!.id,revision:records.get(task.id).candidate!.revision,artifacts:records.get(task.id).candidate!.artifacts.map(({kind,reference,version})=>({kind,reference,version})),evidence:records.get(task.id).candidate!.evidence.map(({source,version})=>({source,version}))}:null},roles:pool.filter(r=>workers.includes(r.role_id)||r.kind==='evaluator').map(r=>({id:r.role_id,name:r.name,responsibility:r.responsibility,kind:r.kind,revision:r.revision,harness:r.harness_ref.id,delegable:workers.includes(r.role_id)})),playbooks:playbooks.map(({content,...p})=>p),stage_schedule:reconcileAssignments(s,task.id),recent_results:s.all("SELECT id,type FROM task_history WHERE task_id=? AND type IN ('role_result','acceptance') ORDER BY id DESC LIMIT 12",task.id).map(r=>({ref:'task_history:'+r.id,type:r.type}))}),tools:managerTools,maxTurns:32,finish:{name:'nominate_delivery',names:['nominate_delivery','finish_coordination'],validate:(args,name)=>{
  if(name==='finish_coordination'){if(!['continue','wait','needs_help'].includes(args?.action)||typeof args.reason!=='string'||!args.reason.trim()||args.action==='needs_help'&&(!args.help_from?.trim()||!args.resume_condition?.trim())||args.action==='wait'&&!args.resume_condition?.trim())return stop('role_result_invalid','retry_wait','Provide action/reason; wait needs resume_condition, needs_help also needs help_from.');const value={action:args.action,reason:args.reason,help_from:args.help_from,resume_condition:args.resume_condition,delay_seconds:Math.max(5,Math.min(86400,Number(args.delay_seconds)||30))};traceEvent(s,task.id,'manager_disposition',value,task.trace_run_id,'role:manager');return {manager_disposition:value} as T;}

  const row=s.get("SELECT h.data FROM task_history h WHERE h.task_id=? AND 'task_history:'||h.id=? AND h.type='role_result' AND json_extract(h.data,'$.role')='dev'",task.id,args?.result_ref);if(!row)return stop('role_nomination_invalid','retry_wait');
  const value=JSON.parse(row.data);
  if(JSON.parse(task.input||'{}').integration){const run=s.get("SELECT r.attempt FROM task_history h JOIN task_runs r ON r.id=h.run_id WHERE h.task_id=? AND 'task_history:'||h.id=?",task.id,args.result_ref);if(run?.attempt!==task.attempt)return stop('role_nomination_stale','retry_wait',JSON.stringify({instruction:'This integration attempt needs a NEW Dev result from this attempt, not a checkout of the published PR head. Read read_version_context for fixed refs and actual HEAD; restored candidate contents may be staged on the base.',required_attempt:task.attempt,existing_attempt:run?.attempt,result_ref:args.result_ref}));}
if(value.contract_revision!==records.get(task.id).revision)return stop('role_nomination_stale','retry_wait');
  const latest=s.get("SELECT id FROM task_history WHERE task_id=? AND type='role_result' AND json_extract(data,'$.role')='dev' ORDER BY id DESC LIMIT 1",task.id);if(args.result_ref!=='task_history:'+latest?.id)return stop('role_nomination_stale','retry_wait');
  const gate=evaluateRequiredStages(s,task.id,latestRoleCandidate(s,task.id));assertStageWaits(s,task.id,gate.waiting);if(!gate.satisfied)stop('role_nomination_stages_incomplete','retry_wait',JSON.stringify(gate.waiting));
  traceEvent(s,task.id,'delivery_nominated',{result_ref:args.result_ref,qa_required:true},task.trace_run_id,'role:manager',[args.result_ref]);return value.result as T;
 }},finalizationTools:['nominate_delivery','finish_coordination'],validate:()=>stop('role_nomination_required','retry_wait'),
  screen:(name,args)=>{const problem=name==='delegate_role'?delegationProblem(args):null;if(problem)denied(problem[0],problem[1],args);},
  execute:async(name,args)=>{
  if(name==='read_stage_schedule')return reconcileAssignments(s,task.id);
  if(name==='plan_task'){try{return planTask(s,task.id,args?.expected_revision,args?.stages,args?.expected_plan_revision);}catch(error){if(error instanceof TaskError&&error.state!=='retry_wait')throw error;return {error:(error as Error).message};}}
  if(name==='delegate_roles'){if(!environment.withRole||!Array.isArray(args?.assignments)||args.assignments.length<1||args.assignments.length>8||new Set(args.assignments.map((a:any)=>a?.role)).size!==args.assignments.length||args.assignments.some((a:any)=>delegationProblem(a)||pool.find(r=>r.role_id===a.role)?.kind!=='observer'))return {error:'parallel_observers_required'};const run=()=>Promise.allSettled(args.assignments.map((a:any)=>environment.withRole!(a.role,()=>managerSpec.execute!('delegate_role',a))));const settled=await (environment.withObservers?environment.withObservers(run):run());const stopped=settled.find(r=>r.status==='rejected'&&r.reason instanceof TaskError&&r.reason.state!=='retry_wait');if(stopped?.status==='rejected')throw stopped.reason;return {results:settled.map(r=>r.status==='fulfilled'?r.value:{error:(r.reason as any)?.code??String(r.reason)})};}
  if(name==='delegate_role'&&environment.withRole&&!args?.__role_scope){const scoped={...args};Object.defineProperty(scoped,'__role_scope',{value:true});return environment.withRole(args?.role,()=>managerSpec.execute!(name,scoped));}
  if(name==='set_task_priority'){const id=args?.task_id??task.id;if(!s.get('SELECT id FROM tasks WHERE id=? AND repository_id=?',id,task.repository_id))return {error:'followup_task_out_of_scope'};return setTaskPriority(s,id,args.priority,args.reason,'role:manager');}
  if(name==='relate_task'){const result=relateTasks(s,task,args);if(result.coordination)return stop('task_coordination_requested','waiting_coordination',result.coordination.coordination_id);return result;}
  if(coordinationTools.some(t=>t.function.name===name))return commonExecute(name,spec.redactor.clean(args));
  if(name==='read_task_record')return read(args);
  if(taskTools.some(t=>t.function.name===name))return records.tool(task.id,name,spec.redactor.clean(args),taskTraceAccess(s,task));
  if(name!=='delegate_role')return {error:'tool_not_allowed'};
  const problem=delegationProblem(args);
  if(problem){denied(problem[0],problem[1],args);return problem[0]==='delegation_scope_invalid'?{error:'delegation_not_allowed',instruction:'Delegation carries only role, purpose and refs; tools, models, harnesses and permissions come from the role configuration.'}
   :{error:'delegation_not_allowed',roles:workers,instruction:'Only the offered worker roles can be delegated to. Independent QA runs after nomination; it is never delegated.'};}
  if(typeof args.purpose!=='string'||!args.purpose.trim()||args.purpose.length>2000||!Array.isArray(args.refs)||args.refs.length>20||args.refs.some((ref:any)=>typeof ref!=='string'||ref.length>200))return {error:'invalid_role_assignment'};
  if(environment.executor&&args.role==='dev'&&executed)return {result_ref:executed,reused:true,instruction:'This entry runs its executor once per call. Read this result and nominate it.'};
  for(const ref of args.refs){try{resolve(String(ref));}catch{return {error:'invalid_task_reference',ref,instruction:'Read task history or use the offered current task/contract refs.'};}}
  // A role with an isolated environment profile gets its own run container instead of a checkout on the shared computer.
  const isolatedRole=(environmentProfiles.find(e=>e.id===pool.find(r=>r.role_id===args.role)?.environment_profile_ref.id) as {isolation?:string}|undefined)?.isolation==='run_container';
  const revision=records.get(task.id).revision,context=isolatedRole?undefined:await environment.prepare(args.role);
  try{
   const sourceVersion=s.get("SELECT json_extract(data,'$.version') version FROM task_history WHERE task_id=? AND type='role_candidate' AND json_extract(data,'$.role')=? ORDER BY id DESC LIMIT 1",task.id,args.role)?.version??null;
   const inputKey=sha(JSON.stringify({role:args.role,purpose:args.purpose,refs:args.refs,revision,attempt:config.required_stages?.length?undefined:task.attempt,candidate_key:args.role==='dev'?undefined:candidateKey(latestRoleCandidate(s,task.id)),plan_revision:reconcileAssignments(s,task.id).plan_revision,stage_id:args.stage_id??null,...(args.role==='dev'?environment.executor?{round:environment.executor.round}:{}:{candidate_version:sourceVersion})}));
   const existing=s.get('SELECT * FROM role_assignments WHERE task_id=? AND input_ref=?',task.id,inputKey);
   const priorStage=existing?s.get('SELECT result FROM task_stage_results WHERE assignment_id=? ORDER BY rowid DESC LIMIT 1',existing.id):null;
   if(existing?.status==='completed'&&(!priorStage||JSON.parse(priorStage.result).passed)){if(environment.executor&&args.role==='dev')executed=existing.result_ref;return {result_ref:existing.result_ref,reused:true};}
   const assignment=existing?.id??randomId();
   const handoff=existing?null:traceEvent(s,task.id,'role_handoff',{assignment_id:assignment,role:args.role,purpose:args.purpose,refs:args.refs,revision},task.trace_run_id,'role:manager',args.refs);
   const role=args.role,dev=role==='dev';
   // github_write reaches every worker the entry offers it to; runRole keeps it only for roles whose GitHub permissions write (#381).
   const narrow=dev?spec.tools??[]:(spec.tools??[]).filter(t=>['read_file','run_command','read_task_history','read_playbook','select_playbooks','search_project_memory','read_project_memory','read_related_artifact','github_write'].includes(t.function.name));
   const roleSpec:AgentSpec<any>={...spec,candidateSnapshot:dev?(environment.writerSnapshot??environment.snapshot??spec.candidateSnapshot):undefined,onRun:id=>{environment.bindRun?.(id);spec.onRun?.(id);},adapter:undefined,pi:undefined,tools:[...narrow,readRecord,...(dev?[]:[findings])],system:dev?spec.system:'Inspect only this fixed candidate. Commands run in a separate disposable checkout; do not change source or claim unexecuted checks.',prompt:JSON.stringify({task_id:task.id,contract:records.get(task.id).contract,purpose:args.purpose,refs:args.refs,handoff_ref:handoff,previous_acceptance:records.get(task.id).acceptance,source_context:dev?spec.prompt:undefined}),execute:commonExecute,finish:dev?spec.finish:{name:'submit_role_result',validate:validateFindings},finalizationTools:dev?spec.finalizationTools:['submit_role_result'],validate:dev?spec.validate:content=>validateFindings(JSON.parse(content))};
   // Create the persistent instance before linking the assignment. runRole reuses it.
   const executor=dev?environment.executor:undefined,instance=roleInstance(s,task,role,executor?.harness,!!executor);
   if(!existing)s.run('INSERT INTO role_assignments VALUES(?,?,?,?,?,?,?,?)',assignment,task.id,instance.id,revision,sourceVersion,'pending',inputKey,null);
   try{bindStageAssignment(s,task.id,assignment,role,args.stage_id);}catch(error){if(error instanceof TaskError&&error.state!=='retry_wait')throw error;return {error:(error as any).code??(error as Error).message,schedule:reconcileAssignments(s,task.id)};}
   s.run("UPDATE role_assignments SET status='running' WHERE id=?",assignment);
   try{const result=await runRole({...roleSpec,task:dev?task:{...task},prompt:JSON.stringify({...JSON.parse(roleSpec.prompt),candidate_version:s.get('SELECT candidate_version FROM role_assignments WHERE id=?',assignment)?.candidate_version??null})},role,assignment,executor?.harness,{entryExecutor:!!executor,prepare:executor?.prepare??(isolatedRole?environment.isolated:environment.worker),...(dev?{snapshot:environment.snapshot}:{rebuildContext:!!(config.required_stages?.length)})});
   s.run("UPDATE role_assignments SET status='completed',result_ref=? WHERE id=?",result.reference,assignment);if(executor)executed=result.reference;
   return {result_ref:result.reference,instance_id:result.instance_id};}catch(error){
    // A run whose lease was taken over no longer owns the assignment: the current run decides its status.
    if((error as any)?.code!=='lease_epoch_stale')s.run("UPDATE role_assignments SET status='failed' WHERE id=? AND status='running'",assignment);traceEvent(s,task.id,'role_assignment_fault',{assignment_id:assignment,role,code:(error as any).code??'runtime_fault'},task.trace_run_id,'framework');throw error;}
  }finally{await context?.();}
 }};
 const result=(await runRole(managerSpec,controller,undefined,undefined,{prepare:environment.controller})).result;
 const dispositionResult=(result as any)?.manager_disposition;if(dispositionResult)return stop(dispositionResult.action==='needs_help'?'manager_needs_help':'manager_deferred',dispositionResult.action==='needs_help'?'needs_help':'retry_wait',JSON.stringify(dispositionResult),dispositionResult.delay_seconds*1000);
 return result;
}
