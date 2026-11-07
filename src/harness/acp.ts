import {spawn} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {client,ndJsonStream,PROTOCOL_VERSION,type ClientConnection} from '@agentclientprotocol/sdk';
import {TaskError,stop,sha,type Redactor} from '../agent/common.js';
import type {HarnessEvent} from './session.js';

export interface AcpConfiguration {command:string;args?:string[];env?:Record<string,string>;stateDirectory:string;model?:string;mode?:string;timeoutMs?:number;version?:string}
/** Executables and auth environment come from an operator-owned file, never task text/API input. */
export function acpConfiguration():AcpConfiguration{
 const path=process.env.BOT_ACP_CONFIG;if(!path)stop('acp_not_configured','waiting_configuration','Set BOT_ACP_CONFIG to an operator-owned ACP launch configuration.');
 let c:any;try{c=JSON.parse(readFileSync(path!,'utf8'));}catch{return stop('acp_configuration_invalid','waiting_configuration','ACP launch configuration is missing or invalid JSON.');}
 if(!c||typeof c.command!=='string'||!c.command||!Array.isArray(c.args??[])||(c.args??[]).some((a:unknown)=>typeof a!=='string')||typeof c.stateDirectory!=='string'||!c.stateDirectory||c.env&&(typeof c.env!=='object'||Array.isArray(c.env)||Object.values(c.env).some(v=>typeof v!=='string'))||c.timeoutMs!==undefined&&(!Number.isSafeInteger(c.timeoutMs)||c.timeoutMs<1000))stop('acp_configuration_invalid','waiting_configuration');
 return c;
}
export interface AcpInput<T> {
 sessionKey:string;
 system:string;
 prompt:string;
 fresh:boolean;
 submissionName?:string;
 state?:{value:Record<string,any>;save:(value:Record<string,any>)=>void};
 tools:{url:string;readonly submitted:boolean;readonly result:T};
 guard:()=>Promise<void>;
 redactor:Redactor;
 validate?:(text:string)=>T|Promise<T>;
}
/** Protocol-only execution: role/task/storage/publication semantics are supplied by callers. */
export async function runAcp<T>(input:AcpInput<T>,signal:AbortSignal,emit:(event:HarnessEvent)=>void):Promise<T>{
 const config=acpConfiguration();for(const [name,value] of Object.entries(config.env??{}))if(/key|token|secret|password/i.test(name))input.redactor.add(value);
 const key=input.sessionKey;
 const cwd=resolve(config.stateDirectory,key);mkdirSync(cwd,{recursive:true,mode:0o700});
 const bridge=input.tools;
 const env={PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:tmpdir(),...config.env};
 const child=spawn(config.command,config.args??[],{cwd,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
 const privateTools=new Set<string>();
 let connection:ClientConnection|undefined,sid='',replaying=false,text='',stopped=false,cancelReason:unknown;
 child.stderr.resume();
 const kill=()=>{if(child.exitCode!==null)return;try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
 const cancel=async(reason:unknown)=>{if(stopped||cancelReason)return;cancelReason=reason;try{if(sid)await connection?.agent.notify('session/cancel',{sessionId:sid});}catch{}setTimeout(()=>{connection?.close(reason);kill();},1000).unref();};
 const abort=()=>{void cancel(signal.reason??new TaskError('harness_cancelled','cancelled'));};signal.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{void cancel(new TaskError('harness_timeout','retry_wait'));},config.timeoutMs??30*60*1000);timer.unref();
 const guard=setInterval(()=>{void input.guard().catch(cancel);},500);guard.unref();
 const emitUpdate=(params:any)=>{
  if(replaying||params.sessionId!==sid)return;
  const u=params.update;
  if(u.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text'){text+=u.content.text;if(text.length>2*1024*1024)throw new Error('acp_output_limit');emit({type:'message',text:input.redactor.text(u.content.text)});}
  else if(['tool_call','tool_call_update'].includes(u.sessionUpdate)){
   if(u.kind==='think')privateTools.add(u.toolCallId);if(privateTools.has(u.toolCallId))return;
   // Explicit factual fields only: do not archive arbitrary vendor reasoning/private extensions.
   const data={callId:u.toolCallId,phase:u.status,title:u.title,kind:u.kind,rawInput:input.redactor.clean(u.rawInput??null),rawOutput:input.redactor.clean(u.rawOutput??null),content:input.redactor.clean((u.content??[]).filter((c:any)=>c.type==='content'&&c.content?.type==='text'||c.type==='diff'||c.type==='terminal'))};
   emit({type:'tool',...data});
  }else if(['current_mode_update','config_option_update','session_info_update','usage_update'].includes(u.sessionUpdate))emit({type:'configuration',update:input.redactor.clean({sessionUpdate:u.sessionUpdate,currentModeId:u.currentModeId,configOptions:u.configOptions,used:u.used,size:u.size,cost:u.cost})});
 };
 try{
  const app=client({name:'bot-harness'}).onNotification('session/update',({params})=>emitUpdate(params)).onRequest('session/request_permission',async({params})=>{
   await input.guard();const option=params.options.find(o=>o.kind==='allow_once');emit({type:'permission',requestId:params.toolCall.toolCallId,decision:option?'allow_once':'cancelled'});
   return {outcome:option?{outcome:'selected' as const,optionId:option.optionId}:{outcome:'cancelled' as const}};
  });
  connection=app.connect(ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  child.once('error',error=>connection?.close(error));child.once('exit',(code,signal)=>connection?.close(new Error(`acp_process_exit:${code??signal}`)));
  const init=await connection.agent.request('initialize',{protocolVersion:PROTOCOL_VERSION,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'bot',version:'1'}});
  if(init.protocolVersion!==PROTOCOL_VERSION)stop('acp_protocol_unsupported','waiting_configuration');
  const mcpServers=[{type:'http' as const,name:'bot',url:bridge.url,headers:[]}];
  if(!init.agentCapabilities?.mcpCapabilities?.http)stop('acp_mcp_http_unsupported','waiting_configuration');
  const previous=input.state?.value;let recovery=input.fresh?'fresh_evaluation':'new_session';
  if(previous?.sessionId&&init.agentCapabilities?.loadSession){
   replaying=true;
   try{await connection.agent.request('session/load',{sessionId:previous.sessionId,cwd,mcpServers});sid=previous.sessionId;recovery='native_resume';}
   catch{recovery='rebuilt_from_task_records';emit({type:'configuration',recovery:'native_resume_failed',previousSessionId:previous.sessionId});}
   finally{replaying=false;}
  }else if(previous?.sessionId)recovery='rebuilt_from_task_records';
  if(!sid){const created=await connection.agent.request<{sessionId:string;models?:unknown;configOptions?:unknown}>('session/new',{cwd,mcpServers});sid=created.sessionId;emit({type:'configuration',stage:'session_setup',models:created.models??null,configOptions:created.configOptions??null});}
  input.state?.save({sessionId:sid,previousSessionId:previous?.sessionId??null,cwd,recoveryMode:recovery,agentInfo:init.agentInfo??null,version:config.version??null,configurationHash:sha(JSON.stringify(config))});
  emit({type:'session_bound',sessionRef:sid,previousSessionRef:previous?.sessionId??null,recoveryMode:recovery,agentInfo:init.agentInfo??null,configuredModel:config.model??null,usage:'unknown'});
  if(config.mode)await connection.agent.request('session/set_mode',{sessionId:sid,modeId:config.mode});
  if(config.model)await connection.agent.request('session/set_config_option',{sessionId:sid,configId:'model',value:config.model});
  for(let repair=0;repair<3;repair++){
   await input.guard();if(signal.aborted)throw signal.reason;
   text='';const response=await connection.agent.request('session/prompt',{sessionId:sid,prompt:[{type:'text',text:input.system+'\n\n'+input.prompt+(repair?'\nYour last turn did not submit a valid role result. Reuse existing observations and submit the required structured result, without repeating unchanged tests.':'')}]});
   if(cancelReason)throw cancelReason;
   if(response.stopReason!=='end_turn')throw new TaskError('acp_turn_incomplete','retry_wait',String(response.stopReason));
   if(bridge.submitted)return bridge.result;
   if(!input.submissionName&&input.validate)return await input.validate!(text);
  }
  return stop('acp_submission_required','retry_wait');
 }catch(error){if(cancelReason)throw cancelReason;if(error instanceof TaskError)throw error;throw new TaskError('acp_execution_failed','retry_wait',input.redactor.text(String((error as Error).message)).slice(0,1000));}
 finally{stopped=true;clearTimeout(timer);clearInterval(guard);signal.removeEventListener('abort',abort);connection?.close();kill();}
}
