import type { Store } from '../storage/database.js';
import { randomId, type Json } from '../core/security.js';
import { mentionsBot, sameLabel, updateTrigger } from '../review/queue.js';
import { customWorkflows, type CustomWorkflow } from './resolve.js';

// One trigger a GitHub event fires. key makes a workflow's task unique: the head for PR openings and pushes, the
// comment for mentions, the delivery for updates and labels.
interface Match { id: string; object: 'issue' | 'pr'; number: number; key: string; label?: string; pullRequest?: any; trigger: Json; comment?: Json }
const open = (object: any) => object?.state === 'open' && object.draft !== true && Number.isSafeInteger(object.number) && object.number > 0;
const sha = (value: unknown) => /^[a-f0-9]{40}$/.test(String(value || '')) ? String(value) : null;

// The triggers of the catalog, matched with the filters the built-in reviews use: drafts, closed objects, the bot's
// own writing and comments from people without a role in the repository never match.
export function matchTriggers(event: string, payload: Json, delivery: string, currentPullRequest?: Json): Match[] {
  const p = payload as any, action = p.action, actor = String(p.sender?.login || ''), matches: Match[] = [];
  if (event === 'issues' && !p.issue?.pull_request && open(p.issue)) {
    if (action === 'opened') matches.push({ id: 'issue.opened', object: 'issue', number: p.issue.number, key: 'opened', trigger: { reason: 'issue.opened', actor } });
    if (action === 'labeled' && p.sender?.type === 'User' && typeof p.label?.name === 'string')
      matches.push({ id: 'issue.labeled', object: 'issue', number: p.issue.number, key: 'labeled:' + delivery, label: p.label.name, trigger: { reason: 'issue.labeled', actor, label: p.label.name } });
  }
  if (event === 'pull_request' && open(p.pull_request) && sha(p.pull_request.head?.sha)) {
    const pr = p.pull_request, head = sha(pr.head.sha)!;
    if (['opened', 'ready_for_review'].includes(action)) matches.push({ id: 'pull_request.opened', object: 'pr', number: pr.number, key: head, pullRequest: pr, trigger: { reason: 'pull_request.' + action, actor } });
    if (action === 'synchronize') matches.push({ id: 'pull_request.synchronize', object: 'pr', number: pr.number, key: head, pullRequest: pr, trigger: { reason: 'pull_request.synchronize', actor } });
    if (action === 'labeled' && p.sender?.type === 'User' && typeof p.label?.name === 'string')
      matches.push({ id: 'pull_request.labeled', object: 'pr', number: pr.number, key: 'labeled:' + delivery, label: p.label.name, pullRequest: pr, trigger: { reason: 'pull_request.labeled', actor, label: p.label.name } });
  }
  // A PR conversation comment carries only the PR number; the webhook read the current PR before archiving.
  const commented = p.issue?.pull_request ? currentPullRequest as any : null;
  if (mentionsBot(event, payload) && (!p.issue.pull_request || open(commented) && commented.number === p.issue.number && sha(commented.head?.sha)))
    matches.push({ id: 'comment.mention', object: p.issue.pull_request ? 'pr' : 'issue', number: p.issue.number, key: 'comment:' + p.comment.id, pullRequest: commented || undefined,
      comment: { id: String(p.comment.id), body: p.comment.body, html_url: p.comment.html_url || '' }, trigger: { reason: 'mention', actor, url: String(p.comment.html_url || '') } });
  const update = updateTrigger(event, payload);
  if (update) {
    const pr = (update.pullRequest || commented) as any;
    if (update.kind === 'review.issue') matches.push({ id: 'issue.updated', object: 'issue', number: update.number, key: 'update:' + delivery, trigger: { event, action, ...update.trigger } });
    else if (open(pr) && pr.number === update.number && sha(pr.head?.sha))
      matches.push({ id: 'pull_request.updated', object: 'pr', number: update.number, key: 'update:' + delivery, pullRequest: pr, trigger: { event, action, ...update.trigger },
        ...(event === 'issue_comment' || event === 'pull_request_review_comment' ? { comment: { id: String(p.comment?.id ?? ''), body: p.comment?.body, html_url: p.comment?.html_url || '' } } : {}) });
  }
  return matches;
}
const fires = (workflow: CustomWorkflow, match: Match) => workflow.triggers.some(trigger => trigger.id === match.id && (!match.label || sameLabel(match.label, trigger.label || '')));

// An issue_comment on a PR needs the PR's current head when a custom workflow would run on it.
export function workflowNeedsPullRequest(store: Store, repositoryId: string, event: string, payload: Json) {
  if (!store.get('SELECT enabled FROM policies WHERE repository_id=?', repositoryId)?.enabled) return false;
  const p = payload as any, workflows = customWorkflows(store, repositoryId).filter(workflow => workflow.enabled);
  const placeholder = { number: p.issue?.number, state: 'open', draft: false, head: { sha: '0'.repeat(40) } };
  return matchTriggers(event, payload, '', placeholder).some(match => match.object === 'pr' && workflows.some(workflow => fires(workflow, match)));
}
// Each enabled custom workflow gets at most one task per delivery: the first of its triggers that the event fires.
export function queueWorkflows(store: Store, repositoryId: string, event: string, payload: Json, delivery: string, currentPullRequest?: Json): number {
  const workflows = customWorkflows(store, repositoryId).filter(workflow => workflow.enabled);
  if (!workflows.length) return 0;
  const matches = matchTriggers(event, payload, delivery, currentPullRequest);
  let created = 0;
  for (const workflow of workflows) {
    const match = matches.find(candidate => fires(workflow, candidate));
    if (match && enqueueWorkflow(store, repositoryId, workflow, match, payload, delivery)) created++;
  }
  return created;
}
function enqueueWorkflow(store: Store, repositoryId: string, workflow: CustomWorkflow, match: Match, payload: Json, delivery: string) {
  const key = `${repositoryId}:${workflow.id}:${match.number}:${match.key}`;
  if (store.get('SELECT 1 FROM tasks WHERE unique_key=?', key)) return null;
  const id = randomId(), now = new Date().toISOString(), kind = match.object === 'pr' ? 'workflow.pr' : 'workflow.issue';
  const input = { ...payload, trigger: match.trigger, ...(match.pullRequest ? { pull_request: match.pullRequest } : {}), ...(match.comment ? { comment: match.comment } : {}) };
  store.run(`INSERT INTO tasks(id,repository_id,kind,workflow_id,status,summary,unique_key,input,object_number,head_sha,source_delivery_id,created_at,updated_at)
    VALUES(?,?,?,?,'queued',?,?,?,?,?,?,?,?)`, id, repositoryId, kind, workflow.id, `${workflow.name} #${match.number}`, key, JSON.stringify(input), match.number,
    match.object === 'pr' ? sha(match.pullRequest?.head?.sha) : null, delivery, now, now);
  store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)', randomId(), id,
    JSON.stringify({ type: 'queued', repository_id: repositoryId, workflow_id: workflow.id, trigger: match.id, detail: `工作流「${workflow.name}」排队中，等待仓库 ${repositoryId} 的虚拟电脑空闲…` }), now);
  return id;
}
