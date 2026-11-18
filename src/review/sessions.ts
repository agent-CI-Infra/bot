import { type Store, type Row } from '../storage/database.js';

// Internal control flow: new discussion arrived before the first publication write.
export class ReviewUpdated extends Error {}

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
export function pendingReviewUpdates(store: Store, task: Row) {
  const cursor = store.get('SELECT review_update_cursor FROM tasks WHERE id=?', task.id)?.review_update_cursor || 0;
  return store.all('SELECT id,data FROM review_updates WHERE task_id=? AND id>? ORDER BY id', task.id, cursor);
}
