import { type Store } from '../storage/database.js';
import { randomId, type Json } from '../core/security.js';

export function enqueue(store: Store, repositoryId: string, kind: string, number: number, head: string | null, input: Json,
  delivery: string | null = null, sourceTask: string | null = null): string | null {
  if (!Number.isSafeInteger(number) || number < 1 || kind.endsWith('.pr') && !/^[a-f0-9]{40}$/.test(head || '')) return null;
  const key = `${repositoryId}:${kind}:${number}:${kind.endsWith('.pr') ? head : 'opened'}`;
  const existing = store.get('SELECT id FROM tasks WHERE unique_key=?', key); if (existing) return null;
  const id = randomId(), now = new Date().toISOString();
  store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,object_number,head_sha,source_task_id,source_delivery_id,created_at,updated_at)
    VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?,?)`, id, repositoryId, kind, `${kind} #${number}`, key, JSON.stringify(input), number, head, sourceTask, delivery, now, now);
  return id;
}
export function queueWebhook(store: Store, repositoryId: string, event: string, payload: Json, delivery: string): number {
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  const object = (event === 'issues' ? payload.issue : payload.pull_request) as Json | undefined;
  const number = Number(object?.number || payload.number), action = payload.action;
  if (object && (action === 'closed' || action === 'converted_to_draft')) {
    store.run("UPDATE tasks SET status='cancelled',error_code='object_closed_or_draft' WHERE repository_id=? AND object_number=? AND kind LIKE ? AND status NOT IN ('succeeded','pr_opened','completed')",
      repositoryId, number, event === 'issues' ? '%.issue' : '%.pr');
  }
  if (!policy?.enabled || !policy.review_enabled) return 0;
  if (event === 'issues' && action === 'opened' && object && !object.pull_request) return enqueue(store, repositoryId, 'review.issue', number, null, payload, delivery) ? 1 : 0;
  if (event === 'pull_request' && ['opened','ready_for_review','synchronize'].includes(String(action)) && object && object.draft !== true && object.state !== 'closed') {
    const head = object.head as Json | undefined;
    return enqueue(store, repositoryId, 'review.pr', number, String(head?.sha || ''), payload, delivery) ? 1 : 0;
  }
  return 0;
}
