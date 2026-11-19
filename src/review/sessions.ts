import { type Store, type Row } from '../storage/database.js';

/** Whether a reviewed Issue or pull request is closed, and since when; workspace cleanup reads it (src/projects/workspace-cleanup.ts). */
export function reviewObjectState(store: Store, repository: string, kind: string, number: number, closed: boolean, now = Date.now()) {
  store.run(`INSERT INTO review_objects VALUES(?,?,?,?) ON CONFLICT(repository_id,kind,object_number)
    DO UPDATE SET closed_at=CASE WHEN excluded.closed_at IS NULL THEN NULL ELSE coalesce(review_objects.closed_at,excluded.closed_at) END`,
    repository, kind, number, closed ? now : null);
}
/** The timeline entry of an update a review took (#770): who, what, a link, and the heads of a push or of a head move. */
export function reviewUpdateLog(data: any) {
  return { type: 'review_update', actor: data?.actor ?? null, reason: data?.reason ?? null, url: data?.url || data?.comment?.html_url || null,
    ...(data?.reason === 'pull_request_head_changed' ? { previous_head: data.previous_head, current_head: data.current_head } : {}),
    ...(data?.reason === 'pushed' ? { after: data.after ?? null } : {}),
    detail: JSON.stringify({ ...data, object: undefined, comment: undefined, review: undefined }) };
}
/** The updates the task's review sessions have not been given yet: those after its delivery cursor. */
export function pendingReviewUpdates(store: Store, task: Row) {
  const cursor = store.get('SELECT review_update_cursor FROM tasks WHERE id=?', task.id)?.review_update_cursor || 0;
  return store.all('SELECT id,data FROM review_updates WHERE task_id=? AND id>? ORDER BY id', task.id, cursor);
}

/*
 * Coverage (#1100). review_update_cursor is how far the task's review sessions have been given updates (at a session's
 * start and between its turns). What a review result answers is fixed when the result is made: it carries
 * `updates_through`, the cursor when its session or role finished. Publication and the Manager go by the result, never by
 * the cursor, so an attempt that reuses an earlier result keeps what that result covered, and an update that came later is
 * carried to the next round instead of holding the publication back.
 */

/** The cursor a result made now is stamped with. */
export const reviewUpdateCursor = (store: Store, taskId: string) => Number(store.get('SELECT review_update_cursor FROM tasks WHERE id=?', taskId)?.review_update_cursor || 0);

/**
 * The last update a review result covers: what its session or role had been given, and at least what its round started
 * with (the round's trigger and merged updates), so those never start yet another round. A result without the stamp (made
 * before #1100, or another task's result) covers only what its round started with.
 */
export function resultCoverage(task: Row, result: any): number {
  let round = 0; try { round = Number(JSON.parse(task.input || '{}').round_update_cursor) || 0; } catch { round = 0; }
  const stamped = Number(result?.updates_through);
  return Math.max(round, Number.isSafeInteger(stamped) && stamped > 0 ? stamped : 0);
}

/** The task's updates after `through`, oldest first. */
const updatesAfter = (store: Store, taskId: string, through: number) =>
  store.all('SELECT id,data FROM review_updates WHERE task_id=? AND id>? ORDER BY id', taskId, through).map(row => ({ id: Number(row.id), data: JSON.parse(row.data) }));

/**
 * The updates after `through` that a next round answers: all of them except a push to a head the review already read
 * (the webhook came after the review moved there itself). `task` needs its `input` and `head_sha`.
 */
export function roundUpdatesAfter(store: Store, task: Row, through: number) {
  let heads: string[] = [];
  try { const input = JSON.parse(task.input || '{}'); heads = Array.isArray(input.heads) ? input.heads.map(String) : []; } catch { heads = []; }
  if (task.head_sha) heads.push(String(task.head_sha));
  return updatesAfter(store, String(task.id), through).filter(update => update.data?.reason !== 'pushed' || !heads.includes(String(update.data.after)));
}

const clip = (value: unknown, limit: number) => { if (value == null || value === '') return null; const text = String(value); return text.length > limit ? text.slice(0, limit) + '…' : text; };
/** A new head of the pull request: the push webhook, or the head move the engine found itself. */
export const pushUpdate = (data: any) => ['pushed', 'pull_request_head_changed'].includes(data?.reason);

/** One update as the Manager reads it: who, when, where, an excerpt, and whether it is a push. */
export function updateFact(update: { id: number; data: any }) {
  const d = update.data || {};
  return { id: update.id, reason: d.reason ?? null, push: pushUpdate(d), actor: d.actor ?? d.comment?.user?.login ?? d.review?.user?.login ?? null,
    // When the update joined the task (`at`, since #1100); older rows have the comment's or review's own time.
    at: d.at ?? d.comment?.created_at ?? d.review?.submitted_at ?? null, url: d.url || d.comment?.html_url || d.review?.html_url || null,
    excerpt: clip(d.comment?.body ?? d.review?.body ?? (d.reason === 'issue_edited' || d.reason === 'pull_request_edited' ? d.object?.body : null), 600),
    ...(d.reason === 'pushed' ? { before: d.before ?? null, after: d.after ?? null } : {}),
    ...(d.reason === 'pull_request_head_changed' ? { before: d.previous_head ?? null, after: d.current_head ?? null } : {}),
    ...(Array.isArray(d.changed) ? { changed: d.changed } : {}) };
}

/**
 * What a review's Manager is told about updates at each of its runs (#1100): the latest Dev result it would nominate, the
 * last update that result covers, and every update after it. The platform publishes a QA-approved result whatever came
 * later; the Manager decides whether to have Dev revise first.
 */
export function reviewUpdateFacts(store: Store, task: Row, limit = 20) {
  const latest = store.get("SELECT id,data FROM task_history WHERE task_id=? AND type='role_result' AND json_extract(data,'$.role')='dev' ORDER BY id DESC LIMIT 1", task.id);
  const current = store.get('SELECT id,input,head_sha FROM tasks WHERE id=?', task.id) ?? task;
  // The same updates a publication would carry to the next round, so the Manager is never told of one that would be skipped.
  const through = resultCoverage(current, latest ? JSON.parse(latest.data).result : null), updates = roundUpdatesAfter(store, current, through);
  return { result_ref: latest ? 'task_history:' + latest.id : null, covered_through: through, uncovered_count: updates.length,
    uncovered: updates.slice(-limit).map(updateFact),
    instruction: updates.length
      ? `${updates.length} update(s) of this ${task.kind === 'review.pr' ? 'pull request' : 'Issue'} came after what ${latest ? 'the latest Dev result' : 'any Dev result so far'} covers (oldest first; at most the newest ${limit} are listed). `
        + 'Unless you act, the platform publishes a QA-approved result as it is, and these updates start the next round of this review after publication, which revises the same summary comment. '
        + 'To answer them before publishing, delegate dev to revise the review and name the updates in the purpose; to publish now, nominate the result as usual. Either way they are answered.'
      : 'No update came after what the latest Dev result covers.' };
}
