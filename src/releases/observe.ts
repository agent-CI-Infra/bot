import type { Store, Row } from '../storage/database.js';
import { stop } from '../agent/common.js';
import { randomId } from '../core/security.js';
import { savedWorkflow } from '../workflows/resolve.js';
import { builtinWorkflow } from '../workflows/catalog.js';
import { enqueueEventTask, eventTaskActive, registerEventWorkflow } from '../workflows/events.js';
import { runSnapshot } from './actions.js';

// CI observation is a task of the release.observe workflow: it runs in the project computer, on a checkout of the release
// commit, like every workflow. The release page asks for it; the finished observation is written onto the release record.

// Observer metadata does not invalidate a pending body edit or the worker's authoritative revision.
function patch(store: Store, id: string, values: Record<string, unknown>) {
  store.transaction(() => {
    const latest = store.get('SELECT data FROM project_releases WHERE id=?', id);
    if (latest) store.run('UPDATE project_releases SET data=? WHERE id=?', JSON.stringify({ ...JSON.parse(latest.data), ...values }), id);
  });
}
// The release record and the run attempt the observation was asked for; anything else ends the task.
function bound(store: Store, task: Row, input: any): Row {
  const row = store.get('SELECT * FROM project_releases WHERE id=? AND repository_id=?', input.release_id, task.repository_id), data = row ? JSON.parse(row.data) : null;
  if (!row || data.run_id !== input.run_id || data.run_attempt !== input.run_attempt) return stop('release_attempt_changed', 'cancelled', 'Actions 运行或 attempt 已变化，这次分析不再适用，请重新查看。');
  return row;
}
/** Queues an observation of the release's bound run, or returns the one still running. */
export function requestObservation(store: Store, row: Row): Row {
  const data = JSON.parse(row.data), running = data.observation_task ? store.get('SELECT * FROM tasks WHERE id=?', data.observation_task) : undefined;
  if (running && eventTaskActive(running)) return running;
  const task = enqueueEventTask(store, row.repository_id, 'release.observe', `${row.id}:${data.run_id}:${data.run_attempt}:${randomId()}`, row.target_sha,
    { release_id: row.id, run_id: data.run_id, run_attempt: data.run_attempt }, `CI 观察 ${row.version}`);
  patch(store, row.id, { observation_task: task.id, observation_error: null });
  return task;
}
const failedJobs = (snapshot: any) => (snapshot?.jobs || []).filter((job: any) => job.conclusion && job.conclusion !== 'success');

registerEventWorkflow('release.observe', {
  async prepare(store, github, task, input, redactor) {
    const row = bound(store, task, input), current = await runSnapshot(github, row);
    if (current.snapshot.id !== input.run_id || current.snapshot.attempt !== input.run_attempt) stop('release_attempt_changed', 'cancelled', 'Actions attempt 已变化，停止本次分析，请刷新后重新查看。');
    const snapshot = redactor.clean(current.snapshot); input.snapshot = snapshot;
    return { sha: row.target_sha, files: { 'run.json': JSON.stringify(snapshot, null, 2) },
      contextFiles: [{ path: '../context/run.json', content: 'The release Actions run to observe, with its jobs and steps as GitHub reports them' }],
      context: { release: { version: row.version, target_sha: row.target_sha }, run: { id: snapshot.id, attempt: snapshot.attempt, url: snapshot.url },
        failed_jobs: failedJobs(snapshot).map((job: any) => ({ id: job.id, name: job.name, conclusion: job.conclusion })),
        workflow_name: 'CI 观察', workflow_prompt: savedWorkflow(store, task.repository_id, 'release.observe')?.prompt ?? builtinWorkflow('release.observe')!.prompt.builtin } };
  },
  validate(store, task, input) { bound(store, task, input); },
  finish(store, task, input, result) {
    const row = bound(store, task, input), jobs = failedJobs(input.snapshot);
    if (!Array.isArray(result?.job_ids) || result.job_ids.some((id: unknown) => !jobs.some((job: any) => job.id === id)) || typeof result.advice !== 'string')
      return stop('release_observation_invalid', 'failed', '运行分析引用了本次运行之外的 job，已拒绝结果。');
    const observation = { run_id: input.run_id, attempt: input.run_attempt, url: input.snapshot.url, jobs: jobs.filter((job: any) => result.job_ids.includes(job.id)),
      advice: result.advice, logs: result.read_logs || [], at: new Date().toISOString(), task_id: task.id };
    patch(store, row.id, { observation, observation_error: null, observation_task: null });
    return observation;
  },
  ended(store, task, code, detail) {
    const input = JSON.parse(task.input), row = store.get('SELECT * FROM project_releases WHERE id=?', input.release_id);
    if (!row || JSON.parse(row.data).observation_task !== task.id) return;
    patch(store, row.id, { observation_task: null, observation_error: `${detail || '本次分析没有完成'}（${code}），Actions 状态不受影响。` });
  }
});
