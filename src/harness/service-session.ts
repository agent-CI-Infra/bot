import {createHash} from 'node:crypto';
import type {AgentSpec,AgentServices} from '../agent/runtime.js';
import type {Row} from '../storage/database.js';
import {randomId} from '../core/security.js';
import {stop} from '../agent/common.js';
import {roleHarness} from '../roles/harness.js';
import {harnessAccess} from './access.js';
import type {AssistantComputer} from '../service-roles/assistant-computers.js';
import type {MediaTurn} from '../channels/media.js';
import {traceEvent} from '../tasks/trace.js';

/** Non-project assistants connect to the same drivers, using the conversation owner's computer, never a random project. */
export async function serviceHarnessTurn(
 spec:AgentSpec<string>,services:AgentServices,role:Row,computer:AssistantComputer|undefined,scope:string,media?:MediaTurn,
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
 const workspace=await computer.sessionWorkspace(spec.task,workspaceId,spec.redactor,event=>traceEvent(spec.store,spec.task.id,'harness_event',event));
 const token=randomId();spec.redactor.add(token);
 const finish={type:'function',function:{name:'finish',description:'Finish this conversational turn. This does not accept or complete a business task.',parameters:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}}};
 const current:AgentSpec<string>={...spec,adapter:undefined,tools:[...(spec.tools??[]).filter(t=>t.function.name!=='finish'),finish],
  ...(media?{takeToolImages:(name,observation)=>media.takeToolImages(name,observation)}:{}),
  finish:{name:'finish',validate:args=>{if(typeof args?.message!=='string')throw new Error('invalid_reply');return args.message;}},onTurnEnd:turn=>turn.text,
  roleWorkspace:workspace,containerOptions:{...spec.containerOptions,manager:workspace.manager,egress:false},
  harnessSessionKey:binding,
  harnessAccess:harnessAccess(JSON.parse(role.permissions??'{}'),false,null,{read:!!spec.tools?.some(t=>t.function.name==='read_file'),write:!!spec.tools?.some(t=>t.function.name==='write_file'),commands:!!spec.tools?.some(t=>t.function.name==='run_command')}),
  harnessState:{value:state,save:value=>{state=spec.redactor.clean(value);spec.store.run('UPDATE service_harness_sessions SET state=?,updated_at=? WHERE id=?',JSON.stringify(state),Date.now(),binding);}},
  runAccess:{token,check:presented=>{if(presented!==token)stop('run_token_invalid','failed');}},
  runContext:()=>({protocol:'bot.role-run/1',candidate_ref:null,task_id:null,conversation_id:binding,assignment_id:binding,run_id:String(spec.task.trace_run_id??spec.task.id),tenant_id:'service',project_id:'service',principal_ref:'service:'+role.id,source_ref:'conversation:'+binding,configuration_snapshot_ref:'service:'+role.revision,lease_epoch:1,contract_revision:0,policy_revision:'service:'+role.revision,role_revision:String(role.revision),harness_revision:driver.version,skill_revisions:[],model_revision:String(spec.model?.version??1),budget:{policy_ref:'entry-default',accounting:'per_run',max_turns:null,max_output_tokens:null,max_total_tokens:null,max_model_requests:null,max_tool_calls:null,max_wall_ms:null,max_concurrency:1},execution_context:{role_instance_id:binding,role:String(role.id),kind:'controller',environment_profile:'assistant'}}),
  pi:{workspace,key:'service:'+binding+':'+randomId(),resume:false,runtime:{version:driver.version,report:event=>traceEvent(spec.store,spec.task.id,'harness_event',{type:'runtime',...event})}},
 };
 if(driver.prepare)await driver.prepare(current);
 traceEvent(spec.store,spec.task.id,'harness_session',{binding,harness:driver.id,workspace_id:workspaceId,access:current.harnessAccess});
 const nativeServices:AgentServices={...services,request:(body,id,onToken,onFinish,options)=>services.request(body,id,onToken,onFinish,{...options,harnessTools:true})};
 try{return await driver.adapter(current)(nativeServices);}finally{await workspace.release(false);}
}
