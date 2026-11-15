import { type Store, type Row } from '../storage/database.js';

// Internal control flow: new discussion arrived before the first publication write.
export class ReviewUpdated extends Error {}

const retentionMs = 15 * 24 * 3600 * 1000;
export function pruneReviewSessions(store: Store, now = Date.now()) {
  store.run(`UPDATE tasks SET messages=NULL WHERE kind LIKE 'review.%' AND messages IS NOT NULL AND (status IN ('cancelled','superseded') OR status='failed' AND publication_started=0 OR EXISTS
    (SELECT 1 FROM review_objects o WHERE o.repository_id=tasks.repository_id AND o.kind=tasks.kind AND o.object_number=tasks.object_number AND o.closed_at<=?))`,now-retentionMs);
  store.run(`DELETE FROM review_sessions WHERE EXISTS (SELECT 1 FROM review_objects o WHERE o.repository_id=review_sessions.repository_id
    AND o.kind=review_sessions.kind AND o.object_number=review_sessions.object_number AND o.closed_at<=?)`, now - retentionMs);
}
export function reviewObjectState(store: Store, repository: string, kind: string, number: number, closed: boolean, now = Date.now()) {
  // Expire before clearing closed_at: reopening after the grace period starts an empty conversation.
  pruneReviewSessions(store, now);
  store.run(`INSERT INTO review_objects VALUES(?,?,?,?) ON CONFLICT(repository_id,kind,object_number)
    DO UPDATE SET closed_at=CASE WHEN excluded.closed_at IS NULL THEN NULL ELSE coalesce(review_objects.closed_at,excluded.closed_at) END`,
    repository, kind, number, closed ? now : null);
}
/**
 * The object's last published review conversation. A session is saved only when a review publishes, so it stays the source
 * whatever its task does next (#770): that task may run its next round, or that round may fail or be stopped.
 */
export function latestReviewSession(store: Store, task: Row) {
  pruneReviewSessions(store);
  return store.get(`SELECT s.* FROM review_sessions s JOIN tasks t ON t.id=s.task_id WHERE s.repository_id=? AND s.kind=?
    AND s.object_number=?`, task.repository_id, task.kind, task.object_number);
}
export function saveReviewSession(store: Store, task: Row) {
  const messages = store.get('SELECT messages FROM tasks WHERE id=?', task.id)?.messages;
  if (!messages) return;
  // The file lists may be blob references (see storedInput); the session keeps them as they are and is resolved where reused.
  const input=JSON.parse(task.input);
  const snapshot=JSON.stringify({snapshot_files:input.snapshot_files,skipped_files:input.skipped_files,snapshot_tree:input.snapshot_tree,source_tree:input.source_tree,coverage:input.coverage,history:!!input.context?.pull_request?.diff});
  store.run(`INSERT INTO review_sessions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,kind,object_number)
    DO UPDATE SET task_id=excluded.task_id,messages=excluded.messages,workspace_id=excluded.workspace_id,generation=excluded.generation,
    head_sha=excluded.head_sha,snapshot=excluded.snapshot`, task.repository_id, task.kind, task.object_number, task.id, messages,
    task.workspace_id, task.generation, task.head_sha, snapshot);
  store.run('UPDATE tasks SET messages=NULL WHERE id=?', task.id);
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
