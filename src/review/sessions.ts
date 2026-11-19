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
/** The result/candidate that last passed acceptance; a retry's cursor reset must not move this mark back. */
export function reviewCoveredUpdate(store: Store, taskId: string) {
  return Number(store.get('SELECT review_covered_update FROM tasks WHERE id=?', taskId)?.review_covered_update) || 0;
}
/**
 * The frontier a produced or accepted result covers. The result's own seen mark wins over accepted coverage, because an
 * attempt bump can reset the delivery cursor while the result still describes what its session actually read; only rows
 * that predate the seen mark fall back to coverage, then to the cursor.
 */
const coverageOf = (row: Row | undefined) => {
  const seen = row?.review_seen_update, covered = Number(row?.review_covered_update) || 0;
  if (seen == null) return covered > 0 ? covered : Number(row?.review_update_cursor) || 0;
  return Math.max(Number(seen) || 0, covered);
};
export function reviewCoverageFrontier(store: Store, taskId: string) {
  return coverageOf(store.get('SELECT review_update_cursor,review_covered_update,review_seen_update FROM tasks WHERE id=?', taskId));
}
/**
 * The delivery frontier for the running conversation. The cursor is the inbox, but accepted coverage is its floor: a retry
 * may reset the cursor, and updates an accepted result already covered must not be delivered again.
 */
export function reviewInboxFrontier(store: Store, taskId: string) {
  const row = store.get('SELECT review_update_cursor,review_covered_update FROM tasks WHERE id=?', taskId);
  return Math.max(Number(row?.review_update_cursor) || 0, Number(row?.review_covered_update) || 0);
}
/** Record what the result that was just produced actually saw, before an attempt bump can reset the delivery cursor. */
export function recordReviewResultSeen(store: Store, taskId: string) {
  return store.run('UPDATE tasks SET review_seen_update=max(coalesce(review_seen_update,0),coalesce(review_update_cursor,0)) WHERE id=?', taskId);
}
/** Mark every update the accepted result saw as covered. Newer updates keep their ids and stay pending. */
export function coverReviewUpdates(store: Store, taskId: string) {
  const row = store.get('SELECT review_update_cursor,review_seen_update FROM tasks WHERE id=?', taskId);
  const cursor = Number(row?.review_update_cursor) || 0, seen = row?.review_seen_update;
  // A result records its own frontier; older rows fall back to the cursor as they always did.
  const through = seen == null ? cursor : Number(seen) || 0;
  return store.run('UPDATE tasks SET review_covered_update=max(coalesce(review_covered_update,0),?) WHERE id=?', through, taskId);
}
/** Updates the running conversation has neither delivered nor had covered by an accepted result. */
export function pendingReviewUpdates(store: Store, task: Row) {
  return store.all('SELECT id,data FROM review_updates WHERE task_id=? AND id>? ORDER BY id', task.id, reviewInboxFrontier(store, task.id));
}
const headsOf = (task: Row) => {
  let heads: string[] = [];
  try { const input = JSON.parse(task.input || '{}'); heads = Array.isArray(input.heads) ? input.heads.map(String) : []; } catch { heads = []; }
  if (task.head_sha) heads.push(String(task.head_sha));
  return heads;
};
/** A push of a head this review already read, or a head move to one of those heads, answers itself. */
export function reviewUpdateIsRead(task: Row, data: any) {
  const heads = headsOf(task), head = data?.reason === 'pushed' ? data.after : data?.reason === 'pull_request_head_changed' ? data.current_head : null;
  return head != null && heads.includes(String(head));
}
/** Updates that still need a next round: newer than the accepted-result frontier, and not a push of a head already read. */
export function nextRoundUpdates(store: Store, task: Row): { id: number; data: any }[] {
  return store.all('SELECT id,data FROM review_updates WHERE task_id=? AND id>? ORDER BY id', task.id, reviewCoverageFrontier(store, task.id))
    .map(row => ({ id: Number(row.id), data: JSON.parse(row.data) }))
    .filter(update => !reviewUpdateIsRead(task, update.data));
}
const clip = (value: unknown, limit: number) => value == null ? null : String(value).slice(0, limit);
const actorOf = (data: any) => data?.actor ?? data?.sender?.login ?? data?.comment?.user?.login ?? data?.review?.user?.login ?? data?.object?.user?.login ?? null;
const urlOf = (data: any) => data?.url ?? data?.comment?.html_url ?? data?.review?.html_url ?? data?.object?.html_url ?? null;
const atOf = (data: any) => data?.at ?? data?.comment?.created_at ?? data?.review?.submitted_at ?? data?.object?.updated_at ?? null;
const summaryOf = (data: any) => data?.comment?.body ?? data?.review?.body ?? data?.object?.body ?? (data?.reason === 'pushed' ? `push ${String(data.before ?? '').slice(0,12)}..${String(data.after ?? '').slice(0,12)}` : null);
/**
 * The current state of a review's inbox for the Manager and publication audit: which updates the accepted result covers,
 * which are only delivered into the running turn, and which still need a later round. Bounded; originals stay in history.
 */
export function reviewUpdateFacts(store: Store, taskId: string, limit = 10) {
  const task = store.get('SELECT id,input,head_sha,review_update_cursor,review_covered_update,review_seen_update FROM tasks WHERE id=?', taskId);
  const delivered = Number(task?.review_update_cursor) || 0, covered = coverageOf(task);
  const rows = store.all('SELECT id,data FROM review_updates WHERE task_id=? ORDER BY id DESC LIMIT ?', taskId, limit).reverse();
  const next = task ? nextRoundUpdates(store, task) : [], nextIds = new Set(next.map(update => update.id));
  const updates = rows.map(row => {
    const data = JSON.parse(row.data), id = Number(row.id);
    return { id, reason: data?.reason ?? null, actor: actorOf(data), at: atOf(data), url: urlOf(data),
      summary: clip(summaryOf(data), 1500), pushed: data?.reason === 'pushed',
      covered: id <= covered, delivered: id <= delivered };
  });
  return { covered_through: covered, delivered_through: delivered, total_count: Number(store.get('SELECT count(*) n FROM review_updates WHERE task_id=?', taskId)?.n) || 0,
    pending_count: next.length, next_round_count: next.length, updates,
    uncovered: updates.filter(update => nextIds.has(update.id)), next_round: updates.filter(update => nextIds.has(update.id)) };
}
