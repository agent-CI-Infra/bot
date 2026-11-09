import { captureTaskConfiguration } from '../tasks/configuration.js';
import { type Store } from '../storage/database.js';
import { randomId, type Json } from '../core/security.js';
import { reviewObjectState } from './sessions.js';
import { developmentLabel } from '../rules/service.js';
import { actionsDevelopmentAllowed } from '../actions/safety.js';
import { recordEvent, type CreateOption, type EventInput } from '../dispatch/store.js';
import { eventFilters, labelDispatched, type EventFilters } from '../work/settings.js';

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
// A new comment on an open Issue or PR that mentions one of the configured names.
export function mentionsBot(event: string, payload: Json): boolean {
  const issue = payload.issue as any, comment = payload.comment as any, configured = process.env.BOT_MENTION_NAMES ?? 'bot,agent-ci-infra-bot';
  if (event !== 'issue_comment' || payload.action !== 'created' || botWrote(payload, comment?.body) || issue?.state !== 'open'
    || !Number.isSafeInteger(issue.number) || issue.number < 1 || typeof comment?.body !== 'string'
    || !/^[1-9]\d*$/.test(String(comment.id ?? '')) || typeof comment.id === 'number' && !Number.isSafeInteger(comment.id)
    || configured.trim().toLowerCase() === 'off') return false;
  const names = configured.split(',').map(name => name.trim()).filter(Boolean);
  return names.some(name => new RegExp(`(^|[^a-z0-9])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`, 'i').test(comment.body));
}
// What the bot writes itself carries its marker; a bot account posts as an ordinary GitHub user, so the sender type is not enough.
const botMarker = /<!-- dept-bot[:-]/;
const botWrote = (payload: any, body: unknown) => payload?.sender?.type === 'Bot' || botMarker.test(String(body ?? ''));
const clip = (value: unknown, limit = 4000) => { const text = String(value ?? ''); return text.length > limit ? text.slice(0, limit) + '…' : text; };
// A person updated an open Issue or PR after it was opened: edited its title or body, commented, submitted a review or replied
// to review comments. Returns the review kind and what triggered it, or null. Opening, new commits and mentions have their
// own events; drafts, closed objects and the bot's own writing never trigger. `otherBot` is set for another review bot's
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
  const source = (type: string, id: unknown) => /^[1-9]\d*$/.test(String(id ?? '')) ? { source: { type, id: Number(id) }, actor_id: String(p.sender?.id ?? '') } : {};
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
// An issue_comment on a PR names only the PR number; the webhook reads the current head before archiving when the comment
// would reach the Manager as a pull request event.
export function pullRequestNeeded(store: Store, repositoryId: string, event: string, payload: Json) {
  if (event !== 'issue_comment' || !(payload.issue as any)?.pull_request) return false;
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId); if (!policy?.enabled) return false;
  const filters = eventFilters(store, repositoryId, policy);
  if (mentionsBot(event, payload) && filters['pull_request.mention']) return true;
  return filters['pull_request.updated'] && updateTrigger(event, payload, otherBotOnBotPullRequest(store, repositoryId, event, payload))?.kind === 'review.pr';
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
  captureTaskConfiguration(store,id);
  store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)',randomId(),id,
    JSON.stringify({type:'queued',repository_id:repositoryId,detail:`排队中，等待仓库 ${repositoryId} 的虚拟电脑空闲…`}),now);
  return id;
}

// ---- GitHub events → Manager dispatch ----

const sha = (value: unknown) => /^[a-f0-9]{40}$/.test(String(value || '')) ? String(value) : null;
const openObject = (object: any) => object?.state === 'open' && object.draft !== true && Number.isSafeInteger(object.number) && object.number > 0;
/** What the Manager reads about an Issue or pull request: enough to judge, never the whole discussion. */
function objectFacts(object: any) {
  return { number: object?.number, title: clip(object?.title, 300), state: object?.state, author: object?.user?.login ?? null,
    labels: (object?.labels || []).map((l: any) => typeof l === 'string' ? l : l?.name).filter(Boolean), body_excerpt: clip(object?.body, 1500),
    ...(object?.head ? { draft: object.draft === true, head: object.head?.sha ?? null, base: object.base?.ref ?? null } : {}), url: object?.html_url ?? null };
}
const commentFacts = (comment: any) => comment ? { id: String(comment.id ?? ''), author: comment.user?.login ?? null, association: comment.author_association ?? null, body: clip(comment.body, 2000), url: comment.html_url ?? null } : undefined;
// The reply work type (former custom workflows): offered beside the review on Issue and pull request events. The Manager
// prompt says when it applies; it was never what the control plane did by default.
function replyOption(object: 'issue' | 'pr', number: number, head: string | null, input: Json, key: string, delivery: string): CreateOption {
  return { id: 'reply', work: 'reply', title: `通用回复 #${number}`, spec: { type: 'reply', kind: object === 'pr' ? 'workflow.pr' : 'workflow.issue', number, head, input, key, delivery } };
}
/**
 * The Manager event of one webhook delivery, after the control plane's filters: drafts, closed objects, the bot's own
 * writing, comments of people without a role in the repository and switched-off event kinds never reach the Manager.
 */
function webhookEvent(store: Store, repositoryId: string, event: string, payload: Json, delivery: string, currentPullRequest: Json | undefined, filters: EventFilters): EventInput | null {
  const p = payload as any, action = String(p.action || ''), actor = String(p.sender?.login || '');
  const base = (type: string, key: string, object: 'issue' | 'pr', number: number, summary: string, facts: Json): Omit<EventInput, 'options'> =>
    ({ repositoryId, key: `${repositoryId}:${key}`, type, source: 'github', summary, facts: { event, action, actor, ...facts }, object: { type: object, number }, delivery });
  // An update or mention: a review that answers it, joining a running review of the same object (and head) instead.
  const update = (type: string, object: 'issue' | 'pr', number: number, target: any, trigger: Json, merge: string, review: { commentId?: string; updateId?: string }, extra: Json = {}): EventInput => {
    const kind = object === 'pr' ? 'review.pr' : 'review.issue', head = object === 'pr' ? sha(target?.head?.sha) : null;
    const input = { ...payload, trigger, ...(object === 'pr' ? { pull_request: target } : {}) };
    const discriminator = review.commentId ? `comment:${review.commentId}` : `update:${delivery}`;
    return { ...base(type, `${type}:${number}:${discriminator}`, object, number, `${type === `${object === 'pr' ? 'pull_request' : 'issue'}.mention` ? '提到 bot' : '更新'}：${clip(target?.title, 120)} #${number}`,
      { object: objectFacts(target), trigger, ...extra }),
      options: [{ id: 'review', work: kind, title: `${object === 'pr' ? '检视 PR' : '检视 Issue'} #${number}`, default: true,
        spec: { type: 'object', kind, number, head, input, delivery, comment_id: review.commentId ?? null, update_id: review.commentId ? null : delivery } },
        replyOption(object, number, head, input, discriminator, delivery)],
      merge: { key: merge, data: { ...trigger, object: p.issue || p.pull_request, comment: p.comment, review: p.review }, trigger, head, kinds: [kind] } };
  };
  // An opening counts unless the object is already closed (or a draft), as before; later events need an open object.
  const notClosed = (object: any) => object && object.state !== 'closed' && object.draft !== true && Number.isSafeInteger(Number(object.number)) && Number(object.number) > 0;
  if (event === 'issues' && !p.issue?.pull_request && notClosed(p.issue)) {
    const issue = p.issue, number = Number(issue.number);
    if (action === 'opened' && filters['issue.opened']) return { ...base('issue.opened', `issue.opened:${number}`, 'issue', number, `Issue 打开：${clip(issue.title, 120)} #${number}`, { object: objectFacts(issue) }),
      options: [{ id: 'review', work: 'review.issue', title: `检视 Issue #${number}`, default: true, spec: { type: 'object', kind: 'review.issue', number, head: null, input: payload, delivery } },
        replyOption('issue', number, null, payload, 'opened', delivery)] };
    if (action === 'labeled' && openObject(issue) && p.sender?.type === 'User' && typeof p.label?.name === 'string') {
      const label = String(p.label.name), options: CreateOption[] = [];
      const development = filters['issue.development_label'] ? labeledDevelopment(store, repositoryId, p, number, delivery) : null;
      if (development) options.push(development);
      if (labelDispatched(filters, 'issue', label)) {
        const trigger = { event, action, reason: 'labeled', actor, label };
        const relabel = update('issue.labeled', 'issue', number, issue, trigger, 'delivery:' + delivery, { updateId: delivery }, { label });
        return { ...relabel, options: [...options, ...relabel.options] };
      }
      return options.length ? { ...base('issue.labeled', `issue.labeled:${number}:update:${delivery}`, 'issue', number, `Issue 加上标签 ${label}：${clip(issue.title, 120)} #${number}`, { object: objectFacts(issue), label }), options } : null;
    }
  }
  if (event === 'pull_request' && notClosed(p.pull_request) && sha(p.pull_request.head?.sha)) {
    const pr = p.pull_request, number = Number(pr.number), head = sha(pr.head.sha)!;
    const opened = ['opened', 'ready_for_review'].includes(action) && filters['pull_request.opened'], pushed = action === 'synchronize' && filters['pull_request.synchronize'];
    if (opened || pushed) {
      const type = opened ? 'pull_request.opened' : 'pull_request.synchronize';
      return { ...base(type, `${type}:${number}:${head}`, 'pr', number, `${opened ? 'PR 打开' : 'PR 推送新提交'}：${clip(pr.title, 120)} #${number}`, { object: objectFacts(pr) }),
        options: [{ id: 'review', work: 'review.pr', title: `检视 PR #${number}（${head.slice(0, 7)}）`, default: true, spec: { type: 'object', kind: 'review.pr', number, head, input: payload, delivery } },
          replyOption('pr', number, head, { ...payload, pull_request: pr }, head, delivery)] };
    }
    if (action === 'labeled' && openObject(pr) && p.sender?.type === 'User' && typeof p.label?.name === 'string' && labelDispatched(filters, 'pull_request', String(p.label.name)))
      return update('pull_request.labeled', 'pr', number, pr, { event, action, reason: 'labeled', actor, label: p.label.name }, 'delivery:' + delivery, { updateId: delivery }, { label: p.label.name });
  }
  // A PR conversation comment carries only the PR number; the webhook read the current PR before archiving.
  const commented = p.issue?.pull_request ? currentPullRequest as any : null;
  const pullRequestOk = (pr: any, number: number) => openObject(pr) && pr.number === number && !!sha(pr.head?.sha);
  if (event === 'issue_comment' && mentionsBot(event, payload)) {
    const object = p.issue.pull_request ? 'pr' : 'issue', number = Number(p.issue.number), type = object === 'pr' ? 'pull_request.mention' : 'issue.mention';
    if (filters[type] && (object === 'issue' || pullRequestOk(commented, number))) {
      const trigger = { event, action, reason: 'mention', actor, url: String(p.comment.html_url || ''), source: { type: 'comment', id: Number(p.comment.id) }, actor_id: String(p.sender?.id ?? '') };
      const kind = object === 'pr' ? 'review.pr' : 'review.issue';
      return update(type, object, number, object === 'pr' ? commented : p.issue, trigger, `${repositoryId}:${kind}:${number}:comment:${p.comment.id}`, { commentId: String(p.comment.id) }, { comment: commentFacts(p.comment) });
    }
  }
  const changed = updateTrigger(event, payload, otherBotOnBotPullRequest(store, repositoryId, event, payload));
  if (changed) {
    const object = changed.kind === 'review.pr' ? 'pr' : 'issue', type = object === 'pr' ? 'pull_request.updated' : 'issue.updated';
    const target = object === 'pr' ? (changed.pullRequest || commented) as any : p.issue;
    if (!filters[type] || object === 'pr' && !pullRequestOk(target, changed.number)) return null;
    return update(type, object, changed.number, target, { event, action, ...changed.trigger as any }, 'delivery:' + delivery, { updateId: delivery },
      { ...(p.comment ? { comment: commentFacts(p.comment) } : {}), ...(p.review ? { review: { state: p.review.state ?? null, body: clip(p.review.body, 2000), author: p.review.user?.login ?? null } } : {}) });
  }
  return null;
}
// A person adding the development label after the review starts the development that review found requested.
// Labels added before the review finishes are checked when the review is published instead.
function labeledDevelopment(store: Store, repositoryId: string, payload: any, number: number, delivery: string): CreateOption | null {
  const issue = payload.issue;
  if (issue?.state !== 'open' || payload.sender?.type !== 'User') return null;
  let label: string; try { label = developmentLabel(store, repositoryId); } catch { return null; }
  if (!sameLabel(payload.label?.name, label) || !developmentReady(issue, label)) return null;
  const review = store.get("SELECT id,result FROM tasks WHERE repository_id=? AND kind='review.issue' AND object_number=? AND status='succeeded' ORDER BY created_at DESC LIMIT 1", repositoryId, number);
  const result = review?.result ? JSON.parse(review.result) : null;
  if (!result || !reviewRequestsCode(issue, result) || !actionsDevelopmentAllowed(store, repositoryId, number, issue, result)) return null;
  return { id: 'development', work: 'development.issue', title: `开发 Issue #${number}`, default: true,
    spec: { type: 'object', kind: 'development.issue', number, head: null, input: { review: result, object_hash: result.object_hash }, delivery, source_task: review!.id } };
}

/** Writes the Manager event of a webhook delivery. Closing and drafting still cancel work at once, without the Manager. */
export function queueWebhook(store: Store, repositoryId: string, event: string, payload: Json, delivery: string, currentPullRequest?: Json): number {
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  const object = (event === 'issues' ? payload.issue : payload.pull_request) as Json | undefined;
  const number = Number(object?.number || payload.number), action = payload.action;
  if (object && Number.isSafeInteger(number) && number>0 && ['opened','reopened','closed'].includes(String(action))) reviewObjectState(store, repositoryId, event === 'issues' ? 'review.issue' : 'review.pr', number, action === 'closed');
  if (object && (action === 'closed' || action === 'converted_to_draft')) {
    store.run("UPDATE tasks SET status='cancelled',error_code='object_closed_or_draft',retry_cycle_started_at=NULL,retry_error_code=NULL,retry_count=0 WHERE repository_id=? AND object_number=? AND kind LIKE ? AND status NOT IN ('succeeded','pr_opened','completed')",
      repositoryId, number, event === 'issues' ? '%.issue' : '%.pr');
    // Events of the object that the Manager has not decided yet would only start work on a closed object.
    store.run("UPDATE dispatch_events SET state='decided',decision='ignore',reason=?,lease=NULL,lease_until=NULL,decided_at=? WHERE repository_id=? AND object_type=? AND object_number=? AND state IN ('pending','failed')",
      '对象已关闭或转为草稿，事件不再分派。', new Date().toISOString(), repositoryId, event === 'issues' ? 'issue' : 'pr', number);
  }
  if (!policy?.enabled) return 0;
  if (event === 'issues' && !policy.actions_failures_enabled && store.get('SELECT 1 FROM actions_failure_issues WHERE repository_id=? AND number=?', repositoryId, number)) return 0;
  const input = webhookEvent(store, repositoryId, event, payload, delivery, currentPullRequest, eventFilters(store, repositoryId, policy));
  return input ? recordEvent(store, input) : 0;
}
/**
 * A pull request review found the head moved before it ran (and no comment or update asked for it): the new head is a
 * push the Manager hears about, under the same key as the webhook of that push, so the two are one event.
 */
export function reviewNewHead(store: Store, repositoryId: string, pr: any) {
  const head = sha(pr?.head?.sha), number = Number(pr?.number);
  if (!head || !openObject(pr)) return 0;
  return recordEvent(store, { repositoryId, key: `${repositoryId}:pull_request.synchronize:${number}:${head}`, type: 'pull_request.synchronize', source: 'review',
    summary: `PR 推送新提交：${clip(pr.title, 120)} #${number}`, facts: { object: objectFacts(pr), note: 'A queued review found this new head before it ran.' }, object: { type: 'pr', number },
    options: [{ id: 'review', work: 'review.pr', title: `检视 PR #${number}（${head.slice(0, 7)}）`, default: true,
      spec: { type: 'object', kind: 'review.pr', number, head, input: { pull_request: pr, number }, delivery: null } }] });
}
