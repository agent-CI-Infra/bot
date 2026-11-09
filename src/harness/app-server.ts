import {StringDecoder} from 'node:string_decoder';
import {resolve} from 'node:path';
import {TaskError,stop,clip} from '../agent/common.js';
import type {Dialect,DialectContext} from './acp.js';
import type {HarnessEvent} from './session.js';

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
 schemaDigest:'723ea781a3f0d5be4ddefb69e58f7c48fc8c77fa070234bf2f603088c38023ec',
 definitions:['InitializeParams','InitializeResponse','ThreadStartParams','ThreadStartResponse','ThreadResumeParams','ThreadResumeResponse','ThreadTurnsListParams','ThreadTurnsListResponse',
  'TurnStartParams','TurnStartResponse','TurnInterruptParams','Turn','TurnStatus','TurnError','CodexErrorInfo','ThreadItem','ItemStartedNotification','ItemCompletedNotification','TurnCompletedNotification',
  'ThreadTokenUsageUpdatedNotification','ThreadTokenUsage','TokenUsageBreakdown','ErrorNotification','ModelReroutedNotification','McpServerStatusUpdatedNotification','ListMcpServerStatusParams','ListMcpServerStatusResponse','McpServerStatus',
  'CommandExecutionRequestApprovalParams','CommandExecutionApprovalDecision','FileChangeRequestApprovalParams','FileChangeApprovalDecision','PermissionsRequestApprovalParams','PermissionsRequestApprovalResponse','GrantedPermissionProfile',
  'McpServerElicitationRequestParams','McpServerElicitationRequestResponse','ToolRequestUserInputParams','ToolRequestUserInputResponse','DynamicToolCallParams','DynamicToolCallResponse',
  'ExperimentalFeatureListParams','ExperimentalFeatureListResponse','ExperimentalFeature','AskForApproval','SandboxPolicy'],
 /** Server requests of the locked version; each one gets an explicit answer below. */
 serverRequests:['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request','item/permissions/requestApproval','item/tool/call','account/chatgptAuthTokens/refresh','attestation/generate','applyPatchApproval','execCommandApproval'],
} as const;
// Notifications the client does not need. Deltas are suppressed at the server; the complete item arrives in item/completed.
const optOut=['item/agentMessage/delta','item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded','item/plan/delta','item/commandExecution/outputDelta','item/fileChange/outputDelta','command/exec/outputDelta','process/outputDelta','remoteControl/status/changed','account/rateLimits/updated'];
const ignored=new Set(['thread/started','thread/status/changed','thread/readState/changed','thread/name/updated','thread/goal/updated','thread/goal/cleared','thread/settings/updated','thread/compacted','thread/closed','turn/diff/updated','turn/plan/updated',
 'serverRequest/resolved','item/mcpToolCall/progress','item/commandExecution/terminalInteraction','item/fileChange/patchUpdated','item/autoApprovalReview/started','item/autoApprovalReview/completed','hook/started','hook/completed','skills/changed','account/updated','app/list/updated','mcpServer/event/stream/notification',...optOut]);
const turnStatuses=['completed','interrupted','failed','inProgress'];
/**
 * Built-in tools a role is never granted. A role reaches the repository only through the offered task tools; Codex's own
 * tools act on the control-plane host, and in the locked version a sandboxed command that is not judged dangerous runs
 * without any approval request, so declining approvals alone cannot stop it. These feature flags remove the tools before
 * the first turn (shell_tool also removes exec_command/write_stdin; the unified_exec flag is not honoured per thread),
 * and experimentalFeature/list for the thread must report every one of them disabled.
 */
export const deniedFeatures=['shell_tool','view_image','multi_agent','apps','plugins','goals','sleep_tool'] as const;
const threadPolicy={approvalPolicy:'on-request',sandbox:'read-only',features:Object.fromEntries(deniedFeatures.map(name=>[name,false])),web_search:'disabled'} as const;
/**
 * Items that must not appear once the tools above are gone. One that does means the restriction did not hold: the run is
 * stopped at once (interrupt, then the process group is reclaimed) instead of continuing. A file change is refused only when
 * it was applied; under the read-only sandbox an attempt waits for an approval this client declines.
 */
const refusedItems:Record<string,string>={commandExecution:'host_command',imageView:'host_file_read',webSearch:'web_search',collabAgentToolCall:'sub_agent',subAgentActivity:'sub_agent'};

class RpcError extends Error{constructor(readonly method:string,readonly code:number,message:string){super(message);}}
// The locked server's answer for a thread whose local rollout is gone (verified with the real CLI).
const threadMissing=(error:RpcError)=>error.code===-32600&&/^no rollout found for thread id /.test(error.message);
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
 private pending=new Map<number,{method:string;resolve:(v:any)=>void;reject:(e:unknown)=>void;accept?:(result:any)=>any}>();private next=1;private buffer='';private decoder=new StringDecoder('utf8');
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
    if(m.error){p.reject(new RpcError(p.method,Number(m.error?.code??0),String(m.error?.message??'error')));return;}
    // accept runs now, before the following lines of the same chunk; the awaiting caller only resumes after this feed.
    let value:any;try{value=p.accept?p.accept(m.result):m.result;}catch(error){p.reject(error);throw error;}
    p.resolve(value);return;
   }
   this.handlers.anomaly('unclassified_message',{});
  }catch(error){this.fail(error as Error);}
 }
 /** accept, when given, handles the result synchronously at the moment its line is read and its value resolves the request. */
 request(method:string,params:unknown,accept?:(result:any)=>any):Promise<any>{
  if(this.failure)return Promise.reject(this.failure);
  const n=this.next++;return new Promise((resolve,reject)=>{this.pending.set(n,{method,resolve,reject,accept});this.write(JSON.stringify({id:n,method,params}));});
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
 // Two separate facts are persisted with the binding:
 // - lastTurn: the turn this binding is following, possibly one that is not confirmed yet (startRequested: a start was
 //   sent and never answered, so its id may be unknown);
 // - knownTurn: the last turn known to really exist. It survives a reconciliation that found nothing new and later starts,
 //   so a late notification of that turn is never taken for the turn a new start began.
 let lastTurn:{id:string|null;status:string|null}={id:null,status:null},knownTurn:string|null=null;
 const persist=(turn:typeof lastTurn,known:string|null=knownTurn)=>{lastTurn=turn;knownTurn=known;ctx.save({lastTurnId:turn.id,lastTurnStatus:turn.status,knownTurnId:known});};
 // id: the turn named by the start answer, bound the moment that answer is read; only its terminal ends this start. hint: a
 // turn id seen before any answer arrived (it may never come), only a guess: hintStarted when a turn/started named it.
 // previous: the turn known before this start, whose late notifications must not set the hint.
 type Waiter={id:string|null;hint:string|null;hintStarted:boolean;previous:string|null;done:boolean;resolve:(turn:any)=>void;reject:(e:unknown)=>void;usage:boolean};
 let current:Waiter|null=null,rerouted:{from:string;to:string}|null=null;
 // Cancel receipts are per turn id: the turns whose terminal arrived on this connection, and a cancel waiting for one turn.
 // A terminal of any other turn (a late one, a wrong guess) never answers that cancel. The end of the connection does.
 const ended=new Set<string>(),awaiting=new Map<string,()=>void>();let connectionEnded!:(kind:string)=>void;
 const closed=new Promise<string>(r=>{connectionEnded=r;});
 const terminalOf=(turnId:string)=>ended.has(turnId)?Promise.resolve('terminal'):new Promise<string>(r=>{awaiting.set(turnId,()=>r('terminal'));});
 const early=new Map<string,any>(),seen=new Set<string>(),reported=new Set<string>(),servers=new Map<string,{status:string;error:string|null}>();
 let serverChange:(()=>void)|null=null,committed=false;
 // Usage seen before the client commits the new binding (e.g. a total restated while resuming) waits with it: if the session
 // is refused, neither the increment nor the new cursor is recorded, so the next attempt counts it exactly once.
 const pendingUsage:HarnessEvent[]=[];
 // An anomaly is recorded once per kind and method; the stream continues.
 const anomaly=(kind:string,detail:Record<string,unknown>={})=>{const key=kind+':'+String(detail.method??'');if(reported.has(key))return;reported.add(key);emit({type:'configuration',stage:'protocol_anomaly',anomaly:kind,...detail});};
 // Before the thread is bound nothing belongs to this run yet (e.g. a usage total restated while resuming); that is no anomaly.
 const ours=(params:any,at:string)=>{if(!threadId)return false;if(params?.threadId===threadId){learn(params.turnId,false);return true;}anomaly('foreign_thread',{method:at});return false;};
 // A turn id seen while a start is still unanswered names the turn that start probably began, unless it is the turn known
 // before: it is persisted at once as an unconfirmed turn, so a cancel can interrupt it and the next run can reconcile it.
 // Any notification may carry a late turn's id; a turn/started is direct evidence of a new turn and replaces such a guess.
 const learn=(turnId:unknown,started:boolean)=>{
  if(!current||current.id||!id(turnId)||turnId===current.previous||current.hint&&(current.hintStarted||!started||current.hint===turnId))return;
  current.hint=turnId as string;current.hintStarted=started;persist({id:current.hint,status:'inProgress'},current.hint);
 };
 // A built-in tool acted although it was not granted: recorded as a denial, then the whole run stops through the shared path
 // (task tools refused, turn/interrupt, bounded wait, process group reclaimed). Sub-agents are refused the same way: their
 // threads, usage and evidence are not part of this role's run.
 const refuse=(itemType:string,reason:string,turnId:string,itemId:string)=>{
  ctx.denied('codex:'+itemType,reason);
  emit({type:'permission',requestId:null,method:'item/'+itemType,threadId,turnId,itemId,decision:'refused_after_start',allowed:false,reason});
  ctx.stop(reason==='sub_agent'?new TaskError('codex_subagent_refused','retry_wait','Codex 派生了子 agent；角色运行不接受子 agent，本次运行已停止。')
   :new TaskError('codex_builtin_tool_refused','waiting_configuration',`Codex 内建工具 ${itemType}（${reason}）不在角色授权内却已执行；本次运行已停止，请检查 Codex 版本与启动配置。`));
 };
 const notification=(method:string,params:any)=>{
  // Only its turn id matters (params.turn.id in the locked schema): it identifies a turn whose start answer may still be
  // pending, or never come.
  if(method==='turn/started'){if(ours(params,method))learn(check.turn(params?.turn,'turn/started.turn').id,true);return;}
  if(method==='turn/completed'){
   if(!ours(params,method))return;const turn=check.turn(params?.turn,'turn/completed.turn');
   ended.add(turn.id);awaiting.get(turn.id)?.();awaiting.delete(turn.id);
   // Only the turn the start answer named ends this start. Before the answer is handled every terminal waits in early and
   // the answer picks its own; the terminal of the hinted turn is then only a cancel receipt for that turn id.
   if(current&&current.id===turn.id){if(current.done){anomaly('duplicate_terminal',{method});return;}current.done=true;current.resolve(turn);}
   else if(current&&current.id===null)early.set(turn.id,turn);
   else anomaly('unknown_turn',{method});
  }else if(method==='item/started'||method==='item/completed'){
   const p=check.item(params,method);if(!ours(p,method))return;
   const it=p.item,completed=method==='item/completed',key=(completed?'c:':'s:')+it.id;
   if(seen.has(key)){anomaly('duplicate_item',{method});return;}seen.add(key);
   const refused=refusedItems[it.type]??(it.type==='fileChange'&&completed&&it.status==='completed'?'unapproved_file_change':it.type==='mcpToolCall'&&it.server!=='bot'?'tool_server_not_offered':null);
   if(refused){emit({type:'tool',callId:it.id,threadId,turnId:p.turnId,itemType:it.type,phase:completed?'completed':'started',...redactor.clean(itemFields(it,completed))});refuse(it.type,refused,p.turnId,it.id);return;}
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
   usageBase=total;ctx.save({usage:total});if(current&&(current.id===params.turnId||current.id===null&&params.turnId!==current.previous))current.usage=true;
   const event:HarnessEvent={type:'usage',source:'codex_app_server',threadId,turnId:String(params.turnId),delta,thread_total:total};
   if(committed)emit(event);else pendingUsage.push(event);
  }else if(method==='error'){
   if(!ours(params,method))return;need(typeof params?.error?.message==='string'&&typeof params.willRetry==='boolean','error.params');
   emit({type:'configuration',stage:'turn_error',threadId,turnId:params.turnId??null,willRetry:params.willRetry,code:errorKind(params.error.codexErrorInfo),message:clip(redactor.text(params.error.message),500)});
  }else if(method==='model/rerouted'){
   if(!ours(params,method))return;need(typeof params?.fromModel==='string'&&typeof params?.toModel==='string','model/rerouted.params');
   // The server moved this turn to another model: recorded and stopped, never continued under a model nobody configured.
   rerouted={from:params.fromModel,to:params.toModel};emit({type:'configuration',stage:'model_rerouted',threadId,turnId:params.turnId??null,fromModel:params.fromModel,toModel:params.toModel,reason:params.reason??null});
   ctx.stop(new TaskError('codex_model_rerouted','waiting_configuration',`app-server 把 ${rerouted.from} 改路由到 ${rerouted.to}；不会在未配置的模型上继续。`));
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
 const rpc=new LineRpc(line=>{ctx.child.stdin.write(line+'\n');},{notification,request,anomaly,failed:error=>{current?.reject(error);connectionEnded('connection_closed');serverChange?.();}});
 ctx.child.stdout.on('data',chunk=>rpc.feed(chunk));
 ctx.child.stdout.once('end',()=>rpc.fail(new TaskError('codex_connection_lost','retry_wait','stdout_closed')));
 ctx.child.once('exit',(code,signal)=>rpc.fail(new TaskError('codex_connection_lost','retry_wait',`exit:${code??signal}`)));
 ctx.child.once('error',error=>rpc.fail(new TaskError('codex_connection_lost','retry_wait',String(error.message))));
 ctx.child.stdin.on('error',error=>rpc.fail(new TaskError('codex_connection_lost','retry_wait',String(error.message))));

 // Before the first turn the thread must run read-only with on-request approvals, and the server's own feature state for
 // this thread must report every denied built-in tool disabled. A flag the server did not apply refuses the session.
 async function verifyBuiltins(thread:ReturnType<typeof check.thread>){
  const sandbox=(thread.sandbox as any)?.type??thread.sandbox;
  if(thread.approvalPolicy!==threadPolicy.approvalPolicy||!['readOnly','read-only'].includes(String(sandbox)))stop('codex_builtin_tools_enabled','waiting_configuration',`thread 的 sandbox ${JSON.stringify(thread.sandbox)}、审批策略 ${JSON.stringify(thread.approvalPolicy)} 不是 read-only / on-request。`);
  const state=new Map<string,boolean>();let cursor:string|null=null;
  for(let page=0;page<20;page++){
   const listed=await rpc.request('experimentalFeature/list',{threadId,limit:500,...(cursor?{cursor}:{})});
   need(Array.isArray(listed?.data)&&listed.data.every((f:any)=>typeof f?.name==='string'&&typeof f?.enabled==='boolean'),'experimentalFeature/list.result');
   for(const f of listed.data)state.set(f.name,f.enabled);
   cursor=typeof listed.nextCursor==='string'&&listed.nextCursor?listed.nextCursor:null;if(!cursor)break;
  }
  const enabled=deniedFeatures.filter(name=>state.get(name)!==false);
  if(enabled.length)stop('codex_builtin_tools_enabled','waiting_configuration',`Codex 内建工具没有关闭：${enabled.join(', ')}`);
  return [...deniedFeatures];
 }
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
   const overrides={cwd,approvalPolicy:threadPolicy.approvalPolicy,sandbox:threadPolicy.sandbox,developerInstructions:ctx.instructions,
    config:{mcp_servers:{bot:{url:ctx.mcpUrl}},features:threadPolicy.features,web_search:threadPolicy.web_search},
    ...(config.model?{model:config.model}:{}),...(config.modelProvider?{modelProvider:config.modelProvider}:{})};
   const prior=!fresh&&previous?.protocol==='codex-app-server'&&id(previous.sessionId)?previous:null;
   let recovery=fresh?'fresh_evaluation':previous?.sessionId?'rebuilt_from_task_records':'new_session',thread:ReturnType<typeof check.thread>|null=null,reconciled:Record<string,unknown>|null=null,notice='';
   const switched=(model:unknown,provider:unknown)=>prior&&(prior.model&&model!==prior.model||prior.modelProvider&&provider!==prior.modelProvider);
   if(prior){
    // A binding made under another model or provider is not resumed under the current one, and nothing switches silently.
    if(switched(config.model??prior.model,config.modelProvider??prior.modelProvider))stop('codex_resume_incompatible','waiting_configuration',`thread ${prior.sessionId} 绑定 ${prior.modelProvider}/${prior.model}，当前配置 ${config.modelProvider??'-'}/${config.model??'-'}。可还原配置后重试；确需换模型时暂停任务并执行 adopt-config（POST /api/tasks/:id/adopt-config），按新配置重建角色会话。`);
    try{thread=check.thread(await rpc.request('thread/resume',{threadId:prior.sessionId,excludeTurns:true,...overrides}),'thread/resume.result');}
    catch(error){
     // Only a thread the server explicitly has no rollout for is lost; any other failure keeps the binding for a retry.
     if(!(error instanceof RpcError))throw error;
     if(!threadMissing(error))stop('codex_resume_failed','retry_wait',`thread/resume ${prior.sessionId}：${clip(redactor.text(error.message),300)}（${error.code}）；保留原 thread 绑定。`);
     emit({type:'configuration',recovery:'native_resume_failed',previousSessionId:prior.sessionId,reason:clip(redactor.text(error.message),300)});
    }
    if(thread){
     // Ownership: the same thread, created in this role instance's own session directory, on the same model and provider.
     if(thread.thread.id!==prior.sessionId||resolve(thread.cwd)!==resolve(cwd))stop('codex_thread_ownership_mismatch','failed','恢复的 thread 不属于这个角色实例。');
     if(switched(thread.model,thread.modelProvider))stop('codex_resume_incompatible','waiting_configuration',`恢复的 thread 使用 ${thread.modelProvider}/${thread.model}，绑定的是 ${prior.modelProvider}/${prior.model}。`);
     recovery='native_resume';usageBase=prior.usage&&count(prior.usage.total)?prior.usage:null;
     // Unknown state is reconciled first: the last turn the binding did not see end is read back from the thread itself. A
     // known turn is matched by id. A start that was never answered may still have begun: the thread's newest turn, if it
     // is not the turn known before that start, is that turn.
     // The last really known turn: knownTurnId, else a turn id the binding recorded (previousTurnId in older bindings).
     knownTurn=[prior.knownTurnId,prior.lastTurnId,prior.previousTurnId].find(id)??null;
     if(prior.lastTurnStatus&&!['completed','not_started'].includes(prior.lastTurnStatus)){
      let status='unknown',turnId:string|null=id(prior.lastTurnId)?prior.lastTurnId:null;
      try{
       const page=await rpc.request('thread/turns/list',{threadId:prior.sessionId,limit:1}),last=Array.isArray(page?.data)?page.data[0]:undefined;
       if(turnId){if(last?.id===turnId&&turnStatuses.includes(last.status))status=last.status;}
       else if(last&&id(last.id)&&last.id!==knownTurn&&turnStatuses.includes(last.status)){turnId=knownTurn=last.id;status=last.status;}
       else if(Array.isArray(page?.data))status='not_started';
      }catch(error){if(!(error instanceof RpcError))throw error;}
      reconciled={turnId,recorded:prior.lastTurnStatus??null,observed:status};
      notice=`Your previous turn ${turnId??'(its start was never confirmed)'} did not end with a confirmed completion (observed: ${status}). Before repeating any action, check task records for its effects.`;
     }
    }
   }
   if(!thread){
    thread=check.thread(await rpc.request('thread/start',overrides),'thread/start.result');
    // A rebuild keeps the binding's model and provider; a different default is a migration the operator makes explicitly.
    if(switched(thread.model,thread.modelProvider))stop('codex_resume_incompatible','waiting_configuration',`thread ${prior!.sessionId} 已丢失，重建会从 ${prior!.modelProvider}/${prior!.model} 换成 ${thread.modelProvider}/${thread.model}。可在 BOT_CODEX_CONFIG 固定原 model/modelProvider 后重试；确需换模型时暂停任务并执行 adopt-config（POST /api/tasks/:id/adopt-config），按新配置重建角色会话。`);
   }
   threadId=thread.thread.id;
   // The model and provider are what the server reports for this thread; a configured value it did not take is refused.
   if(config.model&&thread.model!==config.model||config.modelProvider&&thread.modelProvider!==config.modelProvider)stop('codex_model_mismatch','waiting_configuration',`配置 ${config.modelProvider??'-'}/${config.model??'-'}，app-server 实际为 ${thread.modelProvider}/${thread.model}。`);
   const builtins=await verifyBuiltins(thread),tools=await verifyTools();
   if(prior&&recovery==='native_resume')lastTurn={id:(reconciled?.turnId as string|null|undefined)??prior.lastTurnId??null,status:(reconciled?.observed as string|undefined)??prior.lastTurnStatus??null};
   else{lastTurn={id:null,status:null};knownTurn=null;}
   return {sessionId:threadId,recovery,notice,agentInfo:{name:'codex-app-server',version:cli},
    state:{protocol:'codex-app-server',model:thread.model,modelProvider:thread.modelProvider,cliVersion:cli,lastTurnId:lastTurn.id,lastTurnStatus:lastTurn.status,knownTurnId:knownTurn,usage:usageBase},
    bound:{threadId,model:thread.model,modelProvider:thread.modelProvider,cliVersion:cli,approvalPolicy:redactor.clean(thread.approvalPolicy??null),sandbox:redactor.clean(thread.sandbox??null),disabledBuiltins:builtins,instructionSources:redactor.clean(thread.instructionSources??[]),tools,reconciled}};
  },
  async turn(prompt){
   text='';
   const waiter:Waiter={id:null,hint:null,hintStarted:false,previous:knownTurn,done:false,usage:false,resolve:()=>{},reject:()=>{}};
   const terminal=new Promise<any>((ok,fail)=>{waiter.resolve=ok;waiter.reject=fail;});
   terminal.catch(()=>{});current=waiter;
   const before={turn:lastTurn,known:knownTurn};
   // Before asking, the binding records that a turn may begin: the server can start it and never answer.
   persist({id:null,status:'startRequested'});
   // The answer is taken the moment its line is read: later lines of the same chunk (late notifications of older turns, an
   // item that stops the run) already see this start bound to its turn, and a cancel they trigger interrupts that turn.
   const accept=(result:any)=>{
    const started=check.turn(result?.turn,'turn/start.result.turn');
    // The answer settles which turn this start began; a different hint was a late turn and is dropped from the binding.
    if(waiter.hint&&waiter.hint!==started.id)anomaly('hint_not_started_turn',{method:'turn/start'});
    waiter.id=started.id;persist({id:started.id,status:'inProgress'},started.id);emit({type:'turn',phase:'started',threadId,turnId:started.id});
    const known=early.get(started.id);if(known){early.delete(started.id);waiter.done=true;waiter.resolve(known);}
    return started;
   };
   try{await rpc.request('turn/start',{threadId,input:[{type:'text',text:prompt}]},accept);}
   catch(error){
    // Once the answer named the turn, a later failure (saving it, recording its start) fails this run only: that turn stays
    // the binding's unconfirmed turn for the next run to reconcile, never replaced by a hint and never reported as a start
    // without an answer. Usage it consumed is counted when the thread total it raised is next reported.
    if(waiter.id){if(lastTurn.id!==waiter.id)try{persist({id:waiter.id,status:'inProgress'},waiter.id);}catch{}throw error;}
    // An explicit refusal started nothing: the binding is exactly what it was before. Otherwise the turn may have run: a turn
    // id its notifications carried is already persisted as an unconfirmed turn, and without one the binding keeps "start
    // requested". Its usage counts once: as the reports already received, or as one unknown request when there were none.
    if(error instanceof RpcError)persist(before.turn,before.known);
    else{
     // Without an answer the hinted turn is the best knowledge; a terminal it already reported is kept with it.
     const ended=waiter.hint?early.get(waiter.hint):undefined;if(ended)persist({id:waiter.hint,status:ended.status},waiter.hint);
     emit({type:'turn',phase:'start_unconfirmed',threadId,turnId:waiter.hint,usage:waiter.usage?'observed':'unknown'});
    }
    throw error;
   }
   // Only the terminal notification ends a turn; the start answer does not, and a stream that ends first fails the turn.
   const turn=await terminal;
   persist({id:turn.id,status:turn.status},turn.id);
   emit({type:'turn',phase:'ended',threadId,turnId:turn.id,status:turn.status,durationMs:turn.durationMs??null,usage:waiter.usage?'observed':'unknown',error:turn.error?{code:errorKind(turn.error.codexErrorInfo),message:clip(redactor.text(turn.error.message),500)}:null});
   if(rerouted)stop('codex_model_rerouted','waiting_configuration',`app-server 把 ${rerouted.from} 改路由到 ${rerouted.to}；不会在未配置的模型上继续。`);
   if(turn.status==='completed')return {text};
   if(turn.status==='interrupted')throw new TaskError('codex_turn_interrupted','retry_wait');
   if(turn.status==='inProgress')invalid('turn/completed.turn.status');
   throw turnFailure(turn,s=>redactor.text(s));
  },
  // turn/interrupt, then a bounded wait for the terminal of that same turn (the answered one, or the guess while no answer
  // exists); the caller reclaims the process group afterwards.
  async cancel(){
   const waiter=current;if(!threadId||!waiter||waiter.done||rpc.failure)return;
   const grace=config.cancelGraceMs??5000;
   const turnId=waiter.id??waiter.hint;
   if(turnId){emit({type:'turn',phase:'interrupt_requested',threadId,turnId});rpc.request('turn/interrupt',{threadId,turnId}).catch(()=>{});}
   let timer:NodeJS.Timeout|undefined;
   const receipt=await Promise.race([turnId?terminalOf(turnId):closed,closed,new Promise<string>(r=>{timer=setTimeout(()=>r('timeout'),grace);})]);clearTimeout(timer);
   if(turnId)awaiting.delete(turnId);
   emit({type:'turn',phase:'interrupt_receipt',threadId,turnId,receipt});
  },
  bound(){committed=true;for(const event of pendingUsage.splice(0))emit(event);},
  close(){rpc.fail(new TaskError('codex_connection_closed','retry_wait'));},
 };
 return dialect;
}
