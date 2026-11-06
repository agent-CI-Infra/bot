import { type Store } from '../storage/database.js';
import { randomId, type Json } from '../core/security.js';
import { reviewObjectState } from './sessions.js';
import { developmentLabel } from '../rules/service.js';
import { actionsDevelopmentAllowed } from '../actions/safety.js';
import { queueWorkflows, workflowNeedsPullRequest } from '../workflows/triggers.js';
import { activeTrigger } from '../workflows/resolve.js';

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
// Mentions are plain text, independent of GitHub accounts. Escape configured names before matching.
// A new comment on an open Issue or PR that mentions one of the configured names; any workflow may trigger on it.
export function mentionsBot(event: string, payload: Json): boolean {
  const issue = payload.issue as any, comment = payload.comment as any, configured = process.env.BOT_MENTION_NAMES ?? 'bot,agent-ci-infra-bot';
  if (event !== 'issue_comment' || payload.action !== 'created' || botWrote(payload, comment?.body) || issue?.state !== 'open'
    || !Number.isSafeInteger(issue.number) || issue.number < 1 || typeof comment?.body !== 'string'
    || !/^[1-9]\d*$/.test(String(comment.id ?? '')) || typeof comment.id === 'number' && !Number.isSafeInteger(comment.id)
    || configured.trim().toLowerCase() === 'off') return false;
  const names = configured.split(',').map(name => name.trim()).filter(Boolean);
  return names.some(name => new RegExp(`(^|[^a-z0-9])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`, 'i').test(comment.body));
}
export function commentReviewKind(store: Store, repositoryId: string, event: string, payload: Json): 'review.issue' | 'review.pr' | null {
  const issue = payload.issue as any;
  if (!mentionsBot(event, payload)) return null;
  const kind = issue.pull_request ? 'review.pr' : 'review.issue';
  return activeTrigger(store, repositoryId, kind, 'comment.mention') ? kind : null;
}
// What the bot writes itself carries its marker; a bot account posts as an ordinary GitHub user, so the sender type is not enough.
const botMarker = /<!-- dept-bot[:-]/;
const botWrote = (payload: any, body: unknown) => payload?.sender?.type === 'Bot' || botMarker.test(String(body ?? ''));
const clip = (value: unknown, limit = 4000) => { const text = String(value ?? ''); return text.length > limit ? text.slice(0, limit) + '…' : text; };
// A person updated an open Issue or PR after it was opened: edited its title or body, commented, submitted a review or replied
// to review comments. Returns the review to queue and what triggered it, or null. Opening, new commits and mentions have their
// own triggers; drafts, closed objects and the bot's own writing never trigger. `otherBot` is set for another review bot's
// comment or review on a pull request this bot opened (see otherBotOnBotPullRequest): it counts like a member's.
export function updateTrigger(event: string, payload: Json, otherBot = false): { kind: 'review.issue' | 'review.pr', number: number, pullRequest?: Json, trigger: Json } | null {
  const p = payload as any, action = p.action, actor = String(p.sender?.login || ''), edited = (changes: any) => ['title', 'body'].filter(key => changes && key in changes);
  // Anyone can comment on a public repository: a comment or review counts only from the object's author or from someone
  // with a role in the repository, so strangers cannot spend the model budget. Editing a title or body on GitHub already
  // takes one of those.
  const trusted = (association: unknown, author: any) => otherBot || ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(String(association))
    || author?.id != null && String(author.id) === String(p.sender?.id ?? '');
  const byBot = (payload: any, body: unknown) => otherBot ? botMarker.test(String(body ?? '')) : botWrote(payload, body);
  const by = otherBot ? { actor_type: 'Bot' } : {};
  // Which comment, review or inline comment this is, so a review of the bot's own pull request can name it as a request.
  const source = (type: string, id: unknown) => /^[1-9]\d*$/.test(String(id ?? '')) ? { source: { type, id: Number(id) } } : {};
  const open = (object: any) => object?.state === 'open' && object.draft !== true && Number.isSafeInteger(object.number) && object.number > 0;
  if (event === 'issues' && action === 'edited' && open(p.issue) && !p.issue.pull_request && edited(p.changes).length && !byBot(p, null))
    return { kind: 'review.issue', number: p.issue.number, trigger: { reason: 'issue_edited', actor, changed: edited(p.changes),
      previous: Object.fromEntries(edited(p.changes).map(key => [key, clip(p.changes[key]?.from)])) } };
  if (event === 'issue_comment' && action === 'created' && p.issue?.state === 'open' && Number.isSafeInteger(p.issue.number) && p.issue.number > 0
    && typeof p.comment?.body === 'string' && !byBot(p, p.comment.body) && trusted(p.comment.author_association, p.issue.user))
    return { kind: p.issue.pull_request ? 'review.pr' : 'review.issue', number: p.issue.number, trigger: { reason: 'comment', actor, ...by, url: String(p.comment.html_url || ''), ...source('comment', p.comment.id) } };
  const pr = p.pull_request;
  // A bot account editing its own PR description is the bot, even though GitHub reports a user.
  if (event === 'pull_request' && action === 'edited' && open(pr) && edited(p.changes).length && !byBot(p, null)
    && !(String(pr.user?.id ?? '') === String(p.sender?.id ?? '') && botMarker.test(String(pr.body ?? ''))))
    return { kind: 'review.pr', number: pr.number, pullRequest: pr, trigger: { reason: 'pull_request_edited', actor, changed: edited(p.changes),
      previous: Object.fromEntries(edited(p.changes).map(key => [key, clip(p.changes[key]?.from)])) } };
  if (event === 'pull_request_review_comment' && action === 'created' && open(pr) && typeof p.comment?.body === 'string' && !byBot(p, p.comment.body)
    && trusted(p.comment.author_association, pr.user))
    return { kind: 'review.pr', number: pr.number, pullRequest: pr, trigger: { reason: p.comment.in_reply_to_id ? 'review_reply' : 'review_comment', actor, ...by,
      url: String(p.comment.html_url || ''), path: String(p.comment.path || ''), line: p.comment.line ?? null, ...source('review_comment', p.comment.id) } };
  // Every reply to a review thread also arrives as a review without a body; that one is the comment event above.
  if (event === 'pull_request_review' && action === 'submitted' && open(pr) && !byBot(p, p.review?.body) && trusted(p.review?.author_association, pr.user)
    && (String(p.review?.body || '').trim() || p.review?.state === 'changes_requested'))
    return { kind: 'review.pr', number: pr.number, pullRequest: pr, trigger: { reason: 'review_submitted', actor, ...by, state: String(p.review.state || ''),
      body: clip(p.review.body), url: String(p.review.html_url || ''), ...source('review', p.review.id) } };
  return null;
}
// Another review bot's conversation comment, review or inline comment on a pull request this bot opened. The pull request's
// author is this bot's account, so a different bot account is someone else; the bot's own writing never counts. Such review
// is judged on its merits and may revise the pull request once per bot (see the engine's revisionRequests).
export function otherBotOnBotPullRequest(store: Store, repositoryId: string, event: string, payload: Json): boolean {
  const p = payload as any, object = event === 'issue_comment' ? (p.issue?.pull_request ? p.issue : null) : p.pull_request;
  if (!['issue_comment', 'pull_request_review_comment', 'pull_request_review'].includes(event) || !object || p.sender?.type !== 'Bot') return false;
  const owned = store.get('SELECT author_id FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, Number(object.number));
  return !!owned && String(object.user?.id ?? '') === String(owned.author_id) && String(p.sender?.id ?? '') !== String(owned.author_id);
}
// Reviews of updates follow the review workflow's triggers.
const updateEnabled = (store: Store, repositoryId: string, kind: string) => !!activeTrigger(store, repositoryId, kind, kind === 'review.issue' ? 'issue.updated' : 'pull_request.updated');
type Update = { kind: 'review.issue' | 'review.pr', number: number, pullRequest?: Json, trigger: Json };
// An issue_comment on a PR names only the PR number; the webhook reads the current head before archiving when a review may follow.
export function pullRequestNeeded(store: Store, repositoryId: string, event: string, payload: Json) {
  if (event !== 'issue_comment' || !(payload.issue as any)?.pull_request) return false;
  if (commentReviewKind(store, repositoryId, event, payload) === 'review.pr') return true;
  if (workflowNeedsPullRequest(store, repositoryId, event, payload)) return true;
  return updateTrigger(event, payload, otherBotOnBotPullRequest(store, repositoryId, event, payload))?.kind === 'review.pr' && updateEnabled(store, repositoryId, 'review.pr');
}
// A durable inbox keeps updates independent of prepare's asynchronous input snapshot.
const activeStates = ['queued', 'retry_wait', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'waiting_publication', 'running', 'preparing', 'publishing', 'result_ready'];
// `labeled` is a label a person added that one of the review workflow's label triggers names; it is reviewed as an update.
function queueUpdate(store: Store, repositoryId: string, event: string, payload: Json, delivery: string, currentPullRequest?: Json, mention?: 'review.issue' | 'review.pr', labeled?: Update) {
  const update: Update | null = labeled ?? (mention ? { kind: mention, number: Number((payload.issue as any).number), trigger: { reason: 'mention', actor: String((payload.sender as any)?.login || ''), url: String((payload.comment as any)?.html_url || ''), source: { type: 'comment', id: Number((payload.comment as any).id) } } } : updateTrigger(event, payload, otherBotOnBotPullRequest(store, repositoryId, event, payload)));
  if (!update || !mention && !labeled && !updateEnabled(store, repositoryId, update.kind)) return 0;
  const commentKey=mention?`${repositoryId}:${update.kind}:${update.number}:comment:${(payload.comment as any).id}`:null;
  if(commentKey&&(store.get('SELECT 1 FROM tasks WHERE unique_key=?',commentKey)||store.get('SELECT 1 FROM review_updates WHERE event_key=?',commentKey)))return 0;
  const pr = ((update as any).pullRequest || currentPullRequest) as any;
  if (update.kind === 'review.pr' && (!pr || pr.number !== update.number || pr.state !== 'open' || pr.draft === true)) return 0;
  const active = store.all(`SELECT * FROM tasks WHERE repository_id=? AND kind=? AND object_number=? AND status IN (${activeStates.map(() => '?').join(',')})
    ORDER BY CASE WHEN status IN ('running','preparing','publishing','result_ready') THEN 0 ELSE 1 END,
    (SELECT claimed_at FROM task_claims WHERE task_id=tasks.id) DESC,created_at DESC,rowid DESC`, repositoryId, update.kind, update.number, ...activeStates);
  // A discussion on a new head must never enter the old checkout.
  const running = active.find(task => ['running','preparing','publishing','result_ready'].includes(task.status));
  const sameHead = (task: any) => update.kind !== 'review.pr' || task.head_sha === pr.head?.sha;
  const pending = running && !running.publication_started && sameHead(running) ? running
    : active.find(task => !['running','preparing','publishing','result_ready'].includes(task.status) && !task.publication_started && sameHead(task));
  const trigger = { event, action: payload.action, ...update.trigger };
  if (pending) {
    const data = { ...trigger, object: payload.issue || payload.pull_request, comment: payload.comment, review: payload.review };
    const inserted = store.run('INSERT OR IGNORE INTO review_updates(task_id,event_key,data) VALUES(?,?,?)', pending.id, commentKey||'delivery:'+delivery, JSON.stringify(data));
    if (inserted.changes) {
      const input = JSON.parse(pending.input || '{}');
      store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify({ ...input, merged_updates: [...(input.merged_updates || []), trigger] }), pending.id);
    }
    return 0;
  }
  const publishing = active.find(task => task.publication_started);
  const input = { ...payload, trigger, ...(publishing ? { wait_for_review: publishing.id } : {}) };
  return enqueue(store, repositoryId, update.kind, update.number, update.kind === 'review.pr' ? String(pr.head?.sha || '') : null,
    update.kind === 'review.pr' ? { ...input, pull_request: pr } : input, delivery, null, mention ? String((payload.comment as any).id) : null, mention ? null : delivery) ? 1 : 0;
}
// A person adding the development label after the review starts the development that review found requested.
// Labels added before the review finishes are checked when the review is published instead.
function queueLabeledDevelopment(store: Store, repositoryId: string, payload: any, number: number, delivery: string) {
  const issue = payload.issue;
  if (!activeTrigger(store, repositoryId, 'development.issue', 'issue.labeled') || issue?.state !== 'open' || payload.sender?.type !== 'User') return false;
  let label: string; try { label = developmentLabel(store, repositoryId); } catch { return false; }
  if (!sameLabel(payload.label?.name, label) || !developmentReady(issue, label)) return false;
  const review = store.get("SELECT id,result FROM tasks WHERE repository_id=? AND kind='review.issue' AND object_number=? AND status='succeeded' ORDER BY created_at DESC LIMIT 1", repositoryId, number);
  const result = review?.result ? JSON.parse(review.result) : null;
  if (!result || !reviewRequestsCode(issue, result) || !actionsDevelopmentAllowed(store, repositoryId, number, issue, result)) return false;
  return !!enqueue(store, repositoryId, 'development.issue', number, null, { review: result, object_hash: result.object_hash }, delivery, review!.id);
}

// `commentId` keys a mention review to its comment; `updateId` keys an update review to its delivery record.
export function enqueue(store: Store, repositoryId: string, kind: string, number: number, head: string | null, input: Json,
  delivery: string | null = null, sourceTask: string | null = null, commentId: string | null = null, updateId: string | null = null): string | null {
  if (!Number.isSafeInteger(number) || number < 1 || kind.endsWith('.pr') && !/^[a-f0-9]{40}$/.test(head || '')) return null;
  if (kind === 'development.issue' && !actionsDevelopmentAllowed(store, repositoryId, number)) return null;
  if (commentId !== null && (!['review.issue','review.pr'].includes(kind) || !/^[1-9]\d*$/.test(commentId))) return null;
  if (updateId !== null && (!['review.issue','review.pr'].includes(kind) || !/^[\w-]{1,200}$/.test(updateId))) return null;
  if (kind === 'development.issue' && store.get(`SELECT id FROM tasks WHERE repository_id=? AND kind='development.issue' AND object_number=?
    AND status IN ('queued','retry_wait','waiting_configuration','waiting_environment','waiting_permission','waiting_pr_head','waiting_publication',
      'running','preparing','implementing','validating','publishing','result_ready') LIMIT 1`, repositoryId, number)) return null;
  // One revision of a bot pull request at a time: both would push to the same branch. The requests of a review that finds one
  // running are raised again by the review of the head it pushes.
  if (kind === 'development.pr' && store.get(`SELECT id FROM tasks WHERE repository_id=? AND kind='development.pr' AND object_number=?
    AND status IN ('queued','retry_wait','waiting_configuration','waiting_environment','waiting_permission','waiting_pr_head','waiting_publication',
      'running','preparing','implementing','validating','publishing','result_ready') LIMIT 1`, repositoryId, number)) return null;
  // A revision that people or other bots asked for is keyed by those requests, so a revision of the same head that the bot's
  // own review started earlier does not stand in for it.
  const requests = kind === 'development.pr' && Array.isArray((input as any).revision?.requests) ? (input as any).revision.requests.map((r: any) => `${r.type}:${r.id}`).join(',') : '';
  const key = `${repositoryId}:${kind}:${number}:${commentId !== null ? `comment:${commentId}` : updateId !== null ? `update:${updateId}` : kind.endsWith('.pr') ? head + (requests ? `:requests:${requests}` : '') : 'opened'}`;
  const existing = store.get('SELECT id FROM tasks WHERE unique_key=?', key); if (existing) return null;
  const id = randomId(), now = new Date().toISOString();
  store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,object_number,head_sha,source_task_id,source_delivery_id,created_at,updated_at)
    VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?,?)`, id, repositoryId, kind, `${kind} #${number}`, key, JSON.stringify(input), number, head, sourceTask, delivery, now, now);
  store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)',randomId(),id,
    JSON.stringify({type:'queued',repository_id:repositoryId,detail:`排队中，等待仓库 ${repositoryId} 的虚拟电脑空闲…`}),now);
  return id;
}
export function queueWebhook(store: Store, repositoryId: string, event: string, payload: Json, delivery: string, currentPullRequest?: Json): number {
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  const object = (event === 'issues' ? payload.issue : payload.pull_request) as Json | undefined;
  const number = Number(object?.number || payload.number), action = payload.action;
  if (object && Number.isSafeInteger(number) && number>0 && ['opened','reopened','closed'].includes(String(action))) reviewObjectState(store, repositoryId, event === 'issues' ? 'review.issue' : 'review.pr', number, action === 'closed');
  if (object && (action === 'closed' || action === 'converted_to_draft')) {
    store.run("UPDATE tasks SET status='cancelled',error_code='object_closed_or_draft',retry_cycle_started_at=NULL,retry_error_code=NULL,retry_count=0 WHERE repository_id=? AND object_number=? AND kind LIKE ? AND status NOT IN ('succeeded','pr_opened','completed')",
      repositoryId, number, event === 'issues' ? '%.issue' : '%.pr');
  }
  if (!policy?.enabled) return 0;
  if (event === 'issues' && !policy.actions_failures_enabled && store.get('SELECT 1 FROM actions_failure_issues WHERE repository_id=? AND number=?', repositoryId, number)) return 0;
  // Custom workflows run beside the built-in ones on the same events, with the same filters.
  const custom = queueWorkflows(store, repositoryId, event, payload, delivery, currentPullRequest);
  return custom + (policy.review_enabled ? queueBuiltin(store, repositoryId, event, payload, delivery, currentPullRequest, object, number, action) : 0);
}
function queueBuiltin(store: Store, repositoryId: string, event: string, payload: Json, delivery: string, currentPullRequest: Json | undefined, object: Json | undefined, number: number, action: unknown): number {
  const p = payload as any, has = (kind: string, trigger: string, label?: string) => !!activeTrigger(store, repositoryId, kind, trigger, label);
  if (event === 'issue_comment') {
    const kind = commentReviewKind(store, repositoryId, event, payload);
    // A comment without a mention may still be an update to review.
    if (!kind) return queueUpdate(store, repositoryId, event, payload, delivery, currentPullRequest);
    return queueUpdate(store, repositoryId, event, payload, delivery, currentPullRequest, kind);
  }
  // A label a person adds: the development go-ahead, and a review again when a review workflow triggers on that label.
  const labeled = (kind: 'review.issue' | 'review.pr', target: any) => action === 'labeled' && p.sender?.type === 'User' && typeof p.label?.name === 'string'
    && target?.state === 'open' && target.draft !== true && has(kind, kind === 'review.issue' ? 'issue.labeled' : 'pull_request.labeled', p.label.name)
    ? queueUpdate(store, repositoryId, event, payload, delivery, currentPullRequest, undefined, { kind, number, ...(kind === 'review.pr' ? { pullRequest: target } : {}),
      trigger: { reason: 'labeled', actor: String(p.sender?.login || ''), label: p.label.name } }) : 0;
  // Each trigger can be turned off per workflow; drafts and closed pull requests are never reviewed.
  if (event === 'issues' && action === 'opened' && object && !object.pull_request) return has('review.issue', 'issue.opened') && enqueue(store, repositoryId, 'review.issue', number, null, payload, delivery) ? 1 : 0;
  if (event === 'issues' && action === 'labeled' && object && !object.pull_request)
    return (queueLabeledDevelopment(store, repositoryId, payload, number, delivery) ? 1 : 0) + labeled('review.issue', object);
  const prTrigger = action === 'synchronize' ? has('review.pr', 'pull_request.synchronize') : ['opened','ready_for_review'].includes(String(action)) && has('review.pr', 'pull_request.opened');
  if (event === 'pull_request' && prTrigger && object && object.draft !== true && object.state !== 'closed') {
    const head = object.head as Json | undefined;
    return enqueue(store, repositoryId, 'review.pr', number, String(head?.sha || ''), payload, delivery) ? 1 : 0;
  }
  if (event === 'pull_request' && action === 'labeled') return labeled('review.pr', object);
  return queueUpdate(store, repositoryId, event, payload, delivery, currentPullRequest);
}
