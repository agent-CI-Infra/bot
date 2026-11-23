import type {Store,Row} from '../storage/database.js';
import {runAgent,type AgentSpec} from '../agent/runtime.js';
import {toolArguments} from '../agent/tool-context.js';
import {TaskRecords} from '../tasks/service.js';
import {traceEvent,traceSource} from '../tasks/trace.js';
import {visibleMemorySnapshot,taskTraceAccess} from '../memory/access.js';
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
   const ref=traceEvent(s,task.id,'long_execution_report',{run_id:runId,role:run.role,harness:run.harness,assignment_id:run.assignment_id,assignment_ref:handoff?'task_history:'+handoff.id:null,input_ref:handoff?'task_history:'+handoff.id:'task:'+task.id,elapsed_ms:elapsed,threshold_ms:due,
    recent_activity:latest?{ref:'task_history:'+latest.id,type:latest.type,at:latest.created_at}:null,recent_tool_refs:tools.map(r=>({ref:r.ref,type:r.type,at:r.at,name:r.data.name,call_id:r.data.call_id??null})),
    checkpoint_ref:checkpoint?'task_history:'+checkpoint.id:null,instruction:'Still running. Tool starts without matching receipts may be in flight or unknown, not cancelled. Check source refs and versions; elapsed time alone does not prove a hang.'},runId,'framework');
   s.run('INSERT INTO long_execution_reports(run_id,threshold_ms,report_ref) VALUES(?,?,?)',runId,due,ref);
  }
  return s.get("SELECT * FROM long_execution_reports WHERE run_id=? AND state='pending' AND next_run_at<=? ORDER BY threshold_ms LIMIT 1",runId,now);
 });
}
const processing=new WeakMap<Store,Set<string>>();
// Each piece of evidence offered to the decision is cut at this many characters of its JSON. The report itself names
// records by ref only (at most 12 tool records), so the evidence adds at most 15 such pieces to the task context.
const evidenceChars=6000;
const decisionName='submit_long_execution_decision';
/** A narrow control decision of the Task Manager while its normal turn awaits the worker. It does not bind/take over the
 * Manager role instance, session or lease. Its inputs/results remain in that task's durable history. No new role.
 *
 * Continue or stop is one judgement, so it is one structured model request, not an agent loop (#1256): the evidence the
 * report names is read here under the Manager's knowledge ACL and offered in the prompt, and the request's only tool is
 * the decision, which it must call. No other tool exists, so the turn cannot accept, publish, merge or change criteria. */
export async function decideLongExecution(spec:AgentSpec<any>,report:Row,isCurrent:()=>boolean,stopRun:(reason:string)=>void){
 const s=spec.store,task=spec.task;let active=processing.get(s);if(!active){active=new Set();processing.set(s,active);}if(active.has(task.id))return;
 if(!isCurrent()||!s.get("SELECT id FROM task_runs WHERE id=? AND status='running'",report.run_id))return;
 active.add(task.id);s.run("UPDATE long_execution_reports SET state='running' WHERE run_id=? AND threshold_ms=?",report.run_id,report.threshold_ms);
 const controller=roleConfiguration(s,task.repository_id,taskConfiguration(s,task)?.roles).controller.role;
 const guard=async()=>{await spec.guard();assertTaskRole(s,task,controller);if(!isCurrent())throw new Error('long_execution_already_ended');};
 // Manager may read the explicitly offered computer observations, not another role's transcript, model context
 // or private memory tools. Keep the canonical observation in place and apply the Manager's knowledge ACL.
 const reportData=JSON.parse(s.get("SELECT data FROM task_history WHERE task_id=? AND 'task_history:'||id=?",task.id,report.report_ref)?.data||'{}');
 const readControlEvidence=(source:string)=>{
  const match=/^task_history:(\d+)$/.exec(source);
  if(match&&reportData.recent_tool_refs?.some((r:any)=>r.ref===source)){
   const row=s.get("SELECT type,data FROM task_history WHERE task_id=? AND id=?",task.id,Number(match[1]));
   const data=row&&JSON.parse(row.data);
   if(row&&['tool_started','tool_observation'].includes(row.type)&&['run_command','read_file','write_file'].includes(data?.name))return visibleMemorySnapshot(s,task.repository_id,data,taskTraceAccess(s,{...task,active_role:controller}));
  }
  return traceSource(s,task.id,source,taskTraceAccess(s,{...task,active_role:controller}));
 };
 // One piece of evidence as the request offers it: cut to a bounded size, or the reason it cannot be read.
 const offer=(ref:unknown)=>{
  if(typeof ref!=='string'||!ref)return null;
  let raw:string;try{raw=JSON.stringify(readControlEvidence(ref));}catch(error){return {ref,error:String((error as any).code??'evidence_unavailable')};}
  return raw.length>evidenceChars?{ref,content:raw.slice(0,evidenceChars),truncated:true,chars:raw.length}:{ref,content:raw};
 };
 const decision={type:'function',function:{name:decisionName,description:'Continue or explicitly stop this exact execution. Not a task completion decision.',
  parameters:{type:'object',properties:{action:{type:'string',enum:['continue','stop']},reason:{type:'string'},instructions:{type:'string'}},required:['action','reason'],additionalProperties:false}}};
 const valid=(value:any):value is {action:'continue'|'stop';reason:string;instructions?:string}=>['continue','stop'].includes(value?.action)&&typeof value.reason==='string'&&!!value.reason.trim()&&(value.instructions===undefined||typeof value.instructions==='string');
 try{
  const system=roleExecutionSystem(s,task,controller)+'\nLong execution control decision. The normal Manager coordination is waiting for this running role. Inspect the progress evidence in the request and call '+decisionName+' with continue or stop for this exact run. Time is a reporting threshold, not a failure. An evidence piece may be cut (truncated: true) or unreadable (error). You cannot accept, publish, merge or change task criteria. If the work needs adjustment, give concrete instructions for the normal Manager to apply at its next checkpoint.';
  const prompt=JSON.stringify({report_ref:report.report_ref,report:readControlEvidence(report.report_ref),task:new TaskRecords(s).context(task.id),
   evidence:{worker_configuration:offer('task_runs:'+report.run_id+':config'),assignment:offer(reportData.assignment_ref),checkpoint:offer(reportData.checkpoint_ref),recent_tools:(reportData.recent_tool_refs??[]).map((r:any)=>offer(r?.ref))},
   previous_decisions:s.all('SELECT threshold_ms,state,decision_ref FROM long_execution_reports WHERE run_id=? ORDER BY threshold_ms',report.run_id)});
  const result=await runAgent({store:s,task:{...task,active_role:controller},onRun:id=>{s.run("UPDATE task_runs SET kind='manager_control' WHERE id=?",id);},redactor:spec.redactor,guard,system,prompt,
   model:roleExecutionModel(s,task,controller),requestPrefix:'manager:long-execution:'+report.run_id+':'+report.threshold_ms,modelAttempts:1,tools:[decision],
   adapter:async services=>{
    const {value}=await services.request({messages:[{role:'system',content:system},{role:'user',content:prompt}],tools:[decision],tool_choice:{type:'function',function:{name:decisionName}}},'decision');
    const call=value?.choices?.[0]?.message?.tool_calls?.[0],args=call?.function?.name===decisionName?toolArguments(call):null;
    if(!valid(args))throw new Error('invalid_long_execution_decision');
    return args;
   }});
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
