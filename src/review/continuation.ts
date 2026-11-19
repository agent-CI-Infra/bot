import { type Store, type Row } from '../storage/database.js';
import { randomId } from '../core/security.js';
import { captureTaskConfiguration } from '../tasks/configuration.js';
import { traceEvent } from '../tasks/trace.js';
import { publicationDecision } from '../tasks/publication.js';
import { nextRoundUpdates, reviewUpdateLog } from './sessions.js';

/**
 * #770: a review that has published keeps the Issue or pull request. An update the Manager continues it with (or one that
 * joined while it was publishing) starts the next round of the same task: a new run with its Pi session (#1040), notes and
 * published summary comment, on the object's current state. Rounds are numbered in the task input (`round`, 1 when absent).
 */

const clip = (value: unknown, limit: number) => { const text = String(value ?? ''); return text.length > limit ? text.slice(0, limit) + '…' : text; };
// The update as its trigger: the event fields, without the GitHub objects the update row also carries.
const triggerOf = (data: any) => { const { object: _object, comment: _comment, review: _review, ...trigger } = data || {}; return trigger; };

/** The updates that give a finished review a next round: all unhandled ones except pushes of heads it already read. */
export function continuationUpdates(store: Store, task: Row): { id: number; data: any }[] {
  return nextRoundUpdates(store, task);
}

/** What the next round is told about the previous one when its session does not hold it. */
export function previousResult(task: Row, round: number) {
  let result: any = null; try { result = JSON.parse(task.result || 'null'); } catch { result = null; }
  return { round, reviewed_sha: result?.reviewed_sha ?? task.head_sha ?? null, finished_at: task.updated_at ?? null, summary: clip(result?.summary, 4000),
    findings: (Array.isArray(result?.findings) ? result.findings : []).slice(0, 40).map((f: any) => ({ body: clip(f?.body, 600), format: f?.format ?? null,
      ...(f?.path ? { path: f.path, line: f.line ?? null } : {}), ...(f?.actionable !== undefined ? { actionable: f.actionable } : {}) })),
    published: (Array.isArray(result?.outputs) ? result.outputs : []).map((o: any) => o?.html_url).filter(Boolean).slice(0, 10) };
}

/**
 * What a later round's agent reads about the round it continues: the published result is in its reopened session
 * (resumed), or summarized in previous_result when the session does not hold it (its files are gone, or a role that never
 * took part in it reads the round); on a pull request, how to see what changed since the head it reviewed.
 */
export function continuationContext(input: any, head: string, pr: boolean, resumed: boolean) {
  const previous = input.previous_result || {}, before = /^[a-f0-9]{40}$/.test(String(previous.reviewed_sha || '')) ? String(previous.reviewed_sha) : null;
  const moved = pr && before && before !== head;
  return { round: Number(input.round), previous_round: { reviewed_sha: before, published: previous.published || [] }, ...(resumed ? {} : { previous_result: previous }),
    ...(moved ? { changed_since: { from: before, to: head, log: `git log --oneline ${before}..${head}`, diff: `git diff ${before} ${head}` } } : {}),
    instruction: `This task already published its review${resumed ? ' (earlier in this conversation)' : ', summarized in previous_result'}`
      + ` and continues as round ${Number(input.round)} with the updates that came since (trigger and merged_updates). Continue from the new situation: answer the updates, check what you published`
      + `${moved ? ' against the new head (changed_since shows what changed)' : ' against the current state'}, drop what no longer applies, and finish with the complete revised result.`
      + ' Publishing it edits your earlier summary comment; an earlier inline comment that still applies is referred to with comment_id instead of being posted again.' };
}

/**
 * Starts the next round of a finished review that has updates to take; false when it has none, is not a finished review, or
 * is still held by the run that just finished it (that run's engine calls this again once it has let go). The round runs on
 * the project's current configuration, as a new task would, and is fenced like a retry: a new attempt, a new claim.
 */
export function continueFinishedReview(store: Store, taskId: string): boolean {
  return store.transaction(() => {
    // Checked on the hot columns first: a task's input can be large, and every finished review run asks.
    if (!store.get(`SELECT 1 FROM tasks t WHERE t.id=? AND t.kind LIKE 'review.%' AND t.status='succeeded' AND NOT EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id=t.id)
      AND EXISTS (SELECT 1 FROM review_updates u WHERE u.task_id=t.id AND u.id>(CASE WHEN t.review_seen_update IS NOT NULL
        THEN max(t.review_seen_update,coalesce(t.review_covered_update,0))
        WHEN coalesce(t.review_covered_update,0)>0 THEN t.review_covered_update ELSE t.review_update_cursor END))`, taskId)) return false;
    const task = store.get('SELECT * FROM tasks WHERE id=?', taskId)!, updates = continuationUpdates(store, task);
    // Only pushes/moves of heads the review already read: they are answered, and need no round. Mark them covered so
    // Manager facts and a restart agree with the round decision.
    if (!updates.length) { store.run(`UPDATE tasks SET review_update_cursor=max(coalesce(review_update_cursor,0),coalesce((SELECT max(id) FROM review_updates WHERE task_id=?),0)),
      review_covered_update=max(coalesce(review_covered_update,0),coalesce((SELECT max(id) FROM review_updates WHERE task_id=?),0)) WHERE id=?`, taskId, taskId, taskId); return false; }
    const input = JSON.parse(task.input || '{}'), done = Number(input.round || 1), round = done + 1, now = new Date().toISOString();
    const configuration = store.get('SELECT revision FROM task_execution_configs WHERE task_id=?', taskId)?.revision ?? input.configuration_revision ?? 1;
    // The round is shaped like a review the updates would have created: the latest update a person made is its trigger (the
    // summary comment answers that person; a push asks nobody's question) and the others are merged into it. What the
    // earlier round answered is in its reopened Pi session, or in previous_result.
    const askedIndex = updates.map(update => update.data?.reason !== 'pushed').lastIndexOf(true), asked = askedIndex < 0 ? null : updates[askedIndex]!.data;
    const { comment: _comment, trigger: _trigger, merged_updates: _merged, wait_for_review: _wait, ...kept } = input;
    const next = { ...kept, round, previous_result: previousResult(task, done), ...(asked ? { trigger: triggerOf(asked) } : {}),
      ...(asked?.comment ? { comment: asked.comment } : {}), merged_updates: updates.filter((_, index) => index !== askedIndex).map(update => triggerOf(update.data)),
      configuration_revision: Number(configuration) + 1, round_update_cursor: Math.max(...updates.map(update => update.id)) };
    // The round has taken these updates (they are its trigger and merged_updates): its turns look only at what joins later,
    // whatever the runner reports at its boundaries, and a retry of the round starts there again. The accepted-result mark
    // is separate: it keeps a retry from resurrecting updates an earlier accepted result already covered.
    store.run(`UPDATE tasks SET status='queued',phase='prepare',input=?,workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,model_started=0,publication_started=0,
      review_update_cursor=?,error_code=NULL,retry_count=0,wait_count=0,retry_error_code=NULL,retry_cycle_started_at=NULL,claim_token=NULL,next_run_at=0,attempt=attempt+1,updated_at=?
      WHERE id=? AND status='succeeded'`, JSON.stringify(next), next.round_update_cursor, now, taskId);
    // As when a person adopts the current configuration: the previous round's delivery stays in the task history, the new
    // round submits and is accepted on its own under the configuration captured now. A role instance's Pi session is kept
    // (#1040): its next run reopens it with this round's update, under the current rules and in the current checkout. Other
    // backends start their sessions again.
    store.run('UPDATE task_records SET candidate=NULL,acceptance=NULL,pending=NULL,rounds=0 WHERE task_id=?', taskId);
    store.run("UPDATE role_instances SET session='[]',harness_state=CASE WHEN json_extract(harness_state,'$.harness')='pi' THEN harness_state ELSE '{}' END WHERE task_id=?", taskId);
    store.run('DELETE FROM task_execution_configs WHERE task_id=?', taskId);
    captureTaskConfiguration(store, taskId);
    const reasons = [...new Set(updates.map(update => String(update.data?.reason || 'update')))];
    const logged = (value: unknown) => store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)', randomId(), taskId, JSON.stringify(value), now);
    logged({ type: 'continued', round, updates: updates.length, reasons,
      detail: `检视第 ${done} 轮已发布，之后收到 ${updates.length} 条更新；任务作为第 ${round} 轮继续，重新打开上一轮的 Pi 会话（会话文件已不在时带上一轮结果的摘要），改写同一条总结评论。` });
    for (const update of updates) logged(reviewUpdateLog(update.data));
    traceEvent(store, taskId, 'task_continued', { round, updates: updates.map(update => update.id), reasons }, null, 'framework');
    publicationDecision(store, { ...task, status: 'succeeded' }, 'next_round', { round, reason: 'published_result_has_uncovered_updates',
      pending_updates: updates.length, pending_update_ids: updates.map(update => update.id), carried_updates: updates.length });
    return true;
  });
}

/**
 * After a restart: finished reviews whose next round was due when the process stopped (its run had just finished). Only the
 * newest update rows are read, never the task table as a whole.
 */
export function resumeFinishedReviews(store: Store, recent = 500) {
  for (const row of store.all(`SELECT DISTINCT u.task_id FROM review_updates u JOIN tasks t ON t.id=u.task_id
    WHERE u.id>(SELECT coalesce(max(id),0) FROM review_updates)-? AND u.id>(CASE WHEN t.review_seen_update IS NOT NULL
      THEN max(t.review_seen_update,coalesce(t.review_covered_update,0))
      WHEN coalesce(t.review_covered_update,0)>0 THEN t.review_covered_update ELSE t.review_update_cursor END) AND t.status='succeeded'`, recent))
    continueFinishedReview(store, String(row.task_id));
}
