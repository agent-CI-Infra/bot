import type {GitHub} from '../github/client.js';
import {publicationContext} from '../tasks/publication.js';
import {versionTools} from '../tasks/versions.js';
import type {Store,Row} from '../storage/database.js';
import {Redactor,stop} from '../agent/common.js';
import {TaskRecords} from '../tasks/service.js';
import {traceEvent,traceSource} from '../tasks/trace.js';
import {taskTraceAccess} from '../memory/access.js';
import {runRole,roleConfig,roleExecutionModel,type RoleRunOptions} from './run.js';

/** A saved interruption returns to the existing controller, without requiring a working project computer. */
export async function recoverWithManager(s:Store,task:Row,guard:()=>Promise<void>,redactor:Redactor,source?:()=>Promise<any>,prepare?:RoleRunOptions['prepare'],remote?:()=>Promise<GitHub>){
 const input=JSON.parse(s.get('SELECT input FROM tasks WHERE id=?',task.id)?.input||'{}');if(!input.manager_feedback)return;
 const controller=roleConfig(s,task).controller.role,records=new TaskRecords(s);
 const tool=(name:string,description:string,properties:any,required:string[]=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
 const tools=[...versionTools.filter(t=>t.function.name==='read_publication_context'),tool('read_task_record','Read this task durable evidence by ref.',{ref:{type:'string'}},['ref']),tool('read_task_history','Page retained history.',{offset:{type:'integer'},limit:{type:'integer'}}),tool('read_recovery_source','Read the current Issue/PR; this does not authorize any write.',{}),tool('finish_coordination','Choose resume, continue, wait, or needs_help. Resume may update the task goal/criteria after reading changed requirements. No publication or acceptance.',{action:{type:'string',enum:['resume','continue','wait','needs_help']},reason:{type:'string'},help_from:{type:'string'},resume_condition:{type:'string'},delay_seconds:{type:'integer'},goal:{type:'string'},criteria:{type:'array',items:{type:'string'}}},['action','reason'])];
 const readSource=async()=>{try{return source?await source():{unavailable:true};}catch(error){await guard();return {unavailable:true,error:String((error as any).code??'source_unavailable'),instruction:'This read was unavailable; it does not authorize broader access. Use retained records or choose a wait/help condition.'};}};
 const result=await runRole({store:s,task,redactor,guard,system:'Task Manager recovery. You own how work continues. Read the saved interruption, evidence and current source. Transient failures, exhausted attempts and QA feedback do not by themselves need a human. Choose resume when safe, wait with an automatic retry condition, or needs_help only with a concrete person/action and recovery condition. You cannot override QA, authorization, cancellation, or merge policy. Never request a checkout merely because local and published commit SHAs differ.',prompt:JSON.stringify({feedback:input.manager_feedback,task:records.context(task.id)}),tools,model:roleExecutionModel(s,task,controller),maxTurns:24,
 execute:async(name,args)=>name==='read_publication_context'?publicationContext(s,task,args,remote):name==='read_task_record'?traceSource(s,task.id,args.ref,taskTraceAccess(s,task)):name==='read_task_history'?records.tool(task.id,name,args,taskTraceAccess(s,task)):name==='read_recovery_source'?readSource():{error:'tool_not_allowed'},
 finish:{name:'finish_coordination',validate:v=>{if(!['resume','continue','wait','needs_help'].includes(v?.action)||!v.reason?.trim()||['wait','needs_help'].includes(v.action)&&!v.resume_condition?.trim()||v.action==='needs_help'&&!v.help_from?.trim())return stop('role_result_invalid','retry_wait');return v;}}},controller,undefined,undefined,{rebuildContext:true,prepare});
 const decision=result.result;traceEvent(s,task.id,'manager_disposition',decision,task.trace_run_id,'role:manager',[result.reference]);
 if(decision.action==='needs_help')return stop('manager_needs_help','needs_help',JSON.stringify(decision));
 if(decision.action!=='resume')return stop('manager_deferred','retry_wait',JSON.stringify(decision),Math.max(5,Math.min(86400,Number(decision.delay_seconds)||30))*1000);
 if(decision.goal){const old=records.get(task.id).contract;records.contract(task.id,{...old,goal:decision.goal,criteria:decision.criteria??old.criteria});}
 const latest=JSON.parse(s.get('SELECT input FROM tasks WHERE id=?',task.id)!.input);delete latest.manager_feedback;
 if(input.manager_feedback.code==='issue_needs_replan'){delete latest.object_hash;delete latest.review;}
 const phase=['validate','acceptance'].includes(task.phase)?'prepare':task.phase;
 s.run('UPDATE tasks SET input=?,phase=? WHERE id=?',JSON.stringify(latest),phase,task.id);task.input=JSON.stringify(latest);task.phase=phase;
}
