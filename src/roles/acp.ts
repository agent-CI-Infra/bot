import type {AgentSpec,AgentServices} from '../agent/runtime.js';
import {runAcp} from '../harness/acp.js';
import {taskToolServer} from './task-tools.js';
import {traceEvent} from '../tasks/trace.js';
/** Bind task services to the generic ACP client; no vendor-specific role logic. */
export function acpHarness<T>(spec:AgentSpec<T>){return async(services:AgentServices):Promise<T>=>{
 const bridge=await taskToolServer(spec);
 try{return await runAcp({sessionKey:spec.roleRun?.instance_id??spec.task.id,system:spec.system+'\n\nYou execute one Bot role assignment. The repository is on the managed project computer, NOT this ACP working directory. Use the bot MCP tools read_file/write_file/run_command for all repository work, and read_task_record/read_task_history to expand task/evidence refs. Your own terminal is not the project computer. Do not publish or merge. Do not spawn additional agents. Use the offered submission tool '+(spec.finish?.name??'(none)')+' once your role result is ready; this does not approve the task. After successful submission, end this turn without further actions. Preserve the exact current candidate and use repository-relative commands.',prompt:spec.prompt,fresh:spec.roleRun?.role==='qa',submissionName:spec.finish?.name,state:spec.harnessState,tools:bridge,guard:services.guard,redactor:spec.redactor,validate:spec.validate},spec.executionSignal!,event=>{
  if(event.type==='session_bound'&&spec.task.trace_run_id)spec.store.run('UPDATE task_runs SET recovery_mode=? WHERE id=?',String(event.recoveryMode),spec.task.trace_run_id);
  traceEvent(spec.store,spec.task.id,'harness_event',spec.redactor.clean(event),spec.task.trace_run_id,'harness');spec.onHarnessEvent?.(spec.redactor.clean(event));
 });}finally{await bridge.close();}
};}
