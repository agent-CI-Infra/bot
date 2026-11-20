import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../storage/database.js';
import type { GitHub } from '../github/client.js';
import { publicText } from '../core/redaction.js';
import { stop } from '../agent/common.js';
import { registerEventWork } from '../tasks/event-adapters.js';
import { recordEvent } from '../dispatch/store.js';
import type { failedStepOutput } from './classifier.js';

export const actionsFailurePrompt = readFileSync(resolve(import.meta.dirname, '../../docs/prompts/actions-failures.md'), 'utf8');

type Failed = { job: any; output: ReturnType<typeof failedStepOutput> };

export function requestAnalysis(store: Store, github: GitHub, run: any, failed: Failed[], tag: string | null): void {
  const facts = github.redactor.clean({
    run: {
      id: run.id, attempt: run.run_attempt, workflow: run.name, event: run.event,
      ...(tag ? { tag_run: true, tag } : { branch: run.head_branch }), head_sha: run.head_sha,
      url: `https://github.com/${github.fullName}/actions/runs/${run.id}`,
    },
    failed_jobs: failed.map(({ job, output }) => {
      // Redact the complete line before clipping the excerpt at the event boundary.
      const tail = publicText(output.lines.slice(-400).join('\n'), github.redactor).slice(-1500);
      return { job_id: job.id, name: job.name, ...(output.problem ? { log_problem: output.problem } : {}), output_tail: tail };
    }),
  });
  const repositoryId = String(github.repository.id);
  const tagged = tag ? `（版本标签运行 ${github.redactor.text(tag).slice(0, 100)}）` : '';
  const title = `Actions 失败分析${tagged} run ${run.id} / attempt ${run.run_attempt}`;
  recordEvent(store, {
    repositoryId, key: `${repositoryId}:actions.run_failed:${run.id}:${run.run_attempt}`, type: 'actions.run_failed', source: 'actions',
    summary: `Actions 运行失败${tagged}：${String(facts.run.workflow || '').slice(0, 120)} run ${run.id} / attempt ${run.run_attempt}`,
    facts, options: [{ id: 'analysis', work: 'task.request', title, default: true, spec: { type: 'generic' } }],
  });
}

// Let previously queued analyses finish as internal reports. Their stored input and results remain readable.
registerEventWork('actions.failures', {
  async prepare(_store, _github, _task, input) {
    const files: Record<string, string> = { 'run.json': JSON.stringify({ run: input.run, failed_jobs: input.failed_jobs.map(({ failed_step_output: _, ...job }: any) => job) }, null, 2) };
    for (const job of input.failed_jobs) files[`failed-steps/${job.job_id}.log`] = String(job.failed_step_output || '');
    return { sha: input.run.head_sha, files,
      contextFiles: Object.keys(files).map(path => ({ path: '../context/' + path, content: path })),
      context: { run: input.run, work_name: 'Actions 失败处理' },
    };
  },
  validate(store, task, input) {
    const attempt = store.get('SELECT state FROM actions_failure_attempts WHERE repository_id=? AND run_id=? AND attempt=?', task.repository_id, input.run.id, input.run.attempt);
    if (attempt?.state !== 'pending') stop('actions_attempt_identity_changed', 'cancelled', '这次 Actions 运行已处理完毕，分析不再需要。');
  },
  checkResult(_store, _task, _input, result) {
    if (typeof result?.summary !== 'string') stop('actions_classification_invalid', 'failed', 'Actions 失败分析没有用 finish_analysis 结束。');
  },
  finish(_store, _task, _input, result) {
    return { summary: result.summary };
  },
});
