import { type Store } from '../storage/database.js';
import { randomId, type Json } from '../core/security.js';
import { developmentLabel } from '../rules/service.js';

export const sameLabel = (name: unknown, label: string) => String(name ?? '').toLowerCase() === label.toLowerCase();
// A person's go-ahead for development: the development label is on the Issue and nobody has claimed it.
export function developmentReady(issue: any, label: string) {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  return labels.some((l: any) => sameLabel(typeof l === 'string' ? l : l?.name, label)) && !issue.assignee && !(Array.isArray(issue.assignees) && issue.assignees.length);
}
// The review found an explicit request for this code change in the Issue's own title or body.
export function reviewRequestsCode(issue: any, result: any) {
  const text = String(issue?.title) + '\n' + String(issue?.body || ''), quote = String(result?.request_quote || '');
  return !!result?.requires_code_change && !result.clarification_required && !!result.issue_requests_code
    && !!String(result.implementation_goal || '').trim() && !!quote.trim() && text.includes(quote);
}
// A person adding the development label after the review starts the development that review found requested.
// Labels added before the review finishes are checked when the review is published instead.
function queueLabeledDevelopment(store: Store, repositoryId: string, policy: any, payload: any, number: number, delivery: string) {
  const issue = payload.issue;
  if (!policy.development_enabled || issue?.state !== 'open' || payload.sender?.type !== 'User') return false;
  let label: string; try { label = developmentLabel(store, repositoryId); } catch { return false; }
  if (!sameLabel(payload.label?.name, label) || !developmentReady(issue, label)) return false;
  const review = store.get("SELECT id,result FROM tasks WHERE repository_id=? AND kind='review.issue' AND object_number=? AND status='succeeded' ORDER BY created_at DESC LIMIT 1", repositoryId, number);
  const result = review?.result ? JSON.parse(review.result) : null;
  if (!result || !reviewRequestsCode(issue, result)) return false;
  return !!enqueue(store, repositoryId, 'development.issue', number, null, { review: result, object_hash: result.object_hash }, delivery, review!.id);
}

export function enqueue(store: Store, repositoryId: string, kind: string, number: number, head: string | null, input: Json,
  delivery: string | null = null, sourceTask: string | null = null): string | null {
  if (!Number.isSafeInteger(number) || number < 1 || kind.endsWith('.pr') && !/^[a-f0-9]{40}$/.test(head || '')) return null;
  const key = `${repositoryId}:${kind}:${number}:${kind.endsWith('.pr') ? head : 'opened'}`;
  const existing = store.get('SELECT id FROM tasks WHERE unique_key=?', key); if (existing) return null;
  const id = randomId(), now = new Date().toISOString();
  store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,object_number,head_sha,source_task_id,source_delivery_id,created_at,updated_at)
    VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?,?)`, id, repositoryId, kind, `${kind} #${number}`, key, JSON.stringify(input), number, head, sourceTask, delivery, now, now);
  store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)',randomId(),id,
    JSON.stringify({type:'queued',repository_id:repositoryId,detail:`排队中，等待仓库 ${repositoryId} 的虚拟电脑空闲…`}),now);
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
  // Each trigger can be turned off per repository; drafts and closed pull requests are never reviewed.
  if (event === 'issues' && action === 'opened' && object && !object.pull_request) return policy.review_issues && enqueue(store, repositoryId, 'review.issue', number, null, payload, delivery) ? 1 : 0;
  if (event === 'issues' && action === 'labeled' && object && !object.pull_request) return queueLabeledDevelopment(store, repositoryId, policy, payload, number, delivery) ? 1 : 0;
  const prTrigger = action === 'synchronize' ? policy.review_pr_updates : ['opened','ready_for_review'].includes(String(action)) && policy.review_pull_requests;
  if (event === 'pull_request' && prTrigger && object && object.draft !== true && object.state !== 'closed') {
    const head = object.head as Json | undefined;
    return enqueue(store, repositoryId, 'review.pr', number, String(head?.sha || ''), payload, delivery) ? 1 : 0;
  }
  return 0;
}
