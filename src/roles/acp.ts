import type {AgentSpec,AgentServices} from '../agent/runtime.js';
import {runAcp,type AcpProtocol} from '../harness/acp.js';
import {taskToolServer} from './task-tools.js';
import {traceEvent} from '../tasks/trace.js';
/** Bind task services to the generic external-agent client; the protocol only picks its wire dialect, no vendor role logic. */
export function acpHarness<T>(spec:AgentSpec<T>,protocol:AcpProtocol='acp'){return async(services:AgentServices):Promise<T>=>{
 const bridge=await taskToolServer(spec);let promptSequence=0;
 try{return await runAcp({sessionKey:spec.harnessSessionKey??spec.roleRun?.instance_id??spec.task.id,protocol,system:spec.system+'\n\nYou execute one Bot role assignment. The repository is on the managed project computer, NOT your own session working directory. Use only offered bot MCP tools. Your own terminal is not the project computer. Do not publish or merge. Do not spawn additional agents. Use the offered submission tool '+(spec.finish?.names??[spec.finish?.name??'(none)']).join(' or ')+' once your role result is ready; this does not approve the task. After successful submission, end this turn without further actions.',prompt:spec.prompt,fresh:!!spec.harnessSessionKey||spec.roleRun?.role==='qa',submissionName:spec.finish?.name,toolNames:(spec.tools??[]).map(t=>t.function.name),state:spec.harnessState,tools:bridge,guard:services.guard,redactor:spec.redactor,validate:spec.validate,
  onPrompt:protocol==='acp'&&spec.onExternalRequest?()=>spec.onExternalRequest!({key:(spec.harnessSessionKey??spec.task.id)+':prompt:'+ ++promptSequence,source:'acp_prompt',model:'external',input_tokens:null,output_tokens:null,finished:true}):undefined,
  onDenied:(name,reason)=>spec.onDenied?.(name,reason)},spec.executionSignal!,event=>{
  if(event.type==='session_bound'&&spec.task.trace_run_id)spec.store.run('UPDATE task_runs SET recovery_mode=? WHERE id=?',String(event.recoveryMode),spec.task.trace_run_id);
  traceEvent(spec.store,spec.task.id,'harness_event',spec.redactor.clean(event),spec.task.trace_run_id,'harness');spec.onHarnessEvent?.(spec.redactor.clean(event));
 });}finally{await bridge.close();}
};}
