import {createHash} from 'node:crypto';
import type {AgentSpec,AgentServices} from '../agent/runtime.js';
import type {Row} from '../storage/database.js';
import {randomId,type Json} from '../core/security.js';
import {stop,TaskError} from '../agent/common.js';
import {roleHarness} from '../roles/harness.js';
import {SubmissionError} from '../roles/submission-error.js';
import {harnessAccess} from './access.js';
import type {AssistantComputer} from '../service-roles/assistant-computers.js';
import type {MediaTurn} from '../channels/media.js';
import type {IncomingBatch,TurnMessages} from '../channels/turn-messages.js';
import type {PiServiceTurn} from '../agent/pi.js';
import {chatContextBytes} from '../agent/tool-context.js';
import {staySilentName} from '../service-roles/stay-silent.js';
import {traceEvent} from '../tasks/trace.js';

/**
 * What the native loop of a service assistant does around its model requests, for a turn on Pi (#1253). The other
 * harnesses run their turn as before and ignore it.
 */
export interface ServiceTurnControl {
 /** The answer as the model writes it, for the console's provisional text. Writing it pauses merging, as natively. */
 text?: (delta:string)=>Promise<void>;
 /** Messages that arrive during the turn (#458): merged after the prompt and after each tool batch. */
 incoming?: TurnMessages;
 /** A merged batch, so the caller knows whether the turn must now answer. */
 merged?: (batch:IncomingBatch)=>void;
 /** The request's source. When its version changes (an edit), the session ends and the turn starts again from prompt().
  * `seen` is the version the turn's prompt was built from, as the native loop compares with the version at its start. */
 source?: {version:()=>unknown;prompt:()=>string;seen:unknown};
 /** Answers a stay_silent call (#489) when the turn offers that tool. A silent answer ends the turn without a reply. */
 silence?: (args:unknown)=>Json|Promise<Json>;
}
// Thrown within an attempt whose source changed; serviceHarnessTurn catches it and starts again, it never ends a turn.
const sourceEdited='service_turn_source_edited';

/** Non-project assistants connect to the same drivers, using the conversation owner's computer, never a random project. */
export async function serviceHarnessTurn(
 spec:AgentSpec<string>,services:AgentServices,role:Row,computer:AssistantComputer|undefined,scope:string,media?:MediaTurn,control?:ServiceTurnControl,
):Promise<string>{
 if(!computer)return stop('harness_environment_required','waiting_environment','所选 Harness 需要助手会话运行环境。');
 const driver=roleHarness(String(role.harness)),digest=(v:string)=>createHash('sha256').update(v).digest('hex');
 const binding=digest(scope+':'+role.id+':'+role.revision);
 const previous=spec.store.get('SELECT state FROM service_harness_sessions WHERE id=?',binding);
 let state=previous?JSON.parse(previous.state):{};
 const turnId=spec.task.id+':'+binding;
 spec.store.run("INSERT INTO service_harness_sessions(id,service_role_id,turn_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET turn_id=excluded.turn_id,updated_at=excluded.updated_at",binding,role.id,turnId,Date.now());
 spec={...spec,task:{...spec.task,id:turnId}};
 const workspaceId=digest('workspace:'+binding).slice(0,48);
 const save=(value:Record<string,any>)=>{state=spec.redactor.clean(value);spec.store.run('UPDATE service_harness_sessions SET state=?,updated_at=? WHERE id=?',JSON.stringify(state),Date.now(),binding);};
 // The native loop's turn on Pi: merged messages, streamed text, a restart after an edit and stay_silent as its ending.
 const steered=driver.id==='pi'?control:undefined;
 const attempt=async(prompt:string,version:unknown):Promise<string>=>{
  // A session kept from earlier turns holds the source as it was then; after an edit or a recall it is not continued.
  if(steered?.source&&state.harness&&!Object.is(state.source_version??null,version??null))save({});
  const workspace=await computer.sessionWorkspace(spec.task,workspaceId,spec.redactor,event=>traceEvent(spec.store,spec.task.id,'harness_event',event));
  const egress=computer.egress??true;
  const token=randomId();spec.redactor.add(token);
  // Nothing done on the old source counts: no tool runs, no answer or silence is accepted (as natively, a response to an
  // older projection authorizes nothing). A silence already accepted stands, as the native loop ends right after it.
  let silenced=false;
  const edited=()=>{if(steered?.source&&!Object.is(steered.source.version(),version))throw new TaskError(sourceEdited,'retry_wait');};
  const merge=():string[]=>{const added=steered?.incoming?.take(chatContextBytes);if(!added)return [];steered!.merged?.(added);return [JSON.stringify(added.content)];};
  const service:PiServiceTurn|undefined=steered&&{
   steer:()=>{edited();return merge();},
   boundary:async()=>{edited();steered.incoming?.resume();return {messages:merge()};},
   text:async delta=>{steered.incoming?.pause();await steered.text?.(delta);},
   // As natively: the answer closes merging, a response with tool calls opens it again for the next request.
   responded:toolCalls=>{if(toolCalls)steered.incoming?.resume();else steered.incoming?.pause();},
   retry:async retry=>{await spec.onModelRetry?.({retry:retry.retry,retries:retry.retries,code:'model_unavailable',...(retry.error?{detail:retry.error}:{}),delay_ms:retry.delay_ms,request_id:'pi'});},
  };
  // A Pi turn answers in text, as the native loop does, so the answer streams; it ends silently only through stay_silent.
  const silent=!!steered?.silence&&(spec.tools??[]).some(t=>t.function.name===staySilentName);
  const finishTool={type:'function',function:{name:'finish',description:'Finish this conversational turn. This does not accept or complete a business task.',parameters:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}}};
  const current:AgentSpec<string>={...spec,adapter:undefined,prompt,tools:[...(spec.tools??[]).filter(t=>t.function.name!=='finish'),...(steered?[]:[finishTool])],
   ...(steered?{execute:async(name:string,args:any)=>{edited();return spec.execute?.(name,args);}}:{}),
   ...(media?{takeToolImages:(name,observation)=>media.takeToolImages(name,observation)}:{}),
   finish:steered?(silent?{name:staySilentName,validate:async args=>{
    edited();const result=await steered.silence!(args);
    if(result.error)throw new SubmissionError(String(result.error),{detail:result.detail});
    silenced=true;return '';
   }}:undefined):{name:'finish',validate:args=>{if(typeof args?.message!=='string')throw new Error('invalid_reply');return args.message;}},onTurnEnd:turn=>turn.text,
   roleWorkspace:workspace,containerOptions:{...spec.containerOptions,manager:workspace.manager,egress},
   harnessSessionKey:binding,
   harnessAccess:harnessAccess(JSON.parse(role.permissions??'{}'),egress,null,{read:!!spec.tools?.some(t=>t.function.name==='read_file'),write:!!spec.tools?.some(t=>t.function.name==='write_file'),commands:!!spec.tools?.some(t=>t.function.name==='run_command')}),
   harnessState:{value:state,save:value=>save(steered?.source&&value.harness?{...value,source_version:version??null}:value)},
   runAccess:{token,check:presented=>{if(presented!==token)stop('run_token_invalid','failed');}},
   runContext:()=>({protocol:'bot.role-run/1',candidate_ref:null,task_id:null,conversation_id:binding,assignment_id:binding,run_id:String(spec.task.trace_run_id??spec.task.id),tenant_id:'service',project_id:'service',principal_ref:'service:'+role.id,source_ref:'conversation:'+binding,configuration_snapshot_ref:'service:'+role.revision,lease_epoch:1,contract_revision:0,policy_revision:'service:'+role.revision,role_revision:String(role.revision),harness_revision:driver.version,skill_revisions:[],model_revision:String(spec.model?.version??1),budget:{policy_ref:'entry-default',accounting:'per_run',max_turns:null,max_output_tokens:null,max_total_tokens:null,max_model_requests:null,max_tool_calls:null,max_wall_ms:null,max_concurrency:1},execution_context:{role_instance_id:binding,role:String(role.id),kind:'controller',environment_profile:'assistant'}}),
   pi:{workspace,key:'service:'+binding+':'+randomId(),resume:false,runtime:{version:driver.version,report:event=>traceEvent(spec.store,spec.task.id,'harness_event',{type:'runtime',...event})},...(service?{service}:{})},
  };
  if(driver.prepare)await driver.prepare(current);
  traceEvent(spec.store,spec.task.id,'harness_session',{binding,harness:driver.id,workspace_id:workspaceId,access:current.harnessAccess});
  const nativeServices:AgentServices={...services,request:(body,id,onToken,onFinish,options)=>services.request(body,id,onToken,onFinish,{...options,harnessTools:true})};
  try{const text=await driver.adapter(current)(nativeServices);if(!silenced)edited();return text;}finally{await workspace.release(false);}
 };
 let prompt=spec.prompt,version=steered?.source?.seen;
 for(;;){
  try{return await attempt(prompt,version);}
  catch(error){
   if(!(error instanceof TaskError&&error.code===sourceEdited))throw error;
   // The request was edited: a new session answers the edited request, never the one built on the old request, and the
   // messages merged so far are offered to it again.
   traceEvent(spec.store,spec.task.id,'harness_event',{type:'source_edited'});
   // The version is read first: an edit made while the context is rebuilt starts the turn once more.
   save({});version=steered!.source!.version();prompt=steered!.source!.prompt();steered!.incoming?.refresh?.();
  }
 }
}
