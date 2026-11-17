import type {AgentSpec} from '../agent/runtime.js';
import {TaskError} from '../agent/common.js';
import {SubmissionError} from './submission-error.js';
import {traceEvent} from '../tasks/trace.js';
/** Correctable model submissions stay observations, regardless of how often they are corrected. */
export function submissionFeedback(spec:AgentSpec<any>,error:unknown) {
 if(error instanceof TaskError&&(['cancelled','paused','waiting_permission','waiting_configuration','waiting_environment'].includes(error.state)||/^(run_token_|lease_|task_claim_|role_budget_|stage_budget_|repository_policy_)/.test(error.code)))return undefined;
 const feedback=spec.repairInvalid?.(error);
 if(!(error instanceof SubmissionError)&&!feedback)return undefined;
 const code=String((error as any)?.code??'invalid_submission');
 const clues:Record<string,unknown>=error instanceof SubmissionError?error.clues:{...((error as any)?.detail?{detail:(error as any).detail}:{})};
 const reason=String(clues.reason??code),taskId=String(spec.task.id);
 const ref=traceEvent(spec.store,taskId,'submission_rejected',spec.redactor.clean({code,reason,clues}),spec.task.trace_run_id,'framework');
 const businessTask=spec.store.get('SELECT 1 FROM tasks WHERE id=?',taskId);
 if(!businessTask)return spec.redactor.clean({error:'invalid_submission',code,...clues,message:feedback??'Correct this submission using the offered facts.',evidence_ref:ref});
 const count=spec.store.get("SELECT count(*) n FROM task_history WHERE task_id=? AND type='submission_rejected' AND json_extract(data,'$.code')=? AND json_extract(data,'$.reason')=?",taskId,code,reason)!.n;
 let manager_notice;
 if(count>0&&count%3===0){const notice={code,reason,attempts:count,evidence_ref:ref,instruction:'Repeated submission rejection; Manager decides whether to adjust, continue, defer or request help. No retry-count stop was applied.'};const report=traceEvent(spec.store,taskId,'submission_retry_report',notice,spec.task.trace_run_id,'framework',[ref]);manager_notice={...notice,report_ref:report};}
 return spec.redactor.clean({error:'invalid_submission',code,...clues,message:feedback??'Correct the submission using these facts or choose another coordination action.',evidence_ref:ref,attempts:count,...(manager_notice?{manager_notice}:{})});
}
