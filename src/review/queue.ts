import { captureTaskConfiguration } from '../tasks/configuration.js';
import { type Store } from '../storage/database.js';
import { randomId, type Json } from '../core/security.js';
import { sha as digest } from '../agent/common.js';
import { reviewObjectState } from './sessions.js';
import { developmentLabel } from '../rules/service.js';
import { actionsDevelopmentAllowed } from '../actions/safety.js';
import { findActiveObjectDevelopment, recordEvent, recordFiltered, type CreateOption, type EventInput } from '../dispatch/store.js';
import { eventFilters, labelDispatched, type EventFilters } from '../dispatch/settings.js';
import { botPrWakeEvents, syncBotPullRequestState, type BotWakePreflight } from './bot-pr-wake.js';

export const sameLabel = (name: unknown, label: string) => String(name ?? '').toLowerCase() === label.toLowerCase();
// A person's go-ahead for development: the development label is on the Issue. Whether the Issue should be developed
// (what the review found, who is assigned) is the Manager's judgement, not a control-plane condition.
export function developmentReady(issue: any, label: string) {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  return labels.some((l: any) => sameLabel(typeof l === 'string' ? l : l?.name, label));
}
/** The logins assigned to an Issue, for the Manager's facts. */
export const assigneesOf = (issue: any) => [...(Array.isArray(issue?.assignees) ? issue.assignees : []), ...(issue?.assignee && !issue.assignees?.length ? [issue.assignee] : [])]
  .map((a: any) => String(a?.login || '')).filter(Boolean);
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
// An employee's publication must not re-enter as a fresh high-authority Manager
// event. The marker is committed before sending, including uncertain responses.
function rolePublicationEcho(store: Store, repository: string, body: unknown): boolean {
  for (const match of String(body ?? '').matchAll(/<!-- dept-bot:([a-f0-9]{48}) -->/g)) {
    if (store.get(`SELECT 1 FROM github_effects e JOIN tasks t ON t.id=e.task_id JOIN task_origins o ON o.task_id=t.id
      WHERE e.id=? AND t.repository_id=? AND o.source_kind='role' AND e.kind IN ('issue','pull_request')`, match[1]!, repository)) return true;
  }
  // github_write (#381): an Issue or PR a role task or the Manager itself opened is not a new event for the Manager either.
  for (const match of String(body ?? '').matchAll(/<!-- dept-bot-write:([a-f0-9]{24}) -->/g)) {
    if (store.get(`SELECT 1 FROM github_writes w LEFT JOIN task_origins o ON w.scope='task:'||o.task_id
      WHERE w.marker=? AND w.repository_id=? AND (o.source_kind='role' OR w.scope LIKE 'dispatch:%')`, match[1]!, repository)) return true;
  }
  return false;
}
const botWrote = (payload: any, body: unknown) => payload?.sender?.type === 'Bot' || botMarker.test(String(body ?? ''));
/**
 * A pull request this bot opened (#1104): its ownership record. An opening can arrive before the record is written; only then
 * the publication marker in its description counts, and only when it matches that publication: the effect that opened a pull
 * request from this branch of this repository, written by a development of this repository, and the account this
 * repository's GitHub account acts as (github_actors, written when the client identified itself before publishing) as the
 * author. Anyone can copy a marker into a description, but not the bot's branch and account. Null otherwise.
 */
function botPullRequest(store: Store, repositoryId: string, pr: any, opening = false): { author_id: string; source_task_id: string | null } | null {
  const owned = store.get('SELECT author_id,source_task_id FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, Number(pr?.number));
  if (owned) return String(owned.author_id) === String(pr?.user?.id ?? '') ? { author_id: String(owned.author_id), source_task_id: owned.source_task_id ?? null } : null;
  const actor = opening ? store.get('SELECT a.actor_id FROM repositories r JOIN github_actors a ON a.account_id=r.account_id WHERE r.id=?', repositoryId)?.actor_id : null;
  if (!actor || String(pr?.user?.id ?? '') !== String(actor) || String(pr?.head?.repo?.id ?? '') !== String(repositoryId) || typeof pr?.head?.ref !== 'string') return null;
  for (const match of String(pr?.body ?? '').matchAll(/<!-- dept-bot:([a-f0-9]{48}) -->/g)) {
    const effect = store.get(`SELECT e.task_id,e.request FROM github_effects e JOIN tasks t ON t.id=e.task_id WHERE e.id=? AND t.repository_id=? AND e.kind='pull_request'
      AND (t.kind LIKE 'development.%' OR t.kind='task.request')`, match[1]!, repositoryId);
    let request: any = null; try { request = JSON.parse(String(effect?.request ?? 'null')); } catch { request = null; }
    if (effect && request?.head === pr.head.ref) return { author_id: String(pr.user.id ?? ''), source_task_id: String(effect.task_id) };
  }
  return null;
}
// How often the bot's pull request was revised for requests so far, and how often for this author's (#1104): with no limit of
// its own, the control plane gives the Manager the facts to tell a useful revision from two bots answering each other.
export function revisionFacts(store: Store, repositoryId: string, number: number, author: unknown) {
  const count = (extra: string, ...args: string[]) => Number(store.get(`SELECT count(DISTINCT task_id) n FROM bot_pr_requests WHERE repository_id=? AND number=? AND state='done'${extra}`,
    repositoryId, number, ...args)?.n || 0);
  return { for_requests: count(''), for_this_author: author ? count(' AND author_id=?', String(author)) : 0 };
}
// A person's or another review bot's comment, review or inline comment on a pull request this bot opened, quoted as a request
// a revision carries out (#1104). The webhook already limited who counts (members, the author, other review bots).
function revisionRequest(payload: any, trigger: any) {
  const source = trigger?.source;
  if (!source || !/^[1-9]\d*$/.test(String(source.id))) return null;
  const body = source.type === 'review' ? payload.review?.body : payload.comment?.body;
  return { type: String(source.type), id: String(source.id), author: String(trigger.actor || ''), author_id: String(trigger.actor_id || ''),
    author_type: trigger.actor_type === 'Bot' ? 'Bot' : 'User', url: String(trigger.url || ''), body: clip(body, 4000) };
}
const clip = (value: unknown, limit = 4000) => { const text = String(value ?? ''); return text.length > limit ? text.slice(0, limit) + '…' : text; };
// Why a webhook delivery that a person caused reaches no Manager (#815): kept on a filtered event so the console can say it.
type Stopped = { stopped: { code: string; reason: string } };
const stopped = (code: string, reason: string): Stopped => ({ stopped: { code, reason } });
const isStopped = (value: unknown): value is Stopped => !!value && typeof value === 'object' && 'stopped' in value;
const botContent = () => stopped('bot_own_content', '这是 bot 或其他 App 写的内容。');
const filterOff = (what: string) => stopped('event_filter_off', `项目没有把「${what}」交给 Manager（监听与触发）。`);
// A closed object or a draft pull request; null for an object that is open, or whose state is unknown.
const closedOrDraft = (object: any, pr: boolean) => object?.state === 'closed' ? stopped('object_closed', `${pr ? 'PR' : 'Issue'} 已关闭。`)
  : object?.draft === true ? stopped('object_draft', 'PR 是草稿。') : null;
type UpdateTrigger = { kind: 'review.issue' | 'review.pr', number: number, pullRequest?: Json, trigger: Json };
// A person updated an open Issue or PR after it was opened: edited its title or body, commented, submitted a review or replied
// to review comments. Returns the review kind and what triggered it, or null. Opening, new commits and mentions have their
// own events; drafts, closed objects and the bot's own writing never trigger. `otherBot` is set for another review bot's
// comment or review on a pull request this bot opened (see otherBotOnBotPullRequest): it counts like a member's.
export function updateTrigger(event: string, payload: Json, otherBot = false): UpdateTrigger | null {
  const checked = updateCheck(event, payload, otherBot);
  return checked && !isStopped(checked) ? checked : null;
}
// updateTrigger, with the condition that stopped an update a person made; null when the delivery is no update at all (an
// approval without a body, an edit that changed neither title nor body).
function updateCheck(event: string, payload: Json, otherBot: boolean): UpdateTrigger | Stopped | null {
  const p = payload as any, action = p.action, actor = String(p.sender?.login || ''), edited = (changes: any) => ['title', 'body'].filter(key => changes && key in changes);
  // Anyone can comment on a public repository: a comment or review counts only from the object's author or from someone
  // with a role in the repository, so strangers cannot spend the model budget. Editing a title or body on GitHub already
  // takes one of those.
  const trusted = (association: unknown, author: any) => otherBot || ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(String(association))
    || author?.id != null && String(author.id) === String(p.sender?.id ?? '');
  const outsider = () => stopped('outsider_comment', '评论人在仓库里没有角色，也不是作者；外人的评论只有提到 bot 时才交给 Manager。');
  const byBot = (payload: any, body: unknown) => otherBot ? botMarker.test(String(body ?? '')) : botWrote(payload, body);
  const by = otherBot ? { actor_type: 'Bot' } : {};
  // Which comment, review or inline comment this is, so a review of the bot's own pull request can name it as a request.
  const source = (type: string, id: unknown) => /^[1-9]\d*$/.test(String(id ?? '')) ? { source: { type, id: Number(id) }, actor_id: String(p.sender?.id ?? '') } : {};
  const open = (object: any) => object?.state === 'open' && object.draft !== true && Number.isSafeInteger(object.number) && object.number > 0;
  if (event === 'issues' && action === 'edited' && p.issue && !p.issue.pull_request && edited(p.changes).length) {
    if (!open(p.issue)) return closedOrDraft(p.issue, false);
    if (byBot(p, null)) return botContent();
    return { kind: 'review.issue', number: p.issue.number, trigger: { reason: 'issue_edited', actor, changed: edited(p.changes),
      previous: Object.fromEntries(edited(p.changes).map(key => [key, clip(p.changes[key]?.from)])) } };
  }
  if (event === 'issue_comment' && action === 'created' && p.issue) {
    if (p.issue.state !== 'open') return closedOrDraft(p.issue, !!p.issue.pull_request);
    if (!Number.isSafeInteger(p.issue.number) || p.issue.number < 1 || typeof p.comment?.body !== 'string') return null;
    if (byBot(p, p.comment.body)) return botContent();
    if (!trusted(p.comment.author_association, p.issue.user)) return outsider();
    return { kind: p.issue.pull_request ? 'review.pr' : 'review.issue', number: p.issue.number, trigger: { reason: 'comment', actor, ...by, url: String(p.comment.html_url || ''), ...source('comment', p.comment.id) } };
  }
  const pr = p.pull_request;
  if (event === 'pull_request' && action === 'edited' && pr && edited(p.changes).length) {
    if (!open(pr)) return closedOrDraft(pr, true);
    // A bot account editing its own PR description is the bot, even though GitHub reports a user.
    if (byBot(p, null) || String(pr.user?.id ?? '') === String(p.sender?.id ?? '') && botMarker.test(String(pr.body ?? ''))) return botContent();
    return { kind: 'review.pr', number: pr.number, pullRequest: pr, trigger: { reason: 'pull_request_edited', actor, changed: edited(p.changes),
      previous: Object.fromEntries(edited(p.changes).map(key => [key, clip(p.changes[key]?.from)])) } };
  }
  if (event === 'pull_request_review_comment' && action === 'created' && pr && typeof p.comment?.body === 'string') {
    if (!open(pr)) return closedOrDraft(pr, true);
    if (byBot(p, p.comment.body)) return botContent();
    if (!trusted(p.comment.author_association, pr.user)) return outsider();
    return { kind: 'review.pr', number: pr.number, pullRequest: pr, trigger: { reason: p.comment.in_reply_to_id ? 'review_reply' : 'review_comment', actor, ...by,
      url: String(p.comment.html_url || ''), path: String(p.comment.path || ''), line: p.comment.line ?? null, ...source('review_comment', p.comment.id) } };
  }
  // Every reply to a review thread also arrives as a review without a body; that one is the comment event above.
  if (event === 'pull_request_review' && action === 'submitted' && pr && (String(p.review?.body || '').trim() || p.review?.state === 'changes_requested')) {
    if (!open(pr)) return closedOrDraft(pr, true);
    if (byBot(p, p.review?.body)) return botContent();
    if (!trusted(p.review?.author_association, pr.user)) return outsider();
    return { kind: 'review.pr', number: pr.number, pullRequest: pr, trigger: { reason: 'review_submitted', actor, ...by, state: String(p.review.state || ''),
      body: clip(p.review.body), url: String(p.review.html_url || ''), ...source('review', p.review.id) } };
  }
  return null;
}
// Another review bot's conversation comment, review or inline comment on a pull request this bot opened. The pull request's
// author is this bot's account, so a different bot account is someone else; the bot's own writing never counts. The Manager
// judges it like a member's request, with no limit of the control plane's own (#1104): the event tells it how often the pull
// request was already revised, and by whose request.
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

const activeDevelopment = (store: Store, repositoryId: string, kind: string, number: number) =>
  findActiveObjectDevelopment(store, repositoryId, kind.endsWith('.pr') ? 'pr' : 'issue', number);
const enqueueKey = (repositoryId: string, kind: string, number: number, head: string | null, input: Json, commentId: string | null, updateId: string | null) => {
  // A revision that people or other bots asked for is keyed by those requests, so a revision of the same head that the bot's
  // own review started earlier does not stand in for it.
  const requests = kind === 'development.pr' && Array.isArray((input as any).revision?.requests) ? (input as any).revision.requests.map((r: any) => `${r.type}:${r.id}`).join(',') : '';
  return `${repositoryId}:${kind}:${number}:${commentId !== null ? `comment:${commentId}` : updateId !== null ? `update:${updateId}` : kind.endsWith('.pr') ? head + (requests ? `:requests:${requests}` : '') : 'opened'}`;
};
/**
 * Why enqueue would not create this task now (#815), null when it would: the reason a refused create_task returns to the
 * Manager. The same conditions decide enqueue itself, so the refusal never disagrees with what happens.
 */
export function enqueueRefusal(store: Store, repositoryId: string, kind: string, number: number, head: string | null, input: Json,
  commentId: string | null = null, updateId: string | null = null): { code: string; reason: string; task_id?: string } | null {
  if (!Number.isSafeInteger(number) || number < 1 || kind.endsWith('.pr') && !/^[a-f0-9]{40}$/.test(head || '')) return { code: 'invalid_object', reason: '事件对象的编号或提交无效。' };
  if (kind === 'development.issue' && !actionsDevelopmentAllowed(store, repositoryId, number))
    return { code: 'actions_development_not_allowed', reason: '这是 Actions 失败提报的 Issue，项目已关闭 Actions 失败处理或能力上限不到「可开发并开 PR」。' };
  if (commentId !== null && (!['review.issue','review.pr'].includes(kind) || !/^[1-9]\d*$/.test(commentId))) return { code: 'invalid_object', reason: '评论编号无效。' };
  // A development is keyed by the labeling that asked for it, so a person can ask again after an earlier one ended.
  if (updateId !== null && (!['review.issue','review.pr','development.issue'].includes(kind) || !/^[\w-]{1,200}$/.test(updateId))) return { code: 'invalid_object', reason: '更新编号无效。' };
  const active = kind === 'development.issue' || kind === 'development.pr' ? activeDevelopment(store, repositoryId, kind, number) : null;
  // One development of an Issue at a time; one revision of a bot pull request at a time: both would push to the same branch.
  // The Manager hears this and can continue the running one with the event instead (#1104).
  if (active) return { code: kind === 'development.issue' ? 'development_active' : 'revision_active', task_id: String(active.id),
    reason: `${kind === 'development.issue' ? '这个 Issue 已有' : '这个 PR 已有'}未结束的${kind === 'development.issue' ? '开发' : '修订'}任务（${active.status}），可以把这次的事件续接给它。` };
  const existing = store.get('SELECT id FROM tasks WHERE unique_key=?', enqueueKey(repositoryId, kind, number, head, input, commentId, updateId));
  if (existing) return { code: 'task_already_created', task_id: String(existing.id), reason: '这个事件要建的任务已经建过了。' };
  return null;
}
// `commentId` keys a mention review to its comment; `updateId` keys an update review to its delivery record.
export function enqueue(store: Store, repositoryId: string, kind: string, number: number, head: string | null, input: Json,
  delivery: string | null = null, sourceTask: string | null = null, commentId: string | null = null, updateId: string | null = null): string | null {
  if (enqueueRefusal(store, repositoryId, kind, number, head, input, commentId, updateId)) return null;
  const key = enqueueKey(repositoryId, kind, number, head, input, commentId, updateId);
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
 * A delivery a filter stops returns that filter's reason (#815), decided here so it always names what stopped the event;
 * null for deliveries that are no event at all.
 */
function webhookEvent(store: Store, repositoryId: string, event: string, payload: Json, delivery: string, currentPullRequest: Json | undefined, filters: EventFilters): EventInput | Stopped | null {
  const p = payload as any, action = String(p.action || ''), actor = String(p.sender?.login || '');
  const base = (type: string, key: string, object: 'issue' | 'pr', number: number, summary: string, facts: Json): Omit<EventInput, 'options'> =>
    ({ repositoryId, key: `${repositoryId}:${key}`, type, source: 'github', summary, facts: { event, action, actor, ...facts }, object: { type: object, number }, delivery });
  // Any update of an Issue (an edit, a comment, a mention, a label) can continue its running development as well as its review
  // (#815, #1104): the Manager picks which, and the development reads the update. A development takes the current text instead
  // of stopping.
  const updateKinds = (object: 'issue' | 'pr', kind: string, _trigger: Json) => object === 'issue' ? ['development.issue', kind] : [kind];
  // An update or mention: a review that answers it, joining a running review of the same object instead.
  const update = (type: string, object: 'issue' | 'pr', number: number, target: any, trigger: Json, merge: string, review: { commentId?: string; updateId?: string }, extra: Json = {}): EventInput => {
    const kind = object === 'pr' ? 'review.pr' : 'review.issue', head = object === 'pr' ? sha(target?.head?.sha) : null;
    const input = { ...payload, trigger, ...(object === 'pr' ? { pull_request: target } : {}) };
    const discriminator = review.commentId ? `comment:${review.commentId}` : `update:${delivery}`;
    // An Issue's mention, comment or edit may also start its development, on a basis the Manager states (#815); the Manager
    // judges it from who is assigned and the latest review, as on a label event (whose own facts replace these).
    const development = object === 'issue' ? developmentOffer(store, repositoryId, target, number, delivery) : null;
    // On a pull request this bot opened, the comment itself may be what a revision carries out (#1104): the Manager can revise
    // the pull request directly, or continue the revision already working on it. No review stands in between.
    // A mention has no role check of its own: a stranger's still reaches the Manager, but only a member's, an owner's, a
    // collaborator's or another review bot's comment is offered as a revision.
    const association = String(p.comment?.author_association ?? p.review?.author_association ?? '');
    const asks = (trigger as any)?.actor_type === 'Bot' || ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association);
    const own = object === 'pr' ? botPullRequest(store, repositoryId, target) : null, request = own && asks ? revisionRequest(p, trigger) : null;
    const revision: CreateOption | null = request ? { id: 'development', work: 'development.pr', title: `修订 bot PR #${number}`, default: false,
      spec: { type: 'object', kind: 'development.pr', number, head, input: { revision: { source: 'request', requests: [request] } }, delivery, requests: [request] } } : null;
    return { ...base(type, `${type}:${number}:${discriminator}`, object, number, `${type === `${object === 'pr' ? 'pull_request' : 'issue'}.mention` ? '提到 bot' : '更新'}：${clip(target?.title, 120)} #${number}`,
      { object: objectFacts(target), trigger, ...(development ? { development: developmentFacts(development) } : {}), ...(own ? { bot_pull_request: true, revisions: revisionFacts(store, repositoryId, number, (trigger as any)?.actor_id) } : {}), ...extra }),
      options: [{ id: 'review', work: kind, title: `${object === 'pr' ? '检视 PR' : '检视 Issue'} #${number}`, default: true,
        spec: { type: 'object', kind, number, head, input, delivery, comment_id: review.commentId ?? null, update_id: review.commentId ? null : delivery } },
        replyOption(object, number, head, input, discriminator, delivery), ...(development ? [development.option] : []), ...(revision ? [revision] : [])],
      merge: { key: merge, data: { ...trigger, object: p.issue || p.pull_request, comment: p.comment, review: p.review, ...(request ? { revision_request: request } : {}) }, trigger, head,
        kinds: own ? ['development.pr', kind] : updateKinds(object, kind, trigger) } };
  };
  // An opening counts unless the object is already closed (or a draft), as before; later events need an open object.
  const notClosed = (object: any) => object && object.state !== 'closed' && object.draft !== true && Number.isSafeInteger(Number(object.number)) && Number(object.number) > 0;
  // A label counts when a person adds it to an open object.
  const labelUsable = (object: any) => openObject(object) && typeof p.label?.name === 'string';
  const byApp = () => stopped('label_by_app', '标签不是人加的。');
  if (event === 'issues' && p.issue && !p.issue.pull_request) {
    const issue = p.issue, number = Number(issue.number);
    if (!notClosed(issue)) return closedOrDraft(issue, false);
    if (action === 'opened') {
      if (!filters['issue.opened']) return filterOff('Issue 打开');
      if (rolePublicationEcho(store, repositoryId, issue.body)) return botContent();
      const development = developmentOffer(store, repositoryId, issue, number, delivery);
      return { ...base('issue.opened', `issue.opened:${number}`, 'issue', number, `Issue 打开：${clip(issue.title, 120)} #${number}`,
        { object: objectFacts(issue), ...(development ? { development: developmentFacts(development) } : {}) }),
        options: [{ id: 'review', work: 'review.issue', title: `检视 Issue #${number}`, default: true, spec: { type: 'object', kind: 'review.issue', number, head: null, input: payload, delivery } },
          replyOption('issue', number, null, payload, 'opened', delivery), ...(development ? [development.option] : [])] };
    }
    if (action === 'labeled') {
      if (!labelUsable(issue)) return null;
      if (p.sender?.type !== 'User') return byApp();
      const label = String(p.label.name), options: CreateOption[] = [];
      // A person's development label always reaches the Manager (#815): when the project does not develop now, development is
      // listed as work it does not allow, with the reason, so the Manager can answer the person instead of staying silent.
      const development = filters['issue.development_label'] ? labeledDevelopment(store, repositoryId, p, number, delivery) : null;
      if (development) options.push(development.option);
      const dispatched = labelDispatched(filters, 'issue', label);
      // The development label also offers a review that answers it, so that when the Manager does not start development
      // the bot replies on the Issue with what is missing instead of staying silent.
      if (dispatched || development) {
        const trigger = { event, action, reason: 'labeled', actor, label };
        const relabel = update('issue.labeled', 'issue', number, issue, trigger, 'delivery:' + delivery, { updateId: delivery },
          { label, ...(development ? { development: development.facts } : {}) });
        // A development that waits because the label had been removed is continued with this labeling, which resumes it (#815).
        if (development && relabel.merge) relabel.merge.kinds = ['development.issue', ...relabel.merge.kinds];
        // Before #207 only a dispatched label started a review; the rule decider used in tests keeps that.
        const answers = relabel.options.filter(option => !(development && option.id === 'development')).map(option => option.id === 'review' && !dispatched ? { ...option, default: false } : option);
        return { ...relabel, options: [...options, ...answers] };
      }
      let developmentLabelName: string | null = null; try { developmentLabelName = developmentLabel(store, repositoryId); } catch { /* no label configured */ }
      if (developmentLabelName === null || !sameLabel(label, developmentLabelName)) return stopped('label_not_dispatched', `标签「${label}」不在交给 Manager 的标签里（监听与触发）。`);
      return filters['issue.development_label'] ? null : filterOff('开发标签');
    }
  }
  if (event === 'pull_request' && p.pull_request) {
    const pr = p.pull_request, number = Number(pr.number), head = sha(pr.head?.sha);
    // Every event below needs an open pull request with a head; anything else on a closed or draft one stops the same way.
    if (!notClosed(pr) || !head) return closedOrDraft(pr, true);
    const opened = ['opened', 'ready_for_review'].includes(action), pushed = action === 'synchronize';
    if (opened || pushed) {
      const type = opened ? 'pull_request.opened' : 'pull_request.synchronize';
      if (!filters[type]) return filterOff(opened ? 'PR 打开' : 'PR 推送新提交');
      if (opened && rolePublicationEcho(store, repositoryId, pr.body)) return botContent();
      // The bot's own pull request was reviewed, tested and accepted inside its development (#1104): its opening and the
      // bot's own pushes are not reviewed again. A push by someone else to the bot's branch still is.
      const own = botPullRequest(store, repositoryId, pr, opened);
      if (own && (opened || String(p.sender?.id ?? '') === own.author_id))
        return stopped('bot_own_pull_request', opened ? 'bot 自己开的 PR：开发时已经过独立检视、测试和 QA，不再单独检视。' : 'bot 自己推送的提交：修订时已经过独立检视、测试和 QA，不再单独检视。');
      // A push joins the review already working on the pull request, which moves to the new head (#770). A new review of
      // the head is offered only when no review can take it, so two reviews never cover the same push.
      const trigger = { event, action, reason: 'pushed', actor, before: sha(p.before), after: head };
      return { ...base(type, `${type}:${number}:${head}`, 'pr', number, `${opened ? 'PR 打开' : 'PR 推送新提交'}：${clip(pr.title, 120)} #${number}`, { object: objectFacts(pr), ...(pushed ? { push: trigger } : {}) }),
        options: [{ id: 'review', work: 'review.pr', title: `检视 PR #${number}（${head.slice(0, 7)}）`, default: true, ...(pushed ? { unless_continued: true } : {}),
          spec: { type: 'object', kind: 'review.pr', number, head, input: payload, delivery } },
          replyOption('pr', number, head, { ...payload, pull_request: pr }, head, delivery)],
        ...(pushed ? { merge: { key: `${repositoryId}:review.pr:${number}:head:${head}`, data: trigger, trigger, head, kinds: ['review.pr'] } } : {}) };
    }
    if (action === 'labeled') {
      if (!labelUsable(pr)) return null;
      if (p.sender?.type !== 'User') return byApp();
      if (!labelDispatched(filters, 'pull_request', String(p.label.name))) return stopped('label_not_dispatched', `标签「${p.label.name}」不在交给 Manager 的标签里（监听与触发）。`);
      return update('pull_request.labeled', 'pr', number, pr, { event, action, reason: 'labeled', actor, label: p.label.name }, 'delivery:' + delivery, { updateId: delivery }, { label: p.label.name });
    }
  }
  // A PR conversation comment carries only the PR number; the webhook read the current PR before archiving.
  const commented = p.issue?.pull_request ? currentPullRequest as any : null;
  const pullRequestOk = (pr: any, number: number) => openObject(pr) && pr.number === number && !!sha(pr.head?.sha);
  // A mention the project does not take, or one on a closed or draft pull request, may still count as an update; when it
  // does not, the mention's reason is the one kept.
  let mention: Stopped | null = null;
  if (event === 'issue_comment' && mentionsBot(event, payload)) {
    const object = p.issue.pull_request ? 'pr' : 'issue', number = Number(p.issue.number), type = object === 'pr' ? 'pull_request.mention' : 'issue.mention';
    if (!filters[type]) mention = filterOff(object === 'pr' ? 'PR 里提到 bot' : 'Issue 里提到 bot');
    else if (object === 'issue' || pullRequestOk(commented, number)) {
      const trigger = { event, action, reason: 'mention', actor, url: String(p.comment.html_url || ''), source: { type: 'comment', id: Number(p.comment.id) }, actor_id: String(p.sender?.id ?? '') };
      const kind = object === 'pr' ? 'review.pr' : 'review.issue';
      return update(type, object, number, object === 'pr' ? commented : p.issue, trigger, `${repositoryId}:${kind}:${number}:comment:${p.comment.id}`, { commentId: String(p.comment.id) }, { comment: commentFacts(p.comment) });
    } else mention = closedOrDraft(commented, true);
  }
  const changed = updateCheck(event, payload, otherBotOnBotPullRequest(store, repositoryId, event, payload));
  if (!changed || isStopped(changed)) return mention ?? changed;
  const object = changed.kind === 'review.pr' ? 'pr' : 'issue', type = object === 'pr' ? 'pull_request.updated' : 'issue.updated';
  // A PR conversation comment is checked against the pull request the webhook read: a draft or closed one stops it whatever
  // the switches say. That read happens only when a switch would let the comment through.
  const target = object === 'pr' ? (changed.pullRequest || commented) as any : p.issue, usable = object === 'issue' || pullRequestOk(target, changed.number);
  if (!usable && closedOrDraft(target, true)) return closedOrDraft(target, true);
  const edit = ['issue_edited', 'pull_request_edited'].includes(String((changed.trigger as any).reason));
  if (!filters[type]) return mention ?? filterOff(object === 'pr' ? (edit ? 'PR 的编辑' : 'PR 的评论和检视') : edit ? 'Issue 的编辑' : 'Issue 的评论和编辑');
  if (!usable) return mention;
  return update(type, object, changed.number, target, { event, action, ...changed.trigger as any }, 'delivery:' + delivery, { updateId: delivery },
    { ...(p.comment ? { comment: commentFacts(p.comment) } : {}), ...(p.review ? { review: { state: p.review.state ?? null, body: clip(p.review.body, 2000), author: p.review.user?.login ?? null } } : {}) });
}
// A person adding the development label offers development to the Manager, which judges from these facts whether the
// Issue can be developed now. Only the go-ahead itself is a control-plane condition: an open Issue, the label added by a
// person and still on it, and the clearance of an Issue filed from an Actions failure. Each labeling is its own go-ahead,
// keyed by its delivery; an active development of the same Issue still refuses a second one.
function labeledDevelopment(store: Store, repositoryId: string, payload: any, number: number, delivery: string): { option: CreateOption; facts: Json } | null {
  const issue = payload.issue;
  if (issue?.state !== 'open' || payload.sender?.type !== 'User') return null;
  let label: string; try { label = developmentLabel(store, repositoryId); } catch { return null; }
  if (!sameLabel(payload.label?.name, label) || !developmentReady(issue, label)) return null;
  const offer = developmentOffer(store, repositoryId, issue, number, delivery);
  if (!offer) return null;
  const facts = { label, labeled_by: String(payload.sender?.login || ''), assignees: offer.assignees, review: offer.review };
  // What the control plane did before #207 (for the rule decider in tests): the first development of an unassigned, reviewed Issue.
  return { facts, option: { ...offer.option, default: !!offer.review && !offer.assignees.length
    && !store.get("SELECT 1 FROM tasks t WHERE t.repository_id=? AND t.object_number=? AND t.unique_key IS NOT NULL AND (t.kind='development.issue' OR (t.kind='task.request' AND EXISTS (SELECT 1 FROM task_write_grants g WHERE g.task_id=t.id AND json_valid(g.writes) AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value='pull_request')))) LIMIT 1", repositoryId, number) } };
}
/**
 * Development of an open Issue, offered on its events (#815). Whether to start it is the Manager's decision, made on a basis
 * the control plane checks at create_task (a person's development label, a maintainer's request, a rule of the Manager
 * prompt); nothing in the review or the Issue's text is a condition. An Issue filed from an Actions failure still needs
 * the review that cleared it as a product defect, and nobody assigned.
 */
function developmentOffer(store: Store, repositoryId: string, issue: any, number: number, delivery: string) {
  if (issue?.state !== 'open' || issue.pull_request) return null;
  const review = store.get("SELECT id,result FROM tasks WHERE repository_id=? AND object_number=? AND status='succeeded' AND (kind='review.issue' OR (kind='task.request' AND json_extract(input,'$.delivery')='review')) ORDER BY created_at DESC LIMIT 1", repositoryId, number);
  const result = review?.result ? JSON.parse(review.result) : null, assignees = assigneesOf(issue);
  if (!actionsDevelopmentAllowed(store, repositoryId, number)) return null;
  const option: CreateOption = { id: 'development', work: 'development.issue', title: `开发 Issue #${number}`,
    spec: { type: 'object', kind: 'development.issue', number, head: null, delivery, source_task: review?.id ?? null, update_id: delivery,
      input: { review: result, object_hash: digest(JSON.stringify([issue.title, issue.body])) } } };
  return { option, assignees, review: result ? { task_id: String(review!.id), summary: clip(result.summary, 1500), ...(result.recommendation ? { recommendation: clip(result.recommendation, 1500) } : {}), ...(result.conclusion ? { conclusion: result.conclusion } : {}) } : null };
}

// What the Manager judges a development by when an event offers it: who is assigned and the latest published review.
const developmentFacts = (offer: { assignees: string[]; review: Json | null }) => ({ assignees: offer.assignees, review: offer.review });

/** Writes the Manager event of a webhook delivery. Closing and drafting still cancel work at once, without the Manager. */
export function queueWebhook(
  store: Store,
  repositoryId: string,
  event: string,
  payload: Json,
  delivery: string,
  currentPullRequest?: Json,
  botWakePreflight?: BotWakePreflight,
): number {
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  const object = (event === 'issues' ? payload.issue : payload.pull_request) as Json | undefined;
  const number = Number(object?.number || payload.number), action = payload.action;
  if (event === 'pull_request' && payload.pull_request) syncBotPullRequestState(store, repositoryId, payload.pull_request);
  if (currentPullRequest) syncBotPullRequestState(store, repositoryId, currentPullRequest);
  if (object && Number.isSafeInteger(number) && number>0 && ['opened','reopened','closed'].includes(String(action))) reviewObjectState(store, repositoryId, event === 'issues' ? 'review.issue' : 'review.pr', number, action === 'closed');
  if (object && (action === 'closed' || action === 'converted_to_draft')) {
    const objType = event === 'issues' ? 'issue' : 'pr';
    store.run("UPDATE tasks SET status='cancelled',error_code='object_closed_or_draft',retry_cycle_started_at=NULL,retry_error_code=NULL,retry_count=0 WHERE repository_id=? AND object_number=? AND (kind LIKE ? OR (kind='task.request' AND json_extract(input,'$.target.type')=?)) AND status NOT IN ('succeeded','pr_opened','completed')",
      repositoryId, number, event === 'issues' ? '%.issue' : '%.pr', objType);
    // Events of the object that the Manager has not decided yet would only start work on a closed object.
    store.run("UPDATE dispatch_events SET state='decided',decision='ignore',reason=?,lease=NULL,lease_until=NULL,decided_at=? WHERE repository_id=? AND object_type=? AND object_number=? AND state IN ('pending','failed')",
      '对象已关闭或转为草稿，事件不再分派。', new Date().toISOString(), repositoryId, objType, number);
  }
  // An event a person caused that the filters stop is kept with the reason (#815), so the console can say why nothing happened.
  const filtered = (code: string, reason: string) => { const record = filteredEvent(repositoryId, event, payload, delivery); if (record) recordFiltered(store, { ...record, code, reason }); return 0; };
  if (!policy?.enabled) return filtered('project_disabled', '项目已停用，事件不交给 Manager。');
  if (event === 'issues' && !policy.actions_failures_enabled && store.get('SELECT 1 FROM actions_failure_issues WHERE repository_id=? AND number=?', repositoryId, number))
    return filtered('actions_failures_disabled', '这是 Actions 失败提报的 Issue，项目关闭了 Actions 失败处理。');
  const wakeInputs = botPrWakeEvents(store, repositoryId, event, payload, delivery, botWakePreflight);
  let wakeCreated = 0;
  for (const w of wakeInputs) wakeCreated += recordEvent(store, w);
  const input = webhookEvent(store, repositoryId, event, payload, delivery, currentPullRequest, eventFilters(store, repositoryId, policy));
  if (isStopped(input)) {
    if (!wakeCreated) filtered(input.stopped.code, input.stopped.reason);
    return wakeCreated;
  }
  return wakeCreated + (input ? recordEvent(store, input) : 0);
}

/** The record of a filtered event: only what a person did on an Issue or pull request (#815). */
function filteredEvent(repositoryId: string, event: string, payload: Json, delivery: string) {
  const p = payload as any, action = String(p.action || ''), object = p.pull_request ?? p.issue;
  const pr = !!p.pull_request || !!p.issue?.pull_request, number = Number(object?.number);
  if (!object || !Number.isSafeInteger(number) || number < 1) return null;
  const types: Record<string, string> = { 'issues:opened': 'issue.opened', 'issues:edited': 'issue.updated', 'issues:labeled': 'issue.labeled',
    'issue_comment:created': mentionsBot(event, payload) ? (pr ? 'pull_request.mention' : 'issue.mention') : pr ? 'pull_request.updated' : 'issue.updated',
    'pull_request:opened': 'pull_request.opened', 'pull_request:ready_for_review': 'pull_request.opened', 'pull_request:synchronize': 'pull_request.synchronize',
    'pull_request:labeled': 'pull_request.labeled', 'pull_request:edited': 'pull_request.updated',
    'pull_request_review:submitted': 'pull_request.updated', 'pull_request_review_comment:created': 'pull_request.updated' };
  const type = types[`${event}:${action}`]; if (!type) return null;
  return { repositoryId, key: `${repositoryId}:filtered:${delivery}`, type, summary: `${clip(object.title, 120)} #${number}（${String(p.sender?.login || '')}）`,
    object: { type: pr ? 'pr' as const : 'issue' as const, number }, delivery, facts: { event, action, actor: String(p.sender?.login || '') } };
}
