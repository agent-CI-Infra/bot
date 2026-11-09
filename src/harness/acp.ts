import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {client,ndJsonStream,PROTOCOL_VERSION,type ClientConnection} from '@agentclientprotocol/sdk';
import {TaskError,stop,sha,type Redactor} from '../agent/common.js';
import type {HarnessEvent} from './session.js';
import {appServerDialect} from './app-server.js';

/**
 * Generic external-agent client. One lifecycle (operator launch configuration, own process group, task guard, timeout,
 * cancel then kill, run-local MCP task tools, submission check, persisted binding) drives two wire dialects:
 * - `acp`: Agent Client Protocol v1 (`initialize`, `session/new|load`, `session/prompt`), launched from BOT_ACP_CONFIG;
 * - `codex-app-server`: `codex app-server` over stdio (`initialize`/`initialized`, `thread/start|resume`, `turn/start`,
 *   `turn/interrupt`), launched from BOT_CODEX_CONFIG; see app-server.ts.
 */
export type AcpProtocol='acp'|'codex-app-server';
export interface AcpConfiguration {command:string;args?:string[];env?:Record<string,string>;stateDirectory:string;model?:string;mode?:string;timeoutMs?:number;version?:string;
 protocol:AcpProtocol;
 /** codex-app-server only. */
 modelProvider?:string;sandbox?:'read-only'|'workspace-write';toolStartupMs?:number;cancelGraceMs?:number}
const launch:Record<AcpProtocol,{variable:string;label:string}>={acp:{variable:'BOT_ACP_CONFIG',label:'ACP'},'codex-app-server':{variable:'BOT_CODEX_CONFIG',label:'Codex app-server'}};
const optionalString=(v:unknown)=>v===undefined||typeof v==='string'&&v.length>0&&v.length<=200;
const optionalMs=(v:unknown,min:number)=>v===undefined||Number.isSafeInteger(v)&&(v as number)>=min;
/** Executables and auth environment come from an operator-owned file, never task text/API input. */
export function acpConfiguration(protocol:AcpProtocol='acp'):AcpConfiguration{
 const {variable,label}=launch[protocol];
 const path=process.env[variable];if(!path)stop('acp_not_configured','waiting_configuration',`Set ${variable} to an operator-owned ${label} launch configuration.`);
 let c:any;try{c=JSON.parse(readFileSync(path!,'utf8'));}catch{return stop('acp_configuration_invalid','waiting_configuration',`${label} launch configuration is missing or invalid JSON.`);}
 if(!c||typeof c.command!=='string'||!c.command||!Array.isArray(c.args??[])||(c.args??[]).some((a:unknown)=>typeof a!=='string')||typeof c.stateDirectory!=='string'||!c.stateDirectory||c.env&&(typeof c.env!=='object'||Array.isArray(c.env)||Object.values(c.env).some(v=>typeof v!=='string'))||c.timeoutMs!==undefined&&(!Number.isSafeInteger(c.timeoutMs)||c.timeoutMs<1000))stop('acp_configuration_invalid','waiting_configuration');
 if(c.protocol!==undefined&&c.protocol!==protocol)stop('acp_configuration_invalid','waiting_configuration',`${variable} declares protocol ${String(c.protocol)}, not ${protocol}.`);
 if(protocol==='codex-app-server')codexLaunch(c);
 return {...c,protocol};
}
// A Codex launch runs its own stdio app-server under a dedicated Codex home: no daemon, proxy, socket or shared login.
function codexLaunch(c:any){
 const bad=(detail:string):never=>stop('acp_configuration_invalid','waiting_configuration',detail);
 const args:string[]=c.args??[];
 if(!args.includes('app-server')||args.some(a=>['proxy','daemon','--listen','--stdio'].includes(a)||/^(?:ws|unix):\/\//.test(a)))bad('Codex args must start a stdio `app-server` of its own (no daemon, proxy or listen socket).');
 const home=c.env?.CODEX_HOME;
 if(typeof home!=='string'||!isAbsolute(home))bad('Codex launch needs env.CODEX_HOME: an absolute, dedicated Codex home.');
 if(process.env.HOME&&[join(process.env.HOME,'.codex'),resolve(process.env.HOME)].includes(resolve(home)))bad('CODEX_HOME must not be the host user\'s shared Codex home.');
 if(c.mode!==undefined)bad('mode is an ACP option; Codex uses sandbox.');
 if(c.sandbox!==undefined&&!['read-only','workspace-write'].includes(c.sandbox))bad('sandbox must be read-only or workspace-write.');
 if(!optionalString(c.model)||!optionalString(c.modelProvider)||!optionalMs(c.toolStartupMs,100)||!optionalMs(c.cancelGraceMs,100))bad('model, modelProvider, toolStartupMs or cancelGraceMs is invalid.');
 if(typeof c.version!=='string'||!c.version)bad('version must pin the installed Codex CLI version.');
}
export interface AcpInput<T> {
 sessionKey:string;
 system:string;
 prompt:string;
 fresh:boolean;
 /** Wire dialect and launch configuration; ACP by default. */
 protocol?:AcpProtocol;
 submissionName?:string;
 /** Names of the offered task tools; the Codex dialect verifies the session sees exactly these. */
 toolNames?:string[];
 state?:{value:Record<string,any>;save:(value:Record<string,any>)=>void};
 tools:{url:string;readonly submitted:boolean;readonly result:T};
 guard:()=>Promise<void>;
 redactor:Redactor;
 validate?:(text:string)=>T|Promise<T>;
 /** A permission the agent asked for and did not get. */
 onDenied?:(name:string,reason:string)=>void;
}
/** What a dialect gets from the shared lifecycle. */
export interface DialectContext {config:AcpConfiguration;child:ChildProcessWithoutNullStreams;cwd:string;mcpUrl:string;tools:string[];instructions:string;redactor:Redactor;
 emit:(event:HarnessEvent)=>void;guard:()=>Promise<void>;denied:(name:string,reason:string)=>void;
 /** Merge fields into the persisted session binding (the role instance's harness_state). */
 save:(patch:Record<string,unknown>)=>void}
/** One wire protocol. open binds the external session; turn runs one prompt to its terminal state and throws unless it completed. */
export interface Dialect {
 open(previous:Record<string,any>|undefined,fresh:boolean):Promise<{sessionId:string;recovery:string;agentInfo:unknown;state:Record<string,unknown>;bound:Record<string,unknown>;notice?:string}>;
 turn(text:string):Promise<{text:string}>;
 /** Protocol interrupt, resolved when the agent confirmed it or the grace period ended. */
 cancel():Promise<void>;
 close(reason?:unknown):void;
}
/** Protocol-only execution: role/task/storage/publication semantics are supplied by callers. */
export async function runAcp<T>(input:AcpInput<T>,signal:AbortSignal,emit:(event:HarnessEvent)=>void):Promise<T>{
 const protocol=input.protocol??'acp',config=acpConfiguration(protocol);for(const [name,value] of Object.entries(config.env??{}))if(/key|token|secret|password/i.test(name))input.redactor.add(value);
 const key=input.sessionKey;
 const cwd=resolve(config.stateDirectory,key);mkdirSync(cwd,{recursive:true,mode:0o700});
 const bridge=input.tools;
 const env={PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:tmpdir(),...(protocol==='codex-app-server'?{HOME:config.env!.CODEX_HOME!}:{}),...config.env};
 const child=spawn(config.command,config.args??[],{cwd,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
 let dialect:Dialect|undefined,stopped=false,cancelReason:unknown;
 child.stderr.resume();
 const kill=()=>{if(child.exitCode!==null)return;try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
 // Cancel: the dialect's protocol interrupt first, then the process group is reclaimed whatever the agent answered.
 const cancel=async(reason:unknown)=>{if(stopped||cancelReason)return;cancelReason=reason;try{await dialect?.cancel();}catch{}dialect?.close(reason);kill();};
 const abort=()=>{void cancel(signal.reason??new TaskError('harness_cancelled','cancelled'));};signal.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{void cancel(new TaskError('harness_timeout','retry_wait'));},config.timeoutMs??30*60*1000);timer.unref();
 const guard=setInterval(()=>{void input.guard().catch(cancel);},500);guard.unref();
 // The previous binding stays persisted until the new session is bound; a patch arriving earlier is only kept in memory.
 let binding:Record<string,unknown>={},bound=false;
 const save=(patch:Record<string,unknown>)=>{binding={...binding,...patch};if(bound)input.state?.save(binding);};
 const instructions=input.system;
 try{
  const ctx:DialectContext={config,child,cwd,mcpUrl:bridge.url,tools:input.toolNames??[],instructions,redactor:input.redactor,emit,guard:input.guard,denied:(name,reason)=>input.onDenied?.(name,reason),save};
  dialect=protocol==='codex-app-server'?appServerDialect(ctx):acpDialect(ctx,signal);
  const previous=input.state?.value;
  const opened=await dialect.open(previous,input.fresh);
  bound=true;save({...opened.state,sessionId:opened.sessionId,previousSessionId:previous?.sessionId??null,cwd,recoveryMode:opened.recovery,agentInfo:opened.agentInfo??null,version:config.version??null,configurationHash:sha(JSON.stringify(config))});
  emit({type:'session_bound',sessionRef:opened.sessionId,previousSessionRef:previous?.sessionId??null,recoveryMode:opened.recovery,agentInfo:opened.agentInfo??null,configuredModel:config.model??null,usage:protocol==='acp'?'unknown':'events',protocol,...opened.bound});
  for(let repair=0;repair<3;repair++){
   await input.guard();if(signal.aborted)throw signal.reason;
   // ACP carries the role instructions in every prompt; the app-server keeps them as the thread's developer instructions.
   const body=(protocol==='acp'?input.system+'\n\n':'')+(repair===0&&opened.notice?opened.notice+'\n\n':'')+input.prompt;
   const {text}=await dialect.turn(body+(repair?'\nYour last turn did not submit a valid role result. Reuse existing observations and submit the required structured result, without repeating unchanged tests. If a declined permission blocks the assignment, say so in the submission instead of retrying it.':''));
   if(cancelReason)throw cancelReason;
   if(bridge.submitted)return bridge.result;
   if(!input.submissionName&&input.validate)return await input.validate!(text);
  }
  return stop('acp_submission_required','retry_wait');
 }catch(error){if(cancelReason)throw cancelReason;if(error instanceof TaskError)throw error;throw new TaskError('acp_execution_failed','retry_wait',input.redactor.text(String((error as Error).message)).slice(0,1000));}
 finally{stopped=true;clearTimeout(timer);clearInterval(guard);signal.removeEventListener('abort',abort);dialect?.close();kill();}
}

/** ACP v1 through the locked SDK; unchanged behaviour of the first harness phase. */
function acpDialect(ctx:DialectContext,signal:AbortSignal):Dialect{
 const {config,cwd,emit,redactor:clean}=ctx;
 const privateTools=new Set<string>();
 let connection:ClientConnection,sid='',replaying=false,text='',configured=false;
 const emitUpdate=(params:any)=>{
  if(replaying||params.sessionId!==sid)return;
  const u=params.update;
  if(u.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text'){text+=u.content.text;if(text.length>2*1024*1024)throw new Error('acp_output_limit');emit({type:'message',text:clean.text(u.content.text)});}
  else if(['tool_call','tool_call_update'].includes(u.sessionUpdate)){
   if(u.kind==='think')privateTools.add(u.toolCallId);if(privateTools.has(u.toolCallId))return;
   // Explicit factual fields only: do not archive arbitrary vendor reasoning/private extensions.
   const data={callId:u.toolCallId,phase:u.status,title:u.title,kind:u.kind,rawInput:clean.clean(u.rawInput??null),rawOutput:clean.clean(u.rawOutput??null),content:clean.clean((u.content??[]).filter((c:any)=>c.type==='content'&&c.content?.type==='text'||c.type==='diff'||c.type==='terminal'))};
   emit({type:'tool',...data});
  }else if(['current_mode_update','config_option_update','session_info_update','usage_update'].includes(u.sessionUpdate))emit({type:'configuration',update:clean.clean({sessionUpdate:u.sessionUpdate,currentModeId:u.currentModeId,configOptions:u.configOptions,used:u.used,size:u.size,cost:u.cost})});
 };
 const app=client({name:'bot-harness'}).onNotification('session/update',({params})=>emitUpdate(params)).onRequest('session/request_permission',async({params})=>{
  await ctx.guard();const option=params.options.find(o=>o.kind==='allow_once');emit({type:'permission',requestId:params.toolCall.toolCallId,decision:option?'allow_once':'cancelled',allowed:!!option});
  return {outcome:option?{outcome:'selected' as const,optionId:option.optionId}:{outcome:'cancelled' as const}};
 });
 connection=app.connect(ndJsonStream(Writable.toWeb(ctx.child.stdin) as WritableStream<Uint8Array>,Readable.toWeb(ctx.child.stdout) as ReadableStream<Uint8Array>));
 ctx.child.once('error',error=>connection.close(error));ctx.child.once('exit',(code,sig)=>connection.close(new Error(`acp_process_exit:${code??sig}`)));
 return {
  async open(previous,fresh){
   const init=await connection.agent.request('initialize',{protocolVersion:PROTOCOL_VERSION,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'bot',version:'1'}});
   if(init.protocolVersion!==PROTOCOL_VERSION)stop('acp_protocol_unsupported','waiting_configuration');
   const mcpServers=[{type:'http' as const,name:'bot',url:ctx.mcpUrl,headers:[]}];
   if(!init.agentCapabilities?.mcpCapabilities?.http)stop('acp_mcp_http_unsupported','waiting_configuration');
   let recovery=fresh?'fresh_evaluation':'new_session';
   if(previous?.sessionId&&init.agentCapabilities?.loadSession){
    replaying=true;
    try{await connection.agent.request('session/load',{sessionId:previous.sessionId,cwd,mcpServers});sid=previous.sessionId;recovery='native_resume';}
    catch{recovery='rebuilt_from_task_records';emit({type:'configuration',recovery:'native_resume_failed',previousSessionId:previous.sessionId});}
    finally{replaying=false;}
   }else if(previous?.sessionId)recovery='rebuilt_from_task_records';
   if(!sid){const created=await connection.agent.request<{sessionId:string;models?:unknown;configOptions?:unknown}>('session/new',{cwd,mcpServers});sid=created.sessionId;emit({type:'configuration',stage:'session_setup',models:created.models??null,configOptions:created.configOptions??null});}
   return {sessionId:sid,recovery,agentInfo:init.agentInfo??null,state:{},bound:{}};
  },
  async turn(prompt){
   // Mode and model are set once, after the binding is recorded.
   if(!configured){configured=true;if(config.mode)await connection.agent.request('session/set_mode',{sessionId:sid,modeId:config.mode});if(config.model)await connection.agent.request('session/set_config_option',{sessionId:sid,configId:'model',value:config.model});}
   if(signal.aborted)throw signal.reason;
   text='';const response=await connection.agent.request('session/prompt',{sessionId:sid,prompt:[{type:'text',text:prompt}]});
   if(response.stopReason!=='end_turn')throw new TaskError('acp_turn_incomplete','retry_wait',String(response.stopReason));
   return {text};
  },
  async cancel(){if(sid)try{await connection.agent.notify('session/cancel',{sessionId:sid});}catch{}await new Promise(r=>setTimeout(r,1000).unref());},
  close(reason){connection.close(reason);},
 };
}
