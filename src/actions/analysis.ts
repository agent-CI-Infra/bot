import type { Store, Row } from '../storage/database.js';
import type { GitHub } from '../github/client.js';
import { stop } from '../agent/common.js';
import { registerEventWork } from '../work/events.js';
import { sectionText } from '../work/settings.js';
import { recordEvent } from '../dispatch/store.js';
import { failedStepOutput, verifiedEvidence, type Evidence, type FailureKind } from './classifier.js';

const kinds = new Set<FailureKind>(['external', 'code', 'unknown']);
// How much of each failed step's output goes into the context file; read_job_log reads the rest when the model needs it.
const promptLines = 400, promptChars = 40_000;
type Failed = { job: any; output: ReturnType<typeof failedStepOutput> };
const key = (runId: number, attempt: number) => `${runId}:${attempt}`;

/**
 * The Actions failure analysis is a task in the project computer, on a checkout of the failed commit, when the Manager
 * starts one for the failed run (the run is an event it decides on). The
 * agent reads the failed jobs and records, for each, whether rerunning the same commit is likely to pass (external), the
 * repository is at fault (code), or the evidence does not tell (unknown), through rerun_failed_run and report_failure.
 * The control plane keeps the decisions it bases on that: cited lines must be lines the failed steps printed, an
 * external or code verdict without such a line becomes unknown, and the single rerun and the reports stay its own.
 */
export const analysisTask = (store: Store, repositoryId: string, runId: number, attempt: number) =>
  store.get('SELECT * FROM tasks WHERE unique_key=?', `${repositoryId}:actions.failures:${key(runId, attempt)}`);
/** The Manager's decision on a failed attempt: not asked yet, still deciding, declined (with its reason) or failed. */
export function analysisDecision(store: Store, repositoryId: string, runId: number, attempt: number): { state: 'none' | 'pending' | 'declined' | 'failed'; reason?: string } {
  const event = store.get('SELECT state,decision,reason,result FROM dispatch_events WHERE event_key=?', `${repositoryId}:actions.run_failed:${key(runId, attempt)}`);
  if (!event) return { state: 'none' };
  if (['pending', 'dispatching'].includes(event.state)) return { state: 'pending' };
  if (event.state === 'failed') return { state: 'failed' };
  return JSON.parse(event.result || '{}').created?.length ? { state: 'pending' } : { state: 'declined', reason: String(event.reason || '') };
}
/** Asks the Manager whether to analyze this failed attempt; its task (when created) is found by analysisTask. */
export function requestAnalysis(store: Store, github: GitHub, run: any, failed: Failed[]): void {
  const jobs = failed.map(({ job, output }) => {
    const lines = output.lines.slice(-promptLines); let text = lines.join('\n'); if (text.length > promptChars) text = text.slice(-promptChars);
    return { job_id: job.id, name: job.name, failed_steps: (job.steps || []).filter((s: any) => s.conclusion === 'failure').map((s: any) => ({ number: s.number, name: s.name })),
      ...(output.problem ? { log_problem: output.problem } : {}), failed_step_output: text, ...(output.lines.length > lines.length || text.length < lines.join('\n').length ? { output_clipped: true } : {}) };
  });
  const input = github.redactor.clean({ run: { id: run.id, attempt: run.run_attempt, workflow: run.name, event: run.event, branch: run.head_branch, head_sha: run.head_sha,
    url: `https://github.com/${github.fullName}/actions/runs/${run.id}` }, failed_jobs: jobs });
  const repositoryId = String(github.repository.id);
  recordEvent(store, { repositoryId, key: `${repositoryId}:actions.run_failed:${key(run.id, run.run_attempt)}`, type: 'actions.run_failed', source: 'actions',
    summary: `Actions 运行失败：${String(run.name || '').slice(0, 120)} run ${run.id} / attempt ${run.run_attempt}`,
    facts: { run: (input as any).run, failed_jobs: (input as any).failed_jobs.map(({ failed_step_output, ...job }: any) => ({ ...job, output_tail: String(failed_step_output || '').slice(-1500) })) },
    options: [{ id: 'analysis', work: 'actions.failures', title: `Actions 失败分析 run ${run.id} / attempt ${run.run_attempt}`, default: true,
      spec: { type: 'event', kind: 'actions.failures', key: key(run.id, run.run_attempt), sha: run.head_sha, input, summary: `Actions 失败分析 run ${run.id} / attempt ${run.run_attempt}` } }] });
}
/** What the finished task recorded per job, or null when it ended without a usable result. */
export function taskVerdicts(task: Row): Map<unknown, any> | null {
  if (task.status !== 'succeeded' || !task.result) return null;
  const result = JSON.parse(task.result);
  return Array.isArray(result.verdicts) ? new Map(result.verdicts.map((verdict: any) => [verdict.job_id, verdict])) : null;
}
/** Verdicts checked against the full failed-step output: cited lines must be lines the steps printed. */
export function classifiedEvidence(failed: Failed[], verdicts: Map<unknown, any> | null): Evidence[] {
  return failed.map(({ job, output }) => {
    const verdict = verdicts ? verdicts.get(job.id) ?? { kind: 'unknown', reason: 'The analysis did not classify this job.', evidence: [] }
      : { kind: 'unknown', reason: 'The failure analysis did not return a usable classification.', evidence: [] };
    const quote = verifiedEvidence(verdict.evidence, output.lines);
    // A verdict the cited log does not support is not acted on.
    const kind: FailureKind = output.problem ? 'unknown' : verdict.kind !== 'unknown' && !quote.length ? 'unknown' : verdict.kind;
    const reason = output.problem ?? (kind !== verdict.kind ? 'The analysis cited no line that the failed steps printed.' : String(verdict.reason || '').trim() || 'No reason was given.');
    return { job, kind, reason, quote: quote.join('\n'), ...(!quote.length && output.tail ? { context: output.tail } : {}) };
  });
}
export { failedStepOutput };

registerEventWork('actions.failures', {
  async prepare(store, _github, task, input) {
    const files: Record<string, string> = { 'run.json': JSON.stringify({ run: input.run, failed_jobs: input.failed_jobs.map(({ failed_step_output: _, ...job }: any) => job) }, null, 2) };
    for (const job of input.failed_jobs) files[`failed-steps/${job.job_id}.log`] = String(job.failed_step_output || '');
    const budget = store.get('SELECT retry_state FROM actions_failure_runs WHERE repository_id=? AND run_id=?', task.repository_id, input.run.id);
    return { sha: input.run.head_sha, files,
      contextFiles: [{ path: '../context/run.json', content: 'The failed Actions run and its failed jobs with their failed steps' },
        ...input.failed_jobs.map((job: any) => ({ path: `../context/failed-steps/${job.job_id}.log`, content: `What the failed steps of job ${job.job_id} (${job.name}) printed${job.output_clipped ? ', the last part only' : ''}${job.log_problem ? ': ' + job.log_problem : ''}` }))],
      context: { run: input.run, failed_jobs: input.failed_jobs.map((job: any) => ({ job_id: job.job_id, name: job.name, log_problem: job.log_problem })),
        rerun_budget: !budget || budget.retry_state === 'none' ? 'available' : 'used',
        work_name: 'Actions 失败处理', work_prompt: sectionText(store, task.repository_id, 'actions.failures') } };
  },
  validate(store, task, input) {
    const attempt = store.get('SELECT state FROM actions_failure_attempts WHERE repository_id=? AND run_id=? AND attempt=?', task.repository_id, input.run.id, input.run.attempt);
    if (attempt?.state !== 'pending') stop('actions_attempt_identity_changed', 'cancelled', '这次 Actions 运行已处理完毕，分析不再需要。');
  },
  // Recorded now and acted on after the agent finishes; the answer tells the agent which cited lines were found.
  tools(_store, _task, input, writes, state) {
    const jobs = new Map<unknown, any>(input.failed_jobs.map((job: any) => [job.job_id, job]));
    const record = (ids: unknown[], kind: string, reason: unknown, evidence: unknown) => {
      if (!ids.length || ids.some(id => !jobs.has(id)) || !kinds.has(kind as FailureKind) || typeof reason !== 'string' || !Array.isArray(evidence)) return { error: 'analysis_arguments_invalid', message: 'Use failed job ids from run.json, a kind, a reason and the cited lines.' };
      state.verdicts ??= {};
      const found = ids.map(id => ({ job_id: id, found: verifiedEvidence(evidence, String(jobs.get(id).failed_step_output || '').split('\n')).length }));
      for (const id of ids) state.verdicts[String(id)] = { job_id: id, kind, reason, evidence };
      return { recorded: true, cited_lines_found: found, note: 'The control plane checks the cited lines against the full log and acts after you finish.' };
    };
    return {
      ...(writes.includes('actions_rerun') ? { rerun_failed_run: async (_id: string, args: any) => record(Array.isArray(args?.job_ids) ? args.job_ids : [], 'external', args?.reason, args?.evidence) } : {}),
      ...(writes.includes('issue') ? { report_failure: async (_id: string, args: any) => record([args?.job_id], String(args?.kind), args?.reason, args?.evidence) } : {})
    };
  },
  finish(_store, _task, _input, result, state) {
    if (typeof result?.summary !== 'string') return stop('actions_classification_invalid', 'failed', 'Actions 失败分析没有用 finish_analysis 结束。');
    return { summary: result.summary, verdicts: Object.values(state.verdicts || {}) };
  }
});
