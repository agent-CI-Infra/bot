import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentSpec,AgentServices } from '../agent/runtime.js';
import { stop } from '../agent/common.js';
import { traceEvent } from '../tasks/trace.js';
/** The worker cannot access provider credentials or obtain arbitrary tools. */
export function processHarness<T>(spec:AgentSpec<T>){return async(services:AgentServices):Promise<T>=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../runner/role-worker.mjs',import.meta.url))],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout});let settled=false,result:T,requests=0,pending=Promise.resolve();let bytes=0;
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
    else if(m.args.name===spec.finish?.name){result=await spec.finish!.validate(m.args.args);value={submitted:true};}
    else {value=await spec.execute?.(m.args.name,m.args.args);traceEvent(spec.store,spec.task.id,'tool_observation',{name:m.args.name,arguments:spec.redactor.clean(m.args.args),observation:spec.redactor.clean(value)},spec.task.trace_run_id,'tool');}
   }else if(m.method==='final'){if(typeof m.args!=='string')stop('agent_output_invalid','retry_wait');result=spec.validate?await spec.validate(m.args):spec.redactor.text(m.args) as T;value={submitted:true};}
   else throw new Error('role_worker_protocol');
   child.stdin.write(JSON.stringify({id:m.id,result:spec.redactor.clean(value)})+'\n');
  }).catch(fail);
 });
 child.stdin.write(JSON.stringify({start:{system:spec.system,prompt:spec.prompt,messages:spec.session?.messages??[],tools:spec.tools??[],finish:spec.finish?.name,maxTurns:spec.maxTurns??32}})+'\n');
});}
