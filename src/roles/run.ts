import { cleanRoleMessages } from './storage.js';
import { selectedModel } from '../agent/model.js';
import { taskWorkflow } from '../workflows/resolve.js';
import { runAgent,type AgentSpec } from '../agent/runtime.js';
import { randomId } from '../core/security.js';
import { traceEvent,traceSource } from '../tasks/trace.js';
import { roleDefinition } from './pool.js';
import { roleHarness } from './harness.js';
import { memoryTools } from '../memory/project.js';
import { ProjectMemory } from '../memory/project.js';
export function roleConfig(store:AgentSpec<any>['store'],task:AgentSpec<any>['task']){const saved=store.get('SELECT value FROM settings WHERE key=?','roles:'+task.repository_id);return saved?JSON.parse(saved.value):{enabled:false,harnesses:{}};}
export async function runRole<T>(spec:AgentSpec<T>,role:string,assignment?:string,harnessOverride?:string):Promise<{result:T;reference:string;instance_id:string}>{
 const model=spec.model??selectedModel(spec.store,spec.task.repository_id,taskWorkflow(spec.task as any));spec.redactor.add(model.key);
 const s=spec.store,task=spec.task,config=roleConfig(s,task);let definition=roleDefinition(role,config),harness=harnessOverride??config.harnesses?.[role]??definition.harness;
 roleHarness(harness);
 let instance=s.get('SELECT * FROM role_instances WHERE task_id=? AND role=?',task.id,role);
 if(!instance){const id=randomId();s.run('INSERT INTO role_instances(id,task_id,role,definition,harness,updated_at) VALUES(?,?,?,?,?,?)',id,task.id,role,JSON.stringify(definition),harness,new Date().toISOString());instance=s.get('SELECT * FROM role_instances WHERE id=?',id)!;}
 // Configuration updates affect new instances, not an existing continuing session.
 definition=JSON.parse(instance.definition);harness=instance.harness;
 const stored=cleanRoleMessages(JSON.parse(instance.session)),messages=role==='qa'?[]:stored;
 // A crash can leave an assistant tool batch partially answered. Mark absent receipts as
 // interrupted, never fabricate their observations; the role must query durable task facts.
 for(let i=0;i<messages.length;i++){const msg=messages[i];if(msg.role!=='assistant'||!msg.tool_calls?.length)continue;const replies=new Set<string>();let end=i+1;while(messages[end]?.role==='tool'){replies.add(messages[end].tool_call_id);end++;}const missing=msg.tool_calls.filter((c:any)=>!replies.has(c.id)).map((c:any)=>({role:'tool',tool_call_id:c.id,content:JSON.stringify({error:'interrupted_observation',instruction:'Inspect task records before repeating any action.'})}));messages.splice(end,0,...missing);i=end+missing.length-1;}
 const recover=role==='qa'?'fresh_evaluation':messages.length?'checkpoint_transcript':'new_session';
 const snapshot=traceEvent(s,task.id,'role_input',{instance_id:instance.id,role,role_version:definition.version,harness,assignment_id:assignment??null,recovery_mode:recover,input:spec.redactor.clean(spec.prompt)},task.trace_run_id,'role:'+role);
 const sourceInput=spec.prompt;
 let memory:any;try{memory={availability:'available',...new ProjectMemory(s).search(task.repository_id,'',{role,limit:5,baseline:task.head_sha})};}catch{memory={availability:'unavailable',instruction:'Role memory lookup failed; continue from task records and repository sources. Do not infer no prior knowledge.'};traceEvent(s,task.id,'memory_fault',{operation:'role_context',role,code:'role_memory_unavailable'},task.trace_run_id);}
 const memoryAliases=role==='manager'?[]:memoryTools.filter(t=>['search_project_memory','remember_project_memory'].includes(t.function.name)&&spec.tools?.some(x=>x.function.name===t.function.name)).map(t=>({...t,function:{...t.function,name:t.function.name.replace('_project_','_role_')}}));
 let executionRun:string|undefined;
 const wrapped:AgentSpec<T>={...spec,model,onRun:id=>{executionRun=id;spec.onRun?.(id);},tools:[...(spec.tools??[]),...memoryAliases],execute:async(name,args)=>{if(memoryAliases.some(t=>t.function.name===name))return spec.execute?.(name.replace('_role_','_project_'),{...args,role_scope:role});return spec.execute?.(name,args);},system:definition.prompt+'\n'+spec.system,prompt:JSON.stringify({...(()=>{try{return JSON.parse(sourceInput);}catch{return {input:sourceInput};}})(),role_context:{assignment_ref:snapshot,role_memory:memory}}),requestPrefix:`role:${instance.id}:${instance.sequence}:`,roleRun:{instance_id:instance.id,role,version:definition.version,harness,harness_version:roleHarness(harness).version,assignment_id:assignment,recovery_mode:recover},session:{messages,save:msgs=>{s.run('UPDATE role_instances SET session=?,updated_at=? WHERE id=?',JSON.stringify(cleanRoleMessages(spec.redactor.clean(msgs))),new Date().toISOString(),instance!.id);}}};
 s.run('UPDATE role_instances SET sequence=sequence+1 WHERE id=?',instance.id);
 wrapped.adapter=roleHarness(harness).adapter?.(wrapped);
 const previousRole=task.active_role;task.active_role=role;let result:T;try{result=await runAgent(wrapped);}finally{task.active_role=previousRole;}
 const reference=traceEvent(s,task.id,'role_result',{instance_id:instance.id,role,assignment_id:assignment??null,candidate_version:assignment?s.get('SELECT candidate_version FROM role_assignments WHERE id=?',assignment)?.candidate_version??null:null,contract_revision:s.get('SELECT revision FROM task_records WHERE task_id=?',task.id)?.revision,result:spec.redactor.clean(result)},executionRun,'role:'+role,[snapshot]);
 return {result,reference,instance_id:instance.id};
}
