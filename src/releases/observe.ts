import type { Store, Row } from '../storage/database.js';
import { stop } from '../agent/common.js';
import { randomId } from '../core/security.js';
import { eventTaskActive, registerEventWork } from '../work/events.js';
import { sectionText } from '../work/settings.js';
import { recordEvent, registerDispatchHook } from '../dispatch/store.js';
import { runSnapshot } from './actions.js';

// CI observation is a task of the CI observation work type: it runs in the project computer, on a checkout of the release
// commit, like every task. The release page asks for it; the request is an event the Manager decides on, and the finished
// observation is written onto the release record.

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
/**
 * Asks the Manager for an observation of the release's bound run, unless one is running or still being decided. The
 * release records the event (observation_event) until the Manager's decision gives it a task or says why not.
 */
export function requestObservation(store: Store, row: Row): void {
  const data = JSON.parse(row.data), running = data.observation_task ? store.get('SELECT * FROM tasks WHERE id=?', data.observation_task) : undefined;
  if (running && eventTaskActive(running)) return;
  if (data.observation_event && store.get("SELECT 1 FROM dispatch_events WHERE event_key=? AND state IN ('pending','dispatching')", data.observation_event)) return;
  const key = `${row.id}:${data.run_id}:${data.run_attempt}:${randomId()}`, eventKey = `${row.repository_id}:release.observe:${key}`;
  patch(store, row.id, { observation_event: eventKey, observation_task: null, observation_error: null });
  recordEvent(store, { repositoryId: row.repository_id, key: eventKey, type: 'release.manual', source: 'release', summary: `「发版本」页请求 CI 观察：${row.version}`,
    facts: { action: 'observe', release: { version: row.version, target_sha: row.target_sha }, run: { id: data.run_id, attempt: data.run_attempt, url: data.run_url ?? null } },
    options: [{ id: 'observe', work: 'release.observe', title: `CI 观察 ${row.version}`, default: true, hook: 'release.observe', ref: { release_id: row.id, key: eventKey },
      spec: { type: 'event', kind: 'release.observe', key, sha: row.target_sha, input: { release_id: row.id, run_id: data.run_id, run_attempt: data.run_attempt }, summary: `CI 观察 ${row.version}` } }] });
}
// The Manager's decision on an observation request: the task the release waits for, or why there is none.
registerDispatchHook('release.observe', {
  created(store, task, ref: any) {
    // A late decision on an older request (retried by hand) does not take over a newer one.
    const row = store.get('SELECT data FROM project_releases WHERE id=?', ref.release_id);
    if (row && JSON.parse(row.data).observation_event === ref.key) patch(store, ref.release_id, { observation_task: task.id, observation_event: null, observation_error: null });
  },
  declined(store, _event, reason, ref: any) {
    const row = store.get('SELECT data FROM project_releases WHERE id=?', ref.release_id);
    if (!row || JSON.parse(row.data).observation_event !== ref.key) return;
    patch(store, ref.release_id, { observation_event: null, observation_error: `Manager 没有安排这次分析：${reason}。Actions 状态不受影响。` });
  }
});
const failedJobs = (snapshot: any) => (snapshot?.jobs || []).filter((job: any) => job.conclusion && job.conclusion !== 'success');

registerEventWork('release.observe', {
  async prepare(store, github, task, input, redactor) {
    const row = bound(store, task, input), current = await runSnapshot(github, row);
    if (current.snapshot.id !== input.run_id || current.snapshot.attempt !== input.run_attempt) stop('release_attempt_changed', 'cancelled', 'Actions attempt 已变化，停止本次分析，请刷新后重新查看。');
    const snapshot = redactor.clean(current.snapshot); input.snapshot = snapshot;
    return { sha: row.target_sha, files: { 'run.json': JSON.stringify(snapshot, null, 2) },
      contextFiles: [{ path: '../context/run.json', content: 'The release Actions run to observe, with its jobs and steps as GitHub reports them' }],
      context: { release: { version: row.version, target_sha: row.target_sha }, run: { id: snapshot.id, attempt: snapshot.attempt, url: snapshot.url },
        failed_jobs: failedJobs(snapshot).map((job: any) => ({ id: job.id, name: job.name, conclusion: job.conclusion })),
        work_name: 'CI 观察', work_prompt: sectionText(store, task.repository_id, 'release.observe') } };
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
