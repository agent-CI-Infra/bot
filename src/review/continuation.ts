import { type Store, type Row } from '../storage/database.js';
import { randomId } from '../core/security.js';
import { captureTaskConfiguration } from '../tasks/configuration.js';
import { traceEvent } from '../tasks/trace.js';
import { publicationDecision } from '../tasks/publication.js';
import { heldBy } from '../projects/worktrees.js';
import { reviewUpdateCursor, reviewUpdateLog, roundUpdatesAfter } from './sessions.js';

/**
 * #770: a review that has published keeps the Issue or pull request. An update the Manager continues it with (or one that
 * joined while it was publishing) starts the next round of the same task: a new run with its Pi session (#1040), notes and
 * published summary comment, on the object's current state. Rounds are numbered in the task input (`round`, 1 when absent).
 */

const clip = (value: unknown, limit: number) => { const text = String(value ?? ''); return text.length > limit ? text.slice(0, limit) + '…' : text; };
// The update as its trigger: the event fields, without the GitHub objects and the time it joined (`at`) the row also carries.
const triggerOf = (data: any) => { const { object: _object, comment: _comment, review: _review, at: _at, ...trigger } = data || {}; return trigger; };

/**
 * The updates that give a review a next round: those after what it covers (its update cursor once it has published, which
 * is what its result covered), except a push to a head the review already read.
 */
export function continuationUpdates(store: Store, task: Row, through = reviewUpdateCursor(store, String(task.id))): { id: number; data: any }[] {
  return roundUpdatesAfter(store, task, through);
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

/** What round N+1 of a continuous bot PR development task is told about its previous delivery when its session is rebuilt. */
export function previousDelivery(task: Row, round: number, prNumber?: number | null) {
  let result: any = null;
  try { result = JSON.parse(task.result || 'null'); } catch { result = null; }
  return {
    round,
    status: String(task.status || ''),
    pr_number: Number.isSafeInteger(Number(result?.pr_number)) && Number(result.pr_number) > 0
      ? Number(result.pr_number)
      : (prNumber ?? null),
    pr_url: typeof result?.pr_url === 'string' ? result.pr_url : null,
    branch: typeof result?.branch === 'string' ? result.branch : null,
    sha: typeof result?.sha === 'string' ? result.sha : (task.head_sha ?? null),
    finished_at: task.updated_at ?? null,
    summary: clip(result?.summary, 4000),
  };
}

/**
 * Continuation guidance for round 2+ of a continuous bot PR development task: preserves the same PR and worktree while
 * aligning to the live remote head and incorporating new review comments, check failures, conflicts, or patrol triggers.
 */
export function developmentContinuationContext(input: any, head: string, resumed: boolean) {
  const previous = input.previous_delivery || {};
  const before = /^[a-f0-9]{40}$/.test(String(previous.sha || '')) ? String(previous.sha) : null;
  const moved = Boolean(before && before !== head);
  const prevRound = Number(previous.round) || Math.max(1, Number(input.round || 2) - 1);
  const prNum = previous.pr_number ?? input.pr_number ?? input.bot_pr?.number ?? null;
  return {
    round: Number(input.round || 2),
    mode: 'pull_request_development',
    previous_round: {
      round: prevRound,
      status: previous.status ?? null,
      pr_number: prNum,
      pr_url: previous.pr_url ?? input.bot_pr?.html_url ?? null,
      branch: previous.branch ?? input.bot_pr?.head?.ref ?? null,
      sha: before,
    },
    ...(resumed ? {} : { previous_delivery: previous }),
    ...(moved ? { changed_since: { from: before, to: head, log: `git log --oneline ${before}..${head}`, diff: `git diff ${before} ${head}` } } : {}),
    instruction:
      `This continuous pull request development task already completed round ${prevRound}${prNum ? ` on PR #${prNum}` : ''}`
      + `${resumed ? ' (earlier in this conversation)' : ', summarized in previous_delivery'}`
      + ` and continues as round ${Number(input.round || 2)} with the new events (trigger, merged_updates, wake_events, revision_requests, or conflict_resolution).`
      + `${moved ? ' The remote PR head moved since the previous round (see changed_since); inspect those commits so human changes are preserved.' : ''}`
      + ' Reuse the aligned task workspace and live PR facts in ../context/, address the new feedback/failures/conflicts without regressing earlier work, and deliver via open_pull_request (to update the same PR) or submit_report (when no code edit is needed, such as a pure comment/reply or actions rerun).',
  };
}

/**
 * Wakes a dormant continuous bot PR development task (`pr_opened` or `completed`) into its next round (`round = done + 1`).
 * Preserves `workspace_id`, `generation`, `role_instances` session/harness state, `task_history`, and `model_requests`,
 * refreshes `task_execution_configs`, clears per-round candidate/acceptance slots, and enforces unified Task Manager
 * orchestration (`executor_role = NULL`).
 */
export function continueDevelopmentTask(
  store: Store,
  taskId: string,
  event?: Row,
  merge?: any,
  reason?: string,
): boolean {
  return store.transaction(() => {
    const task = store.get(
      `SELECT t.* FROM tasks t
       WHERE t.id=? AND t.kind='task.request' AND t.status IN ('pr_opened','completed')
         AND NOT EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id=t.id)
         AND EXISTS (SELECT 1 FROM task_write_grants g WHERE g.task_id=t.id AND json_valid(g.writes)
           AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value='pull_request'))`,
      taskId,
    );
    if (!task) return false;

    const input = (() => { try { return JSON.parse(String(task.input || '{}')); } catch { return {}; } })();
    const done = Number(input.round || 1);
    const round = done + 1;
    const now = new Date().toISOString();
    const configuration = store.get('SELECT revision FROM task_execution_configs WHERE task_id=?', taskId)?.revision ?? input.configuration_revision ?? 1;
    const roundStartedHistoryId = Number(store.get('SELECT coalesce(max(id),0) AS m FROM task_history WHERE task_id=?', taskId)?.m ?? 0);
    const roundMinAttempt = Number(task.attempt || 1) + 1;

    const ownedPr = store.hasTable('bot_pull_requests')
      ? store.get('SELECT number,branch,sha FROM bot_pull_requests WHERE repository_id=? AND source_task_id=? ORDER BY number DESC LIMIT 1', task.repository_id, taskId)
      : undefined;
    const prNumber =
      event?.object_type === 'pr' && Number(event.object_number) > 0
        ? Number(event.object_number)
        : ownedPr
          ? Number(ownedPr.number)
          : Number(input.pr_number || input.bot_pr?.number || (input.target?.type === 'pr' ? input.target.number : 0)) || null;

    const cursor = Number(task.review_update_cursor || 0);
    const updates = store.hasTable('review_updates')
      ? store.all('SELECT id,data FROM review_updates WHERE task_id=? AND id>? ORDER BY id ASC', taskId, cursor).map(row => ({
          id: Number(row.id),
          data: (() => { try { return JSON.parse(String(row.data || '{}')); } catch { return {}; } })(),
        }))
      : [];
    const maxCursor = updates.length ? Math.max(...updates.map(u => u.id)) : cursor;

    const latestData = updates.at(-1)?.data ?? merge?.data ?? null;
    const trigger = merge?.trigger
      ?? (latestData ? triggerOf(latestData) : undefined)
      ?? (event ? { event: String(event.type || 'dispatch'), reason: String(event.type || 'continued'), summary: String(event.summary || '') } : undefined);
    const comment = latestData?.comment ?? merge?.data?.comment ?? undefined;
    const mergedUpdates = updates.length
      ? updates.map(u => triggerOf(u.data))
      : trigger
        ? [trigger]
        : [];
    const wakeEvents = [
      ...updates.map(u => u.data).filter(d => d && typeof d === 'object' && d.wake_type),
      ...(merge?.data?.wake_type && !updates.some(u => u.data?.wake_type === merge.data.wake_type && u.data?.pr_number === merge.data.pr_number) ? [merge.data] : []),
    ];

    const collectedRequests: any[] = [];
    const seenReq = new Set<string>();
    const addReq = (r: any) => {
      if (!r || typeof r !== 'object' || !r.type || r.id == null) return;
      const k = `${r.type}:${r.id}`;
      if (seenReq.has(k)) return;
      seenReq.add(k);
      collectedRequests.push(r);
    };
    for (const u of updates) {
      addReq(u.data?.revision_request);
      if (Array.isArray(u.data?.revision_requests)) for (const r of u.data.revision_requests) addReq(r);
    }
    addReq(merge?.data?.revision_request);
    if (Array.isArray(merge?.data?.revision_requests)) for (const r of merge.data.revision_requests) addReq(r);

    let conflictBaseSha: string | null = null;
    let conflictBaseRef: string | null = null;
    const checkConflict = (d: any) => {
      if (!d || typeof d !== 'object') return;
      const isConflict = d.wake_type === 'pull_request.conflicted' || (d.wake_type === 'pull_request.patrol' && d.is_conflicted === true);
      if (isConflict && typeof d.base_sha === 'string' && /^[a-f0-9]{40}$/i.test(d.base_sha)) {
        conflictBaseSha = d.base_sha.toLowerCase();
        if (typeof d.base_ref === 'string' && d.base_ref.trim()) conflictBaseRef = d.base_ref.trim();
      }
    };
    for (const u of updates) checkConflict(u.data);
    checkConflict(merge?.data);

    const reviewFromMerge = latestData?.review_findings
      ? { ...(latestData.review || {}), findings: latestData.review_findings }
      : merge?.data?.review_findings
        ? { ...(merge.data.review || {}), findings: merge.data.review_findings }
        : undefined;

    const latestHead = [
      merge?.head,
      latestData?.head_sha,
      latestData?.after,
    ].find(v => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v)) ?? null;

    const {
      comment: _comment,
      trigger: _trigger,
      merged_updates: _merged,
      wake_event: _wakeEvent,
      wake_events: _wakeEvents,
      conflict_base_sha: _conflictBaseSha,
      conflict_base_ref: _conflictBaseRef,
      move_to_sha: _moveToSha,
      delivery: _delivery,
      executor_role: _executorRole,
      revision_requests: _revisionRequests,
      revision: _revision,
      previous_result: _previousResult,
      previous_delivery: _previousDelivery,
      wait_for_review: _waitForReview,
      recovery: _recovery,
      integration: _integration,
      continuation_reason: _continuationReason,
      ...kept
    } = input;

    const revisionSource = collectedRequests.length
      ? 'request'
      : reviewFromMerge
        ? 'review'
        : wakeEvents.length
          ? String(wakeEvents.at(-1)?.wake_type || 'wake').replace(/^pull_request\./, '')
          : 'continued';
    const next = {
      ...kept,
      generic: true,
      delivery: null,
      round,
      round_started_history_id: roundStartedHistoryId,
      round_min_attempt: roundMinAttempt,
      ...(prNumber ? { pr_number: prNumber } : {}),
      previous_delivery: previousDelivery(task, done, prNumber),
      ...(trigger ? { trigger } : {}),
      ...(comment ? { comment } : {}),
      ...(mergedUpdates.length ? { merged_updates: mergedUpdates } : {}),
      ...(wakeEvents.length ? { wake_events: wakeEvents, wake_event: wakeEvents.at(-1) } : {}),
      ...(collectedRequests.length ? { revision: { source: 'request', requests: collectedRequests }, revision_requests: collectedRequests } : { revision: { source: revisionSource } }),
      ...(reviewFromMerge ? { review: reviewFromMerge } : {}),
      ...(conflictBaseSha ? { conflict_base_sha: conflictBaseSha, ...(conflictBaseRef ? { conflict_base_ref: conflictBaseRef } : {}) } : {}),
      ...(reason ? { continuation_reason: reason } : {}),
      configuration_revision: Number(configuration) + 1,
      round_update_cursor: maxCursor,
    };

    // Preserve workspace_id and generation so runRequest can advance the existing worktree in place (#1331).
    const changed = store.run(
      `UPDATE tasks
       SET status='queued', phase='prepare', input=?, head_sha=coalesce(?,head_sha),
           messages=NULL, result=NULL, model_started=0, publication_started=0,
           review_update_cursor=max(review_update_cursor,?),
           error_code=NULL, retry_count=0, wait_count=0, retry_error_code=NULL, retry_cycle_started_at=NULL,
           claim_token=NULL, next_run_at=0, attempt=attempt+1, updated_at=?
       WHERE id=? AND status IN ('pr_opened','completed')`,
      JSON.stringify(next),
      latestHead,
      maxCursor,
      now,
      taskId,
    );
    if (Number(changed.changes) !== 1) return false;

    // Reset per-round candidate/acceptance slots while keeping task_history, model_requests, and role_instances sessions.
    store.run('UPDATE task_records SET candidate=NULL,acceptance=NULL,pending=NULL,rounds=0 WHERE task_id=?', taskId);
    if (store.hasTable('development_candidates')) store.run('DELETE FROM development_candidates WHERE task_id=?', taskId);
    if (store.hasTable('task_origins')) {
      store.run(
        "UPDATE task_origins SET executor_role=NULL WHERE task_id=? AND NOT (source_kind='role' AND COALESCE(json_extract(permissions,'$.delegation'),'')<>'allow')",
        taskId,
      );
    }
    store.run('DELETE FROM task_execution_configs WHERE task_id=?', taskId);
    captureTaskConfiguration(store, taskId);

    // If the task's worktree binding was released when the previous round ended, reclaim it now while unheld so
    // workspace-cleanup retains the worktree across round startup and runRequest can advance it in place.
    if (task.workspace_id && store.hasTable('worktree_bindings') && store.hasTable('worktrees')) {
      const openBinding = store.get(
        'SELECT id FROM worktree_bindings WHERE task_id=? AND workspace_id=? AND released_at IS NULL LIMIT 1',
        taskId,
        task.workspace_id,
      );
      if (!openBinding) {
        const lastBinding = store.get(
          `SELECT b.id, b.worktree_id FROM worktree_bindings b
           JOIN worktrees w ON w.repository_id=b.repository_id AND w.id=b.worktree_id
           WHERE b.task_id=? AND b.workspace_id=? AND b.release_reason='task_ended' AND w.state<>'removed'
           ORDER BY b.id DESC LIMIT 1`,
          taskId,
          task.workspace_id,
        );
        if (lastBinding && !heldBy(store, String(task.repository_id), String(lastBinding.worktree_id)).length) {
          store.run('UPDATE worktree_bindings SET released_at=NULL,release_reason=NULL WHERE id=?', lastBinding.id);
        }
      }
    }

    const reasons = [...new Set([
      ...(event?.type ? [String(event.type)] : []),
      ...updates.map(u => String(u.data?.wake_type || u.data?.reason || 'update')),
    ])];
    const logged = (value: unknown) => store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)', randomId(), taskId, JSON.stringify(value), now);
    logged({
      type: 'continued',
      round,
      mode: 'development',
      pr_number: prNumber,
      updates: updates.length,
      reasons,
      detail: `bot PR${prNumber ? ` #${prNumber}` : ''} 第 ${done} 轮已结束，现作为同一任务的第 ${round} 轮继续（保留工作区与角色会话，统一由 Task Manager 编排）。`,
    });
    for (const update of updates) logged(reviewUpdateLog(update.data));
    traceEvent(
      store,
      taskId,
      'task_continued',
      {
        round,
        mode: 'development',
        pr_number: prNumber,
        event_id: event?.id ?? null,
        event_type: event?.type ?? null,
        updates: updates.map(u => u.id),
        reasons,
        preserved_workspace_id: task.workspace_id ?? null,
      },
      null,
      'framework',
    );
    return true;
  });
}

/**
 * Starts the next round of a finished review that has updates to take; false when it has none, is not a finished review, or
 * is still held by the run that just finished it (that run's engine calls this again once it has let go). The round runs on
 * the project's current configuration, as a new task would, and is fenced like a retry: a new attempt, a new claim.
 */
export function continueFinishedReview(store: Store, taskId: string): boolean {
  return store.transaction(() => {
    // Checked on the hot columns first: a task's input can be large, and every finished review run asks.
    if (!store.get(`SELECT 1 FROM tasks t WHERE t.id=? AND (t.kind LIKE 'review.%' OR (t.kind='task.request' AND EXISTS (SELECT 1 FROM task_write_grants g WHERE g.task_id=t.id AND json_valid(g.writes) AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value='review'))))
      AND t.status='succeeded' AND NOT EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id=t.id)
      AND EXISTS (SELECT 1 FROM review_updates u WHERE u.task_id=t.id AND u.id>t.review_update_cursor)`, taskId)) return false;
    const task = store.get('SELECT * FROM tasks WHERE id=?', taskId)!, updates = continuationUpdates(store, task);
    // Only pushes of heads the review already read: they are answered, and need no round.
    if (!updates.length) { store.run('UPDATE tasks SET review_update_cursor=(SELECT max(id) FROM review_updates WHERE task_id=?) WHERE id=?', taskId, taskId); return false; }
    const input = JSON.parse(task.input || '{}'), done = Number(input.round || 1), round = done + 1, now = new Date().toISOString();
    const configuration = store.get('SELECT revision FROM task_execution_configs WHERE task_id=?', taskId)?.revision ?? input.configuration_revision ?? 1;
    // The round is shaped like a review the updates would have created: the latest update a person made is its trigger (the
    // summary comment answers that person; a push asks nobody's question) and the others are merged into it. What the
    // earlier round answered is in its reopened Pi session, or in previous_result.
    const askedIndex = updates.map(update => update.data?.reason !== 'pushed').lastIndexOf(true), asked = askedIndex < 0 ? null : updates[askedIndex]!.data;
    const latestPushSha = [...updates].reverse().map(update => update.data?.after).find(sha => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha)) ?? null;
    const { comment: _comment, trigger: _trigger, merged_updates: _merged, wait_for_review: _wait, delivery: _delivery, ...kept } = input;
    const next = { ...kept, ...(kept.generic ? { delivery: null } : {}), ...(kept.target && latestPushSha ? { target: { ...kept.target, ref: latestPushSha }, move_to_sha: latestPushSha } : {}), round, previous_result: previousResult(task, done), ...(asked ? { trigger: triggerOf(asked) } : {}),
      ...(asked?.comment ? { comment: asked.comment } : {}), merged_updates: updates.filter((_, index) => index !== askedIndex).map(update => triggerOf(update.data)),
      configuration_revision: Number(configuration) + 1, round_update_cursor: Math.max(...updates.map(update => update.id)) };
    // The round has taken these updates (they are its trigger and merged_updates): its turns are given only what joins later,
    // and a result of this round covers at least these (src/review/sessions.ts).
    store.run(`UPDATE tasks SET status='queued',phase='prepare',input=?,head_sha=coalesce(?,head_sha),workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,model_started=0,publication_started=0,
      review_update_cursor=?,error_code=NULL,retry_count=0,wait_count=0,retry_error_code=NULL,retry_cycle_started_at=NULL,claim_token=NULL,next_run_at=0,attempt=attempt+1,updated_at=?
      WHERE id=? AND status='succeeded'`, JSON.stringify(next), latestPushSha, next.round_update_cursor, now, taskId);
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
    const continued = traceEvent(store, taskId, 'task_continued', { round, updates: updates.map(update => update.id), reasons }, null, 'framework');
    publicationDecision(store, task, 'next_round', { reason: 'published_result_has_uncovered_updates', round, covered_through: Number(task.review_update_cursor || 0),
      pending_updates: updates.length, pending_update_ids: updates.map(update => update.id), carried_updates: updates.length, reasons, caused_by: [continued] });
    return true;
  });
}

/**
 * After a restart: finished reviews whose next round was due when the process stopped (its run had just finished). Only the
 * newest update rows are read, never the task table as a whole.
 */
export function resumeFinishedReviews(store: Store, recent = 500) {
  for (const row of store.all(`SELECT DISTINCT u.task_id FROM review_updates u JOIN tasks t ON t.id=u.task_id
    WHERE u.id>(SELECT coalesce(max(id),0) FROM review_updates)-? AND u.id>t.review_update_cursor AND t.status='succeeded'`, recent))
    continueFinishedReview(store, String(row.task_id));
}
