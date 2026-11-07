import type { AgentSpec } from '../agent/runtime.js';
import { randomId } from '../core/security.js';
import { sha,stop } from '../agent/common.js';
import { traceEvent,traceSource } from '../tasks/trace.js';
import { TaskRecords } from '../tasks/service.js';
import { taskTools,playbookInstructions,playbooks } from '../tasks/playbooks.js';
import { rolePool,configuredRoles } from './pool.js';
import { runRole,roleConfig } from './run.js';
const tool=(name:string,description:string,properties:any,required:string[]=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const readRecord=tool('read_task_record','Read a durable record from THIS task by offered reference; use offset to page its JSON.',{ref:{type:'string'},offset:{type:'integer'}},['ref']);
export interface TeamEnvironment {prepare:(role:string)=>Promise<(()=>Promise<void>)|void>}
/** Manager has no executor callback, publication tool or completion authority. */
export async function runTeam<T>(spec:AgentSpec<T>,environment:TeamEnvironment):Promise<T>{
 const records=new TaskRecords(spec.store),s=spec.store,task=spec.task,pool=configuredRoles(roleConfig(s,task)),workers=pool.filter(r=>!['manager','qa'].includes(r.id)).map(r=>r.id);
 const resolve=(ref:string)=>traceSource(s,task.id,ref);
 const read=async(args:any)=>{if(!Number.isSafeInteger(args.offset??0)||(args.offset??0)<0)return {error:'invalid_offset'};let source;try{source=resolve(String(args.ref));}catch{return {error:'task_record_not_found',ref:args.ref,instruction:'Use an offered task_history source, task:'+task.id+' or contract:revision:'+records.get(task.id).revision};}const text=JSON.stringify(source),offset=args.offset??0;traceEvent(s,task.id,'role_record_read',{role:task.active_role,ref:args.ref,offset},task.trace_run_id,'role:'+task.active_role,[args.ref]);return {ref:args.ref,content:text.slice(offset,offset+16000),next_offset:offset+16000<text.length?offset+16000:null};};
 const commonExecute=async(name:string,args:any)=>{if(name==='read_task_record')return read(args);return spec.execute?.(name,args);};
 const findings=tool('submit_role_result','Persist findings for the fixed inspected candidate. This cannot approve or finish the task.',{summary:{type:'string'},findings:{type:'array',items:{type:'object',properties:{description:{type:'string'},evidence:{type:'array',items:{type:'string'}},severity:{type:'string'}},required:['description','evidence'],additionalProperties:false}},inspected_scope:{type:'array',items:{type:'string'}},unknowns:{type:'array',items:{type:'string'}}},['summary','findings','inspected_scope','unknowns']);
 const validateFindings=(v:any)=>{if(Array.isArray(v?.findings)&&v.findings.some((f:any)=>typeof f?.evidence==='string')){v={...v,findings:v.findings.map((f:any)=>typeof f?.evidence==='string'?{...f,evidence:[f.evidence]}:f)};traceEvent(s,task.id,'role_result_normalized',{role:task.active_role,field:'findings.evidence',from:'string',to:'string_array'},task.trace_run_id,'framework');}if(!v||typeof v.summary!=='string'||!v.summary.trim()||!Array.isArray(v.findings)||v.findings.some((f:any)=>!f||typeof f.description!=='string'||!f.description.trim()||!Array.isArray(f.evidence)||f.evidence.some((e:any)=>typeof e!=='string'))||!Array.isArray(v.inspected_scope)||v.inspected_scope.some((x:any)=>typeof x!=='string')||!Array.isArray(v.unknowns)||v.unknowns.some((x:any)=>typeof x!=='string'))return stop('role_result_invalid','retry_wait','Expected summary, findings with string-array evidence, inspected_scope string[] and unknowns string[].');return spec.redactor.clean(v);};
 const delegate=tool('delegate_role','Ask dev/test/reviewer/ux to work. Handoff uses persistent references, not copied conversations. Reuse dev for fixes. Returns ONLY a result reference; read it before deciding the next coordination step.',{role:{type:'string',enum:workers},purpose:{type:'string'},refs:{type:'array',items:{type:'string'}}},['role','purpose','refs']);
 const nominate=tool('nominate_delivery','Nominate a completed dev role result for mandatory independent QA. This does not approve, finish, publish or merge.',{result_ref:{type:'string'}},['result_ref']);
 const managerTools=[delegate,nominate,readRecord,...taskTools];
 const managerSpec:AgentSpec<T>={...spec,adapter:undefined,session:undefined,system:'Task Manager. '+playbookInstructions,prompt:JSON.stringify({task_id:task.id,task_ref:'task:'+task.id,contract_ref:'contract:revision:'+records.get(task.id).revision,contract:records.get(task.id).contract,current_state:{...records.get(task.id),candidate:records.get(task.id).candidate?{id:records.get(task.id).candidate!.id,revision:records.get(task.id).candidate!.revision,artifacts:records.get(task.id).candidate!.artifacts.map(({kind,reference,version})=>({kind,reference,version})),evidence:records.get(task.id).candidate!.evidence.map(({source,version})=>({source,version}))}:null},roles:pool.map(({prompt,...r})=>r),playbooks:playbooks.map(({content,...p})=>p),recent_results:s.all("SELECT id,type FROM task_history WHERE task_id=? AND type IN ('role_result','acceptance') ORDER BY id DESC LIMIT 12",task.id).map(r=>({ref:'task_history:'+r.id,type:r.type}))}),tools:managerTools,maxTurns:32,finish:{name:'nominate_delivery',validate:args=>{
  const row=s.get("SELECT h.data FROM task_history h WHERE h.task_id=? AND 'task_history:'||h.id=? AND h.type='role_result' AND json_extract(h.data,'$.role')='dev'",task.id,args?.result_ref);if(!row)return stop('role_nomination_invalid','retry_wait');
  const value=JSON.parse(row.data);if(value.contract_revision!==records.get(task.id).revision)return stop('role_nomination_stale','retry_wait');
  const latest=s.get("SELECT id FROM task_history WHERE task_id=? AND type='role_result' AND json_extract(data,'$.role')='dev' ORDER BY id DESC LIMIT 1",task.id);if(args.result_ref!=='task_history:'+latest?.id)return stop('role_nomination_stale','retry_wait');
  traceEvent(s,task.id,'delivery_nominated',{result_ref:args.result_ref,qa_required:true},task.trace_run_id,'role:manager',[args.result_ref]);return value.result as T;
 }},finalizationTools:['nominate_delivery'],validate:()=>stop('role_nomination_required','retry_wait'),execute:async(name,args)=>{
  if(name==='read_task_record')return read(args);
  if(taskTools.some(t=>t.function.name===name))return records.tool(task.id,name,spec.redactor.clean(args));
  if(name!=='delegate_role'||!workers.includes(args?.role)||typeof args.purpose!=='string'||!args.purpose.trim()||args.purpose.length>2000||!Array.isArray(args.refs)||args.refs.length>20||args.refs.some((ref:any)=>typeof ref!=='string'||ref.length>200))return {error:'invalid_role_assignment'};
  for(const ref of args.refs){try{resolve(String(ref));}catch{return {error:'invalid_task_reference',ref,instruction:'Read task history or use the offered current task/contract refs.'};}}
  const revision=records.get(task.id).revision,context=await environment.prepare(args.role);
  try{
   const sourceVersion=s.get("SELECT json_extract(data,'$.version') version FROM task_history WHERE task_id=? AND type='role_candidate' AND json_extract(data,'$.role')=? ORDER BY id DESC LIMIT 1",task.id,args.role)?.version??null;
   const inputKey=sha(JSON.stringify({role:args.role,purpose:args.purpose,refs:args.refs,revision,attempt:task.attempt,...(args.role==='dev'?{}:{candidate_version:sourceVersion})}));
   const existing=s.get('SELECT * FROM role_assignments WHERE task_id=? AND input_ref=?',task.id,inputKey);
   if(existing?.status==='completed')return {result_ref:existing.result_ref,reused:true};
   const assignment=existing?.id??randomId();
   const handoff=existing?null:traceEvent(s,task.id,'role_handoff',{assignment_id:assignment,role:args.role,purpose:args.purpose,refs:args.refs,revision},task.trace_run_id,'role:manager',args.refs);
   const role=args.role,dev=role==='dev';
   const narrow=dev?spec.tools??[]:(spec.tools??[]).filter(t=>['read_file','run_command','read_task_history','read_playbook','select_playbooks','search_project_memory','read_project_memory','read_related_artifact'].includes(t.function.name));
   const roleSpec:AgentSpec<any>={...spec,adapter:undefined,tools:[...narrow,readRecord,...(dev?[]:[findings])],system:dev?spec.system:'Inspect only this fixed candidate. Commands run in a separate disposable checkout; do not change source or claim unexecuted checks.',prompt:JSON.stringify({task_id:task.id,contract:records.get(task.id).contract,purpose:args.purpose,refs:args.refs,handoff_ref:handoff,previous_acceptance:records.get(task.id).acceptance,source_context:dev?spec.prompt:undefined}),execute:commonExecute,finish:dev?spec.finish:{name:'submit_role_result',validate:validateFindings},finalizationTools:dev?spec.finalizationTools:['submit_role_result'],validate:dev?spec.validate:content=>validateFindings(JSON.parse(content))};
   // Create the persistent instance before linking the assignment. runRole reuses it.
   const definition=pool.find(r=>r.id===role)!;let instance=s.get('SELECT id FROM role_instances WHERE task_id=? AND role=?',task.id,role);
   if(!instance){const id=randomId();s.run('INSERT INTO role_instances(id,task_id,role,definition,harness,updated_at) VALUES(?,?,?,?,?,?)',id,task.id,role,JSON.stringify(definition),definition.harness,new Date().toISOString());instance={id};}
   if(!existing)s.run('INSERT INTO role_assignments VALUES(?,?,?,?,?,?,?,?)',assignment,task.id,instance.id,revision,sourceVersion,'running',inputKey,null);
   s.run("UPDATE role_assignments SET status='running' WHERE id=?",assignment);
   try{const result=await runRole({...roleSpec,prompt:JSON.stringify({...JSON.parse(roleSpec.prompt),candidate_version:s.get('SELECT candidate_version FROM role_assignments WHERE id=?',assignment)?.candidate_version??null})},role,assignment);
   s.run("UPDATE role_assignments SET status='completed',result_ref=? WHERE id=?",result.reference,assignment);
   return {result_ref:result.reference,instance_id:result.instance_id};}catch(error){s.run("UPDATE role_assignments SET status='failed' WHERE id=?",assignment);traceEvent(s,task.id,'role_assignment_fault',{assignment_id:assignment,role,code:(error as any).code??'runtime_fault'},task.trace_run_id,'framework');throw error;}
  }finally{await context?.();}
 }};
 return (await runRole(managerSpec,'manager')).result;
}
