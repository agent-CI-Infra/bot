import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { runTools } from '../agent/runtime.js';
import { managedSession } from '../harness/session.js';
import { acpHarness } from './acp.js';
import type { AgentSpec,AgentServices } from '../agent/runtime.js';
import { stop } from '../agent/common.js';
import { traceEvent } from '../tasks/trace.js';
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
   if(m.method==='checkpoint'){if(!Array.isArray(m.args)||Buffer.byteLength(JSON.stringify(m.args))>2*1024*1024)stop('agent_context_too_large','needs_replan');spec.session?.save(spec.redactor.clean(m.args));value={saved:true};}
   else if(m.method==='model'){const response=await services.request(m.args,'worker:'+requests++);const message=response.value?.choices?.[0]?.message;value=spec.redactor.clean({role:'assistant',content:typeof message?.content==='string'?message.content:null,...(message?.tool_calls?{tool_calls:message.tool_calls}:{})});}
   else if(m.method==='tool'){
    const offered=spec.tools?.some(t=>t.function.name===m.args.name);
    if(!offered||!m.args.offered)value={error:'tool_not_allowed'};
    else if(m.args.name===spec.finish?.name){try{result=await spec.finish!.validate(m.args.args);value={submitted:true};}catch(error){value=repair(error);}}
    else {value=await spec.execute?.(m.args.name,m.args.args);traceEvent(spec.store,spec.task.id,'tool_observation',{name:m.args.name,arguments:spec.redactor.clean(m.args.args),observation:spec.redactor.clean(value)},spec.task.trace_run_id,'tool');}
   }else if(m.method==='final'){if(typeof m.args!=='string')stop('agent_output_invalid','retry_wait');try{result=spec.validate?await spec.validate(m.args):spec.redactor.text(m.args) as T;value={submitted:true};}catch(error){value=repair(error);}}
   else throw new Error('role_worker_protocol');
   child.stdin.write(JSON.stringify({id:m.id,result:spec.redactor.clean(value)})+'\n');
  }).catch(fail);
 });
 child.stdin.write(JSON.stringify({start:{system:spec.system,prompt:spec.prompt,messages:spec.session?.messages??[],tools:spec.tools??[],finish:spec.finish?.name,maxTurns:spec.maxTurns??32}})+'\n');
});}

export const harnesses:RoleHarnessMetadata[]=[{id:'acp',version:'1',session:'external_session',events:'acp_events_and_task_tools',externalModel:true},{id:'native',version:'1',session:'checkpoint_transcript',events:'tool_observations'},{id:'process',version:'1',session:'checkpoint_transcript',events:'rpc_tool_observations'}];
export interface RoleHarnessMetadata {id:string;version:string;session:string;events:string;externalModel?:boolean}
type AdapterFactory=<T>(spec:AgentSpec<T>)=>NonNullable<AgentSpec<T>['adapter']>;
const adapters=new Map<string,AdapterFactory|undefined>([['native',undefined],['process',processHarness],['acp',acpHarness]]);
/** Extensions are registered by trusted integration code, never by task text or a model tool. */
export function registerRoleHarness(metadata:RoleHarnessMetadata,factory:AdapterFactory){
 if(!/^[a-z][a-z0-9_-]{0,31}$/.test(metadata.id)||!metadata.version||!['checkpoint_transcript','task_records','external_session'].includes(metadata.session)||!metadata.events||adapters.has(metadata.id)||typeof factory!=='function')throw new Error('invalid_or_duplicate_role_harness');
 adapters.set(metadata.id,factory);harnesses.push({...metadata});
}
export function roleHarness(id:string){
 if(!adapters.has(id))throw new Error('unknown_role_harness');const factory=adapters.get(id);
 return {...harnesses.find(h=>h.id===id)!,adapter:<T>(spec:AgentSpec<T>)=>async(services:AgentServices)=>{
  const emit=(event:import('../harness/session.js').HarnessEvent)=>traceEvent(spec.store,spec.task.id,'harness_event',spec.redactor.clean(event),spec.task.trace_run_id,'harness');
  const session=managedSession(async signal=>{const wrapped={...spec,executionSignal:signal,guard:async()=>{if(signal.aborted)throw signal.reason;await spec.guard();}};return factory?factory(wrapped)({...services,guard:wrapped.guard}):runTools(wrapped,{...services,guard:wrapped.guard});},emit);
  try{return await session.run();}finally{await session.close();}
 }};
}
