import {nominationSource,validateNominationResult} from './nomination.js';
import {SubmissionError} from './submission-error.js';
import {candidateParticipation} from './participation.js';
import {childTaskContext,waitForChildren} from '../tasks/children.js';
import {eventSubscriptionToolNames,eventSubscriptionTools,executeTaskSubscriptionTool,taskEventSubscriptionContext} from '../tasks/event-subscriptions.js';
import {versionTools} from '../tasks/versions.js';
import {reviewUpdateFacts} from '../review/sessions.js';
import {setTaskPriority,priorityInstructions} from '../tasks/priority.js';
import {relateTasks} from '../tasks/followups.js';
import { latestRoleCandidate, candidateKey } from './schedule.js';
import {coordinationTools,readProjectTask,waitForCoordinatedTasks} from '../tasks/coordination.js';
import { taskTraceAccess } from '../memory/access.js';
import type { AgentSpec } from '../agent/runtime.js';
import { randomId } from '../core/security.js';
import { sha,stop,TaskError } from '../agent/common.js';
import { traceEvent,traceSource } from '../tasks/trace.js';
import { grantView } from '../tasks/grants.js';
import { sourcePolicies } from '../tasks/management.js';
import { TaskRecords } from '../tasks/service.js';
import { taskTools,taskRecordInstructions } from '../tasks/record-tools.js';
import { publicationDecision } from '../tasks/publication.js';
import { runRole,roleConfig,roleInstance,type RoleRunOptions } from './run.js';
import { findingsSchema,nominationSchema } from './catalog.js';
import { UnsupportedCapabilityError } from './role-run.js';
import type { Workspace } from '../agent/workspace.js';
import { controllerWorkspaceInstructions,workspaceContext,workspaceTool,workspaceToolNames,workspaceTools } from '../agent/workspace-tools.js';
const tool=(name:string,description:string,properties:any,required:string[]=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const readRecord=tool('read_task_record','Read a durable record from THIS task by offered reference; use offset to page its JSON.',{ref:{type:'string'},offset:{type:'integer'}},['ref']);
export interface TeamEnvironment {
 /** Entry-specific observer tool descriptions and defaults; execution still uses the entry callback. */
 observerTools?:AgentSpec<any>['tools'];
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
 /** The task's workspace (#769). While it holds no worktree, the controller chooses one for the task, or none. */
 workspace?:Workspace;
 /** Entry-specific checks for a Dev result after the controller has applied its description overrides. */
 validateOwnNomination?:(result:any)=>Promise<void>;
}
/** The controller has no executor callback, publication tool or completion authority. */
export async function runTeam<T>(spec:AgentSpec<T>,environment:TeamEnvironment):Promise<T>{
 const records=new TaskRecords(spec.store),s=spec.store,task=spec.task,config=roleConfig(s,task),controller=config.controller.role;
 const pool=config.roles.filter(r=>r.enabled),workers=environment.workers??pool.filter(r=>r.kind==='writer'||r.kind==='observer').map(r=>r.role_id),devDefinition=pool.find(r=>r.role_id==='dev');
 // One record per distinct refused call: the model output is screened, and the call is checked again when executed.
 const recorded=new Set<string>(),denied=(reason:string,detail:any,args:any)=>{const key=sha(reason+JSON.stringify(args??null));if(recorded.has(key))return;recorded.add(key);traceEvent(s,task.id,'capability_denied',{role:controller,tool:'delegate_role',reason,...detail},task.trace_run_id,'framework');};
 // Delegation cannot carry authority: only an offered worker role, a purpose and task record references.
 const delegationProblem=(args:any):[string,any]|null=>!args||typeof args!=='object'||Object.keys(args).some(k=>!['role','purpose','refs'].includes(k))?['delegation_scope_invalid',{fields:args&&typeof args==='object'?Object.keys(args):null}]
  :!workers.includes(args.role)?['delegation_not_allowed',{requested_role:typeof args.role==='string'?args.role.slice(0,64):null}]:null;
 let executed:string|undefined;
 // What a Dev result would publish (#1106). The Manager sees the developer's text where it decides on nomination, in its
 // input and in delegate_role's answer, so it can keep it unchanged instead of writing its own.
 const devText=(ref?:string|null)=>{
  const id=ref?/^task_history:(\d+)$/.exec(ref)?.[1]:undefined;
  const row=ref?id?s.get("SELECT id,data FROM task_history WHERE id=? AND task_id=? AND type='role_result'",Number(id),task.id):undefined
   :s.get("SELECT id,data FROM task_history WHERE task_id=? AND type='role_result' AND json_extract(data,'$.role')='dev' ORDER BY id DESC LIMIT 1",task.id);
  const result=row?JSON.parse(row.data).result:null;
  return typeof result?.summary==='string'?{ref:'task_history:'+row!.id,summary:result.summary,...(typeof result.change_title==='string'?{change_title:result.change_title}:{})}:undefined;
 };
 const devReturn=(ref:string|null|undefined)=>{const {ref:_ref,...text}=devText(ref)??{ref:null};return text;};
 // Which entry point ran under which configuration revision: the task keeps its id, contract, candidate and history.
 traceEvent(s,task.id,'controller_entry',{entry:environment.entry??(task.kind==='task.request'?'request':'development'),controller,config_revision:config.revision,legacy:!!config.legacy,workers,executor:environment.executor?{role:'dev',harness:environment.executor.harness??(devDefinition?.entry_harness_source==='role'?devDefinition.harness_ref.id:'pi')}:null,attempt:task.attempt},task.trace_run_id,'framework');
 const resolveHandoff=(ref:string)=>{
  // Cross-task task: refs are authorized by the existing managed-task boundary in runRole.
  const other=/^task:([^:]+)$/.exec(ref),target=other&&other[1]!==task.id?s.get('SELECT id FROM tasks WHERE id=? AND repository_id=?',other[1]!,task.repository_id):null;
  return traceSource(s,target?.id??task.id,ref,taskTraceAccess(s,task));
 };
 const read=async(args:any)=>{if(!Number.isSafeInteger(args.offset??0)||(args.offset??0)<0)return {error:'invalid_offset'};let source;try{source=traceSource(s,task.id,String(args.ref),taskTraceAccess(s,task));}catch(error){return {error:(error as any).code==='trace_role_private'?'task_record_forbidden':'task_record_not_found',ref:args.ref,task_ref:'task:'+task.id,instruction:'Record refs belong to this task. Use its offered refs, or read_managed_task(task_id, source) for another authorized task. Parent/child task: refs can be handed off directly.'};}const text=JSON.stringify(source),offset=args.offset??0;traceEvent(s,task.id,'role_record_read',{role:task.active_role,ref:args.ref,offset},task.trace_run_id,'role:'+task.active_role,[args.ref]);return {ref:args.ref,content:text.slice(offset,offset+16000),next_offset:offset+16000<text.length?offset+16000:null};};
 const commonExecute=async(name:string,args:any)=>{if(name==='read_child_tasks')return childTaskContext(s,task.id);if(name==='wait_for_children'){const result=waitForChildren(s,task,args);if('waiting' in result&&result.waiting)stop('task_children_pending','waiting_coordination','Waiting for any child result; no execution slot held.');return result;}if(name==='wait_for_tasks'){const result=waitForCoordinatedTasks(s,task,args);if(result.waiting)stop('task_coordination_requested','waiting_coordination','Waiting for declared task dependencies; no execution slot held.');return result;}if(eventSubscriptionToolNames.includes(name))return executeTaskSubscriptionTool(s,{...task,active_role:task.active_role??controller},name,spec.redactor.clean(args));if(name==='list_project_tasks')return s.all("SELECT t.id,t.summary,t.status,r.revision FROM tasks t JOIN task_records r ON r.task_id=t.id WHERE t.repository_id=? ORDER BY t.created_at DESC,t.id LIMIT 100",task.repository_id);if(name==='read_project_task')return readProjectTask(s,task.repository_id,args);if(name==='read_task_record')return read(args);return spec.execute?.(name,args);};
 const children=[tool('read_child_tasks','Read children, durable return events and result/evidence refs. Read originals through read_managed_task. Return cursor is passed to wait_for_children.',{}),tool('wait_for_children','Acknowledge handled child events and wait for ANY new result, successful or not. Releases this task slot; does not stop other children. Read and handle events before passing their after_event_id.',{after_event_id:{type:'integer'},reason:{type:'string'}},['after_event_id','reason'])];
 const findings={type:'function',function:{name:'submit_role_result',description:'Persist findings for the fixed inspected candidate. This cannot approve or finish the task.',parameters:findingsSchema}};
 const validateFindings=(v:any)=>{if(Array.isArray(v?.findings)&&v.findings.some((f:any)=>typeof f?.evidence==='string')){v={...v,findings:v.findings.map((f:any)=>typeof f?.evidence==='string'?{...f,evidence:[f.evidence]}:f)};traceEvent(s,task.id,'role_result_normalized',{role:task.active_role,field:'findings.evidence',from:'string',to:'string_array'},task.trace_run_id,'framework');}if(!v||typeof v.summary!=='string'||!v.summary.trim()||!Array.isArray(v.findings)||v.findings.some((f:any)=>!f||typeof f.description!=='string'||!f.description.trim()||!Array.isArray(f.evidence)||f.evidence.some((e:any)=>typeof e!=='string'))||!Array.isArray(v.inspected_scope)||v.inspected_scope.some((x:any)=>typeof x!=='string')||!Array.isArray(v.unknowns)||v.unknowns.some((x:any)=>typeof x!=='string'))return stop('role_result_invalid','retry_wait','Expected summary, findings with string-array evidence, inspected_scope string[] and unknowns string[].');return spec.redactor.clean(v);};
 const delegate=tool('delegate_role','Ask dev/test/reviewer/ux to work. Handoff uses persistent references, not copied conversations. Reuse dev for fixes. Success returns a result reference to read. A missing admission capability returns started:false, missing/available capabilities and evidence; decide how to continue in this session.',{role:{type:'string',enum:workers},purpose:{type:'string',description:'Short purpose, at most 2000 characters. The worker already receives the contract; use refs for detailed requirements/evidence instead of copying them.'},refs:{type:'array',description:'At most 20 persistent references, each at most 200 characters.',items:{type:'string'}}},['role','purpose','refs']);
 const nominate={type:'function',function:{name:'nominate_delivery',description:'Nominate the latest own Dev result OR an accepted child task:<id> result, with optional supporting_refs. Child references reuse evidence only: they do not import files. Inspect/integrate the current parent workspace as needed before nominating; independent QA evaluates the entire parent contract on that workspace. No new Dev run is mandatory. This does not approve, publish or merge.',parameters:nominationSchema}};
 const parallel=tool('delegate_roles','Run independent read-only observer roles on the same fixed candidate concurrently. Never include a writer. Returns one result reference per assignment.',{assignments:{type:'array',items:delegate.function.parameters}},['assignments']);
 const priority=tool('set_task_priority','Task Manager ranks same-project tasks from evidence using P0-P3. Changed priority joins its new level tail; never preempts running work.',{task_id:{type:'string'},priority:{type:'string',enum:['P0','P1','P2','P3']},reason:{type:'string'}},['priority','reason']);
 const relation=tool('relate_task','Record your judgment: same_problem, related, or recurrence. Cite evidence. Records the link without pausing tasks.',{task_id:{type:'string'},key:{type:'string'},relationship:{type:'string',enum:['same_problem','related','recurrence']},reason:{type:'string'},evidence:{type:'string'}},['task_id','key','relationship','reason','evidence']);
 // A generic task (#814): the Task Manager sees its writes and may change them with grant_writes (a task-management tool
 // runRole offers the controller); the worker it delegates next gets the matching delivery tools.
 const generic=s.get('SELECT 1 FROM task_write_grants WHERE task_id=?',task.id);
 const disposition=tool('finish_coordination','Finish this coordination turn without delivery: continue later, wait for an external condition, or explicitly request human help. Never nominates, publishes or completes the task.',{action:{type:'string',enum:['continue','wait','needs_help']},reason:{type:'string'},delay_seconds:{type:'integer',minimum:5,maximum:86400},help_from:{type:'string'},resume_condition:{type:'string'}},['action','reason']);
 // The controller chooses the task's worktree while the task holds none (#769); without a choice the system's applies when
 // the task first needs its files. Its roles get no such tools: they work in what it chose. The rule goes in the prompt, as
 // a role run keeps only its role's own system prompt.
 const worktreePlan=environment.workspace?.plannedWorktree?.();
 const choosing=!!worktreePlan&&worktreePlan.state!=='bound';
 // Once a delegated role has run in this attempt, the choice holds for the attempt: the entry executor is the one session of
 // the task workspace, and running it again in the same attempt returns that session's result. A new attempt prepares the
 // task again, and the controller chooses before it delegates.
 const roleRan=()=>!!s.get('SELECT 1 FROM task_runs WHERE task_id=? AND attempt=? AND role IS NOT NULL AND role<>? LIMIT 1',task.id,task.attempt,controller);
 const choose=async(name:string,args:any)=>name!=='list_workspaces'&&roleRan()?{error:'workspace_choice_final',
   message:'A delegated role already ran in this attempt, so the workspace choice holds for the rest of it. For a run with a different workspace, end this turn with finish_coordination (action continue): the next attempt prepares the task again and you choose before delegating.'}
  :spec.redactor.clean(await workspaceTool(environment.workspace!,name,spec.redactor.clean(args),controller));
 // A report request runs as the Manager (#851), so the Manager keeps the github_write its own role allows there: a project
 // scheduled task can start a workflow or file an Issue itself (#1072). Each call still checks the acting role and the
 // project ceiling; workers keep it only where their own role writes, and generic tasks follow their grants instead. The
 // Manager's prompt carries the entry's late_scheduled_runs too, since it is the one that can file that recommendation.
 const managerWrite=!generic&&task.kind==='task.request'&&records.get(task.id).contract?.endpoint==='report'?(spec.tools??[]).filter(t=>t.function.name==='github_write'):[];
 // A review's Manager reads at every run which updates the result it would nominate does not cover, and that the platform
 // publishes regardless (#1100); a Dev run it delegates reports the same facts again for the result it made.
 const reviewUpdates=environment.entry==='review'?()=>reviewUpdateFacts(s,task):undefined;
 const subscriptionCtx=taskEventSubscriptionContext(s,String(task.id));
 // Every Manager disposition (a turn ending without a nomination, or finish_coordination) defers a review's
 // publication; the defer decision records the disposition it came from once, after runRole returns.
 let dispositionTrace:string[]=[];
 const managerTools=[...children,disposition,...(spec.tools??[]).filter(t=>eventSubscriptionTools.some(e=>e.function.name===t.function.name)),...(spec.tools??[]).filter(t=>versionTools.some(v=>v.function.name===t.function.name)),...managerWrite,priority,relation,delegate,...(environment.withRole?[parallel]:[]),nominate,readRecord,...taskTools.filter(t=>!coordinationTools.some(c=>c.function.name===t.function.name)),...coordinationTools,...(choosing?workspaceTools:[])];
 const managerSpec:AgentSpec<T>={...spec,guard:async()=>{await spec.guard();},candidateSnapshot:undefined,adapter:undefined,session:undefined,pi:undefined,onTurnEnd:turn=>{dispositionTrace=[traceEvent(s,task.id,'manager_observation',turn,task.trace_run_id,'role:'+controller)];return {manager_disposition:{action:'continue',reason:turn.text||'Harness turn ended without a delivery nomination; retained for the next coordination turn.',delay_seconds:30}} as T;},system:'Task Manager. '+priorityInstructions+' '+taskRecordInstructions,prompt:JSON.stringify({...(choosing?{workspace:{...workspaceContext(worktreePlan!),instruction:controllerWorkspaceInstructions}}:{}),...(subscriptionCtx?{event_subscriptions:subscriptionCtx}:{}),version_context:(()=>{try{return JSON.parse(spec.prompt).version_context;}catch{return undefined;}})(),integration:(()=>{try{return JSON.parse(spec.prompt).integration;}catch{return undefined;}})(),late_scheduled_runs:(()=>{try{return JSON.parse(spec.prompt).late_scheduled_runs;}catch{return undefined;}})(),...(reviewUpdates?{review_updates:reviewUpdates()}:{}),task_id:task.id,task_ref:'task:'+task.id,contract_ref:'contract:revision:'+records.get(task.id).revision,contract:records.get(task.id).contract,...(generic?{writes:grantView(s,task,sourcePolicies(s,task),[config.roles.find(r=>r.role_id===controller)?.permissions].filter(Boolean) as any[])}:{}),current_state:records.context(task.id),roles:pool.filter(r=>workers.includes(r.role_id)||r.kind==='evaluator').map(r=>({id:r.role_id,name:r.name,responsibility:r.responsibility,kind:r.kind,revision:r.revision,harness:r.harness_ref.id,delegable:workers.includes(r.role_id)})),recent_results:s.all("SELECT id,type FROM task_history WHERE task_id=? AND type IN ('role_result','acceptance') ORDER BY id DESC LIMIT 12",task.id).map(r=>({ref:'task_history:'+r.id,type:r.type})),latest_dev_result:devText(),candidate_participation:candidateParticipation(s,task.id)}),tools:managerTools,maxTurns:32,finish:{name:'nominate_delivery',names:['nominate_delivery','finish_coordination'],validate:async(args,name)=>{
  if(name==='finish_coordination'){if(!['continue','wait','needs_help'].includes(args?.action)||typeof args.reason!=='string'||!args.reason.trim()||args.action==='needs_help'&&(!args.help_from?.trim()||!args.resume_condition?.trim())||args.action==='wait'&&!args.resume_condition?.trim())return stop('role_result_invalid','retry_wait','Provide action/reason; wait needs resume_condition, needs_help also needs help_from.');const value={action:args.action,reason:args.reason,help_from:args.help_from,resume_condition:args.resume_condition,delay_seconds:Math.max(5,Math.min(86400,Number(args.delay_seconds)||30))};dispositionTrace=[traceEvent(s,task.id,'manager_disposition',value,task.trace_run_id,'role:manager')];return {manager_disposition:value} as T;}

  const source=nominationSource(s,task,args?.result_ref);
  if(args.supporting_refs!==undefined&&(!Array.isArray(args.supporting_refs)||args.supporting_refs.length>20))throw new SubmissionError('role_nomination_invalid',{reason:'invalid_supporting_refs',expected:'An array of at most 20 references',submitted_ref:args.result_ref});
  const supporting=(args?.supporting_refs??[]).map((ref:unknown)=>nominationSource(s,task,ref));
  if(JSON.parse(task.input||'{}').integration&&source.own){const run=s.get("SELECT r.attempt FROM task_history h JOIN task_runs r ON r.id=h.run_id WHERE h.task_id=? AND 'task_history:'||h.id=?",task.id,args.result_ref);if(run?.attempt!==task.attempt)throw new SubmissionError('role_nomination_stale',{reason:'integration_attempt_mismatch',submitted_ref:args.result_ref,expected_attempt:task.attempt,observed_attempt:run?.attempt??null,discovery:{tool:'read_version_context',arguments:{}}});}
  const nominated={...source.result,...(args.summary?{summary:args.summary}:{}),...(args.change_title?{change_title:args.change_title}:{})};
  if(source.own)await environment.validateOwnNomination?.(nominated);
  // Another task's result never saw this review's updates: without the stamp the entry's validation adds, it covers what
  // the round started with (src/review/sessions.ts).
  const result=source.own?nominated:reviewUpdates?{...await validateNominationResult(spec,nominated),updates_through:undefined}:await validateNominationResult(spec,nominated);
  // What the Manager nominated with (#1250): who produced results for the candidate, and its own note on the checks.
  const checksNote=typeof args.checks_note==='string'&&args.checks_note.trim()?spec.redactor.text(args.checks_note.trim()).slice(0,2000):undefined;
  traceEvent(s,task.id,'delivery_nominated',{result_ref:args.result_ref,sources:[source,...supporting].map(({source_task_id,source_ref,provenance})=>({task_id:source_task_id,ref:source_ref,...provenance})),candidate_scope:'current_parent_workspace',qa_required:true,candidate_participation:candidateParticipation(s,source.source_task_id)??null,...(checksNote?{checks_note:checksNote}:{})},task.trace_run_id,'role:manager',[source.source_ref,...supporting.map((r:any)=>r.source_ref)]);return result as T;
 }},finalizationTools:['nominate_delivery','finish_coordination'],validate:()=>stop('role_nomination_required','retry_wait'),
  screen:(name,args)=>{const problem=name==='delegate_role'?delegationProblem(args):null;if(problem)denied(problem[0],problem[1],args);},
  execute:async(name,args)=>{
  if(name==='github_write'&&managerWrite.length)return spec.execute!(name,args);
  if(choosing&&workspaceToolNames.includes(name))return choose(name,args);
  if(['read_child_tasks','wait_for_children',...eventSubscriptionToolNames].includes(name))return commonExecute(name,args);
  if(name==='delegate_roles'){if(!environment.withRole||!Array.isArray(args?.assignments)||args.assignments.length<1||args.assignments.length>8||new Set(args.assignments.map((a:any)=>a?.role)).size!==args.assignments.length||args.assignments.some((a:any)=>delegationProblem(a)||pool.find(r=>r.role_id===a.role)?.kind!=='observer'))return {error:'parallel_observers_required'};const run=()=>Promise.allSettled(args.assignments.map((a:any)=>environment.withRole!(a.role,()=>managerSpec.execute!('delegate_role',a))));const settled=await (environment.withObservers?environment.withObservers(run):run());const stopped=settled.find(r=>r.status==='rejected'&&r.reason instanceof TaskError&&r.reason.state!=='retry_wait');if(stopped?.status==='rejected')throw stopped.reason;return {results:settled.map(r=>r.status==='fulfilled'?r.value:{error:(r.reason as any)?.code??String(r.reason)})};}
  if(name==='delegate_role'&&environment.withRole&&!args?.__role_scope){const scoped={...args};Object.defineProperty(scoped,'__role_scope',{value:true});return environment.withRole(args?.role,()=>managerSpec.execute!(name,scoped));}
  if(name==='set_task_priority'){const id=args?.task_id??task.id;if(!s.get('SELECT id FROM tasks WHERE id=? AND repository_id=?',id,task.repository_id))return {error:'followup_task_out_of_scope'};return setTaskPriority(s,id,args.priority,args.reason,'role:manager');}
  if(name==='relate_task')return relateTasks(s,task,args);
  if(coordinationTools.some(t=>t.function.name===name))return commonExecute(name,spec.redactor.clean(args));
  if(versionTools.some(t=>t.function.name===name))return commonExecute(name,args);
  if(name==='read_task_record')return read(args);
  if(taskTools.some(t=>t.function.name===name))return records.tool(task.id,name,spec.redactor.clean(args),taskTraceAccess(s,task));
  if(name!=='delegate_role')return {error:'tool_not_allowed'};
  const problem=delegationProblem(args);
  if(problem){denied(problem[0],problem[1],args);return problem[0]==='delegation_scope_invalid'?{error:'delegation_not_allowed',instruction:'Delegation carries only role, purpose and refs; tools, models, harnesses and permissions come from the role configuration.'}
   :{error:'delegation_not_allowed',roles:workers,instruction:'Only the offered worker roles can be delegated to. Independent QA runs after nomination; it is never delegated.'};}
  if(typeof args.purpose!=='string'||!args.purpose.trim()||args.purpose.length>2000||!Array.isArray(args.refs)||args.refs.length>20||args.refs.some((ref:any)=>typeof ref!=='string'||ref.length>200))return {error:'invalid_role_assignment',limits:{purpose_max_chars:2000,refs_max_items:20,ref_max_chars:200},received:{purpose_chars:typeof args?.purpose==='string'?args.purpose.length:null,refs_count:Array.isArray(args?.refs)?args.refs.length:null},task_ref:'task:'+task.id,contract_ref:'contract:revision:'+records.get(task.id).revision,instruction:'The worker receives the contract. Use a short purpose and persistent refs for details, or choose another arrangement.'};
  if(environment.executor&&args.role==='dev'&&executed)return {result_ref:executed,reused:true,...devReturn(executed),candidate_participation:candidateParticipation(s,task.id),instruction:'This entry runs its executor once per call. Read this result and nominate it.',...(reviewUpdates?{review_updates:reviewUpdates()}:{})};
  for(const ref of args.refs){try{resolveHandoff(String(ref));}catch{return {error:'invalid_task_reference',ref,task_ref:'task:'+task.id,instruction:'Use record refs owned by this task, or an authorized parent/child task: ref. For another task original, use read_managed_task(task_id, source).'};}}
  const revision=records.get(task.id).revision,context=await environment.prepare(args.role);
  try{
   const sourceVersion=s.get("SELECT json_extract(data,'$.version') version FROM task_history WHERE task_id=? AND type='role_candidate' AND json_extract(data,'$.role')=? ORDER BY id DESC LIMIT 1",task.id,args.role)?.version??null;
   const inputKey=sha(JSON.stringify({role:args.role,purpose:args.purpose,refs:args.refs,revision,attempt:task.attempt,candidate_key:args.role==='dev'?undefined:candidateKey(latestRoleCandidate(s,task.id)),...(args.role==='dev'?environment.executor?{round:environment.executor.round}:{}:{candidate_version:sourceVersion})}));
   const existing=s.get('SELECT * FROM role_assignments WHERE task_id=? AND input_ref=?',task.id,inputKey);
   if(existing?.status==='completed'){if(environment.executor&&args.role==='dev')executed=existing.result_ref;return {result_ref:existing.result_ref,reused:true,...(args.role==='dev'?devReturn(existing.result_ref):{}),candidate_participation:candidateParticipation(s,task.id),...(args.role==='dev'&&reviewUpdates?{review_updates:reviewUpdates()}:{})};}
   const assignment=existing?.id??randomId();
   const handoff=existing?null:traceEvent(s,task.id,'role_handoff',{assignment_id:assignment,role:args.role,purpose:args.purpose,refs:args.refs,revision},task.trace_run_id,'role:manager',args.refs);
   const role=args.role,dev=role==='dev';
   // Worker roles share the entry's inspection, GitHub read, memory and command tools; only executor delivery/finishing tools stay exclusive to dev.
   // runRole filters offered tools again against the role's own permissionSnapshot (#381, #1121).
   const devExclusive=new Set(['submit_delivery','submit_report','open_pull_request','post_review','create_pull_request','report_development_milestone','rerun_failed_run','subscribe_event','cancel_event_subscription',...(generic?['github_write']:[])]);
   const narrow=dev?spec.tools??[]:(environment.observerTools??spec.tools??[]).filter(t=>!devExclusive.has(t.function.name)&&!t.function.name.startsWith('finish_'));
   const roleSpec:AgentSpec<any>={...spec,candidateSnapshot:dev?(environment.writerSnapshot??environment.snapshot??spec.candidateSnapshot):undefined,onRun:id=>{environment.bindRun?.(id);spec.onRun?.(id);},adapter:undefined,pi:undefined,tools:[...narrow,readRecord,...(dev?[]:[findings])],system:dev?spec.system:'Inspect the candidate in the shared task workspace (reusing existing dependencies, build caches and test artifacts when present). Do not modify tracked source files or claim unexecuted checks.',prompt:JSON.stringify({task_id:task.id,contract:records.get(task.id).contract,purpose:args.purpose,refs:args.refs,handoff_ref:handoff,previous_acceptance:records.get(task.id).acceptance,source_context:dev?spec.prompt:undefined}),execute:commonExecute,finish:dev?spec.finish:{name:'submit_role_result',validate:validateFindings},finalizationTools:dev?spec.finalizationTools:['submit_role_result'],validate:dev?spec.validate:content=>validateFindings(JSON.parse(content))};
   // Create the persistent instance before linking the assignment. runRole reuses it.
   const executor=dev?environment.executor:undefined,instance=roleInstance(s,task,role,executor?.harness,!!executor);
   if(!existing)s.run('INSERT INTO role_assignments VALUES(?,?,?,?,?,?,?,?)',assignment,task.id,instance.id,revision,sourceVersion,'pending',inputKey,null);
   s.run("UPDATE role_assignments SET status='running' WHERE id=?",assignment);
   try{const result=await runRole({...roleSpec,task:dev?task:{...task},prompt:JSON.stringify({...JSON.parse(roleSpec.prompt),candidate_version:s.get('SELECT candidate_version FROM role_assignments WHERE id=?',assignment)?.candidate_version??null})},role,assignment,executor?.harness,{entryExecutor:!!executor,prepare:executor?.prepare??environment.worker,...(dev?{snapshot:environment.snapshot}:{})});
   s.run("UPDATE role_assignments SET status='completed',result_ref=? WHERE id=?",result.reference,assignment);if(executor)executed=result.reference;
   return {result_ref:result.reference,instance_id:result.instance_id,...(dev?devReturn(result.reference):{}),candidate_participation:candidateParticipation(s,task.id),...(dev&&reviewUpdates?{review_updates:reviewUpdates()}:{})};}catch(error){
    // A run whose lease was taken over no longer owns the assignment: the current run decides its status.
    if((error as any)?.code!=='lease_epoch_stale')s.run("UPDATE role_assignments SET status='failed' WHERE id=? AND status='running'",assignment);const admission=error instanceof UnsupportedCapabilityError?error.observation:undefined;
    traceEvent(s,task.id,'role_assignment_fault',{assignment_id:assignment,role,code:(error as any).code??'runtime_fault',...(admission?{started:false,admission_ref:admission.admission_ref}:{})},task.trace_run_id,'framework');
    if(error instanceof UnsupportedCapabilityError)return {error:'unsupported_capability',...error.observation,assignment_id:assignment,detail:error.detail,instruction:'Use these actual role/environment capabilities to decide whether to choose another eligible role or environment, wait, or request help. This assignment did not start; its requirements are unchanged.'};
    throw error;}
  }finally{await context?.();}
 }};
 const result=(await runRole(managerSpec,controller,undefined,undefined,{prepare:environment.controller})).result;
 const dispositionResult=(result as any)?.manager_disposition;
 // A review's Manager decider either nominates (publish/next round) or defers; both finish_coordination and a Harness turn
 // ending without a nomination arrive here, so the defer decision is recorded exactly once for either path.
 if(dispositionResult&&String(task.kind).startsWith('review.')&&['continue','wait'].includes(dispositionResult.action))
  publicationDecision(s,task,'defer',{reason:dispositionResult.reason,manager_action:dispositionResult.action,caused_by:dispositionTrace.filter(Boolean)});
 if(dispositionResult)return stop(dispositionResult.action==='needs_help'?'manager_needs_help':'manager_deferred',dispositionResult.action==='needs_help'?'needs_help':'retry_wait',JSON.stringify(dispositionResult),dispositionResult.delay_seconds*1000);
 return result;
}
