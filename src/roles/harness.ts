import {submissionFeedback} from './submission-feedback.js';
import {resolveCommandTimeout} from '../agent/command.js';
import {checkHarnessAccess} from '../harness/access.js';
import {computeAllowedGithubScopes,persistentCliStateWorkspaceId} from '../harness/container-session.js';
import {useWorkspace} from '../projects/workspace-cleanup.js';
import {ReadTokens} from '../agent/read-token.js';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomId } from '../core/security.js';
import { runTools } from '../agent/runtime.js';
import { managedSession } from '../harness/session.js';
import { claudeCodeHarness } from './claude-code.js';
import { createTaskToolDispatcher } from './task-tools.js';
import { prepareClaudeCode } from '../harness/claude-code.js';
import { claudeCodeRuntime } from '../harness/claude-code-protocol.js';
import { codexHarness, prepareCodex } from '../harness/codex.js';
import { COMPATIBLE_CLI_RANGES } from '../harness/agent-tools.js';
import type { AgentSpec,AgentServices } from '../agent/runtime.js';
import { TaskError, stop } from '../agent/common.js';
import { traceEvent } from '../tasks/trace.js';
import { piAdapter,piRuntime } from '../agent/pi.js';
import type { RoleKind } from './catalog.js';
import type { HarnessCapabilities } from './protocol.js';
import { codexAppServer } from '../harness/app-server.js';
/** The worker cannot access provider credentials or obtain arbitrary tools. */
export function processHarness<T>(spec:AgentSpec<T>){return async(services:AgentServices):Promise<T>=>new Promise((resolve,reject)=>{
 const runId=spec.task.trace_run_id;
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../runner/role-worker.mjs',import.meta.url))],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
 const abort=()=>fail(spec.executionSignal?.reason??new Error('harness_cancelled'));
 spec.executionSignal?.addEventListener('abort',abort,{once:true});
 child.once('close',()=>spec.executionSignal?.removeEventListener('abort',abort));
 child.once('spawn',()=>traceEvent(spec.store,spec.task.id,'harness_started',{harness:'process',version:'1',pid:child.pid,recovery:'checkpoint_transcript'},runId));
 const lines=createInterface({input:child.stdout});let settled=false,result:T,requests=0,pending=Promise.resolve();let bytes=0;
 const repair=(error:unknown)=>{const feedback=submissionFeedback(spec,error);if(!feedback)throw error;return feedback;};
 const fail=(e:unknown)=>{if(settled)return;settled=true;child.kill('SIGKILL');reject(e);};
 child.on('error',fail);child.stderr.resume();child.stdin.on('error',fail);child.on('close',code=>{if(!settled)fail(new Error('role_worker_exit:'+code));});
 lines.on('line',line=>{bytes+=line.length;if(bytes>64*1024*1024){fail(new Error('role_worker_output_limit'));return;}
  pending=pending.then(async()=>{if(settled)return;await services.guard();const m=JSON.parse(line);
   if(m.fault)throw new Error(m.fault);
   if(m.done){settled=true;child.stdin.end();resolve(result??m.result);return;}
   let value:any;
   if(m.method==='checkpoint'){if(!Array.isArray(m.args)||Buffer.byteLength(JSON.stringify(m.args))>2*1024*1024)stop('agent_context_too_large','needs_replan');spec.session?.save(spec.redactor.clean(m.args));
    // A transcript whose every tool call has its result is a safe point to end this run (for example on a new role revision).
    if(spec.checkpoint&&completeTranscript(m.args))await spec.checkpoint();value={saved:true};}
   else if(m.method==='model'){const response=await services.request(m.args,'worker:'+requests++);const message=response.value?.choices?.[0]?.message;value=spec.redactor.clean({role:'assistant',content:typeof message?.content==='string'?message.content:null,...(message?.tool_calls?{tool_calls:message.tool_calls}:{})});}
   else if(m.method==='tool'){
    // The worker presents its run token on every tool call; a revoked, expired or taken-over run is refused here.
    if(spec.runAccess){try{spec.runAccess.check(m.args?.token,'tools:invoke');}catch(error){value={error:(error as any).code??'run_token_invalid'};spec.onDenied?.(String(m.args?.name),(error as any).code??'run_token_invalid');child.stdin.write(JSON.stringify({id:m.id,result:value})+'\n');return;}}
    const offered=spec.tools?.some(t=>t.function.name===m.args.name);
    if(offered&&m.args.offered)spec.screen?.(m.args.name,m.args.args);
    if(!offered||!m.args.offered){value={error:'tool_not_allowed'};spec.onDenied?.(String(m.args.name),'not_offered');}
    else if(spec.finish&&(spec.finish.names??[spec.finish.name]).includes(m.args.name)){try{result=await spec.finish!.validate(m.args.args,m.args.name);value={submitted:true};}catch(error){value=repair(error);}}
    else {value=await spec.execute?.(m.args.name,m.args.args);traceEvent(spec.store,spec.task.id,'tool_observation',{name:m.args.name,arguments:spec.redactor.clean(m.args.args),observation:spec.redactor.clean(value)},spec.task.trace_run_id,'tool');}
   }else if(m.method==='final'){if(typeof m.args!=='string')stop('agent_output_invalid','retry_wait');try{result=spec.validate?await spec.validate(m.args):spec.redactor.text(m.args) as T;value={submitted:true};}catch(error){value=repair(error);}}
   else throw new Error('role_worker_protocol');
   child.stdin.write(JSON.stringify({id:m.id,result:spec.redactor.clean(value)})+'\n');
  }).catch(fail);
 });
 child.stdin.write(JSON.stringify({start:{system:spec.system,prompt:spec.prompt,messages:spec.session?.messages??[],tools:spec.tools??[],finish:spec.finish?.name,finishes:spec.finish?.names,finalizationTools:spec.finalizationTools,finalizationMessage:spec.finish?.finalizationMessage,textResult:!!spec.validate||!spec.finish,maxTurns:spec.maxTurns??32,token:spec.runAccess?.token??null}})+'\n');
});}

export const completeTranscript=(messages:any[])=>{const last=messages.findLastIndex(m=>m?.role==='assistant');if(last<0||!messages[last].tool_calls?.length)return true;const answered=new Set(messages.slice(last+1).filter(m=>m?.role==='tool').map(m=>m.tool_call_id));return messages[last].tool_calls.every((c:any)=>answered.has(c.id));};
/**
 * The capability matrix of a driver. Role configuration is checked against it before a run starts: the role kinds it can
 * run, the model APIs it speaks, whether it needs tool calls and which structured submissions it supports. A combination
 * outside the matrix is a configuration error; no other model, provider or driver is substituted.
 */
export interface RoleHarnessMetadata {id:string;version:string;session:string;events:string;kinds?:RoleKind[];model_api?:string[];tool_calls?:boolean;structured_output?:string[];environment?:'control_plane'|'workspace';runtime?:{package:string;version:string}|null;
 /** The driver brings its own model (ACP agents): no project model is resolved, called or accounted for it. */
 externalModel?:boolean;
 /** What the driver's protocol does, checked by RoleRun admission (see protocol.ts). Undeclared means unsupported. */
 capabilities?:HarnessCapabilities}
const openai=['openai-chat-completions'];
const containerRelayApis=['openai-chat-completions','openai-responses','anthropic-messages'];
// All project roles execute on the control plane or shared project computer (`isolation: 'none'`).
// Container CLI drivers (Claude Code, Codex) execute inside the shared project computer workspace,
// communicating with the control plane through the task mailbox (model relay, stdio MCP `bot`, read-only GitHub token helpers).
const inProcess:HarnessCapabilities={raw_evidence:'control_plane_tools',cancel:'abort_signal',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['checkpoint_restore','rebuilt_from_task_records']};
export const harnesses:Required<RoleHarnessMetadata>[]=[
 {id:'claude_code',version:claudeCodeRuntime.version,session:'external_session',events:claudeCodeRuntime.protocol,kinds:['controller','writer','observer','evaluator'],model_api:containerRelayApis,tool_calls:true,structured_output:['tool_call'],environment:'workspace',runtime:{package:claudeCodeRuntime.package,version:COMPATIBLE_CLI_RANGES.claude_code.tested},externalModel:false,
  capabilities:{raw_evidence:'task_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']}},
 {id:'codex',version:'1',session:'external_session',events:'codex_app_server_events_and_task_tools',kinds:['controller','writer','observer','evaluator'],model_api:containerRelayApis,tool_calls:true,structured_output:['tool_call'],environment:'workspace',runtime:{package:'@openai/codex',version:codexAppServer.cli},externalModel:false,
  capabilities:{raw_evidence:'task_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']}},
 {id:'native',version:'1',session:'checkpoint_transcript',events:'tool_observations',kinds:['controller','writer','observer','evaluator'],model_api:openai,tool_calls:true,structured_output:['tool_call','text_json'],environment:'control_plane',runtime:null,externalModel:false,capabilities:inProcess},
 // A Node child process without an OS sandbox; its tool calls carry the run token over JSON-line RPC.
 {id:'process',version:'1',session:'checkpoint_transcript',events:'rpc_tool_observations',kinds:['controller','writer','observer','evaluator'],model_api:openai,tool_calls:true,structured_output:['tool_call','text_json'],environment:'control_plane',runtime:null,externalModel:false,capabilities:{...inProcess,cancel:'protocol_then_kill'}},
 // The real Pi SDK in a project computer workspace (runner/pi-entry.mjs), reached through the task mailbox.
 {id:'pi',version:piRuntime.version,session:'native_resume',events:'pi_session_events',kinds:['controller','writer','observer','evaluator'],model_api:openai,tool_calls:true,structured_output:['tool_call'],environment:'workspace',runtime:{package:piRuntime.package,version:piRuntime.version},externalModel:false,
  capabilities:{raw_evidence:'control_plane_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']}}];
type AdapterFactory=<T>(spec:AgentSpec<T>)=>NonNullable<AgentSpec<T>['adapter']>;
const adapters=new Map<string,AdapterFactory|undefined>([['native',undefined],['process',processHarness],['codex',codexHarness],['claude_code',claudeCodeHarness],['pi',piHarness]]);
/** Extensions are registered by trusted integration code, never by task text or a model tool. */
export function registerRoleHarness(metadata:RoleHarnessMetadata,factory:AdapterFactory){
 if(!/^[a-z][a-z0-9_-]{0,31}$/.test(metadata.id)||!metadata.version||!['checkpoint_transcript','task_records','native_resume','external_session'].includes(metadata.session)||!metadata.events||adapters.has(metadata.id)||typeof factory!=='function')throw new Error('invalid_or_duplicate_role_harness');
 if(metadata.capabilities!==undefined&&!validCapabilities(metadata.capabilities))throw new Error('invalid_role_harness_capabilities');
 adapters.set(metadata.id,factory);harnesses.push({kinds:['writer','observer','evaluator'],model_api:metadata.externalModel?[]:openai,tool_calls:true,structured_output:['tool_call'],environment:'control_plane',runtime:null,externalModel:false,...metadata,capabilities:metadata.capabilities??{}});
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
 const config={...(base?.config??{capabilities:{workspace:{read:false,write:false,notes:false,shell:false},github:{permissions:{},publication:'none'},agents:false,writes:[]},finish_tools:[],finish_on_pull_request:false,review_session:false}),
  command_timeout:{default_seconds:cmdBudget.defaultSeconds,max_seconds:cmdBudget.maxSeconds},
  model_transport:spec.containerOptions?.modelTransport,system:spec.system,prompt:spec.prompt,accept_turn_result:!!spec.onTurnEnd,resources:spec.harnessResources,tools,control_tools:control,workspace_id:spec.roleWorkspace?.task.workspace_id??env.workspace.task.workspace_id,...(spec.harnessAccess?{native_access:spec.harnessAccess,native_workspace_id:spec.roleWorkspace?.task.workspace_id,native_fresh:spec.roleRun?.role==='qa'}:{}),
  ...(bound?{native_session:{id:bound.sessionId,file:bound.transcript}}:{}),...(sessionStore?{session_store:sessionStore}:{}),session_key:spec.roleRun?.instance_id??spec.harnessSessionKey};
 return async(services:AgentServices):Promise<T>=>{
  const nativeUsage=new Map<number,{input:number;output:number;known:boolean}>();
  // Whether this run bound a session (session_bound), which an ending that must not be reopened clears again.
  let binding=false;
  const repository=spec.task.repository_id?spec.store.get('SELECT * FROM repositories WHERE id=?',spec.task.repository_id):undefined;
  const scopeInfo=computeAllowedGithubScopes(spec);
  const reads=repository&&scopeInfo.initial.length?new ReadTokens(spec.store,repository,spec.redactor,spec.guard,spec.containerOptions?.githubApiUrl,scopeInfo.initial,scopeInfo.live,64):undefined;
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
   if(event.type==='model'&&event.source==='pi_native'){
    const u=event.usage,known=Number.isFinite(u?.input)&&Number.isFinite(u?.output);
    nativeUsage.set(event.step,{input:known?u.input+(u.cacheRead??0)+(u.cacheWrite??0):0,output:known?u.output:0,known});
    const rows=[...nativeUsage.values()];
    spec.onExternalUsage?.({model_requests:rows.length,input_tokens:rows.reduce((n,r)=>n+r.input,0),output_tokens:rows.reduce((n,r)=>n+r.output,0),unknown_requests:rows.filter(r=>!r.known).length,semantics:'lower_bound',cost:'unknown',accounting_source:'pi_native_events'});
    spec.onHarnessEvent?.({type:'usage',source:'pi_native',usage:u,model:event.model});
   }
  }};
  try{
   return await piAdapter<T>({results:spec.resultSession,store:spec.store,taskId:spec.task.id,guard:spec.guard,workspace:sessionWorkspace,redactor:spec.redactor,config,conversation:base?.conversation,platform:base?.platform,repository:base?.repository,token:base?.token??(reads?()=>reads.issue():undefined),createPullRequest:base?.createPullRequest,publication:base?.publication,
    offered:name=>tools.some(t=>t.function.name===name),ensureWorkspace:async()=>(spec.roleWorkspace??env.workspace).ensure?.()??{},resume:env.resume,key:env.key,signal:spec.executionSignal,maxRequests:spec.harnessAccess?spec.harnessTurnLimit:base?undefined:spec.maxTurns??32,finalizationTools:spec.finalizationTools??(finish?.names??(finish?[finish.name]:[])),finalizationMessage:finish?.finalizationMessage,checkpoint:spec.checkpoint,runtime:env.runtime,
    // Pi may refuse a call itself (unknown tool, schema mismatch) before the control plane sees it; the model output always
    // passes through here, so every forbidden call is recorded whatever the runtime did with it.
    inspect:message=>{for(const call of message?.tool_calls??[]){const name=String(call.function?.name);if(spec.harnessAccess&&['read','edit','write','bash','grep','find','ls'].includes(name))continue;if(!tools.some(t=>t.function.name===name)&&!(spec.harnessAccess&&['read','edit','write','bash','grep','find','ls'].includes(name))){spec.onDenied?.(name,'not_offered');continue;}let args:any=null;try{args=JSON.parse(call.function.arguments);}catch{}spec.screen?.(name,args);}},
    control:async(name,args,meta)=>{
     const out=await dispatcher.call(dispatcher.token,{id:meta?.id??randomId(),name,arguments:args,transport:'mailbox'});
     return {result:out.observation,...(out.submitted?{finish:true}:{})};
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
 if(!adapters.has(id))throw new Error('unknown_role_harness');const factory=adapters.get(id);
 const createSession=<T>(spec:AgentSpec<T>,services:AgentServices)=>{
  const emit=(event:import('../harness/session.js').HarnessEvent)=>{traceEvent(spec.store,spec.task.id,'harness_event',spec.redactor.clean(event),spec.task.trace_run_id,'harness');spec.onHarnessEvent?.(spec.redactor.clean(event));};
  const external=spec.cancelSignal;
  let nativeState=spec.harnessState?.value??{};
  const cancel=()=>void session.cancel(external?.reason);
  const session=managedSession(async(signal,message)=>{
   if(external?.aborted)throw external.reason??new TaskError('harness_cancelled','cancelled');
   checkHarnessAccess(id,spec.harnessAccess);
   const wrapped:AgentSpec<T>={...spec,...(message!==undefined?{prompt:message}:{}),executionSignal:signal,
    harnessState:{value:nativeState,save:value=>{nativeState=value;spec.harnessState?.save(value);}},
    guard:async()=>{if(signal.aborted)throw signal.reason;await spec.guard();}};
   return factory?factory(wrapped)({...services,guard:wrapped.guard}):runTools(wrapped,{...services,guard:wrapped.guard});
  },emit,async()=>external?.removeEventListener('abort',cancel));
  external?.addEventListener('abort',cancel,{once:true});
  return session;
 };
 return {...harnesses.find(h=>h.id===id)!,prepare:id==='claude_code'?prepareClaudeCode:id==='codex'?prepareCodex:undefined,createSession,adapter:<T>(spec:AgentSpec<T>)=>async(services:AgentServices)=>{
  const session=createSession(spec,services);
  try{return await session.run();}finally{await session.close();}
 }};
}
