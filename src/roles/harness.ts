import {resolveCommandTimeout} from '../agent/command.js';
import {checkHarnessAccess} from '../harness/access.js';
import {computeAllowedGithubScopes,githubHostFromApiUrl,persistentCliStateWorkspaceId,ScopedReadTokens} from '../harness/container-session.js';
import {useWorkspace} from '../projects/workspace-cleanup.js';
import { randomId } from '../core/security.js';
import { managedSession } from '../harness/session.js';
import { claudeCodeHarness } from './claude-code.js';
import { createTaskToolDispatcher } from './task-tools.js';
import { prepareClaudeCode } from '../harness/claude-code.js';
import { claudeCodeRuntime } from '../harness/claude-code-protocol.js';
import { codexHarness, prepareCodex } from '../harness/codex.js';
import { COMPATIBLE_CLI_RANGES } from '../harness/agent-tools.js';
import type { AgentToolCli } from '../harness/agent-tools.js';
import type { AgentSpec,AgentServices } from '../agent/runtime.js';
import { TaskError, stop } from '../agent/common.js';
import { traceEvent } from '../tasks/trace.js';
import { piAdapter,piRuntime } from '../agent/pi.js';
import type { RoleKind } from './catalog.js';
import type { HarnessCapabilities } from './protocol.js';
import { icodeProductId, workswarmProductId } from '../../runner/acp-products.mjs';
import { acpHarness, prepareAcp } from '../harness/acp.js';
import { codexAppServer } from '../harness/app-server.js';
import { LocalManager } from '../projects/local-manager.js';
import { toHarnessSkillSetConfig } from './skill-store.js';
/**
 * The capability matrix of a driver. Role configuration is checked against it before a run starts: the role kinds it can
 * run, the model APIs it speaks, whether it needs tool calls and which structured submissions it supports. A combination
 * outside the matrix is a configuration error; no other model, provider or driver is substituted.
 */
export interface RoleHarnessMetadata {id:string;version:string;session:string;events:string;kinds?:RoleKind[];model_api?:string[];tool_calls?:boolean;structured_output?:string[];environment?:'control_plane'|'workspace';runtime?:{package:string;version:string}|null;
 /** The agent-tools volume CLI this driver runs, when its readiness is decided by that volume's installed binary (#1042).
  *  Without it, a driver reports from its declaration only when it declares `environment: 'workspace'` **and**
  *  `capabilities.raw_evidence: 'task_tools'`; a workspace driver that reports control-plane tools (Pi) keeps no row. */
 tool_volume?:AgentToolCli;
 /** The driver brings its own model (ACP agents): no project model is resolved, called or accounted for it. */
 externalModel?:boolean;
 /** What the driver's protocol does, checked by RoleRun admission (see protocol.ts). Undeclared means unsupported. */
 capabilities?:HarnessCapabilities;
 /** false: the driver runs where a configuration names it, but no backend listing (role editor, agent backends) offers it. */
 listed?:boolean;
 /** The driver works a service assistant's turn as a conversation (#1253): it takes serviceHarnessTurn's steering
  *  (`pi.service`: messages merged during the turn, the streamed answer), restarts after an edit and answers in text,
  *  ending silently only through stay_silent. The other drivers get a `finish` tool and no steering. */
 steered_turns?:boolean}
/** The drivers a person may choose from: every registered one except those registered as unlisted. */
export const listedHarnesses=()=>harnesses.filter(h=>h.listed!==false);
const openai=['openai-chat-completions'];
const containerRelayApis=['openai-chat-completions','openai-responses','anthropic-messages'];
// Every built-in driver runs in the shared project computer (`isolation: 'none'`); none runs on the control plane since the
// Process driver was removed (#1338). Container CLI drivers (Claude Code, Codex) execute inside its workspace,
// communicating with the control plane through the task mailbox (model relay, stdio MCP `bot`, read-only GitHub token helpers).
// iCode and WorkSwarm are ACP products from the tool volume and share these declarations; there is no generic ACP backend
// (#1339), so this is not a registered driver of its own.
const acpProduct=(id:string):RegisteredRoleHarness=>({
 id,version:'1',session:'external_session',events:'acp_v1',kinds:['writer','observer'],
 model_api:containerRelayApis,tool_calls:true,structured_output:['tool_call'],environment:'workspace',runtime:null,externalModel:false,
 capabilities:{raw_evidence:'task_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']},
});
const workswarm=acpProduct(workswarmProductId);
/** A registered driver: every declaration is filled in except `tool_volume`, which only tool-volume CLIs carry (#1042). */
export type RegisteredRoleHarness=Required<Omit<RoleHarnessMetadata,'tool_volume'|'listed'|'steered_turns'>> & {tool_volume?:AgentToolCli;listed?:boolean;steered_turns?:boolean};
// Manager (controller) and QA (evaluator) run only on Pi (#1337): no other driver declares those kinds, so role admission
// (definition.ts) refuses them for these two roles while Dev, Test, Reviewer, UX and custom roles keep every choice.
export const harnesses:RegisteredRoleHarness[]=[
 {id:'claude_code',version:claudeCodeRuntime.version,session:'external_session',events:claudeCodeRuntime.protocol,kinds:['writer','observer'],model_api:['anthropic-messages'],tool_calls:true,structured_output:['tool_call'],environment:'workspace',runtime:{package:claudeCodeRuntime.package,version:COMPATIBLE_CLI_RANGES.claude_code.tested},tool_volume:'claude_code',externalModel:false,
  capabilities:{raw_evidence:'task_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']}},
 {id:'codex',version:'1',session:'external_session',events:'codex_app_server_events_and_task_tools',kinds:['writer','observer'],model_api:['openai-responses'],tool_calls:true,structured_output:['tool_call'],environment:'workspace',runtime:{package:'@openai/codex',version:codexAppServer.cli},tool_volume:'codex',externalModel:false,
  capabilities:{raw_evidence:'task_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']}},
 acpProduct(icodeProductId),
 {...workswarm,model_api:['openai-chat-completions','anthropic-messages'],capabilities:{...workswarm.capabilities,recovery:['rebuilt_from_task_records']}},
 // The real Pi SDK in a project computer workspace (runner/pi-entry.mjs), calling models through the unified passthrough gateway.
 {id:'pi',version:piRuntime.version,session:'native_resume',events:'pi_session_events',kinds:['controller','writer','observer','evaluator'],model_api:containerRelayApis,tool_calls:true,structured_output:['tool_call'],environment:'workspace',runtime:{package:piRuntime.package,version:piRuntime.version},externalModel:false,
  capabilities:{raw_evidence:'control_plane_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']},steered_turns:true}];
/** Whether the driver works service assistant turns with steering (`steered_turns`); an unknown id does not. */
export const steersServiceTurns=(id:string)=>harnesses.some(h=>h.id===id&&h.steered_turns===true);
export const runsInTaskCheckout = (driver: RoleHarnessMetadata) => driver.environment === 'workspace' && driver.capabilities?.raw_evidence === 'task_tools';
type AdapterFactory=<T>(spec:AgentSpec<T>)=>NonNullable<AgentSpec<T>['adapter']>;
// Every driver brings its own transport: there is no control-plane tool loop to fall back to (#1257).
const adapters=new Map<string,AdapterFactory>([['codex',codexHarness],['claude_code',claudeCodeHarness],[icodeProductId,spec=>acpHarness(spec,icodeProductId)],[workswarmProductId,spec=>acpHarness(spec,workswarmProductId)],['pi',piHarness]]);
/** Extensions are registered by trusted integration code, never by task text or a model tool. */
export function registerRoleHarness(metadata:RoleHarnessMetadata,factory:AdapterFactory){
 if(!/^[a-z][a-z0-9_-]{0,31}$/.test(metadata.id)||!metadata.version||!['checkpoint_transcript','task_records','native_resume','external_session'].includes(metadata.session)||!metadata.events||adapters.has(metadata.id)||typeof factory!=='function')throw new Error('invalid_or_duplicate_role_harness');
 if(metadata.capabilities!==undefined&&!validCapabilities(metadata.capabilities))throw new Error('invalid_role_harness_capabilities');
 adapters.set(metadata.id,factory);harnesses.push({kinds:['writer','observer'],model_api:metadata.externalModel?[]:openai,tool_calls:true,structured_output:['tool_call'],environment:'control_plane',runtime:null,externalModel:false,...metadata,capabilities:metadata.capabilities??{}});
}
// Capability declarations use the protocol vocabulary only; anything else is a registration error, not a silent default.
const capabilityValues:Record<string,readonly unknown[]>={raw_evidence:['control_plane_tools','task_tools','none'],cancel:['abort_signal','protocol_then_kill','none'],isolation:['none'],version_binding:[true,false],output_validation:[true,false],fresh_context:[true,false]};
function validCapabilities(value:any){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 return Object.entries(value).every(([key,v])=>key==='recovery'?Array.isArray(v)&&v.every(m=>['native_resume','checkpoint_restore','rebuilt_from_task_records','unsupported'].includes(m)):capabilityValues[key]?.includes(v));
}
/**
 * The Pi harness for a role run. spec.pi names the workspace and, for an entry executor, the workflow's own Pi tool
 * profile. Tools the role run adds on top of that profile (task records, delegation, skills) become control-plane tools:
 * Pi forwards them through the mailbox and the control plane executes and validates them with the run's own callbacks.
 */
function piHarness<T>(spec:AgentSpec<T>):NonNullable<AgentSpec<T>['adapter']>{
 const env=spec.pi;if(!env)return stop('pi_environment_required','waiting_configuration','Pi harness 需要项目电脑工作区；这个入口没有为角色准备 Pi 会话。');
 const base=env.session,tools=spec.tools??[],own=new Set((base?.config?.tools??[]).map((t:any)=>t.function.name)),finish=spec.finish;
 const control=tools.map(t=>t.function.name).filter(name=>!own.has(name)||(finish?.names??[finish?.name]).includes(name));
 // Pi manages its own sessions (#1040). A role instance's session files live in a task directory of their own, as
 // Claude Code's and Codex's state does (persistentCliStateWorkspaceId), so a later round or retry in another workspace or
 // worktree finds them; it is recorded with the task and removed with the task's directories. The binding saved when the
 // session started (harness_state) names the session and file the runner opens again.
 const sessionStore=spec.roleRun?.instance_id?persistentCliStateWorkspaceId(spec.roleRun.instance_id):undefined;
 if(sessionStore)useWorkspace(spec.store,{...env.workspace.task,workspace_id:sessionStore},'workspace_harness_start');
 const bound=spec.harnessState?.value?.harness==='pi'&&typeof spec.harnessState.value.sessionId==='string'?spec.harnessState.value:undefined;
 const cmdBudget=resolveCommandTimeout(spec.store,spec.task,spec.roleRun?.role,base?.config?.command_timeout?.default_seconds??null);
 const isLocalTransport=(env.workspace as any)?.manager instanceof LocalManager||(spec.roleWorkspace as any)?.manager instanceof LocalManager||spec.containerOptions?.manager instanceof LocalManager;
 const skillSetConfig=toHarnessSkillSetConfig(spec.harnessSkillSet,isLocalTransport);
 const config={...(base?.config??{capabilities:{workspace:{read:false,write:false,notes:false,shell:false},github:{permissions:{},publication:'none'},agents:false,writes:[]},finish_tools:[],finish_on_pull_request:false,review_session:false}),
  command_timeout:{default_seconds:cmdBudget.defaultSeconds,max_seconds:cmdBudget.maxSeconds},
  ...(spec.runAccess?.token?{run_token:spec.runAccess.token}:{}),
  github_host:githubHostFromApiUrl(spec.containerOptions?.githubApiUrl),
  ...(spec.containerOptions?.allowHttpGit?{allow_http_git:true}:{}),
  system:spec.system,prompt:spec.prompt,accept_turn_result:!!spec.onTurnEnd,...(skillSetConfig?{skill_set:skillSetConfig}:{}),tools,control_tools:control,workspace_id:spec.roleWorkspace?.task.workspace_id??env.workspace.task.workspace_id,...(spec.harnessAccess?{native_access:spec.harnessAccess,native_workspace_id:spec.roleWorkspace?.task.workspace_id,native_fresh:spec.roleRun?.role==='qa'}:{}),
  ...(bound?{native_session:{id:bound.sessionId,file:bound.transcript}}:{}),...(sessionStore?{session_store:sessionStore}:{}),session_key:spec.roleRun?.instance_id??spec.harnessSessionKey};
 return async(services:AgentServices):Promise<T>=>{
  // Whether this run bound a session (session_bound), which an ending that must not be reopened clears again.
  let binding=false;
  const scopedReads=new ScopedReadTokens(spec,64);
  const reads=scopedReads.available?scopedReads:undefined;
  const tokenHandler=base?.token??(reads?async(req?:{purpose?:'git'|'gh';repository?:string;token?:unknown})=>{
   if(spec.runAccess)spec.runAccess.check(req?.token,'github:read_token');
   await spec.guard();
   return reads.issue(req?.purpose==='git'?'git':'gh',req?.repository);
  }:undefined);
  const dispatcher=createTaskToolDispatcher(spec,{includeSubmissionDetails:true,skipScreen:true});
  const onAbort=()=>dispatcher.halt();
  if(spec.executionSignal){if(spec.executionSignal.aborted)onAbort();else spec.executionSignal.addEventListener('abort',onAbort,{once:true});}
  const sessionWorkspace={call:env.workspace.call.bind(env.workspace),deliver:env.workspace.deliver.bind(env.workspace),log:(event:any)=>{
   env.workspace.log(event);
   if(event.type!=='tool'||event.phase&&['read','edit','write','bash','grep','find','ls'].includes(event.name))spec.onHarnessEvent?.(event);
   if(event.type==='session_bound'){
    binding=true;spec.harnessState?.save({harness:'pi',sessionId:event.session_id,transcript:event.transcript,recoveryMode:event.recoveryMode,workspaceId:config.native_workspace_id??config.workspace_id,...(sessionStore?{stateWorkspaceId:sessionStore}:{})});
    // The run records what the session actually did, as Claude Code and Codex runs do: reopened, or rebuilt because the
    // bound file is gone. A new session keeps the start mode the run was prepared with.
    if(spec.roleRun&&spec.task.trace_run_id&&['native_resume','rebuilt_from_task_records'].includes(event.recoveryMode))spec.store.run('UPDATE task_runs SET recovery_mode=? WHERE id=?',event.recoveryMode,spec.task.trace_run_id);
   }
  }};
  try{
   return await piAdapter<T>({results:spec.resultSession,store:spec.store,taskId:spec.task.id,task:spec.task,guard:spec.guard,beforeModel:spec.beforeModel,runAccess:spec.runAccess,leaseEpoch:spec.runContext?.()?.lease_epoch,
    // An unknown checkout is an untrusted one (#1379).
    ...(spec.roleRun&&spec.runAccess?{ssh:{role:spec.roleRun.role,trusted:spec.harnessAccess?.trustedCheckout===true}}:{}),workspace:sessionWorkspace,redactor:spec.redactor,config,conversation:base?.conversation,platform:base?.platform,repository:base?.repository,token:tokenHandler,createPullRequest:base?.createPullRequest,publication:base?.publication,
    offered:name=>tools.some(t=>t.function.name===name),ensureWorkspace:async()=>(spec.roleWorkspace??env.workspace).ensure?.()??{},resume:env.resume,key:env.key,signal:spec.executionSignal,maxRequests:spec.harnessAccess?spec.harnessTurnLimit:base?undefined:spec.maxTurns??32,finalizationTools:spec.finalizationTools??(finish?.names??(finish?[finish.name]:[])),finalizationMessage:finish?.finalizationMessage,checkpoint:spec.checkpoint,runtime:env.runtime,service:env.service,
    // Pi may refuse a call itself (unknown tool, schema mismatch) before the control plane sees it; the model output always
    // passes through here, so every forbidden call is recorded whatever the runtime did with it.
    inspect:message=>{for(const call of message?.tool_calls??[]){const name=String(call.function?.name);if(spec.harnessAccess&&['read','edit','write','bash','grep','find','ls'].includes(name))continue;if(!tools.some(t=>t.function.name===name)&&!(spec.harnessAccess&&['read','edit','write','bash','grep','find','ls'].includes(name))){spec.onDenied?.(name,'not_offered');continue;}let args:any=null;try{args=JSON.parse(call.function.arguments);}catch{}spec.screen?.(name,args);}},
    control:async(name,args,meta)=>{
     const out=await dispatcher.call(dispatcher.token,{id:meta?.id??randomId(),name,arguments:args,transport:'mailbox'});
     return {result:out.observation,...(out.submitted?{finish:true}:{}),...(out.images?.length?{images:out.images}:{})};
    },
    complete:async(state,publication)=>{
     if(dispatcher.submitted)return dispatcher.result as T;
     if(spec.onTurnEnd&&state.result?.harness_turn)return spec.onTurnEnd({text:String(state.result.text??''),session_id:state.result.session_id});
     // A session that finished while the control plane was away carries its submission; validate it again from task facts.
     if(finish&&state.result?.submitted===true)return finish.validate(state.result.submission,state.result.submission_name);
     if(base?.complete)return base.complete(state,publication);
     return stop('role_submission_required','retry_wait','Pi 会话结束但没有通过控制面提交结果。');
    }})(services);
  }catch(error){
   // A session over the context limit after Pi's own recovery, or one that was cancelled, is not reopened: the next run
   // starts a new session from task records. Any other ending keeps the binding, and the next run continues the session.
   if(error instanceof TaskError&&['agent_context_too_large','harness_cancelled'].includes(error.code)&&(binding||bound))spec.harnessState?.save({});
   throw error;
  }finally{spec.executionSignal?.removeEventListener('abort',onAbort);await dispatcher.close();await reads?.revoke();}
 };
}
export function roleHarness(id:string){
 const factory=adapters.get(id);if(!factory)throw new Error('unknown_role_harness');
 // ACP products (iCode, WorkSwarm) read their installed tool-volume product before the run and finish their session on close.
 const isAcp=harnesses.find(h=>h.id===id)?.events==='acp_v1';
 const createSession=<T>(spec:AgentSpec<T>,services:AgentServices)=>{
  const emit=(event:import('../harness/session.js').HarnessEvent)=>{traceEvent(spec.store,spec.task.id,'harness_event',spec.redactor.clean(event),spec.task.trace_run_id,'harness');spec.onHarnessEvent?.(spec.redactor.clean(event));};
  const external=spec.cancelSignal;
  let nativeState=spec.harnessState?.value??{};
  let activeAcp:Promise<T>|undefined;
  const cancel=()=>void session.cancel(external?.reason);
  const session=managedSession(async(signal,message)=>{
   if(external?.aborted)throw external.reason??new TaskError('harness_cancelled','cancelled');
   checkHarnessAccess(id,spec.harnessAccess);
   const wrapped:AgentSpec<T>={...spec,...(message!==undefined?{prompt:message,harnessInitialPrompt:spec.prompt}:{}),executionSignal:signal,
    harnessState:{value:nativeState,save:value=>{nativeState=value;spec.harnessState?.save(value);}},
    guard:async()=>{if(signal.aborted)throw signal.reason;await spec.guard();}};
   const guarded={...services,guard:wrapped.guard};
   const running=factory(wrapped)(guarded);
   if(isAcp)activeAcp=running;
   return running;
  },emit,async()=>{external?.removeEventListener('abort',cancel);await activeAcp?.catch(()=>{});});
  external?.addEventListener('abort',cancel,{once:true});
  return session;
 };
 return {...harnesses.find(h=>h.id===id)!,prepare:id==='claude_code'?prepareClaudeCode:id==='codex'?prepareCodex:isAcp?<T>(spec:AgentSpec<T>)=>prepareAcp(spec,id):undefined,createSession,adapter:<T>(spec:AgentSpec<T>)=>async(services:AgentServices)=>{
  const session=createSession(spec,services);
  try{return await session.run();}finally{await session.close();}
 }};
}
