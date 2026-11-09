import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { runTools } from '../agent/runtime.js';
import { managedSession } from '../harness/session.js';
import { acpHarness } from './acp.js';
import { claudeCodeHarness } from './claude-code.js';
import { prepareClaudeCode } from '../harness/claude-code.js';
import { claudeCodeRuntime } from '../harness/claude-code-protocol.js';
import type { AgentSpec,AgentServices } from '../agent/runtime.js';
import { stop } from '../agent/common.js';
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
 const lines=createInterface({input:child.stdout});let settled=false,result:T,requests=0,pending=Promise.resolve();let bytes=0,repairs=0;
 const repair=(error:unknown)=>{const feedback=spec.repairInvalid?.(error);if(!feedback||repairs++>=2)throw error;return {error:'invalid_submission',message:spec.redactor.text(feedback)};};
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
    if(spec.runAccess){try{spec.runAccess.check(m.args?.token);}catch(error){value={error:(error as any).code??'run_token_invalid'};spec.onDenied?.(String(m.args?.name),(error as any).code??'run_token_invalid');child.stdin.write(JSON.stringify({id:m.id,result:value})+'\n');return;}}
    const offered=spec.tools?.some(t=>t.function.name===m.args.name);
    if(offered&&m.args.offered)spec.screen?.(m.args.name,m.args.args);
    if(!offered||!m.args.offered){value={error:'tool_not_allowed'};spec.onDenied?.(String(m.args.name),'not_offered');}
    else if(m.args.name===spec.finish?.name){try{result=await spec.finish!.validate(m.args.args);value={submitted:true};}catch(error){value=repair(error);}}
    else {value=await spec.execute?.(m.args.name,m.args.args);traceEvent(spec.store,spec.task.id,'tool_observation',{name:m.args.name,arguments:spec.redactor.clean(m.args.args),observation:spec.redactor.clean(value)},spec.task.trace_run_id,'tool');}
   }else if(m.method==='final'){if(typeof m.args!=='string')stop('agent_output_invalid','retry_wait');try{result=spec.validate?await spec.validate(m.args):spec.redactor.text(m.args) as T;value={submitted:true};}catch(error){value=repair(error);}}
   else throw new Error('role_worker_protocol');
   child.stdin.write(JSON.stringify({id:m.id,result:spec.redactor.clean(value)})+'\n');
  }).catch(fail);
 });
 child.stdin.write(JSON.stringify({start:{system:spec.system,prompt:spec.prompt,messages:spec.session?.messages??[],tools:spec.tools??[],finish:spec.finish?.name,maxTurns:spec.maxTurns??32,token:spec.runAccess?.token??null}})+'\n');
});}

export const completeTranscript=(messages:any[])=>{const last=messages.findLastIndex(m=>m?.role==='assistant');if(last<0||!messages[last].tool_calls?.length)return true;const answered=new Set(messages.slice(last+1).filter(m=>m?.role==='tool').map(m=>m.tool_call_id));return messages[last].tool_calls.every((c:any)=>answered.has(c.id));};
/**
 * The capability matrix of a driver. Role configuration is checked against it before a run starts: the role kinds it can
 * run, the model APIs it speaks, whether it needs tool calls and which structured submissions it supports. A combination
 * outside the matrix is a configuration error; no other model, provider or driver is substituted.
 */
export interface RoleHarnessMetadata {id:string;version:string;session:string;events:string;kinds?:RoleKind[];model_api?:string[];tool_calls?:boolean;structured_output?:string[];environment?:'control_plane'|'workspace'|'run_environment';runtime?:{package:string;version:string}|null;
 /** The driver brings its own model (ACP agents): no project model is resolved, called or accounted for it. */
 externalModel?:boolean;
 /** What the driver's protocol does, checked by RoleRun admission (see protocol.ts). Undeclared means unsupported. */
 capabilities?:HarnessCapabilities}
const openai=['openai-chat-completions'];
// None of the built-in drivers runs its agent inside a per-run environment: Native and Pi loops and the Process worker
// run on the control plane or the shared project computer, and an ACP or Codex agent runs on the control-plane host. Their
// registration therefore never claims run isolation; admission refuses them for profiles that require it.
const inProcess:HarnessCapabilities={raw_evidence:'control_plane_tools',cancel:'abort_signal',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['checkpoint_restore','rebuilt_from_task_records']};
export const harnesses:Required<RoleHarnessMetadata>[]=[
 {id:'claude_code',version:claudeCodeRuntime.version,session:'external_session',events:claudeCodeRuntime.protocol,kinds:['writer','observer','evaluator'],model_api:[],tool_calls:true,structured_output:['tool_call'],environment:'control_plane',runtime:{package:claudeCodeRuntime.package,version:claudeCodeRuntime.version},externalModel:true,
  capabilities:{raw_evidence:'control_plane_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']}},
 // A generic ACP agent with its own model; role authority stays with the control plane. It declares no project model API. Only the Bot task tools
 // are observed by the control plane; the agent's own terminal and tools are not.
 {id:'acp',version:'1',session:'external_session',events:'acp_events_and_task_tools',kinds:['controller','writer','observer','evaluator'],model_api:[],tool_calls:true,structured_output:['tool_call'],environment:'control_plane',runtime:null,externalModel:true,
  capabilities:{raw_evidence:'task_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']}},
 // The same client speaking `codex app-server` (BOT_CODEX_CONFIG), locked to one CLI version. Its thread events, permission
 // answers and usage are structured; the agent still runs on the control-plane host with its own sandbox, so no isolation.
 {id:'codex',version:'1',session:'external_session',events:'codex_app_server_events_and_task_tools',kinds:['writer','observer','evaluator'],model_api:[],tool_calls:true,structured_output:['tool_call'],environment:'control_plane',runtime:{package:'@openai/codex',version:codexAppServer.cli},externalModel:true,
  capabilities:{raw_evidence:'task_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']}},
 {id:'native',version:'1',session:'checkpoint_transcript',events:'tool_observations',kinds:['controller','writer','observer','evaluator'],model_api:openai,tool_calls:true,structured_output:['tool_call','text_json'],environment:'control_plane',runtime:null,externalModel:false,capabilities:inProcess},
 // A Node child process without an OS sandbox; its tool calls carry the run token over JSON-line RPC.
 {id:'process',version:'1',session:'checkpoint_transcript',events:'rpc_tool_observations',kinds:['controller','writer','observer','evaluator'],model_api:openai,tool_calls:true,structured_output:['tool_call','text_json'],environment:'control_plane',runtime:null,externalModel:false,capabilities:{...inProcess,cancel:'protocol_then_kill'}},
 // The real Pi SDK in a project computer workspace (runner/pi-entry.mjs), reached through the task mailbox.
 {id:'pi',version:piRuntime.version,session:'native_resume',events:'pi_session_events',kinds:['controller','writer','observer','evaluator'],model_api:openai,tool_calls:true,structured_output:['tool_call'],environment:'workspace',runtime:{package:piRuntime.package,version:piRuntime.version},externalModel:false,
  capabilities:{raw_evidence:'control_plane_tools',cancel:'protocol_then_kill',isolation:'none',version_binding:true,output_validation:true,fresh_context:true,recovery:['native_resume','rebuilt_from_task_records']}}];
type AdapterFactory=<T>(spec:AgentSpec<T>)=>NonNullable<AgentSpec<T>['adapter']>;
const adapters=new Map<string,AdapterFactory|undefined>([['native',undefined],['process',processHarness],['acp',spec=>acpHarness(spec)],['codex',spec=>acpHarness(spec,'codex-app-server')],['claude_code',claudeCodeHarness],['pi',piHarness]]);
/** Extensions are registered by trusted integration code, never by task text or a model tool. */
export function registerRoleHarness(metadata:RoleHarnessMetadata,factory:AdapterFactory){
 if(!/^[a-z][a-z0-9_-]{0,31}$/.test(metadata.id)||!metadata.version||!['checkpoint_transcript','task_records','native_resume','external_session'].includes(metadata.session)||!metadata.events||adapters.has(metadata.id)||typeof factory!=='function')throw new Error('invalid_or_duplicate_role_harness');
 if(metadata.capabilities!==undefined&&!validCapabilities(metadata.capabilities))throw new Error('invalid_role_harness_capabilities');
 adapters.set(metadata.id,factory);harnesses.push({kinds:['writer','observer','evaluator'],model_api:metadata.externalModel?[]:openai,tool_calls:true,structured_output:['tool_call'],environment:'control_plane',runtime:null,externalModel:false,...metadata,capabilities:metadata.capabilities??{}});
}
// Capability declarations use the protocol vocabulary only; anything else is a registration error, not a silent default.
const capabilityValues:Record<string,readonly unknown[]>={raw_evidence:['control_plane_tools','task_tools','none'],cancel:['abort_signal','protocol_then_kill','none'],isolation:['run_environment','none'],version_binding:[true,false],output_validation:[true,false],fresh_context:[true,false]};
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
 const control=tools.map(t=>t.function.name).filter(name=>!own.has(name));
 const config={...(base?.config??{capabilities:{workspace:{read:false,write:false,notes:false,shell:false},github:{permissions:{},publication:'none'},agents:false,writes:[]},finish_tools:[],finish_on_pull_request:false,review_session:false}),
  system:spec.system,prompt:spec.prompt,tools,control_tools:control,workspace_id:env.workspace.task.workspace_id};
 let submitted:{value:T}|undefined,repairs=0;
 return piAdapter<T>({store:spec.store,taskId:spec.task.id,guard:spec.guard,workspace:env.workspace,redactor:spec.redactor,config,conversation:base?.conversation,platform:base?.platform,repository:base?.repository,token:base?.token,createPullRequest:base?.createPullRequest,publication:base?.publication,
  offered:name=>tools.some(t=>t.function.name===name),resume:env.resume,key:env.key,dropReasoning:true,signal:spec.executionSignal,maxRequests:base?undefined:spec.maxTurns,checkpoint:spec.checkpoint,runtime:env.runtime,
  // Pi may refuse a call itself (unknown tool, schema mismatch) before the control plane sees it; the model output always
  // passes through here, so every forbidden call is recorded whatever the runtime did with it.
  inspect:message=>{for(const call of message?.tool_calls??[]){const name=String(call.function?.name);if(!tools.some(t=>t.function.name===name)){spec.onDenied?.(name,'not_offered');continue;}let args:any=null;try{args=JSON.parse(call.function.arguments);}catch{}spec.screen?.(name,args);}},
  control:async(name,args)=>{
   if(finish&&name===finish.name){try{const value=await finish.validate(args);submitted={value};return {result:{submitted:true,submission:args},finish:true};}catch(error){const feedback=spec.repairInvalid?.(error);if(!feedback||repairs++>=2)throw error;return {result:{error:'invalid_submission',message:spec.redactor.text(feedback)}};}}
   const value=spec.execute?await spec.execute(name,args):{error:'tool_not_allowed'};
   traceEvent(spec.store,spec.task.id,'tool_observation',{name,arguments:spec.redactor.clean(args),observation:spec.redactor.clean(value)},spec.task.trace_run_id,'tool');
   return {result:value};
  },
  complete:async(state,publication)=>{
   if(base?.complete)return base.complete(state,publication);
   if(submitted)return submitted.value;
   // A session that finished while the control plane was away carries its submission; validate it again from task facts.
   if(finish&&state.result?.submitted===true)return finish.validate(state.result.submission);
   return stop('role_submission_required','retry_wait','Pi 会话结束但没有通过控制面提交结果。');
  }});
}
export function roleHarness(id:string){
 if(!adapters.has(id))throw new Error('unknown_role_harness');const factory=adapters.get(id);
 const createSession=<T>(spec:AgentSpec<T>,services:AgentServices)=>{
  const emit=(event:import('../harness/session.js').HarnessEvent)=>{traceEvent(spec.store,spec.task.id,'harness_event',spec.redactor.clean(event),spec.task.trace_run_id,'harness');spec.onHarnessEvent?.(spec.redactor.clean(event));};
  const session=managedSession(async signal=>{const wrapped={...spec,executionSignal:signal,guard:async()=>{if(signal.aborted)throw signal.reason;await spec.guard();}};return factory?factory(wrapped)({...services,guard:wrapped.guard}):runTools(wrapped,{...services,guard:wrapped.guard});},emit);
  // A RoleRun cancel or an exhausted budget interrupts the session the same way the task guard does.
  const external=spec.cancelSignal;if(external){const cancel=()=>void session.cancel();if(external.aborted)cancel();else external.addEventListener('abort',cancel,{once:true});}
  return session;
 };
 return {...harnesses.find(h=>h.id===id)!,prepare:id==='claude_code'?prepareClaudeCode:undefined,createSession,adapter:<T>(spec:AgentSpec<T>)=>async(services:AgentServices)=>{
  const session=createSession(spec,services);
  try{return await session.run();}finally{await session.close();}
 }};
}
