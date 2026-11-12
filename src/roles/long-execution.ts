import type {Store,Row} from '../storage/database.js';
import {runAgent,type AgentSpec} from '../agent/runtime.js';
import {TaskRecords} from '../tasks/service.js';
import {traceEvent,traceSource} from '../tasks/trace.js';
import {taskTraceAccess} from '../memory/access.js';
import {taskConfiguration} from '../tasks/configuration.js';
import {roleExecutionSystem,roleExecutionModel} from './run.js';
import {roleConfiguration} from './definition.js';
import {assertTaskRole} from '../tasks/management.js';

export const firstReportMs=60*60_000,reportIntervalMs=20*60_000;
export function longExecutionStorage(s:Store){s.db.exec(`CREATE TABLE IF NOT EXISTS long_execution_reports(
 run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,threshold_ms INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
 report_ref TEXT NOT NULL,decision_ref TEXT,error TEXT,next_run_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(run_id,threshold_ms));`);}
/** A threshold is about this continuous execution, never thread age or last activity. */
export function longExecutionThreshold(elapsed:number){return elapsed<firstReportMs?null:firstReportMs+Math.floor((elapsed-firstReportMs)/reportIntervalMs)*reportIntervalMs;}
export function observeLongExecution(s:Store,task:Row,runId:string,now=Date.now()){
 const run=s.get("SELECT * FROM task_runs WHERE id=? AND task_id=? AND status='running'",runId,task.id);if(!run)return;
 const elapsed=now-Date.parse(run.started_at),threshold=longExecutionThreshold(elapsed);if(threshold===null)return;
 return s.transaction(()=>{
  // Catch up separate reporting nodes after a delayed tick, without silently resetting elapsed time.
  for(let due=firstReportMs;due<=threshold;due+=reportIntervalMs){
   if(s.get('SELECT 1 FROM long_execution_reports WHERE run_id=? AND threshold_ms=?',runId,due))continue;
   const latest=s.get("SELECT id,type,created_at FROM task_history WHERE task_id=? AND run_id=? AND type IN ('tool_started','tool_observation','execution_evidence','harness_event','model_request') ORDER BY id DESC LIMIT 1",task.id,runId);
   const tools=s.all("SELECT id,type,data,created_at FROM task_history WHERE task_id=? AND run_id=? AND type IN ('tool_started','tool_observation') ORDER BY id DESC LIMIT 12",task.id,runId).map(r=>({ref:'task_history:'+r.id,type:r.type,at:r.created_at,data:JSON.parse(r.data)}));
   const checkpoint=s.get("SELECT id,type FROM task_history WHERE task_id=? AND type IN ('artifact_checkpoint','checkpoint','role_run_checkpoint') ORDER BY id DESC LIMIT 1",task.id);
   const handoff=run.assignment_id?s.get("SELECT id FROM task_history WHERE task_id=? AND type='role_handoff' AND json_extract(data,'$.assignment_id')=? ORDER BY id DESC LIMIT 1",task.id,run.assignment_id):null;
   const ref=traceEvent(s,task.id,'long_execution_report',{run_id:runId,role:run.role,harness:run.harness,assignment_id:run.assignment_id,assignment_ref:handoff?'task_history:'+handoff.id:null,input_ref:'task_runs:'+runId+':config',elapsed_ms:elapsed,threshold_ms:due,
    recent_activity:latest?{ref:'task_history:'+latest.id,type:latest.type,at:latest.created_at}:null,recent_tool_refs:tools.map(r=>({ref:r.ref,type:r.type,at:r.at,name:r.data.name,call_id:r.data.call_id??null})),
    checkpoint_ref:checkpoint?'task_history:'+checkpoint.id:null,instruction:'Still running. Tool starts without matching receipts may be in flight or unknown, not cancelled. Check source refs and versions; elapsed time alone does not prove a hang.'},runId,'framework');
   s.run('INSERT INTO long_execution_reports(run_id,threshold_ms,report_ref) VALUES(?,?,?)',runId,due,ref);
  }
  return s.get("SELECT * FROM long_execution_reports WHERE run_id=? AND state='pending' AND next_run_at<=? ORDER BY threshold_ms LIMIT 1",runId,now);
 });
}
const processing=new WeakMap<Store,Set<string>>();
/** A narrow control turn of the Task Manager while its normal turn awaits the worker. It does not bind/take over the
 * Manager role instance, session or lease. Its inputs/results remain in that task's durable history. No new role. */
export async function decideLongExecution(spec:AgentSpec<any>,report:Row,isCurrent:()=>boolean,stopRun:(reason:string)=>void){
 const s=spec.store,task=spec.task;let active=processing.get(s);if(!active){active=new Set();processing.set(s,active);}if(active.has(task.id))return;
 if(!isCurrent()||!s.get("SELECT id FROM task_runs WHERE id=? AND status='running'",report.run_id))return;
 active.add(task.id);s.run("UPDATE long_execution_reports SET state='running' WHERE run_id=? AND threshold_ms=?",report.run_id,report.threshold_ms);
 const controller=roleConfiguration(s,task.repository_id,taskConfiguration(s,task)?.roles).controller.role;
 const guard=async()=>{await spec.guard();assertTaskRole(s,task,controller);if(!isCurrent())throw new Error('long_execution_already_ended');};
 const tool=(name:string,description:string,properties:any,required:string[]=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
 try{
  const result=await runAgent({store:s,task:{...task,active_role:controller},onRun:id=>{s.run("UPDATE task_runs SET kind='manager_control' WHERE id=?",id);},redactor:spec.redactor,guard,system:roleExecutionSystem(s,task,controller)+'\nLong execution control turn. The normal Manager coordination is waiting for this running role. Inspect progress and choose continue or stop for this exact run. Time is a reporting threshold, not a failure. You cannot accept, publish, merge or change task criteria. If the work needs adjustment, record concrete instructions for the normal Manager to apply at its next checkpoint.',
   model:roleExecutionModel(s,task,controller),requestPrefix:'manager:long-execution:'+report.run_id+':'+report.threshold_ms,
   prompt:JSON.stringify({report_ref:report.report_ref,report:traceSource(s,task.id,report.report_ref,taskTraceAccess(s,{...task,active_role:controller})),task:new TaskRecords(s).context(task.id),previous_decisions:s.all('SELECT threshold_ms,state,decision_ref FROM long_execution_reports WHERE run_id=? ORDER BY threshold_ms',report.run_id)}),maxTurns:8,modelAttempts:1,
   tools:[tool('read_task_record','Read original task evidence by durable ref.',{ref:{type:'string'},offset:{type:'integer',minimum:0}},['ref']),tool('submit_long_execution_decision','Continue or explicitly stop this exact execution. Not a task completion decision.',{action:{type:'string',enum:['continue','stop']},reason:{type:'string'},instructions:{type:'string'}},['action','reason'])],
   execute:async(name,args)=>{if(name!=='read_task_record')return {error:'tool_not_allowed'};if(!Number.isSafeInteger(args.offset??0)||(args.offset??0)<0)return {error:'invalid_offset'};const raw=JSON.stringify(traceSource(s,task.id,args.ref,taskTraceAccess(s,{...task,active_role:controller}))),offset=args.offset??0;return {ref:args.ref,content:raw.slice(offset,offset+16000),next_offset:offset+16000<raw.length?offset+16000:null};},
   finish:{name:'submit_long_execution_decision',validate:value=>{if(!['continue','stop'].includes(value?.action)||typeof value.reason!=='string'||!value.reason.trim()||value.instructions!==undefined&&typeof value.instructions!=='string')throw new Error('invalid_long_execution_decision');return value;}}});
  const applicable=isCurrent()&&!!s.get("SELECT id FROM task_runs WHERE id=? AND status='running'",report.run_id);
  const ref=traceEvent(s,task.id,'long_execution_decision',{run_id:report.run_id,report_ref:report.report_ref,...result,applied:applicable},task.trace_run_id,'role:'+controller,[report.report_ref]);
  s.run("UPDATE long_execution_reports SET state=?,decision_ref=?,error=NULL WHERE run_id=? AND threshold_ms=?",applicable?'decided':'ended',ref,report.run_id,report.threshold_ms);
  if(applicable&&result.instructions)traceEvent(s,task.id,'supplemental_instruction',{instruction:result.instructions,actor:'role:'+controller,source_ref:ref},task.trace_run_id,'role:'+controller,[ref]);
  if(applicable&&result.action==='stop')stopRun(result.reason);
 }catch(error){
  const ended=!isCurrent();s.run('UPDATE long_execution_reports SET state=?,error=?,next_run_at=? WHERE run_id=? AND threshold_ms=?',ended?'ended':'pending',String((error as any).code??(error as Error).message),Date.now()+60_000,report.run_id,report.threshold_ms);
  traceEvent(s,task.id,'long_execution_notification_fault',{run_id:report.run_id,report_ref:report.report_ref,code:String((error as any).code??(error as Error).message),execution_continues:!ended},task.trace_run_id,'framework');
 }finally{active.delete(task.id);}
}
