import {StringDecoder} from 'node:string_decoder';
import {resolve} from 'node:path';
import {TaskError,stop,clip} from '../agent/common.js';
import type {Dialect,DialectContext} from './acp.js';

/**
 * Codex app-server dialect of the generic external-agent client (src/harness/acp.ts). The client keeps one lifecycle for
 * every wire protocol (launch configuration, process group, guard, cancel, MCP task tools, submission check, binding);
 * this file only speaks the app-server JSON-RPC lines: initialize/initialized, thread/start or a verified thread/resume,
 * turn/start until a terminal turn/completed, turn/interrupt, and the server's approval requests.
 *
 * The protocol is locked to one CLI version. `scripts/codex-protocol-lock.mjs` regenerates the JSON Schema with the installed
 * CLI and compares the digest of the definitions below; the validators in this file check exactly the fields the client
 * consumes. Anything else in a message is ignored, never trusted.
 */
export const codexAppServer={
 cli:'0.166.0',
 schemaDigest:'2f1269279072bbe401887eafd203b941521b3f33ab82d68d8efcc25add3712fb',
 definitions:['InitializeParams','InitializeResponse','ThreadStartParams','ThreadStartResponse','ThreadResumeParams','ThreadResumeResponse','ThreadTurnsListParams','ThreadTurnsListResponse',
  'TurnStartParams','TurnStartResponse','TurnInterruptParams','Turn','TurnStatus','TurnError','CodexErrorInfo','ThreadItem','ItemStartedNotification','ItemCompletedNotification','TurnCompletedNotification',
  'ThreadTokenUsageUpdatedNotification','ThreadTokenUsage','TokenUsageBreakdown','ErrorNotification','ModelReroutedNotification','McpServerStatusUpdatedNotification','ListMcpServerStatusParams','ListMcpServerStatusResponse','McpServerStatus',
  'CommandExecutionRequestApprovalParams','CommandExecutionApprovalDecision','FileChangeRequestApprovalParams','FileChangeApprovalDecision','PermissionsRequestApprovalParams','PermissionsRequestApprovalResponse','GrantedPermissionProfile',
  'McpServerElicitationRequestParams','McpServerElicitationRequestResponse','ToolRequestUserInputParams','ToolRequestUserInputResponse','DynamicToolCallParams','DynamicToolCallResponse'],
 /** Server requests of the locked version; each one gets an explicit answer below. */
 serverRequests:['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request','item/permissions/requestApproval','item/tool/call','account/chatgptAuthTokens/refresh','attestation/generate','applyPatchApproval','execCommandApproval'],
} as const;
// Notifications the client does not need. Deltas are suppressed at the server; the complete item arrives in item/completed.
const optOut=['item/agentMessage/delta','item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded','item/plan/delta','item/commandExecution/outputDelta','item/fileChange/outputDelta','command/exec/outputDelta','process/outputDelta','remoteControl/status/changed','account/rateLimits/updated'];
const ignored=new Set(['thread/started','thread/status/changed','thread/readState/changed','thread/name/updated','thread/goal/updated','thread/goal/cleared','thread/settings/updated','thread/compacted','thread/closed','turn/started','turn/diff/updated','turn/plan/updated',
 'serverRequest/resolved','item/mcpToolCall/progress','item/commandExecution/terminalInteraction','item/fileChange/patchUpdated','item/autoApprovalReview/started','item/autoApprovalReview/completed','hook/started','hook/completed','skills/changed','account/updated','app/list/updated','mcpServer/event/stream/notification',...optOut]);
const turnStatuses=['completed','interrupted','failed','inProgress'];

class RpcError extends Error{constructor(readonly method:string,readonly code:number,message:string){super(message);}}
const invalid=(at:string):never=>stop('codex_protocol_invalid','retry_wait',at);
const need=(ok:unknown,at:string)=>{if(!ok)invalid(at);};
const id=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256;
const count=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0;
const check={
 initialize(v:any){need(v&&typeof v.userAgent==='string'&&typeof v.codexHome==='string'&&typeof v.platformOs==='string','initialize.result');return v as {userAgent:string;codexHome:string;platformOs:string};},
 thread(v:any,at:string){
  need(v&&v.thread&&id(v.thread.id)&&typeof v.model==='string'&&typeof v.modelProvider==='string'&&typeof v.cwd==='string',at);
  need(v.instructionSources==null||Array.isArray(v.instructionSources)&&v.instructionSources.every((s:unknown)=>typeof s==='string'),at+'.instructionSources');
  return v as {thread:{id:string;cliVersion?:string};model:string;modelProvider:string;cwd:string;instructionSources?:string[];approvalPolicy:unknown;sandbox:unknown};
 },
 turn(v:any,at:string){need(v&&id(v.id)&&turnStatuses.includes(v.status),at);need(v.error==null||typeof v.error.message==='string',at+'.error');return v as {id:string;status:string;error?:{message:string;codexErrorInfo?:unknown}|null;durationMs?:number|null};},
 usage(v:any){const b=v?.tokenUsage?.total;need(b&&['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'].every(k=>count(b[k])),'thread/tokenUsage/updated.tokenUsage.total');return b;},
 item(v:any,method:string){need(v&&id(v.threadId)&&id(v.turnId)&&v.item&&id(v.item.id)&&typeof v.item.type==='string',method);return v;},
};
type Usage={input:number;cached:number;output:number;reasoning:number;total:number};
const usageOf=(b:any):Usage=>({input:b.inputTokens,cached:b.cachedInputTokens,output:b.outputTokens,reasoning:b.reasoningOutputTokens,total:b.totalTokens});

/** JSON-RPC over newline-delimited stdio, as the app-server speaks it (no "jsonrpc" member). Lines may arrive split in any
 * chunk boundary, including inside a multi-byte character. Requests are correlated by numeric id; an answer to an unknown or
 * already answered id is an anomaly, not a result. A broken line or a closed stream fails every pending request. */
export class LineRpc{
 private pending=new Map<number,{method:string;resolve:(v:any)=>void;reject:(e:unknown)=>void}>();private next=1;private buffer='';private decoder=new StringDecoder('utf8');
 failure:Error|null=null;
 constructor(private write:(line:string)=>void,private handlers:{notification:(method:string,params:any)=>void;request:(id:number|string,method:string,params:any)=>void;anomaly:(kind:string,detail:Record<string,unknown>)=>void;failed:(error:Error)=>void},private maxLine=16*1024*1024){}
 feed(chunk:Buffer|string){
  if(this.failure)return;this.buffer+=typeof chunk==='string'?chunk:this.decoder.write(chunk);
  let at:number;while(!this.failure&&(at=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,at);this.buffer=this.buffer.slice(at+1);if(line.trim())this.line(line);}
  if(this.buffer.length>this.maxLine)this.fail(new TaskError('codex_protocol_invalid','retry_wait','line_too_long'));
 }
 private line(text:string){
  let m:any;try{m=JSON.parse(text);}catch{this.fail(new TaskError('codex_protocol_invalid','retry_wait','json_line'));return;}
  try{
   if(!m||typeof m!=='object'||Array.isArray(m))invalid('message');
   const hasId=typeof m.id==='number'||typeof m.id==='string';
   if(typeof m.method==='string'){if(hasId)this.handlers.request(m.id,m.method,m.params);else this.handlers.notification(m.method,m.params);return;}
   if(hasId&&('result' in m||'error' in m)){
    const p=typeof m.id==='number'?this.pending.get(m.id):undefined;
    if(!p){this.handlers.anomaly('unexpected_response',{id:String(m.id)});return;}
    this.pending.delete(m.id);
    if(m.error)p.reject(new RpcError(p.method,Number(m.error?.code??0),String(m.error?.message??'error')));else p.resolve(m.result);return;
   }
   this.handlers.anomaly('unclassified_message',{});
  }catch(error){this.fail(error as Error);}
 }
 request(method:string,params:unknown):Promise<any>{
  if(this.failure)return Promise.reject(this.failure);
  const n=this.next++;return new Promise((resolve,reject)=>{this.pending.set(n,{method,resolve,reject});this.write(JSON.stringify({id:n,method,params}));});
 }
 notify(method:string,params?:unknown){if(!this.failure)this.write(JSON.stringify(params===undefined?{method}:{method,params}));}
 respond(n:number|string,result:unknown){if(!this.failure)this.write(JSON.stringify({id:n,result}));}
 respondError(n:number|string,code:number,message:string){if(!this.failure)this.write(JSON.stringify({id:n,error:{code,message}}));}
 fail(error:Error){if(this.failure)return;this.failure=error;for(const p of this.pending.values())p.reject(error);this.pending.clear();this.handlers.failed(error);}
}

const version=(userAgent:string)=>/^[^\/\s]+\/(\d+\.\d+\.\d+[\w.+-]*)/.exec(userAgent)?.[1]??null;
const httpStatus=(info:any)=>{if(!info||typeof info!=='object')return null;for(const v of Object.values(info))if(v&&typeof v==='object'&&Number.isSafeInteger((v as any).httpStatusCode))return (v as any).httpStatusCode as number;return null;};
const errorKind=(info:unknown)=>typeof info==='string'?info:info&&typeof info==='object'?Object.keys(info)[0]??null:null;
/** A failed turn's cause, mapped to the platform's existing waiting states. Business success never comes from here. */
function turnFailure(turn:{error?:{message:string;codexErrorInfo?:unknown}|null},clean:(s:string)=>string){
 const info=turn.error?.codexErrorInfo,status=httpStatus(info),message=clean(String(turn.error?.message??'')).slice(0,500);
 if(info==='unauthorized'||status===401||status===403)return new TaskError('codex_authentication_failed','waiting_configuration',message);
 if(info==='modelNotFound')return new TaskError('codex_model_unavailable','waiting_configuration',message);
 return new TaskError('codex_turn_failed','retry_wait',`${errorKind(info)??'unknown'}: ${message}`);
}

/**
 * Permission requests are answered from the role's authority, not from CLI defaults, and never wait for an administrator:
 * - the Bot MCP server's own prompts are approved: every call is checked again by the control plane (offered tool, run
 *   token, lease), so approving the prompt grants nothing beyond the offered task tools;
 * - shell commands, file changes and extra sandbox permissions on this host are declined: a role works on the repository
 *   only through the offered task tools, and its Codex session directory is not the project computer;
 * - questions for a user get no answer (there is no interactive user); dynamic tools are not registered; the client does
 *   not hold or refresh account tokens.
 * A role that cannot continue without a declined permission reports that blocker through its submission tool.
 */
function decide(method:string,params:any):{result?:unknown;error?:[number,string];decision:string;allowed:boolean;reason:string}{
 switch(method){
  // Only a confirmation form; a URL elicitation (open a page, sign in) is never accepted on a user's behalf.
  case 'mcpServer/elicitation/request':return params?.serverName==='bot'&&params?.mode!=='url'?{result:{action:'accept',content:{}},decision:'accept',allowed:true,reason:'offered_task_tools_rechecked_by_control_plane'}:{result:{action:'decline'},decision:'decline',allowed:false,reason:'tool_server_not_offered'};
  case 'item/commandExecution/requestApproval':return {result:{decision:'decline'},decision:'decline',allowed:false,reason:'host_command_outside_role_authority'};
  case 'item/fileChange/requestApproval':return {result:{decision:'decline'},decision:'decline',allowed:false,reason:'host_file_change_outside_role_authority'};
  case 'item/permissions/requestApproval':return {result:{permissions:{}},decision:'grant_none',allowed:false,reason:'sandbox_escalation_outside_role_authority'};
  case 'item/tool/requestUserInput':return {result:{answers:{}},decision:'no_answer',allowed:false,reason:'no_interactive_user'};
  case 'item/tool/call':return {result:{success:false,contentItems:[{type:'inputText',text:'Dynamic tools are not offered. Use the bot MCP task tools.'}]},decision:'refuse',allowed:false,reason:'dynamic_tool_not_registered'};
  case 'applyPatchApproval':case 'execCommandApproval':return {result:{decision:'abort'},decision:'abort',allowed:false,reason:'legacy_approval_outside_role_authority'};
  case 'account/chatgptAuthTokens/refresh':return {error:[-32601,'token refresh is not provided by this client'],decision:'refuse',allowed:false,reason:'client_holds_no_account_tokens'};
  case 'attestation/generate':return {error:[-32601,'attestation is not provided by this client'],decision:'refuse',allowed:false,reason:'attestation_not_offered'};
  default:return {error:[-32601,'method not found'],decision:'refuse',allowed:false,reason:'unknown_server_request'};
 }
}
// A run event body is bounded (64 KiB); large structured values keep a preview instead of failing the stream.
const bounded=(value:unknown,limit=8000)=>{const json=JSON.stringify(value??null);return json.length<=limit?value??null:{truncated:true,preview:clip(json,limit)};};
// Public, bounded fields of an item. Reasoning items and user input never reach here; full results of the Bot tools are in
// the control plane's own tool observations, so only their status is repeated.
function itemFields(it:any,completed:boolean){
 const status=typeof it.status==='string'?it.status:completed?'completed':'in_progress';
 switch(it.type){
  case 'commandExecution':return {kind:'execute',title:clip(it.command,1000),status,rawInput:{command:clip(it.command,2000),cwd:typeof it.cwd==='string'?it.cwd:null},rawOutput:completed?{exitCode:it.exitCode??null,durationMs:it.durationMs??null,output:clip(it.aggregatedOutput??'',8000)}:null};
  case 'fileChange':return {kind:'edit',title:'file change',status,rawInput:{changes:(Array.isArray(it.changes)?it.changes:[]).slice(0,50).map((c:any)=>({path:clip(c?.path,300),kind:c?.kind??null}))},rawOutput:completed?{diff:clip((it.changes??[]).map((c:any)=>String(c?.diff??'')).join('\n'),8000)}:null};
  case 'mcpToolCall':return {kind:'mcp',title:clip(`${it.server}.${it.tool}`,300),status,rawInput:{server:it.server??null,tool:it.tool??null,arguments:bounded(it.arguments)},rawOutput:completed?{error:it.error?.message?clip(it.error.message,500):null,durationMs:it.durationMs??null}:null};
  case 'dynamicToolCall':return {kind:'dynamic',title:clip(it.tool,300),status,rawInput:{tool:it.tool??null,arguments:bounded(it.arguments)},rawOutput:completed?{success:it.success??null}:null};
  case 'webSearch':return {kind:'fetch',title:clip(it.query,500),status,rawInput:{query:clip(it.query,500)},rawOutput:null};
  case 'plan':return {kind:'plan',title:'plan',status,rawInput:null,rawOutput:completed?{text:clip(it.text,8000)}:null};
  // Codex's built-in review is one more tool of the session; it is never the platform's independent review or QA.
  case 'enteredReviewMode':case 'exitedReviewMode':return {kind:'builtin_review',title:clip(it.review,500),status,rawInput:null,rawOutput:null,note:'not_platform_review'};
  case 'collabAgentToolCall':case 'subAgentActivity':return {kind:'agent',title:String(it.tool??it.kind??it.type),status,rawInput:null,rawOutput:null};
  default:return {kind:'other',title:String(it.type),status,rawInput:null,rawOutput:null};
 }
}

export function appServerDialect(ctx:DialectContext):Dialect{
 const {config,cwd,emit,redactor}=ctx;
 const home=resolve(String(config.env?.CODEX_HOME??''));
 let threadId='',cli:string|null=null,text='',usageBase:Usage|null=null;
 type Waiter={id:string|null;done:boolean;resolve:(turn:any)=>void;reject:(e:unknown)=>void;settled:Promise<void>;usage:boolean};
 let current:Waiter|null=null,rerouted:{from:string;to:string}|null=null;
 const early=new Map<string,any>(),seen=new Set<string>(),reported=new Set<string>(),servers=new Map<string,{status:string;error:string|null}>();
 let serverChange:(()=>void)|null=null;
 // An anomaly is recorded once per kind and method; the stream continues.
 const anomaly=(kind:string,detail:Record<string,unknown>={})=>{const key=kind+':'+String(detail.method??'');if(reported.has(key))return;reported.add(key);emit({type:'configuration',stage:'protocol_anomaly',anomaly:kind,...detail});};
 // Before the thread is bound nothing belongs to this run yet (e.g. a usage total restated while resuming); that is no anomaly.
 const ours=(params:any,at:string)=>{if(!threadId)return false;if(params?.threadId===threadId)return true;anomaly('foreign_thread',{method:at});return false;};
 const notification=(method:string,params:any)=>{
  if(method==='turn/completed'){
   if(!ours(params,method))return;const turn=check.turn(params?.turn,'turn/completed.turn');
   if(current&&current.id===turn.id){if(current.done){anomaly('duplicate_terminal',{method});return;}current.done=true;current.resolve(turn);}
   else if(current&&current.id===null)early.set(turn.id,turn);
   else anomaly('unknown_turn',{method});
  }else if(method==='item/started'||method==='item/completed'){
   const p=check.item(params,method);if(!ours(p,method))return;
   const it=p.item,completed=method==='item/completed',key=(completed?'c:':'s:')+it.id;
   if(seen.has(key)){anomaly('duplicate_item',{method});return;}seen.add(key);
   // Private reasoning is never archived; user input is the client's own prompt.
   if(it.type==='reasoning'||it.type==='userMessage'||it.type==='hookPrompt')return;
   if(it.type==='agentMessage'){
    if(!completed)return;need(typeof it.text==='string','item/completed.item.text');
    text+=(text?'\n':'')+it.text;if(text.length>2*1024*1024)stop('acp_output_limit','retry_wait');
    emit({type:'message',text:clip(redactor.text(it.text),12000),threadId,turnId:p.turnId,itemId:it.id,phase:it.phase??null});return;
   }
   emit({type:'tool',callId:it.id,threadId,turnId:p.turnId,itemType:it.type,phase:completed?'completed':'started',...redactor.clean(itemFields(it,completed))});
  }else if(method==='thread/tokenUsage/updated'){
   if(!ours(params,method))return;const total=usageOf(check.usage(params));
   // Thread totals are cumulative and persisted with the binding: a restated total (for example after resume) is not new usage.
   const base=usageBase??{input:0,cached:0,output:0,reasoning:0,total:0};
   if(total.total<base.total){anomaly('usage_decreased',{method});usageBase=total;ctx.save({usage:total});return;}
   if(total.total===base.total)return;
   const delta={input_tokens:total.input-base.input,cached_input_tokens:total.cached-base.cached,output_tokens:total.output-base.output,reasoning_output_tokens:total.reasoning-base.reasoning,total_tokens:total.total-base.total};
   usageBase=total;ctx.save({usage:total});if(current&&(current.id===params.turnId||current.id===null))current.usage=true;
   emit({type:'usage',source:'codex_app_server',threadId,turnId:String(params.turnId),delta,thread_total:total});
  }else if(method==='error'){
   if(!ours(params,method))return;need(typeof params?.error?.message==='string'&&typeof params.willRetry==='boolean','error.params');
   emit({type:'configuration',stage:'turn_error',threadId,turnId:params.turnId??null,willRetry:params.willRetry,code:errorKind(params.error.codexErrorInfo),message:clip(redactor.text(params.error.message),500)});
  }else if(method==='model/rerouted'){
   if(!ours(params,method))return;need(typeof params?.fromModel==='string'&&typeof params?.toModel==='string','model/rerouted.params');
   // The server moved this turn to another model: recorded and stopped, never continued under a model nobody configured.
   rerouted={from:params.fromModel,to:params.toModel};emit({type:'configuration',stage:'model_rerouted',threadId,turnId:params.turnId??null,fromModel:params.fromModel,toModel:params.toModel,reason:params.reason??null});void dialect.cancel();
  }else if(method==='mcpServer/startupStatus/updated'){
   need(typeof params?.name==='string'&&typeof params?.status==='string','mcpServer/startupStatus/updated.params');
   if(params.threadId&&threadId&&params.threadId!==threadId)return;
   servers.set(params.name,{status:params.status,error:typeof params.error==='string'?clip(redactor.text(params.error),300):null});serverChange?.();
  }else if(method==='warning'||method==='configWarning'||method==='deprecationNotice'){
   emit({type:'configuration',stage:'warning',method,message:clip(redactor.text(String(params?.message??params?.summary??'')),500)});
  }else if(!ignored.has(method))anomaly('unknown_notification',{method});
 };
 const request=(n:number|string,method:string,params:any)=>{void (async()=>{
  let reply=decide(method,params);
  // A request for another thread is never approved, whatever it asks for.
  if(params?.threadId!==undefined&&params.threadId!==threadId){if(reply.allowed)reply={result:{action:'decline'},decision:'decline',allowed:false,reason:'foreign_thread'};else reply={...reply,reason:'foreign_thread'};}
  // A run that lost its lease, token or task while the request waited answers nothing affirmatively.
  else if(reply.allowed)try{await ctx.guard();}catch{reply={result:{action:'cancel'},decision:'cancel',allowed:false,reason:'run_no_longer_authorized'};}
  if(reply.error)rpc.respondError(n,reply.error[0],reply.error[1]);else rpc.respond(n,reply.result);
  if(!reply.allowed)ctx.denied('codex:'+method,reply.reason);
  emit({type:'permission',requestId:String(n),method,threadId:params?.threadId??null,turnId:params?.turnId??null,itemId:params?.itemId??null,decision:reply.decision,allowed:reply.allowed,reason:reply.reason,
   ...redactor.clean({command:typeof params?.command==='string'?clip(params.command,1000):undefined,serverName:params?.serverName,requested:params?.permissions?Object.keys(params.permissions):undefined,justification:typeof params?.reason==='string'?clip(params.reason,500):undefined})});
 })();};
 const rpc=new LineRpc(line=>{ctx.child.stdin.write(line+'\n');},{notification,request,anomaly,failed:error=>{current?.reject(error);serverChange?.();}});
 ctx.child.stdout.on('data',chunk=>rpc.feed(chunk));
 ctx.child.stdout.once('end',()=>rpc.fail(new TaskError('codex_connection_lost','retry_wait','stdout_closed')));
 ctx.child.once('exit',(code,signal)=>rpc.fail(new TaskError('codex_connection_lost','retry_wait',`exit:${code??signal}`)));
 ctx.child.once('error',error=>rpc.fail(new TaskError('codex_connection_lost','retry_wait',String(error.message))));
 ctx.child.stdin.on('error',error=>rpc.fail(new TaskError('codex_connection_lost','retry_wait',String(error.message))));

 // The task tools must be exactly the Bot MCP server with exactly the offered tools; servers or plugins from the Codex home
 // are not platform capabilities, so a session that would see them is refused before the first turn.
 async function verifyTools(){
  const deadline=Date.now()+(config.toolStartupMs??15000);
  while(!['ready','failed','cancelled'].includes(servers.get('bot')?.status??'')){
   if(rpc.failure)throw rpc.failure;const left=deadline-Date.now();if(left<=0)break;
   await new Promise<void>(done=>{const t=setTimeout(done,left);serverChange=()=>{clearTimeout(t);done();};});serverChange=null;
  }
  const started=servers.get('bot');if(started?.status!=='ready')stop('codex_task_tools_unavailable','retry_wait',`bot MCP: ${started?.status??'no status'} ${started?.error??''}`.trim());
  const listed=await rpc.request('mcpServerStatus/list',{threadId,detail:'toolsAndAuthOnly'});
  need(Array.isArray(listed?.data)&&listed.data.every((s:any)=>typeof s?.name==='string'),'mcpServerStatus/list.result');
  const extra=listed.data.map((s:any)=>String(s.name)).filter((name:string)=>name!=='bot');
  if(extra.length||listed.nextCursor)stop('codex_unauthorized_tool_servers','waiting_configuration',`Codex 会话加载了未授权的 MCP/插件服务：${extra.join(', ')||'(more pages)'}`);
  const exposed=Object.keys(listed.data.find((s:any)=>s.name==='bot')?.tools??{}).sort(),offered=[...ctx.tools].sort();
  if(exposed.join('\n')!==offered.join('\n'))stop('codex_task_tools_mismatch','retry_wait',`exposed ${exposed.join(',')}; offered ${offered.join(',')}`);
  return exposed;
 }
 const dialect:Dialect={
  async open(previous,fresh){
   const init=check.initialize(await rpc.request('initialize',{clientInfo:{name:'bot',title:'Bot role harness',version:'1'},capabilities:{experimentalApi:false,optOutNotificationMethods:optOut}}));
   cli=version(init.userAgent);
   // The installed CLI, the operator's pin and the protocol lock must be the same version.
   if(cli!==codexAppServer.cli||config.version!==codexAppServer.cli)stop('codex_version_unsupported','waiting_configuration',`codex app-server ${cli??'unknown'}，配置固定 ${config.version??'-'}，协议锁定 ${codexAppServer.cli}`);
   if(resolve(init.codexHome)!==home)stop('codex_home_unexpected','waiting_configuration','app-server 使用的 CODEX_HOME 不是启动配置指定的专用目录。');
   rpc.notify('initialized');
   const overrides={cwd,approvalPolicy:'on-request',sandbox:config.sandbox??'read-only',developerInstructions:ctx.instructions,config:{mcp_servers:{bot:{url:ctx.mcpUrl}}},
    ...(config.model?{model:config.model}:{}),...(config.modelProvider?{modelProvider:config.modelProvider}:{})};
   const prior=!fresh&&previous?.protocol==='codex-app-server'&&id(previous.sessionId)?previous:null;
   let recovery=fresh?'fresh_evaluation':previous?.sessionId?'rebuilt_from_task_records':'new_session',thread:ReturnType<typeof check.thread>|null=null,reconciled:Record<string,unknown>|null=null,notice='';
   const switched=(model:unknown,provider:unknown)=>prior&&(prior.model&&model!==prior.model||prior.modelProvider&&provider!==prior.modelProvider);
   if(prior){
    // A binding made under another model or provider is not resumed under the current one, and nothing switches silently.
    if(switched(config.model??prior.model,config.modelProvider??prior.modelProvider))stop('codex_resume_incompatible','waiting_configuration',`thread ${prior.sessionId} 绑定 ${prior.modelProvider}/${prior.model}，当前配置 ${config.modelProvider??'-'}/${config.model??'-'}。可还原配置后重试，或对角色应用新 revision 以新 thread 重建。`);
    try{thread=check.thread(await rpc.request('thread/resume',{threadId:prior.sessionId,excludeTurns:true,...overrides}),'thread/resume.result');}
    catch(error){if(!(error instanceof RpcError))throw error;emit({type:'configuration',recovery:'native_resume_failed',previousSessionId:prior.sessionId,reason:clip(redactor.text(error.message),300)});}
    if(thread){
     // Ownership: the same thread, created in this role instance's own session directory, on the same model and provider.
     if(thread.thread.id!==prior.sessionId||resolve(thread.cwd)!==resolve(cwd))stop('codex_thread_ownership_mismatch','failed','恢复的 thread 不属于这个角色实例。');
     if(switched(thread.model,thread.modelProvider))stop('codex_resume_incompatible','waiting_configuration',`恢复的 thread 使用 ${thread.modelProvider}/${thread.model}，绑定的是 ${prior.modelProvider}/${prior.model}。`);
     recovery='native_resume';usageBase=prior.usage&&count(prior.usage.total)?prior.usage:null;
     // Unknown state is reconciled first: the last turn the binding did not see end is read back from the thread itself.
     if(prior.lastTurnId&&prior.lastTurnStatus!=='completed'){
      let status='unknown';try{const page=await rpc.request('thread/turns/list',{threadId:prior.sessionId,limit:1});const last=page?.data?.[0];if(last?.id===prior.lastTurnId&&turnStatuses.includes(last.status))status=last.status;}catch(error){if(!(error instanceof RpcError))throw error;}
      reconciled={turnId:prior.lastTurnId,recorded:prior.lastTurnStatus??null,observed:status};
      notice=`Your previous turn ${prior.lastTurnId} did not end with a confirmed completion (observed: ${status}). Before repeating any action, check task records for its effects.`;
     }
    }
   }
   if(!thread)thread=check.thread(await rpc.request('thread/start',overrides),'thread/start.result');
   threadId=thread.thread.id;
   // The model and provider are what the server reports for this thread; a configured value it did not take is refused.
   if(config.model&&thread.model!==config.model||config.modelProvider&&thread.modelProvider!==config.modelProvider)stop('codex_model_mismatch','waiting_configuration',`配置 ${config.modelProvider??'-'}/${config.model??'-'}，app-server 实际为 ${thread.modelProvider}/${thread.model}。`);
   const tools=await verifyTools();
   return {sessionId:threadId,recovery,notice,agentInfo:{name:'codex-app-server',version:cli},
    state:{protocol:'codex-app-server',model:thread.model,modelProvider:thread.modelProvider,cliVersion:cli,...(prior&&recovery==='native_resume'?{lastTurnId:prior.lastTurnId??null,lastTurnStatus:reconciled?.observed??prior.lastTurnStatus??null}:{lastTurnId:null,lastTurnStatus:null}),usage:usageBase},
    bound:{threadId,model:thread.model,modelProvider:thread.modelProvider,cliVersion:cli,approvalPolicy:redactor.clean(thread.approvalPolicy??null),sandbox:config.sandbox??'read-only',instructionSources:redactor.clean(thread.instructionSources??[]),tools,reconciled}};
  },
  async turn(prompt){
   text='';let resolveSettled!:()=>void;
   const settled=new Promise<void>(r=>{resolveSettled=r;});
   const waiter:Waiter={id:null,done:false,usage:false,resolve:()=>{},reject:()=>{},settled};
   const terminal=new Promise<any>((ok,fail)=>{waiter.resolve=turn=>{resolveSettled();ok(turn);};waiter.reject=error=>{resolveSettled();fail(error);};});
   terminal.catch(()=>{});current=waiter;
   const started=check.turn((await rpc.request('turn/start',{threadId,input:[{type:'text',text:prompt}]}))?.turn,'turn/start.result.turn');
   waiter.id=started.id;ctx.save({lastTurnId:started.id,lastTurnStatus:'inProgress'});emit({type:'turn',phase:'started',threadId,turnId:started.id});
   const known=early.get(started.id);if(known){early.delete(started.id);waiter.done=true;waiter.resolve(known);}
   // Only the terminal notification ends a turn; the start answer does not, and a stream that ends first fails the turn.
   const turn=await terminal;
   ctx.save({lastTurnStatus:turn.status});
   emit({type:'turn',phase:'ended',threadId,turnId:turn.id,status:turn.status,durationMs:turn.durationMs??null,usage:waiter.usage?'observed':'unknown',error:turn.error?{code:errorKind(turn.error.codexErrorInfo),message:clip(redactor.text(turn.error.message),500)}:null});
   if(rerouted)stop('codex_model_rerouted','waiting_configuration',`app-server 把 ${rerouted.from} 改路由到 ${rerouted.to}；不会在未配置的模型上继续。`);
   if(turn.status==='completed')return {text};
   if(turn.status==='interrupted')throw new TaskError('codex_turn_interrupted','retry_wait');
   if(turn.status==='inProgress')invalid('turn/completed.turn.status');
   throw turnFailure(turn,s=>redactor.text(s));
  },
  // turn/interrupt, then a bounded wait for the terminal receipt; the caller reclaims the process group afterwards.
  async cancel(){
   const waiter=current;if(!threadId||!waiter||waiter.done||rpc.failure)return;
   const grace=config.cancelGraceMs??5000;
   if(waiter.id){emit({type:'turn',phase:'interrupt_requested',threadId,turnId:waiter.id});rpc.request('turn/interrupt',{threadId,turnId:waiter.id}).catch(()=>{});}
   let timer:NodeJS.Timeout|undefined;
   const receipt=await Promise.race([waiter.settled.then(()=>waiter.done?'terminal':'connection_closed'),new Promise<string>(r=>{timer=setTimeout(()=>r('timeout'),grace);})]);clearTimeout(timer);
   emit({type:'turn',phase:'interrupt_receipt',threadId,turnId:waiter.id,receipt});
  },
  close(){rpc.fail(new TaskError('codex_connection_closed','retry_wait'));},
 };
 return dialect;
}
