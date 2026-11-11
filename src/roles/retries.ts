import type {Store,Row} from '../storage/database.js';
import type {Workspace} from '../agent/workspace.js';
import type {GitHub} from '../github/client.js';
import {Redactor,stop} from '../agent/common.js';
import {TaskRecords} from '../tasks/service.js';
import {pendingRetryReport} from '../tasks/retries.js';
import {traceEvent,traceSource} from '../tasks/trace.js';
import {taskTraceAccess} from '../memory/access.js';
import {runRole,roleExecutionModel,roleConfig} from './run.js';
import {roleBackendWorkspace} from './workspace.js';

/** A short decision by the existing Manager, like its post-QA follow-up planning. No new task or agent. */
export async function assessRetryReport(s:Store,task:Row,workspace:Workspace,github:GitHub,guard:()=>Promise<void>,redactor:Redactor){
 const report=pendingRetryReport(s,task.id);if(!report)return false;
 const records=new TaskRecords(s);
 const controller=roleConfig(s,task).controller.role;
 const ciEvidence:string[]=[];
 if(report.group==='merge_checks'){
  const row=s.get('SELECT data FROM task_history WHERE task_id=? AND id=?',task.id,Number(report.failure_ref.split(':')[1]));
  const failure=row?JSON.parse(row.data):null;
  try{
   const source=/^task_history:(\d+)$/.exec(String(failure?.source_ref||'')),raw=source?s.get("SELECT data FROM task_history WHERE task_id=? AND id=? AND type='merge_checks'",task.id,Number(source[1])):null;
   const checks=JSON.parse(raw?.data||failure?.detail||'{}').check_runs??[],job=checks.find((check:any)=>check.status==='completed'&&!['success','neutral','skipped'].includes(check.conclusion));
   if(job){const info=await github.request('GET',github.path('/actions/jobs/'+job.id)),log=await github.jobLog(job.id);
    ciEvidence.push(traceEvent(s,task.id,'retry_evidence',redactor.clean({job_id:job.id,steps:info.steps,log:log.slice(-32000)}),null,'framework',[report.failure_ref]));}
  }catch(error){traceEvent(s,task.id,'retry_evidence',{error:String((error as any).code??'ci_log_unavailable'),failure_ref:report.failure_ref},null,'framework');}
 }
 const tools=[{type:'function',function:{name:'read_task_history',description:'Page this task history, including retry failures, reports and decisions.',parameters:{type:'object',properties:{offset:{type:'integer'},limit:{type:'integer'}}}}},
  {type:'function',function:{name:'read_task_record',description:'Read an offered task_history ref, including the failure or original CI job steps/log. Use offset to page long records.',parameters:{type:'object',properties:{ref:{type:'string'},offset:{type:'integer'}},required:['ref']}}},
  {type:'function',function:{name:'submit_retry_decision',description:'Continue retries, or investigate by returning this attempt to normal Manager/team coordination. Does not accept, publish or merge a candidate.',parameters:{type:'object',properties:{action:{type:'string',enum:['continue_retry','investigate']},reason:{type:'string'}},required:['action','reason'],additionalProperties:false}}}];
 try{
  const result=await runRole({store:s,task,guard,redactor,system:'Task Manager retry report. Read the actual failure and attempts. Decide whether to continue retries (noise or a temporary failure) or investigate/repair through your normal team. Do not infer that a Dev report means its candidate was collected. Do not approve delivery.',
   prompt:JSON.stringify({report,ci_evidence_refs:ciEvidence,current_state:records.context(task.id)}),tools,model:roleExecutionModel(s,task,controller),maxTurns:12,
   execute:async(name,args)=>{
    if(name==='read_task_history')return records.tool(task.id,name,args,taskTraceAccess(s,task));
    if(name==='read_task_record'){
     return traceSource(s,task.id,args.ref,taskTraceAccess(s,{...task,active_role:controller}));
    }
    return {error:'tool_not_allowed'};
   },finish:{name:'submit_retry_decision',validate:value=>{
    if(!['continue_retry','investigate'].includes(value?.action)||typeof value.reason!=='string'||!value.reason.trim())stop('role_result_invalid','retry_wait','Expected retry action and reason');return value;
   }}},controller,undefined,undefined,{rebuildContext:true,prepare:roleBackendWorkspace(workspace)});
  traceEvent(s,task.id,'retry_decision',{report_ref:report.ref,group:report.group,count:report.count,...result.result},null,'role:'+controller,[report.ref,result.reference]);
  return result.result.action==='investigate';
 }catch(error){
  // Reporting must not replace the original failure or block an otherwise permitted retry.
  traceEvent(s,task.id,'retry_notification_fault',{report_ref:report.ref,code:String((error as any).code??'manager_unavailable')},null,'framework');
  return false;
 }
}
