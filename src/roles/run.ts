import { assertStageRun, assertStageStart, stageRunBinding, stagePolicyHash, artifactCandidate, deliveryType, stageForAssignment, stageBudgetExceeded, stageBudgetUsage, recordStageResult, latestRoleCandidate, candidateKey } from './schedule.js';
import {executionBaseline} from '../agent/common.js';
import { executionModel, taskConfiguration } from '../tasks/configuration.js';
import { cleanRoleMessages } from './storage.js';
import { workOf } from '../work/catalog.js';
import { runAgent,type AgentSpec } from '../agent/runtime.js';
import { environmentProfiles } from './catalog.js';
import { TaskToolGateway,gatewayToolNames,gatewayCapabilities } from './gateway.js';
import { roleRunProtocol,validateCandidateRef,contentHash,protocolRecovery,type Budget,type CandidateRef,type RunContext,type RunEvent } from './protocol.js';
import { roleCapacity } from './board.js';
import { admitRun,allocateLease,appendRunEvent,assertLease,budgetExceeded,buildRunContext,inputCandidate,instanceUsage,issueRunToken,leaseCurrent,planRecovery,recordCheckpoint,revokeRunTokens,runBudget,runEvents,scopeUsage,sourceRef,touchRunToken,verifyRunToken,type EnvironmentFacts } from './role-run.js';
import { randomId } from '../core/security.js';
import { traceEvent,endRun } from '../tasks/trace.js';
import { roleHarness } from './harness.js';
import { memoryTools } from '../memory/project.js';
import { taskTraceAccess, visibleMemorySnapshot, memoryViewFence, taskMemoryAccess } from '../memory/access.js';
import { ProjectMemory } from '../memory/project.js';
import { TaskError,stop } from '../agent/common.js';
import { roleConfiguration,configurationRevision,resolveRole,roleAuthority,skillFiles,type Entry,type RoleConfiguration } from './definition.js';
import type { PiRoleEnvironment } from '../agent/pi.js';
import type { Row,Store } from '../storage/database.js';
import { assertManagedExecution, assertTaskRole, managedTaskOrigin, roleTaskCaller, taskExecutor, taskAuthorizationFence, taskManagementTools, taskToolAllowed } from '../tasks/management.js';
import { TaskCommands } from '../tasks/commands.js';
import { resolvePrincipalActor } from '../identity/authorization.js';
import { externalModelRecorder } from '../metrics/accounting.js';
/** The project's role configuration in its V2 form (legacy configurations are presented as V2 with legacy:true). */
export function roleConfig(store:AgentSpec<any>['store'],task:AgentSpec<any>['task']){return roleConfiguration(store,task.repository_id,taskConfiguration(store,task)?.roles);}
/** Whether this entry point runs under the project controller. */
export const controlled=(store:Store,task:Row,entry:Entry)=>{const config=roleConfig(store,task);return config.enabled&&config.controller.entries[entry]===true;};
type Resolved=ReturnType<typeof resolveRole>;
// Task defaults stay fixed; only an explicit role apply may move an existing instance to a newer V2 revision.
function taskRole(s:Store,task:Row,role:string,harness?:string,pinned=false,override?:RoleConfiguration,model?:AgentSpec<any>['model'],entryExecutor=false){
 const fixed=taskConfiguration(s,task),instance=s.get('SELECT config_revision,pending_revision FROM role_instances WHERE task_id=? AND role=?',task.id,role);
 let config=override??(fixed?roleConfig(s,task):undefined);
 if(!override&&config&&instance){const revision=Math.max(Number(instance.config_revision??0),Number(instance.pending_revision??0));
  if(revision>config.revision)config=configurationRevision(s,task.repository_id,revision)??config;}
 return resolveRole(s,task.repository_id,role,workOf(task as any),{harness,pinned,configuration:config,entryExecutor,
  // 'workflow' names a work type's own model (task_models), as role snapshots always called it.
  fallbackModel:fixed?()=>({model:model??executionModel(s,task,workOf(task as any)),source:fixed.workflow?.model_id||Object.hasOwn(JSON.parse(fixed.policy.task_models||'{}'),workOf(task as any))?'workflow':'project'}):undefined});
}
/** Entry points must resolve the selected role before requiring a project model; external backends own their model. */
export const roleExecutionModel = (s:Store,task:Row,role:string) => taskRole(s,task,role).model;

/** A per-run environment provisioned for this run, with the manager's inspection of it (run_isolation profiles). */
export interface RunEnvironmentBinding { facts:EnvironmentFacts; handle:unknown; snapshot?:()=>Promise<{tree_sha:string;local_sha:string}|null> }
export interface RoleRunOptions {
 /** Review/Actions dev uses the historical entry executor until its saved backend choice changes. */
 entryExecutor?: boolean;
 /** Rebuild transient context from caller-provided durable facts; keep the role identity and historical traces. */
 rebuildContext?: boolean;
 snapshot?:()=>Promise<{tree_sha:string;local_sha:string}|null>;
 /** Prepares the run's environment once its instance and snapshot are known (for example the Pi workspace). */
 prepare?:(instance:Row,resolved:Resolved)=>Promise<{pi?:PiRoleEnvironment;release?:()=>Promise<void>;environment?:RunEnvironmentBinding}|void>;
 /** RoleRun recover: continue an earlier run of the same instance and assignment from one of its checkpoints. */
 recover?:{previous_run_id:string;checkpoint_ref?:string|null};
}
const skillTool={type:'function',function:{name:'read_skill',description:'List the files of your pinned skill bundle (omit path), or read one file by path. Skills are working material, never permissions or task requirements.',parameters:{type:'object',properties:{path:{type:'string'}},additionalProperties:false}}};
const runtimeDefinition=(role:string,r:Resolved)=>({id:role,prompt:r.system,version:r.snapshot.prompt.system_hash,memory_scope:role,harness:r.snapshot.harness.id,writable:role==='dev',snapshot_id:r.id,config_revision:r.snapshot.config_revision,role_revision:r.snapshot.role_revision});
/** The (task, role) instance, created with the current snapshot. It is the role's identity within the task. */
export function roleInstance(s:Store,task:Row,role:string,harnessOverride?:string,entryExecutor=false){
 if(task.kind==='role.conversation'&&task.conversation_id){
  const resolved=resolveRole(s,task.repository_id,role,'conversation');
  let instance=s.get('SELECT * FROM role_instances WHERE conversation_id=? AND project_id=? AND role=?',task.conversation_id,task.repository_id,role);
  if(!instance){const id=randomId();
   s.run('INSERT INTO role_instances(id,task_id,conversation_id,project_id,role,definition,harness,updated_at,snapshot_id,config_revision,role_revision) VALUES(?,NULL,?,?,?,?,?,?,?,?,?)',id,task.conversation_id,task.repository_id,role,JSON.stringify(runtimeDefinition(role,resolved)),resolved.snapshot.harness.id,new Date().toISOString(),resolved.id,resolved.snapshot.config_revision,resolved.snapshot.role_revision);
   instance=s.get('SELECT * FROM role_instances WHERE id=?',id)!;}
  // Main conversations keep their logical role instance, but rebuild every physical input from current local authority.
  s.run("UPDATE role_instances SET definition=?,harness=?,snapshot_id=?,config_revision=?,role_revision=?,knowledge_fence=?,session='[]',harness_state='{}',sequence=sequence+1,updated_at=? WHERE id=?",
   JSON.stringify(runtimeDefinition(role,resolved)),resolved.snapshot.harness.id,resolved.id,resolved.snapshot.config_revision,resolved.snapshot.role_revision,task.authority_fence??null,new Date().toISOString(),instance.id);
  return s.get('SELECT * FROM role_instances WHERE id=?',instance.id)!;
 }
 let instance=s.get('SELECT * FROM role_instances WHERE task_id=? AND role=?',task.id,role);
 if(!instance){const resolved=taskRole(s,task,role,harnessOverride,false,undefined,undefined,entryExecutor),id=randomId();
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
// ------------------------------------------------------------------------------------------------ RoleRun protocol
/**
 * One role run through the RoleRun protocol (protocol.ts). runRole is prepare → start → collect, repeated when a run ends
 * at a safe checkpoint for a new role revision. The same operations are exported as roleRuns for adapters and operators:
 * events, checkpoint and cancel work on a started handle; recover starts a new run of the same instance and assignment.
 */
interface Bound { ctx:RunContext; token:string; token_id:string; run_id:string; epoch:number }
interface Live { bound:Bound|null; exhausted:string|null;stage_exhausted:string|null; tools:number; onBound?:()=>void; timer?:ReturnType<typeof setTimeout>; stageTimer?:ReturnType<typeof setTimeout>; heartbeat?:ReturnType<typeof setInterval> }
interface LoopState { resolved:Resolved; instance:Row; continuation:{ref:string;from_run:string|null}|null }
export interface PreparedRun<T> {
 protocol:typeof roleRunProtocol.id; operation_id:string; role:string; assignment?:string; scope:string; spec:AgentSpec<T>; wrapped:AgentSpec<T>;
 instance:Row; resolved:Resolved; recovery_start:string; admission:ReturnType<typeof admitRun>; candidate:ReturnType<typeof inputCandidate>; budget:Budget;
 live:Live; env:{release?:()=>Promise<void>;environment?:RunEnvironmentBinding;snapshot?:RoleRunOptions['snapshot']}; inputRef:string; released:boolean;
}
export interface RoleRunHandle<T> { readonly operation_id:string; readonly run_id:string|null; readonly lease_epoch:number|null; readonly context:RunContext|null; readonly settled:boolean }
interface Handle<T> extends RoleRunHandle<T> { prepared:PreparedRun<T>; controller:AbortController; done:Promise<T>; settled:boolean; cancelled:string|null }
const handles=new Map<string,Handle<any>>(),gateway=(s:Store)=>new TaskToolGateway(s);
const tokenTtl=15*60_000;
// bounded caps each run (#167); metered also counts every run of the role instance in the task (role-run.ts runBudget).
const perRunBudget=(snapshot:Resolved['snapshot'])=>snapshot.budget.id==='bounded'||snapshot.budget.id==='metered';
const cumulativeBudget=(snapshot:Resolved['snapshot'])=>snapshot.budget.id==='metered';
// The scope of an assignment's runs: the delegated assignment, otherwise the entry's own assignment of this instance in
// this attempt for this candidate (the controller per attempt, each QA evaluation per candidate).
function assignmentScope(s:Store,task:Row,instance:Row,assignment?:string){
 if(assignment)return assignment;
 const candidate=s.get('SELECT candidate FROM task_records WHERE task_id=?',task.id)?.candidate,id=candidate?String(JSON.parse(String(candidate)).id??'none').slice(0,16):'none';
 return `entry:${instance.id}:${Number(task.attempt??1)}:${id}`;
}
const harnessEventType:Record<string,[RunEvent['type'],RunEvent['category']]>={session_bound:['session_bound','progress'],message:['message','progress'],tool:['tool_call','observation'],artifact:['artifact','artifact'],permission:['permission','denied'],configuration:['configuration','progress'],turn:['turn','progress'],usage:['usage','budget']};

async function prepareRun<T>(spec:AgentSpec<T>,role:string,assignment:string|undefined,harnessOverride:string|undefined,options:RoleRunOptions,state:LoopState,shared:{sourceInput:string;priorRun:Row|undefined;priorSubmission:Row|null|undefined;memory:any}):Promise<PreparedRun<T>>{
 const s=spec.store,task=spec.task,stage=stageForAssignment(s,assignment),workflow=workOf(task as any),{resolved,continuation}=state;let instance=state.instance;
 const sourceFence=taskAuthorizationFence(s,task,role);
 if(instance.source_fence!==sourceFence){
  if(instance.sequence>0){s.run("UPDATE role_instances SET session='[]',harness_state='{}',runtime=NULL WHERE id=?",instance.id);instance={...instance,session:'[]',harness_state:'{}',runtime:null};traceEvent(s,task.id,'source_authorization_changed',{role,instance_id:instance.id,recovery:'rebuilt_from_authorized_facts'},task.trace_run_id);}
  s.run('UPDATE role_instances SET source_fence=? WHERE id=?',sourceFence,instance.id);instance.source_fence=sourceFence;
 }
 if(stage&&s.get('SELECT instance_id FROM role_assignments WHERE id=? AND task_id=?',assignment!,task.id)?.instance_id!==instance.id)stop('role_recovery_scope_mismatch','failed','阶段委派必须属于当前任务与角色实例。');
 const knowledgeFence=memoryViewFence(s,{...task,active_role:role});
 if(instance.knowledge_fence!==knowledgeFence){
  if(instance.sequence>0){s.run("UPDATE role_instances SET session='[]',harness_state='{}',runtime=NULL WHERE id=?",instance.id);instance={...instance,session:'[]',harness_state:'{}',runtime:null};traceEvent(s,task.id,'role_memory_view_changed',{role,instance_id:instance.id,recovery:'rebuilt_from_authorized_task_records'},task.trace_run_id);}
  s.run('UPDATE role_instances SET knowledge_fence=? WHERE id=?',knowledgeFence,instance.id);instance.knowledge_fence=knowledgeFence;
 }
 const scopedInput=()=>visibleMemorySnapshot(s,task.repository_id,(()=>{try{return JSON.parse(shared.sourceInput);}catch{return {input:shared.sourceInput};}})(),taskTraceAccess(s,{...task,active_role:role}));
 const definition=JSON.parse(instance.definition),harness=instance.harness,snapshot=resolved.snapshot,driver=roleHarness(harness),persistence=driver.session;
 // The role's explicit model wins; otherwise the caller's pinned execution model, which follows the workflow/project order.
 // A driver with its own model gets no project model at all.
 const model=snapshot.model.source==='role'||driver.externalModel?resolved.model:spec.model??(taskConfiguration(s,task)?executionModel(s,task,workflow):resolved.model);if(model.key)spec.redactor.add(model.key);
 // A profile that needs a run container is refused before anything is provisioned when the driver cannot run inside one.
 const isolatedProfile=(environmentProfiles.find(e=>e.id===snapshot.environment.id) as {isolation?:string}|undefined)?.isolation==='run_container';
 if(isolatedProfile&&driver.capabilities.isolation!=='run_environment')admitRun(s,{task,role,kind:snapshot.kind,harness:{id:driver.id,version:driver.version,capabilities:driver.capabilities},environment:{id:snapshot.environment.id,isolation:'run_container'},environmentFacts:null,candidate:inputCandidate(s,task,role,snapshot.kind),source_ref:sourceRef(s,task),fresh:true,validated:!!(spec.finish||spec.validate),snapshot_id:resolved.id});
 const env=await options.prepare?.(instance,resolved)||{};
 let released=false;const release=async()=>{if(released)return;released=true;await env.release?.();};
 try{
  // rebuildContext: the caller supplies the durable facts, so no stored conversation is restored (as for QA).
  const rebuild=options.rebuildContext||stage?.role_constraints.independent;
  const stored=visibleMemorySnapshot(s,task.repository_id,cleanRoleMessages(JSON.parse(instance.session)),taskTraceAccess(s,{...task,active_role:role})),messages=rebuild||role==='qa'||persistence!=='checkpoint_transcript'?[]:stored;
  // A crash can leave an assistant tool batch partially answered. Mark absent receipts as
  // interrupted, never fabricate their observations; the role must query durable task facts.
  for(let i=0;i<messages.length;i++){const msg=messages[i];if(msg.role!=='assistant'||!msg.tool_calls?.length)continue;const replies=new Set<string>();let end=i+1;while(messages[end]?.role==='tool'){replies.add(messages[end].tool_call_id);end++;}const missing=msg.tool_calls.filter((c:any)=>!replies.has(c.id)).map((c:any)=>({role:'tool',tool_call_id:c.id,content:JSON.stringify({error:'interrupted_observation',instruction:'Inspect task records before repeating any action.'})}));messages.splice(end,0,...missing);i=end+missing.length-1;}
  // The starting recovery mode depends on the driver's session kind. An external session is pending until the agent binds
  // it (ACP session_bound then records native_resume or rebuilt_from_task_records); a Pi session is native_resume only
  // when its live session is reattached.
  const recover=role==='qa'?'fresh_evaluation':rebuild?'rebuilt_from_task_records':persistence==='external_session'?'external_session_pending'
   :persistence==='native_resume'?(env.pi?.resume?'native_resume':instance.sequence>0?'rebuilt_from_task_records':'new_session')
   :persistence==='checkpoint_transcript'?(messages.length?'checkpoint_transcript':'new_session'):instance.sequence>0?'rebuilt_from_task_records':'new_session';
  // Admission: what this kind and environment need against what the driver declares and the environment verified.
  const kind=snapshot.kind,scope=assignmentScope(s,task,instance,assignment);let candidate=inputCandidate(s,task,role,kind);
  if(stage&&kind==='observer'){const ref=latestRoleCandidate(s,task.id);if(ref){if(ref.kind==='code'&&candidate.ref?.kind==='code'&&candidateKey(ref)!==candidateKey(candidate.ref))stop('candidate_changed','retry_wait');candidate={ref,evidence:candidate.evidence};}}
  const profile=environmentProfiles.find(e=>e.id===snapshot.environment.id) as {id:string;isolation?:string}|undefined;
  const qaState=role==='qa'||rebuild?{}:JSON.parse(instance.harness_state??'{}');
  // A Pi entry executor submits through its workflow session's finish tools and completion check, not spec.finish.
  const admission=admitRun(s,{task,role,kind,harness:{id:driver.id,version:driver.version,capabilities:driver.capabilities},environment:profile?{id:profile.id,isolation:profile.isolation}:null,environmentFacts:env.environment?.facts??null,
   candidate,source_ref:sourceRef(s,task),required:stage?.role_constraints.capabilities,fresh:!messages.length&&!Object.keys(qaState).length,validated:!!(spec.finish||spec.validate||env.pi?.session),snapshot_id:resolved.id});
  const budget=runBudget(snapshot);
  // A cumulative budget already used up by earlier runs of this assignment stops before anything starts; no other model.
  if(cumulativeBudget(snapshot)){const used=instanceUsage(s,instance.id),reached=budgetExceeded(budget,used);if(reached||budget.max_turns!==null&&used.runs>0&&used.model_requests>=budget.max_turns)stop('role_budget_exhausted','waiting_configuration',`${role}：本任务中这个角色的累计预算 ${reached??'max_turns'} 已用尽；已有产物保留，提高预算后才能继续。`);}
  if(options.recover){const previous=s.get('SELECT role_instance_id,lease_scope FROM task_runs WHERE id=? AND task_id=?',options.recover.previous_run_id,task.id);if(!previous||previous.role_instance_id!==instance.id||previous.lease_scope!==scope)stop('role_recovery_scope_mismatch','failed','只能恢复同一角色实例、同一委派的运行。');}
  const roleContext={role,snapshot_ref:'role_snapshots:'+resolved.id,config_revision:snapshot.config_revision,role_revision:snapshot.role_revision,model_source:snapshot.model.source};
  const ref=traceEvent(s,task.id,'role_input',{instance_id:instance.id,role_version:definition.version,harness,assignment_id:assignment??null,recovery_mode:recover,...roleContext,skills:snapshot.skills?{id:snapshot.skills.id,revision:snapshot.skills.revision,content_hash:snapshot.skills.content_hash,files:snapshot.skills.files.map(f=>f.path)}:null,continuation:continuation?.ref??null,input:spec.redactor.clean(spec.prompt)},task.trace_run_id,'role:'+role,continuation?[continuation.ref]:[]);
  const denied=(tool:string|null,reason:string)=>traceEvent(s,task.id,'capability_denied',{role,instance_id:instance.id,tool,reason,snapshot_id:resolved.id,policy:snapshot.capability.id},task.trace_run_id,'framework');
  // Authority is live: a removed role, revoked permission or disabled coordination stops further capability use; the snapshot never extends it.
  const direct=managedTaskOrigin(s,task.id)?.source_kind==='role';
  const authority=(tool?:string)=>{assertTaskRole(s,task,role);const reason=roleAuthority(s,task.repository_id,snapshot,tool,direct);if(reason){denied(tool??null,reason);stop('role_authority_revoked','waiting_configuration',`${role}：${reason}`);}if(tool&&!taskToolAllowed(s,task,role,tool)){denied(tool,'source_permission_ceiling');stop('role_authority_revoked','waiting_permission','源请求不允许此能力。');}};
  // Flat permissions filter every offered tool, including the submission tool.
  const allowedTools=snapshot.capability.tools;
  const memoryAliases=role==='manager'?[]:memoryTools.filter(t=>['search_project_memory','remember_project_memory'].includes(t.function.name)&&spec.tools?.some(x=>x.function.name===t.function.name)).map(t=>({...t,function:{...t.function,name:t.function.name.replace('_project_','_role_')}}));
  const tools=[...(spec.tools??[]).filter(t=>!taskManagementTools.some(m=>m.function.name===t.function.name)),...(snapshot.kind==='evaluator'?[]:taskManagementTools),...memoryAliases,...(snapshot.skills?[skillTool]:[])].filter(t=>(!allowedTools||allowedTools.includes(t.function.name))&&taskToolAllowed(s,task,role,t.function.name));
  if(spec.finish&&!tools.some(tool=>tool.function.name===spec.finish!.name))stop('role_submission_forbidden','waiting_configuration',`${role}：当前权限禁止提交本次任务要求的结果，请在角色权限中调整。`);
  const bounded=perRunBudget(snapshot)?snapshot.budget:undefined,cumulative=cumulativeBudget(snapshot);
  const live:Live={bound:null,exhausted:null,stage_exhausted:null,tools:0};
  const operationId=`role-run:${instance.id}:${contentHash(scope).slice(0,16)}:${instance.sequence}`;
  // Budget exhaustion keeps what exists (a checkpoint with session, receipts and workspace) and stops this run only.
  const exhaust=(limit:string)=>{
   const b=live.bound;live.exhausted=limit;
   if(b&&leaseCurrent(s,b.run_id,b.epoch)){try{recordCheckpoint(s,{run_id:b.run_id,lease_epoch:b.epoch,instance_id:instance.id,reason:'budget_exhausted:'+limit});}catch{}
    appendRunEvent(s,{run_id:b.run_id,lease_epoch:b.epoch,type:'budget',category:'budget',operation_id:'budget:'+limit,data:{limit,usage:instanceUsage(s,instance.id),budget}});revokeRunTokens(s,b.run_id,'budget_exhausted');}
   return stop('role_budget_exhausted','waiting_configuration',`${role}：本任务中这个角色的累计预算 ${limit} 已用尽；已取消本次运行并保留已有产物，不会换模型重开预算。`);
  };
  const exhaustStage=(limit:string):never=>{live.stage_exhausted=limit;const b=live.bound;if(b&&leaseCurrent(s,b.run_id,b.epoch)){recordCheckpoint(s,{run_id:b.run_id,lease_epoch:b.epoch,instance_id:instance.id,reason:'stage_budget_exhausted:'+limit});appendRunEvent(s,{run_id:b.run_id,lease_epoch:b.epoch,type:'budget',category:'budget',data:{stage_id:stage?.stage_id,limit}});revokeRunTokens(s,b.run_id,'stage_budget_exhausted');}return stop('stage_budget_exhausted','paused',limit);};
  const budgetGuard=(pendingTools=0)=>{assertStageRun(s,task.id,assignment,snapshot.kind);const stageLimit=stageBudgetExceeded(s,assignment);if(stageLimit)exhaustStage(stageLimit);if(!cumulative||!live.bound)return;const reached=budgetExceeded(budget,instanceUsage(s,instance.id),{tool_calls:pendingTools});if(reached)exhaust(reached);};
  const access={get token(){return live.bound?.token??'';},check(presented:unknown){const b=live.bound;if(!b||presented!==b.token)throw new TaskError('run_token_invalid','failed');verifyRunToken(s,presented,{run_id:b.run_id,lease_epoch:b.epoch});}};
  let executionRun:string|undefined;
  const wrapped:AgentSpec<T>={...spec,model,tools,pi:env.pi??spec.pi,runEnvironment:env.environment?.handle,
   guard:async()=>{await spec.guard();authority();const b=live.bound;if(b){assertLease(s,b.run_id,b.epoch);if(!touchRunToken(s,b.token_id,tokenTtl))stop('run_token_revoked','cancelled','运行的能力令牌已撤销或过期，运行停止。');budgetGuard();}},
   maxTurns:bounded?.max_turns?Math.min(spec.maxTurns??16,cumulative?bounded.max_turns-instanceUsage(s,instance.id).model_requests:bounded.max_turns):spec.maxTurns,maxOutputTokens:bounded?.max_output_tokens?Math.min(spec.maxOutputTokens??8192,bounded.max_output_tokens):spec.maxOutputTokens,
   onDenied:(name,reason)=>denied(name,reason),
   // A newer revision requested for this running instance ends the run here; the loop below continues it.
   checkpoint:async()=>{await spec.checkpoint?.();const pending=s.get('SELECT pending_revision FROM role_instances WHERE id=?',instance.id)?.pending_revision;if(pending&&pending>(instance.config_revision??0))stop('role_revision_checkpoint','retry_wait','角色在安全检查点结束，将带新 revision 续接。');},
   repairInvalid:spec.repairInvalid??(error=>(error instanceof SyntaxError||/^role_(?:result|delivery|nomination)_/.test(String((error as any).code)))?'Read read_stage_schedule and delegate missing required stages when nomination is blocked. Correct the submission structure using the existing inspected evidence; do not repeat unchanged verification. Findings require description and evidence:string[], inspected_scope:string[], unknowns:string[]. Delivery nomination requires an exact offered latest dev result_ref. Preserve actual findings and uncertainty. '+String((error as any).detail??''):undefined),
   onRun:id=>{executionRun=id;bind(id);spec.onRun?.(id);},
   execute:async(name,args)=>{authority(name);if(cumulative&&bounded?.max_tool_calls)budgetGuard(1);
    const b=live.bound,op=b?'tool:'+(++live.tools):null;
    if(b)appendRunEvent(s,{run_id:b.run_id,lease_epoch:b.epoch,type:'tool_call',category:'progress',operation_id:op,data:{name}});
    budgetGuard();
    const value=await (async()=>{
     const caller=()=>{
      const origin=assertManagedExecution(s,task),auth=s.get('SELECT principal_id FROM task_authorizations WHERE task_id=?',task.id),principal=origin?.principal_id??auth?.principal_id;
      const actor=principal?resolvePrincipalActor(s,principal,null,task.repository_id):undefined;
      return roleTaskCaller(s,task.repository_id,role,{actor,conversation_id:origin?.conversation_id??undefined,source_message:origin?.source_message??undefined,
        allowed_capabilities:origin?.principal_capabilities?JSON.parse(origin.principal_capabilities):undefined,
        source_task_id:task.id,source_run_id:b?.run_id,allowed_tools:snapshot.capability.tools?.filter(tool=>taskToolAllowed(s,task,role,tool)),
        guard:()=>{authority(name);if(b)assertLease(s,b.run_id,b.epoch);}});
     };
     if(['delegate_role','delegate_roles'].includes(name)){
      const targets=name==='delegate_role'?[args?.role]:Array.isArray(args?.assignments)?args.assignments.map((a:any)=>a?.role):[];
      for(const target of targets){const definition=roleConfig(s,task).roles.find(r=>r.role_id===target&&r.enabled);
       // Entry validation still diagnoses unsupported/QA targets; eligible workers use the shared executor boundary.
       if(definition&&['writer','observer'].includes(definition.kind))taskExecutor(s,caller(),target);
      }
     }
     if(taskManagementTools.some(t=>t.function.name===name))return new TaskCommands(s).tool(caller(),name,args);
     // Task facts are expanded through the gateway with this run's token: the same server-side checks for every adapter.
     if(b&&gatewayToolNames.includes(name))return gateway(s).call(b.token,{tool:name,arguments:args,run_id:b.run_id,lease_epoch:b.epoch});
     if(name==='read_skill'&&snapshot.skills){const files=skillFiles(s,task.repository_id,snapshot.skills);if(args?.path===undefined)return {bundle:{id:snapshot.skills.id,revision:snapshot.skills.revision,content_hash:snapshot.skills.content_hash,source:snapshot.skills.source},files:files.map(({content,...f})=>f)};
      const file=files.find(f=>f.path===args.path);if(!file)return {error:'skill_file_not_found',files:files.map(f=>f.path)};
      traceEvent(s,task.id,'skill_read',{role,instance_id:instance.id,bundle:{id:snapshot.skills.id,revision:snapshot.skills.revision,content_hash:snapshot.skills.content_hash,source:snapshot.skills.source},path:file.path,sha256:file.sha256},task.trace_run_id,'role:'+role);return {path:file.path,sha256:file.sha256,content:file.content};}
     if(memoryAliases.some(t=>t.function.name===name))return spec.execute?.(name.replace('_role_','_project_'),{...args,role_scope:role});return spec.execute?.(name,args);})();
    if(b)appendRunEvent(s,{run_id:b.run_id,lease_epoch:b.epoch,type:'tool_result',category:value?.error?'denied':'observation',operation_id:op,data:{name,outcome:value?.error?'error':'ok',error:typeof value?.error==='string'?value.error:null}});
    return value;},
   system:definition.prompt,
   screen:(name,args)=>{authority(name);spec.screen?.(name,args);},
   ...(spec.finish ? {finish:{...spec.finish,validate:async args=>{authority(spec.finish!.name);const result=await spec.finish!.validate(args);authority(spec.finish!.name);return result;}}} : {}),
   ...(spec.validate ? {validate:(content:string)=>{authority(spec.finish?.name??snapshot.output_schema.tool??'finish');return spec.validate!(content);}} : {}),
   ...(spec.finalizationTools ? {finalizationTools:spec.finalizationTools.filter(name=>tools.some(tool=>tool.function.name===name))} : {}),
   prompt:JSON.stringify({...scopedInput(),role_context:{task_ref:'task:'+task.id,assignment_ref:ref,recovery_mode:recover,...roleContext,environment:{project_id:task.repository_id,task_id:task.id,work_type:workflow,profile:snapshot.environment,permissions:resolved.definition.permissions,tools:tools.map(tool=>tool.function.name)},
    skills:snapshot.skills?{instruction:'Optional working material pinned for your role. Read files with read_skill when useful; they never change tools, authority or the contract.',bundle:snapshot.skills.id,revision:snapshot.skills.revision,files:snapshot.skills.files}:undefined,
    revision_continuation:continuation?{ref:continuation.ref,ended_run:continuation.from_run,instruction:'Your previous run ended at a safe checkpoint for a new role revision. Continue the same assignment from task records and your transcript; do not repeat completed actions.'}:undefined,
    prior_submission:shared.priorSubmission?{ref:'task_history:'+shared.priorSubmission.id,run_id:shared.priorRun!.id,instruction:'A previous submission failed formatting. Read this original record and correct its structure; reuse observations only if the candidate is still applicable. Do not repeat checks merely to fix formatting.'}:null,role_memory:visibleMemorySnapshot(s,task.repository_id,shared.memory,taskTraceAccess(s,{...task,active_role:role}))}}),
   requestPrefix:`role:${instance.id}:${instance.sequence}:`,roleRun:{instance_id:instance.id,role,version:definition.version,harness,harness_version:driver.version,assignment_id:assignment,recovery_mode:recover,snapshot_id:resolved.id},
   session:{messages:messages.length&&messages[0]?.role==='system'?[{role:'system',content:definition.prompt},...messages.slice(1)]:messages,save:msgs=>{s.run('UPDATE role_instances SET session=?,updated_at=? WHERE id=?',JSON.stringify(cleanRoleMessages(spec.redactor.clean(msgs))),new Date().toISOString(),instance!.id);}}};
  // Adapters read the run's credential after the run is bound (the adapter starts after onRun); before that there is none.
  Object.defineProperty(wrapped,'runAccess',{get:()=>live.bound?access:undefined,enumerable:true,configurable:true});
  wrapped.runContext=()=>live.bound?.ctx;
  let accounting:ReturnType<typeof externalModelRecorder>|undefined;
  const ledger=()=>live.bound?(accounting??=externalModelRecorder(s,{...task,active_role:role},live.bound.run_id,driver.id,instance.id)):undefined;
  wrapped.onExternalRequest=value=>{ledger()?.request(value);};
  wrapped.onExternalUsage=usage=>{const b=live.bound;if(!b)return;assertLease(s,b.run_id,b.epoch);traceEvent(s,task.id,'external_model_usage',usage,b.run_id,'harness');budgetGuard();};
  // Public harness events also enter the run's normalized stream; session_bound settles a pending recovery mode.
  wrapped.onHarnessEvent=event=>{const b=live.bound,mapped=harnessEventType[event.type];if(!b||!mapped)return;ledger()?.event(event);
   if(event.type==='session_bound'&&b.ctx.resume_from_run_id){const mode=protocolRecovery(String(event.recoveryMode))??(['new_session','fresh_evaluation'].includes(String(event.recoveryMode))?'rebuilt_from_task_records':null);if(mode)s.run('UPDATE task_runs SET protocol_recovery=? WHERE id=?',mode,b.run_id);}
   // A permission the agent was granted is progress; only refused ones are denials.
   appendRunEvent(s,{run_id:b.run_id,lease_epoch:b.epoch,type:mapped[0],category:event.type==='permission'&&event.allowed===true?'progress':mapped[1],data:{harness_event:event.type,...Object.fromEntries(Object.entries(event).filter(([k])=>k!=='type'))}});};
  // Binding a new task_runs row: the scheduler's lease epoch, the RunContext, the recovery plan and a capability token.
  const bind=(runId:string)=>{
   // prepare/start may overlap before either run binds. Recheck after this run row exists, with no await before lease allocation.
   const same=s.get("SELECT id FROM task_runs WHERE role_instance_id=? AND status='running' AND id<>?",instance.id,runId);if(same)stop('role_run_already_active','retry_wait');
   // Second capacity check: admission ran before this run bound, so two runs admitted against the same free slot can both
   // reach here. `beginRun` has already inserted this run's own row as running; `exclude` leaves that row out, so
   // `running` counts the other runs only and `others < limit` means the same as `total <= limit`. What makes the sequence
   // safe is that both runs' rows are already visible to each other's SELECT, with no await in between. The row this
   // attempt created is closed before the refusal is raised, so a refused run holds no slot.
   const capacity=roleCapacity(s,String(task.repository_id),role,snapshot.kind,runId);
   if(capacity&&capacity.running>=capacity.limit){endRun(s,{id:runId,task_id:task.id} as Row,'stopped','role_capacity');stop('role_capacity','retry_wait',`${role}：本项目该角色的并发上限 ${capacity.limit} 已满（${capacity.running} 个运行中）；本次不启动，任务排队重试，不消耗尝试次数。`);}
   const conflict=(snapshot.kind==='writer'||snapshot.kind==='observer')&&s.get("SELECT r.id FROM task_runs r JOIN role_snapshots p ON p.id=r.role_snapshot WHERE r.task_id=? AND r.id<>? AND r.status='running' AND (json_extract(p.snapshot,'$.kind')='writer' OR (?='writer' AND json_extract(p.snapshot,'$.kind')='observer'))",task.id,runId,snapshot.kind);if(conflict)stop('candidate_writer_busy','retry_wait');
   const lease=allocateLease(s,task.id,scope,runId,typeof task.claim_token==='string'?task.claim_token:null),previous=options.recover?.previous_run_id??lease.previous_run_id;
   const ctx=buildRunContext(s,{task,scope,run_id:runId,lease_epoch:lease.epoch,...(previous?{resume_from_run_id:previous}:{}),instance,role,snapshot,snapshot_id:resolved.id,candidate:candidate.ref});
   if(wrapped.harnessBinding){ctx.model_revision=wrapped.harnessBinding.model_revision;ctx.harness_revision=wrapped.harnessBinding.harness_revision;}
   const stageBinding=stageRunBinding(s,assignment);if(stageBinding)ctx.stage=stageBinding;
   if(role==='qa'){const hash=stagePolicyHash(s,task.id);if(hash)ctx.stage_policy_hash=hash;}
   let mode:string|null=null,plan:ReturnType<typeof planRecovery>|null=null;
   if(previous){
    plan=planRecovery(s,{previous_run_id:previous,checkpoint_ref:options.recover?.checkpoint_ref,capabilities:driver.capabilities,model_revision:ctx.model_revision,role_revision:ctx.role_revision,session_kind:recover,resumable_session:recover==='native_resume'||recover==='checkpoint_transcript'});
    if(plan.mode==='unsupported')stop('role_recovery_unsupported','waiting_configuration',`${role}（${driver.id}）无法恢复运行 ${previous}；不会伪造继续原进程。`);
    // The mode is what this run actually does: QA always evaluates afresh, a pending external session settles on binding.
    mode=role==='qa'?'rebuilt_from_task_records':recover==='external_session_pending'?null:protocolRecovery(recover)??(recover==='new_session'?'rebuilt_from_task_records':plan.mode);
   }
   s.run('UPDATE task_runs SET run_context=?,resume_from_run_id=?,admission=?,protocol_recovery=?,operation_id=? WHERE id=?',JSON.stringify(ctx),previous??null,JSON.stringify(admission),mode,operationId,runId);
   if(ctx.task_id===null)stop('role_run_protocol_invalid','waiting_configuration','Task RoleRun requires task scope.');
   const issued=issueRunToken(s,{tenant_id:ctx.tenant_id,project_id:ctx.project_id,task_id:ctx.task_id!,run_id:runId,lease_epoch:lease.epoch},[...gatewayCapabilities(snapshot),'events:write','checkpoint:write'],tokenTtl);
   spec.redactor.add(issued.token);
   live.bound={ctx,token:issued.token,token_id:issued.id,run_id:runId,epoch:lease.epoch};
   appendRunEvent(s,{run_id:runId,lease_epoch:lease.epoch,type:'run_started',category:'progress',operation_id:operationId,data:{assignment_id:scope,resume_from_run_id:previous??null,recovery_mode:mode,start_mode:recover,candidate_ref:ctx.candidate_ref,source_ref:ctx.source_ref,budget:ctx.budget.policy_ref,admitted:admission.required}});
   if(previous)traceEvent(s,task.id,'role_run_recovery',{protocol:roleRunProtocol.id,run_id:runId,resume_from_run_id:previous,lease_epoch:lease.epoch,previous_epoch:lease.previous_epoch??null,recovery_mode:mode??'pending_session_binding',planned:plan},runId,'framework',plan?.checkpoint_ref?[plan.checkpoint_ref]:[]);
   // Wall time is cumulative too; the timer interrupts the session even while a tool call runs.
   if(cumulative&&budget.max_wall_ms!==null){const left=budget.max_wall_ms-instanceUsage(s,instance.id).wall_ms;live.timer=setTimeout(()=>{try{exhaust('max_wall_ms');}catch(error){handles.get(operationId)?.controller.abort(error);}},Math.max(0,left));live.timer.unref?.();}
   const stageWall=stageBudgetUsage(s,assignment)?.remaining_wall_ms;
   if(stageWall!==undefined&&stageWall!==null){live.stageTimer=setTimeout(()=>{try{exhaustStage('max_wall_seconds');}catch(error){handles.get(operationId)?.controller.abort(error);}},Math.max(0,stageWall));live.stageTimer.unref?.();}
   // The token lives while this control plane still holds the run: a heartbeat extends it, a crash lets it expire.
   live.heartbeat=setInterval(()=>{try{touchRunToken(s,issued.id,tokenTtl);}catch{}},60_000);live.heartbeat.unref?.();
   live.onBound?.();
  };
  s.run('UPDATE role_instances SET sequence=sequence+1 WHERE id=?',instance.id);instance.sequence++;
  if(persistence!=='checkpoint_transcript')wrapped.session=undefined;
  // The external session binding persists on the instance; QA always starts a new one.
  wrapped.harnessState={value:qaState,save:value=>s.run('UPDATE role_instances SET harness_state=?,updated_at=? WHERE id=?',JSON.stringify(spec.redactor.clean(value)),new Date().toISOString(),instance!.id)};
  if(driver.externalModel)wrapped.modelTrace={source:'external_harness',model:'unknown'};
  await driver.prepare?.(wrapped);
  // The driver decides the transport; the native driver is the control-plane tool loop.
  wrapped.adapter=driver.adapter?.(wrapped);
  const prepared:PreparedRun<T>={protocol:roleRunProtocol.id,operation_id:operationId,role,...(assignment?{assignment}:{}),scope,spec,wrapped,instance,resolved,recovery_start:recover,admission,candidate,budget,live,env:{release,environment:env.environment,snapshot:options.snapshot},inputRef:ref,released:false};
  Object.defineProperty(prepared,'executionRun',{get:()=>executionRun});
  return prepared;
 }catch(error){await release();throw error;}
}
/** start(prepared, operation_id) → handle. The same operation id returns the same handle; a second concurrent run of one assignment is refused. */
export async function startRoleRun<T>(prepared:PreparedRun<T>,operationId=prepared.operation_id):Promise<RoleRunHandle<T>>{
 const known=handles.get(operationId);if(known)return known;
 const s=prepared.spec.store;
 // After a restart the in-memory handle is gone: a recorded operation id gets a deterministic refusal, never a second run.
 if(s.get('SELECT 1 FROM task_runs WHERE operation_id=?',operationId)){await prepared.env.release?.();stop('role_run_operation_used','failed',`操作 ${operationId} 已经启动过运行，不会重复启动。`);}
 assertStageStart(s,prepared.spec.task.id,prepared.assignment,prepared.resolved.snapshot.kind);
 if(stageBudgetExceeded(s,prepared.assignment)){await prepared.env.release?.();stop('stage_budget_exhausted','paused');}
 const kind=prepared.resolved.snapshot.kind;
 const conflict=(kind==='writer'||kind==='observer')&&s.get("SELECT r.id FROM task_runs r JOIN role_snapshots p ON p.id=r.role_snapshot WHERE r.task_id=? AND r.status='running' AND (json_extract(p.snapshot,'$.kind')='writer' OR (?='writer' AND json_extract(p.snapshot,'$.kind')='observer'))",prepared.spec.task.id,kind);
 if(conflict){await prepared.env.release?.();stop('candidate_writer_busy','retry_wait');}
 const busy=s.get("SELECT id FROM task_runs WHERE lease_scope=? AND status='running'",prepared.scope);
 if(busy){await prepared.env.release?.();stop('role_run_already_active','retry_wait',`委派 ${prepared.scope} 已有运行 ${busy.id}；每个委派同时只有一次运行。`);}
 const controller=new AbortController();prepared.wrapped.cancelSignal=controller.signal;
 let started!:()=>void;const bound=new Promise<void>(resolve=>{started=resolve;});prepared.live.onBound=started;
 const handle:Handle<T>={operation_id:operationId,prepared,controller,settled:false,cancelled:null,done:undefined as any,
  get run_id(){return prepared.live.bound?.run_id??null;},get lease_epoch(){return prepared.live.bound?.epoch??null;},get context(){return prepared.live.bound?.ctx??null;}};
 handles.set(operationId,handle);
 handle.done=runAgent(prepared.wrapped).finally(()=>{handle.settled=true;if(prepared.live.timer)clearTimeout(prepared.live.timer);if(prepared.live.stageTimer)clearTimeout(prepared.live.stageTimer);if(prepared.live.heartbeat)clearInterval(prepared.live.heartbeat);started();});
 handle.done.catch(()=>{});
 await bound;return handle;
}
const internal=<T>(handle:RoleRunHandle<T>)=>{const h=handles.get(handle.operation_id);if(!h)stop('role_run_handle_unknown','failed');return h as Handle<T>;};
/** checkpoint(handle) → the session reference that may be kept, confirmed tool receipts and the workspace snapshot. */
export async function checkpointRoleRun<T>(handle:RoleRunHandle<T>,reason='requested'){
 const h=internal(handle),b=h.prepared.live.bound;if(!b)return stop('role_run_not_started','failed');
 const workspace=await (h.prepared.resolved.snapshot.kind==='writer'?(h.prepared.env.environment?.snapshot??h.prepared.spec.candidateSnapshot):undefined)?.().catch(()=>null)??null;
 return recordCheckpoint(h.prepared.spec.store,{run_id:b.run_id,lease_epoch:b.epoch,instance_id:h.prepared.instance.id,reason,workspace});
}
/**
 * cancel(handle, reason) → receipt. The protocol interrupt comes first (the session's own cancel), then a bounded wait;
 * a run that does not end in time is recorded as stopped, its environment (container and process group) is released and
 * its tokens are revoked. A checkpoint taken before the interrupt keeps the existing artifacts.
 */
export async function cancelRoleRun<T>(handle:RoleRunHandle<T>,reason:string,graceMs=10_000){
 const h=internal(handle),s=h.prepared.spec.store,b=h.prepared.live.bound,requested=new Date().toISOString();
 if(h.settled)return {run_id:b?.run_id??null,lease_epoch:b?.epoch??null,reason,requested_at:requested,already_settled:true,settled:true,forced:false,tokens_revoked:0,environment_released:h.prepared.released};
 h.cancelled=reason;let checkpoint:string|null=null;
 if(b&&leaseCurrent(s,b.run_id,b.epoch)){appendRunEvent(s,{run_id:b.run_id,lease_epoch:b.epoch,type:'cancel_requested',category:'cancelled',operation_id:'cancel:'+requested,data:{reason}});try{checkpoint=(await checkpointRoleRun(handle,'cancel:'+reason)).checkpoint_ref;}catch{}}
 h.controller.abort(new TaskError('harness_cancelled','cancelled',reason));
 const settled=await Promise.race([h.done.then(()=>true,()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),graceMs).unref?.())]);
 let environmentReleased=false;
 if(!settled&&b){endRun(s,{id:b.run_id,task_id:h.prepared.spec.task.id},'stopped','cancel_timeout');await h.prepared.env.release?.().catch(()=>{});environmentReleased=true;}
 const revoked=b?revokeRunTokens(s,b.run_id,'cancelled'):0;
 const receipt={run_id:b?.run_id??null,lease_epoch:b?.epoch??null,reason,requested_at:requested,already_settled:false,settled,forced:!settled,tokens_revoked:revoked,environment_released:environmentReleased,checkpoint_ref:checkpoint};
 if(b)traceEvent(s,h.prepared.spec.task.id,'role_run_cancelled',{protocol:roleRunProtocol.id,...receipt},b.run_id,'framework');
 return receipt;
}
/** The result candidate of a run: what a writer produced, otherwise the findings record bound to the fixed input. */
function outputCandidate(kind:string,result:any,reference:string,ctx:RunContext):CandidateRef{
 if(kind==='writer'&&result?.status==='no_changes')return {kind:'no_changes',ref:reference,source_ref:ctx.source_ref,record_hash:contentHash({source_ref:ctx.source_ref,tree_hash:result.tree_sha??null})};
 const commit=result?.local_sha??result?.commit_sha??result?.sha,tree=result?.tree_sha;
 if(kind==='writer'&&/^[a-f0-9]{40}$/.test(commit??'')&&/^[a-f0-9]{40}$/.test(tree??''))return {kind:'code',ref:reference,commit_sha:commit,tree_hash:tree};
 return {kind:'artifact',ref:reference,revision:'contract:revision:'+ctx.contract_revision,content_hash:contentHash(result)};
}
/**
 * collect(handle) → validated result and immutable refs. A result is accepted only from the run that still holds its lease
 * (a taken-over run's late result is refused), whose role is still authorized, and, for observers, whose fixed input is
 * still the one recorded at start. It is the role's submission, never task acceptance.
 */
export async function collectRoleRun<T>(handle:RoleRunHandle<T>){
 const h=internal(handle),p=h.prepared,s=p.spec.store,task=p.spec.task,live=p.live;let result:T;
 try{
  try{result=await h.done;}
  catch(error){
   const b=live.bound;
   if(b&&leaseCurrent(s,b.run_id,b.epoch)){
    const code=live.stage_exhausted?'stage_budget_exhausted':live.exhausted?'role_budget_exhausted':(error as any).code??'runtime_error';
    if((error as any).code!=='role_revision_checkpoint'&&!live.exhausted)try{recordCheckpoint(s,{run_id:b.run_id,lease_epoch:b.epoch,instance_id:p.instance.id,reason:'ended:'+code,workspace:await p.env.environment?.snapshot?.().catch(()=>null)??null});}catch{}
    appendRunEvent(s,{run_id:b.run_id,lease_epoch:b.epoch,type:'ended',category:code==='role_revision_checkpoint'?'checkpoint':h.cancelled||(error as any).state==='cancelled'?'cancelled':'failed',data:{status:code==='role_revision_checkpoint'?'checkpoint_continuation':h.cancelled?'cancelled':'failed',code,reason:h.cancelled}});
   }
   if(b)revokeRunTokens(s,b.run_id,'ended');
   if(live.stage_exhausted)throw new TaskError('stage_budget_exhausted','paused',live.stage_exhausted);
   if(live.exhausted&&!(error instanceof TaskError&&error.code==='role_budget_exhausted'))throw new TaskError('role_budget_exhausted','waiting_configuration',`${p.role}：本任务中这个角色的累计预算 ${live.exhausted} 已用尽；已取消本次运行并保留已有产物。`);
   throw error;
  }
  const b=live.bound;
  const snapshotter=p.resolved.snapshot.kind==='writer'?(p.env.environment?.snapshot??p.spec.candidateSnapshot??p.env.snapshot):undefined;
  let snapshot:{tree_sha:string;local_sha:string}|null=null;
  if(b&&snapshotter){try{snapshot=await snapshotter()??null;if(!snapshot||!/^([a-f0-9]{40})$/.test(snapshot.tree_sha)||!/^([a-f0-9]{40})$/.test(snapshot.local_sha))throw new Error('invalid_snapshot');}
   catch{traceEvent(s,task.id,'role_run_result_rejected',{run_id:b.run_id,reason:'role_snapshot_unavailable'},b.run_id,'framework');appendRunEvent(s,{run_id:b.run_id,lease_epoch:b.epoch,type:'ended',category:'failed',data:{code:'role_snapshot_unavailable'}});stop('role_snapshot_unavailable','waiting_environment');}}
  if(b){
   if(!leaseCurrent(s,b.run_id,b.epoch)){traceEvent(s,task.id,'role_run_result_rejected',{run_id:b.run_id,lease_epoch:b.epoch,reason:'lease_epoch_stale'},b.run_id,'framework');stop('lease_epoch_stale','cancelled','运行的租约已被接管，迟到的结果不被接受。');}
   const live2=roleAuthority(s,task.repository_id,p.resolved.snapshot,p.spec.finish?.name??p.resolved.snapshot.output_schema.tool??'finish',managedTaskOrigin(s,task.id)?.source_kind==='role');if(live2){traceEvent(s,task.id,'role_run_result_rejected',{run_id:b.run_id,lease_epoch:b.epoch,reason:live2},b.run_id,'framework');stop('role_authority_revoked','waiting_configuration',`${p.role}：${live2}`);}
   if(p.resolved.snapshot.kind==='observer'&&b.ctx.candidate_ref){const now=stageForAssignment(s,p.assignment)?latestRoleCandidate(s,task.id):inputCandidate(s,task,p.role,'observer').ref;if(!now||candidateKey(now)!==candidateKey(b.ctx.candidate_ref)){traceEvent(s,task.id,'role_run_result_rejected',{run_id:b.run_id,lease_epoch:b.epoch,reason:'candidate_changed',started_with:b.ctx.candidate_ref,current:now},b.run_id,'framework');stop('candidate_changed','retry_wait','检视期间固定候选已变化；旧环境的结论不能认证新内容。');}}
  }
  await p.env.release?.();
  const runId=(p as any).executionRun as string|undefined,assignment=p.assignment;
  await p.spec.guard();
  return s.transaction(()=>{
  // Release and the caller's guard may await external work. Recheck immediately before recording a result.
  const revoked=roleAuthority(s,task.repository_id,p.resolved.snapshot,p.spec.finish?.name??p.resolved.snapshot.output_schema.tool??'finish',managedTaskOrigin(s,task.id)?.source_kind==='role');
  if(revoked)stop('role_authority_revoked','waiting_configuration',`${p.role}：${revoked}`);
  if(b)assertLease(s,b.run_id,b.epoch);
  const reference=traceEvent(s,task.id,'role_result',{instance_id:p.instance.id,role:p.role,assignment_id:assignment??null,snapshot_id:p.resolved.id,candidate_version:assignment?s.get('SELECT candidate_version FROM role_assignments WHERE id=?',assignment)?.candidate_version??null:null,contract_revision:s.get('SELECT revision FROM task_records WHERE task_id=?',task.id)?.revision,result:p.spec.redactor.clean(result)},runId,'role:'+p.role,[p.inputRef]);
  let candidate:CandidateRef|null=null;
  if(b){
   const source=JSON.parse(task.input??'{}'),mode=deliveryType(s,task.id);
   candidate=outputCandidate(p.resolved.snapshot.kind,snapshot?{...result as any,...snapshot,...(mode==='code'&&snapshot.tree_sha===source.snapshot_tree?{status:'no_changes'}:{})}:result,reference,b.ctx);
   if(p.resolved.snapshot.kind==='writer'&&mode==='artifact'&&candidate.kind!=='no_changes'&&s.get('SELECT 1 FROM task_stage_plans WHERE task_id=?',task.id))candidate=artifactCandidate(result,snapshot?.tree_sha??null,b.ctx.contract_revision,reference,task.kind);
   validateCandidateRef(candidate);
   appendRunEvent(s,{run_id:b.run_id,lease_epoch:b.epoch,type:'ended',category:'completed',operation_id:'collect:'+b.run_id,data:{status:'completed',result_ref:reference,result_hash:contentHash(p.spec.redactor.clean(result)),candidate_ref:candidate,source_snapshot:snapshot?{commit_sha:snapshot.local_sha,tree_hash:snapshot.tree_sha}:null,input_candidate_ref:b.ctx.candidate_ref,usage:instanceUsage(s,String(p.instance.id))}});
   if(assignment)recordStageResult(s,assignment,b.run_id,b.epoch,{result_ref:reference,candidate_ref:candidate});
   if(assignment)s.run("UPDATE role_assignments SET status='completed',result_ref=? WHERE id=?",reference,assignment);
   revokeRunTokens(s,b.run_id,'collected');
  }
  return {result,reference,instance_id:String(p.instance.id),candidate_ref:candidate,context:b?.ctx??null};
  });
 }finally{if(live.bound)revokeRunTokens(s,live.bound.run_id,'collect_ended');await p.env.release?.().catch(()=>{});handles.delete(h.operation_id);}
}
/** events(handle, after_cursor) → a bounded page of the run's normalized events. */
export function roleRunEvents<T>(store:Store,handle:RoleRunHandle<T>|string,after=0,limit=100){const id=typeof handle==='string'?handle:handle.run_id;if(!id)return stop('role_run_not_started','failed');return runEvents(store,id,after,limit);}
export async function runRole<T>(spec:AgentSpec<T>,role:string,assignment?:string,harnessOverride?:string,options:RoleRunOptions={}):Promise<{result:T;reference:string;instance_id:string;candidate_ref:CandidateRef|null;context:RunContext|null}>{
 assertTaskRole(spec.store,spec.task,role);
 const s=spec.store,task=spec.task,existing=s.get('SELECT * FROM role_instances WHERE task_id=? AND role=?',task.id,role);
 // Under a legacy configuration an existing instance keeps the harness it was first bound to; V2 resolves the current revision.
 const pinned=!harnessOverride&&!!existing&&roleConfig(s,task).legacy;
 let resolved=taskRole(s,task,role,harnessOverride??(pinned?existing!.harness:undefined),pinned,undefined,spec.model,options.entryExecutor);
 let instance=existing??roleInstance(s,task,role,harnessOverride,options.entryExecutor),continuation:{ref:string;from_run:string|null}|null=null;
 // A new assignment is a safe boundary: it starts on the current revision. An instance created before RoleDefinitionV2
 // under a legacy configuration keeps the definition it was pinned with.
 if(instance.snapshot_id!==resolved.id&&!(resolved.snapshot.legacy&&!instance.snapshot_id))instance=rebind(s,task,instance,resolved,'delegation').instance;
 const sourceInput=spec.prompt;
 const priorRun=s.get("SELECT id,stop_reason,assignment_id FROM task_runs WHERE role_instance_id=? ORDER BY rowid DESC LIMIT 1",instance.id),priorSubmission=priorRun?.stop_reason==='role_result_invalid'?s.get("SELECT id FROM task_history WHERE run_id=? AND type='tool_started' AND json_extract(data,'$.name')=? ORDER BY id DESC LIMIT 1",priorRun.id,spec.finish?.name??''):null;
 let memory:any;try{memory={availability:'available',...new ProjectMemory(s,taskMemoryAccess(s,{...task,active_role:role})).search(task.repository_id,'',{role,limit:5,baseline:executionBaseline(task)})};}catch{memory={availability:'unavailable',instruction:'Role memory lookup failed; continue from task records and repository sources. Do not infer no prior knowledge.'};traceEvent(s,task.id,'memory_fault',{operation:'role_context',role,code:'role_memory_unavailable'},task.trace_run_id);}
 const previousRole=task.active_role;task.active_role=role;
 try{
 for(;;){
  const prepared=await prepareRun(spec,role,assignment,harnessOverride,options,{resolved,instance,continuation},{sourceInput,priorRun,priorSubmission,memory});
  const handle=await startRoleRun(prepared);
  try{const collected=await collectRoleRun(handle);return collected;}
  catch(error){
   if(!(error instanceof TaskError&&error.code==='role_revision_checkpoint'))throw error;
   // The old run ended at a safe checkpoint with its own snapshot. Continue the same assignment on the new revision.
   const executionRun=(prepared as any).executionRun as string|undefined;
   const next=taskRole(s,task,role,harnessOverride,false,roleConfiguration(s,task.repository_id),spec.model,options.entryExecutor);const moved=rebind(s,task,s.get('SELECT * FROM role_instances WHERE id=?',prepared.instance.id)!,next,'checkpoint',executionRun);
   resolved=next;instance=moved.instance;continuation={ref:moved.ref,from_run:executionRun??null};options={...options,recover:undefined};continue;
  }
 }
 }finally{task.active_role=previousRole;}
}
/**
 * The RoleRun protocol operations. prepare assembles the run exactly as runRole does (snapshot, admission, tools, budget);
 * recover is prepare+start of a new run (new task_runs id and lease epoch) for the same instance and assignment, with
 * resume_from_run_id and the planned recovery mode.
 */
export const roleRuns={
 protocol:roleRunProtocol,
 async prepare<T>(spec:AgentSpec<T>,role:string,assignment?:string,harnessOverride?:string,options:RoleRunOptions={}){
  const s=spec.store,task=spec.task,instance=roleInstance(s,task,role,harnessOverride,options.entryExecutor),resolved=taskRole(s,task,role,harnessOverride,false,undefined,spec.model,options.entryExecutor);
  const bound=instance.snapshot_id!==resolved.id&&!(resolved.snapshot.legacy&&!instance.snapshot_id)?rebind(s,task,instance,resolved,'delegation').instance:instance;
  const previousRole=task.active_role;task.active_role=role;
  try{return await prepareRun(spec,role,assignment,harnessOverride,options,{resolved,instance:bound,continuation:null},{sourceInput:spec.prompt,priorRun:undefined,priorSubmission:null,memory:{availability:'not_loaded'}});}finally{task.active_role=previousRole;}
 },
 start:startRoleRun,events:roleRunEvents,checkpoint:checkpointRoleRun,cancel:cancelRoleRun,collect:collectRoleRun,
 async recover<T>(spec:AgentSpec<T>,role:string,assignment:string|undefined,previousRunId:string,checkpointRef?:string|null,harnessOverride?:string){
  const s=spec.store,previous=s.get('SELECT run_context FROM task_runs WHERE id=? AND task_id=?',previousRunId,spec.task.id);if(!previous)stop('role_run_unknown','failed');
  const prepared=await roleRuns.prepare(spec,role,assignment,harnessOverride,{recover:{previous_run_id:previousRunId,checkpoint_ref:checkpointRef??null}});
  const handle=await startRoleRun(prepared);
  return {handle,recovery_mode:s.get('SELECT protocol_recovery FROM task_runs WHERE id=?',handle.run_id)?.protocol_recovery??null};
 }
};
