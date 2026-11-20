import type { Store, Row } from '../storage/database.js';
import { GitHub } from './client.js';
import { registeredRedactor, publicText } from '../core/redaction.js';
import { Redactor, TaskError } from '../agent/common.js';
import { digest, randomId } from '../core/security.js';
import { covers, projectCeiling, resourceLevel } from '../projects/ceiling.js';
import { autoMergePolicy, githubMaintainer, isBotPullRequest, mergeBoundary, mergeNeedsRequest, principalMaintainer, type AutoMergePolicy } from './merge-policy.js';
import { mergeQueue } from './merge-queue.js';

/**
 * github_write: one GitHub write tool for every agent, shaped like the GitHub REST API (#381).
 *
 * An agent names a repository-relative REST route (`POST /issues/12/comments`) and its JSON body, plus a key. The control
 * plane maps the route to the GitHub resource that GitHub's fine-grained permissions use for it (Issues, Pull requests,
 * Contents, Actions), checks the caller's role still has write on that resource, mints a token with exactly that permission for this
 * one call, sends the request, revokes the token and returns the useful part of GitHub's answer. The agent never holds a
 * token that can write.
 *
 * - Text meant for people (title and body of Issues, comments, PRs and reviews) gets the public-text redaction and is
 *   sent as written, mentions included. The same credential allowlist applies to other strings.
 * - The key makes a retried call return the earlier result instead of writing twice: within one scope (a task, a dispatched
 *   event, a group or management turn) a key that already reached GitHub is answered from the ledger.
 * - Every call is recorded in github_writes (who, repository, method, path, a request digest, GitHub's status and URL) and in
 *   the project audit.
 * - Starting a workflow (#1072) always asks GitHub for the run it created (return_run_details), so the agent and the ledger
 *   hold the run's id and link. Whether the workflow declares workflow_dispatch, whether the ref is right and whether a run is
 *   already going are GitHub's and the agent's to judge: GitHub refuses what it cannot run (for example 422).
 * - Merging a pull request (#1170) needs the develop ceiling, Contents and Pull requests write, and the project's auto-merge
 *   policy (see merge-policy.ts): where the policy needs a maintainer's request, the call names it (merge_request) and the
 *   control plane checks who made it. The same call enqueues when the base branch requires a merge queue.
 */

export type WriteResource = 'issues' | 'pull_requests' | 'contents' | 'actions';
/** The legacy custom operation a route matches (see resourceAllowed); none means the resource's full write. */
export type WriteOperation = 'create' | 'reply' | 'labels';
export const writeMethods = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;
/** Who asked for a write: kept in the ledger and the audit. */
// principal_id: the person who asked (management assistant); grantor_id: the person whose authority a group binding uses.
export interface WriteActor { kind: 'task' | 'manager' | 'service' | 'management'; role?: string | null; task_id?: string | null; event_id?: string | null;
  service_role_id?: string | null; conversation_id?: string | null; source_message?: string | null; principal_id?: string | null; grantor_id?: string | null }
export interface WriteContext {
  store: Store; repository: Row; redactor: Redactor; guard: () => Promise<void>; apiUrl?: string;
  /** Keys are unique within a scope: a task, a dispatched event, a group or management turn. */
  scope: string; actor: WriteActor;
  /** The caller's live permission for a resource (and the matching legacy operation); checked before and right before sending. */
  allowed: (resource: WriteResource, operation?: WriteOperation) => boolean;
  /**
   * The person who sent the message this turn answers (a management or group conversation), as the caller verified it: a
   * platform principal, or null when the sender is not linked to one. Absent where no person's message drives the call.
   */
  speaker?: () => string | null;
}

// One route: `shared` routes act on an Issue or a pull request by number (GitHub keeps both under /issues), `comment` routes on
// an Issue or PR conversation comment by id. human: which body fields people read and therefore get the public-text redaction.
// base64: whether body.content is base64 file content always (contents) or only with encoding base64 (blobs).
// dispatch: a workflow_dispatch, whose body always asks GitHub to return the run it started.
// merge: merging a pull request, gated by the project's auto-merge policy and adapted to the base branch's merge queue.
interface Route { methods: string[]; pattern: RegExp; resource: WriteResource | 'shared' | 'comment'; operation?: WriteOperation; human?: 'text' | 'review'; base64?: 'always' | 'encoding'; dispatch?: boolean; merge?: boolean }
const n = '([1-9]\\d{0,9})', segment = '[^/]+';
const route = (methods: string, path: string, resource: Route['resource'], extra: Partial<Route> = {}): Route =>
  ({ methods: methods.split('|'), pattern: new RegExp('^' + path + '$'), resource, ...extra });
const routes: Route[] = [
  // Issues (and, by number, pull requests: GitHub serves both under /issues).
  route('POST', '/issues', 'issues', { operation: 'create', human: 'text' }),
  route('PATCH', `/issues/${n}`, 'shared', { human: 'text' }),
  route('POST', `/issues/${n}/comments`, 'shared', { operation: 'reply', human: 'text' }),
  route('PATCH', `/issues/comments/${n}`, 'comment', { operation: 'reply', human: 'text' }),
  route('DELETE', `/issues/comments/${n}`, 'comment', { operation: 'reply' }),
  route('POST|PUT|DELETE', `/issues/${n}/labels`, 'shared', { operation: 'labels' }),
  route('DELETE', `/issues/${n}/labels/${segment}`, 'shared', { operation: 'labels' }),
  route('POST|DELETE', `/issues/${n}/assignees`, 'shared'),
  route('PUT|DELETE', `/issues/${n}/lock`, 'shared'),
  route('POST', '/labels', 'issues'), route('PATCH|DELETE', `/labels/${segment}`, 'issues'),
  route('POST', '/milestones', 'issues'), route('PATCH|DELETE', `/milestones/${n}`, 'issues'),
  // Pull requests.
  route('POST', '/pulls', 'pull_requests', { operation: 'create', human: 'text' }),
  route('PATCH', `/pulls/${n}`, 'pull_requests', { human: 'text' }),
  route('POST', `/pulls/${n}/reviews`, 'pull_requests', { operation: 'reply', human: 'review' }),
  route('PUT', `/pulls/${n}/reviews/${n}`, 'pull_requests', { operation: 'reply', human: 'text' }),
  route('POST', `/pulls/${n}/reviews/${n}/events`, 'pull_requests', { operation: 'reply', human: 'text' }),
  route('PUT', `/pulls/${n}/reviews/${n}/dismissals`, 'pull_requests'),
  route('POST', `/pulls/${n}/comments`, 'pull_requests', { operation: 'reply', human: 'text' }),
  route('POST', `/pulls/${n}/comments/${n}/replies`, 'pull_requests', { operation: 'reply', human: 'text' }),
  route('PATCH', `/pulls/comments/${n}`, 'pull_requests', { operation: 'reply', human: 'text' }),
  route('DELETE', `/pulls/comments/${n}`, 'pull_requests', { operation: 'reply' }),
  route('POST|DELETE', `/pulls/${n}/requested_reviewers`, 'pull_requests'),
  route('PUT', `/pulls/${n}/update-branch`, 'pull_requests'),
  // Contents: files, Git objects and refs, merges. Merging a pull request is a Contents write on GitHub; here it also needs
  // Pull requests write, which its merge queue takes (#1170).
  route('PUT', '/contents/.+', 'contents', { base64: 'always' }), route('DELETE', '/contents/.+', 'contents'),
  route('POST', '/git/blobs', 'contents', { base64: 'encoding' }), route('POST', '/git/(?:trees|commits|tags|refs)', 'contents'),
  route('PATCH|DELETE', '/git/refs/.+', 'contents'),
  route('PUT', `/pulls/${n}/merge`, 'contents', { merge: true }), route('POST', '/merges', 'contents'),
  // Actions: start a workflow by its file name or id (#1072).
  route('POST', `/actions/workflows/${segment}/dispatches`, 'actions', { dispatch: true })
];

const fn = (name: string, description: string, properties: any, required: string[]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const description = 'Write to GitHub through the control plane, exactly like the GitHub REST API: method and a path relative to the repository (/repos/{owner}/{repo} is implied), with the REST JSON body. '
  + 'Examples: POST /issues {title, body}; POST /issues/12/comments {body}; POST /issues/12/labels {labels}; PATCH /issues/12 {state}; POST /pulls {title, head, base, body}; '
  + 'POST /pulls/7/reviews {event, body, comments}; PUT /pulls/7/merge; PUT /contents/docs/a.md {message, content (base64), sha?, branch?}; POST /git/refs {ref, sha}; '
  + 'POST /actions/workflows/nightly.yml/dispatches {ref, inputs?} starts a workflow that declares workflow_dispatch and returns its workflow_run_id and html_url (read its runs first: do not start one that is already queued or running unless asked). '
  + 'PUT /pulls/7/merge {sha?, merge_method?} merges the pull request, or adds it to the merge queue when its base branch requires one (the answer says queued); it needs Contents and Pull requests write and is allowed only as the project\'s auto-merge policy says (your instructions state it). '
  + 'Allowed only where your role has write on the route\'s GitHub resource (Issues, Pull requests, Contents or Actions) and the project\'s capability ceiling allows it (comment for Issues, pull requests and Actions, develop for Contents); other repositories, other routes and changes to .github/workflows/ are refused. '
  + 'Text is sent as written: an @mention notifies that person, so mention someone only when the task asks for it; secrets are removed. key: a short stable name for this write (for example "triage-comment"); calling again with the same key returns the earlier result instead of writing twice, so keep it when retrying and use a new key for a different write. '
  + 'Use github_read to check state before writing; write only what your task needs.';
const properties = { method: { type: 'string', enum: [...writeMethods] }, path: { type: 'string', description: 'Repository-relative REST path, such as /issues/12/comments. No query string.' },
  body: { type: 'object', description: 'The REST request body. Omit when the route takes none.' }, key: { type: 'string', maxLength: 120 },
  merge_request: { type: 'string', maxLength: 500, description: 'Only with PUT /pulls/{n}/merge, when the auto-merge policy needs a maintainer\'s explicit request for this merge: the link to their comment, review or review comment on this pull request, or "current_message" when the message you are answering in a Feishu or management conversation asks for it. The control plane checks that the person has write access to the repository.' } };
/** What an agent is told about github_write in one project; it applies only where the tool is among its tools. */
export const githubWriteInstructions = (policy: AutoMergePolicy) => ' If github_write is among your tools, your role may write to this repository on GitHub through the control plane, shaped like the GitHub REST API. Use it only for what this task and its prompt ask for (for example a comment, a label or a follow-up Issue), read the current state with github_read first, keep one stable key per intended write and never use it to approve a pull request unless the task explicitly asks for that. Never push to another author\'s branch or to the default branch unless a person explicitly asked for that push (in a GitHub comment, in Feishu or in the task they created); then cite that request where you report the write. '
  + mergeBoundary(policy) + ' Your task\'s own result is still delivered by its finishing tool.';
/** The tool of task entries and the Manager: the repository is the one of the task or event. */
export const githubWriteTool = fn('github_write', description, properties, ['method', 'path', 'key']);
/**
 * github_write with the project's merge boundary in its own description (#1170). Role runs replace the entry's system
 * prompt with the role's, so the boundary travels with the tool to every holder.
 */
export const withMergePolicy = <T extends { function: { name: string; description: string } }>(tools: T[], policy: AutoMergePolicy): T[] =>
  tools.map(tool => tool.function.name === 'github_write' ? { ...tool, function: { ...tool.function, description: tool.function.description + ' ' + mergeBoundary(policy) } } : tool);
/** github_write as a generic task's delivery tool (#814): the task's grant and its source govern it, not the executing role. */
export const grantedGithubWriteTool = fn('github_write', description.replace("Allowed only where your role has write on the route's GitHub resource (Issues, Pull requests, Contents or Actions)",
  "Offered because this task was granted GitHub writes; each call is allowed only where the task's source (the roles that created or delegated it, a group's level) has write on the route's GitHub resource (Issues, Pull requests, Contents or Actions)"), properties, ['method', 'path', 'key']);
/** The tool of assistants that serve several repositories: the repository is chosen per call and checked against their scope. */
export const scopedGithubWriteTool = fn('github_write', description.replace('(/repos/{owner}/{repo} is implied)', 'of the selected repository') + ' The repository argument selects one repository you may use; any other is refused.',
  { repository: { type: 'string', description: 'Repository full name (owner/name).' }, ...properties }, ['repository', 'method', 'path', 'key']);

export function githubWriteStorage(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS github_writes(id TEXT PRIMARY KEY,scope TEXT NOT NULL,key TEXT NOT NULL,repository_id TEXT NOT NULL,actor TEXT NOT NULL,
      method TEXT NOT NULL,path TEXT NOT NULL,request_digest TEXT NOT NULL,state TEXT NOT NULL,status INTEGER,html_url TEXT,response TEXT,error TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,marker TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS github_writes_key ON github_writes(scope,key);
    CREATE INDEX IF NOT EXISTS github_writes_repository ON github_writes(repository_id,created_at);
    CREATE INDEX IF NOT EXISTS github_writes_marker ON github_writes(marker) WHERE marker<>'';`);
}

/** A repository-relative REST path without a query, traversal or encoded separators; null when it is not one. */
function writePath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length > 1024 || !path.startsWith('/') || path.startsWith('//') || /[?#\\\s\u0000-\u001f]/.test(path)) return null;
  try {
    if (new URL(path, 'https://repository.invalid').pathname !== path) return null;
    for (const part of path.slice(1).split('/')) {
      let decoded = part;
      for (;;) {
        if (!decoded || decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f]/.test(decoded)) return null;
        let next; try { next = decodeURIComponent(decoded); } catch { return null; }
        if (next === decoded) break;
        decoded = next;
      }
    }
  } catch { return null; }
  return path;
}
/** A path writePath accepted, with each segment decoded the way GitHub reads it. */
const decodedPath = (path: string) => path.split('/').map(part => {
  for (let next = decodeURIComponent(part); next !== part; next = decodeURIComponent(part)) part = next;
  return part;
}).join('/');
/** The route a write names, or null when no resource covers it. */
export function writeRoute(method: string, path: string): (Route & { number?: number; comment?: number }) | null {
  for (const entry of routes) {
    const match = entry.methods.includes(method) ? entry.pattern.exec(path) : null;
    if (match) return { ...entry, ...(entry.resource === 'shared' || entry.merge ? { number: Number(match[1]) } : entry.resource === 'comment' ? { comment: Number(match[1]) } : {}) };
  }
  return null;
}

// A body that cannot be sent as given: binary content holding a credential.
class Unsendable extends Error { constructor(readonly code: string, readonly detail: string) { super(code); } }
/**
 * The body GitHub receives. All strings use the publication allowlist. Base64 file content is redacted as text when it is UTF-8; binary content that
 * contains a known secret is refused instead of being corrupted. Every text body carries the bot's marker: a bot account
 * writes as an ordinary user, and the marker keeps its own comments and Issues from coming back as new events.
 */
function sanitize(entry: Route, body: unknown, redactor: Redactor, marker: string): unknown {
  const plain = (value: unknown): unknown => typeof value === 'string' ? publicText(value, redactor)
    : Array.isArray(value) ? value.map(plain) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)])) : value;
  const human = (value: unknown, title = false) => {
    if (typeof value !== 'string') return plain(value);
    const cleaned = publicText(value, redactor);
    return title ? cleaned.replace(/[\r\n]+/g, ' ').trim() : cleaned;
  };
  const marked = (value: unknown) => typeof value === 'string' ? value + '\n\n' + marker : value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return entry.dispatch && body === undefined ? { return_run_details: true } : plain(body);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (entry.human && key === 'title') result[key] = human(value, true);
    else if (entry.human && key === 'body') result[key] = marked(human(value));
    else if (entry.human === 'review' && key === 'comments' && Array.isArray(value))
      result[key] = value.map(item => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, k === 'body' ? marked(human(v)) : plain(v)])) : plain(item));
    else if (key === 'content' && typeof value === 'string' && (entry.base64 === 'always' || entry.base64 === 'encoding' && (body as any).encoding === 'base64')) result[key] = base64Content(value, redactor);
    else result[key] = plain(value);
  }
  if (entry.dispatch) result.return_run_details = true;
  return result;
}
function base64Content(value: string, redactor: Redactor): string {
  const data = Buffer.from(value, 'base64');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { if (redactor.contains(data)) throw new Unsendable('github_write_secret_in_content', 'The binary content contains a credential of this deployment.'); return value; }
  const cleaned = publicText(text, redactor);
  return cleaned === text ? value : Buffer.from(cleaned).toString('base64');
}

/** The useful part of GitHub's answer: identities, links and states, never whole objects. */
function summarize(value: any): any {
  if (Array.isArray(value)) return value.slice(0, 100).map(item => item && typeof item === 'object' && typeof item.name === 'string' ? item.name : summarize(item));
  if (!value || typeof value !== 'object') return value ?? null;
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'number', 'html_url', 'state', 'title', 'name', 'ref', 'sha', 'merged', 'message', 'draft', 'workflow_run_id', 'run_url'])
    if (['string', 'number', 'boolean'].includes(typeof value[key])) out[key] = value[key];
  if (value.object?.sha) out.object = { sha: value.object.sha, type: value.object.type ?? null };
  if (value.commit?.sha) out.commit = { sha: value.commit.sha, html_url: value.commit.html_url ?? null };
  if (value.content?.path) out.content = { path: value.content.path, sha: value.content.sha ?? null, html_url: value.content.html_url ?? null };
  if (Array.isArray(value.labels)) out.labels = value.labels.map((l: any) => typeof l === 'string' ? l : l?.name).filter(Boolean);
  return out;
}
const urlOf = (value: any): string | null => {
  const url = value?.html_url ?? value?.content?.html_url ?? value?.commit?.html_url ?? null;
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
};

const now = () => new Date().toISOString();
/**
 * One github_write call. Returns what the agent sees: GitHub's useful answer, or an error it can act on. A rate limit is
 * thrown so the caller waits the same way it waits for reads.
 */
export async function githubWrite(context: WriteContext, args: unknown): Promise<any> {
  const { store, redactor: base, repository } = context;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'invalid_arguments' };
  const input = args as Record<string, unknown>, method = String(input.method ?? '').toUpperCase(), path = writePath(input.path), key = typeof input.key === 'string' ? input.key.trim() : '';
  if (Object.keys(input).some(name => !['method', 'path', 'body', 'key', 'merge_request'].includes(name)) || !(writeMethods as readonly string[]).includes(method) || !path || !key || key.length > 120
    || input.body !== undefined && (input.body === null || typeof input.body !== 'object')
    || input.merge_request !== undefined && (typeof input.merge_request !== 'string' || input.merge_request.length > 500))
    return { error: 'invalid_arguments', detail: 'github_write takes method (POST, PATCH, PUT or DELETE), a repository-relative path without a query, an optional JSON object body, a key of up to 120 characters and, only for a merge, an optional merge_request.' };
  if (input.body !== undefined && Buffer.byteLength(JSON.stringify(input.body)) > 1024 * 1024) return { error: 'github_write_body_too_large', detail: 'The request body exceeds 1 MiB.' };
  // Every known credential of this deployment is redacted, not only the ones this caller holds.
  const redactor = registeredRedactor(store);
  for (const value of base.values) redactor.add(value);
  const entry = writeRoute(method, path), marker = digest(context.scope + '\n' + key).slice(0, 24);
  const record = (state: string, fields: { request_digest?: string; status?: number | null; html_url?: string | null; response?: unknown; error?: string | null } = {}) => {
    const id = randomId(), time = now();
    store.run('INSERT INTO github_writes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, context.scope, key, String(repository.id), JSON.stringify(context.actor), method, path,
      fields.request_digest ?? '', state, fields.status ?? null, fields.html_url ?? null, fields.response === undefined ? null : JSON.stringify(fields.response), fields.error ?? null, time, time, marker);
    audit(state, fields.status ?? null, fields.html_url ?? null);
    return id;
  };
  const audit = (state: string, status: number | null, url: string | null) => store.audit(auditActor(context.actor), 'github.write.' + state,
    `${method} ${path}${status ? ' ' + status : ''}${url ? ' ' + url : ''}`, String(repository.id));
  const refuse = (error: string, detail?: string, extra: Record<string, unknown> = {}) => { record('refused', { error }); return { error, ...extra, ...(detail ? { detail } : {}) }; };
  // The project's capability ceiling (#850) bounds every caller's writes: Issues, pull requests and Actions need comment,
  // Contents (files, refs, merging) develop. It is read live, like the caller's own permission.
  const aboveCeiling = (resource: WriteResource) => {
    const ceiling = projectCeiling(store, String(repository.id)), needed = resourceLevel(resource);
    return covers(ceiling, needed) ? null : refuse('capability_ceiling', `This project's capability ceiling is ${ceiling}; ${resourceName(resource)} writes need ${needed}. Nothing was sent; a project administrator can raise the ceiling.`, { needed, ceiling });
  };
  if (!entry) return refuse('github_write_route_unsupported', `${method} ${path} is not a supported repository write. Supported: Issues, comments, labels, assignees, milestones, pull requests, reviews, review comments, files and Git refs, merges, workflow dispatches.`);
  if (input.merge_request !== undefined && !entry.merge) return { error: 'invalid_arguments', detail: 'merge_request goes only with PUT /pulls/{n}/merge.' };
  // CI changes are bot pull requests that people review and merge (#931). github_write's token never has the Workflows
  // permission, so GitHub refuses a ref update that would change .github/workflows/; a file write there is refused here,
  // matched on the decoded path GitHub will see (writePath already refused segments that do not decode).
  if (entry.resource === 'contents' && /^\/contents\/\.github\/workflows(?:\/|$)/i.test(decodedPath(path)))
    return refuse('github_workflow_write_forbidden', 'github_write never changes .github/workflows/. A CI change is delivered as a bot pull request: a development task a project administrator confirmed as a CI change, reviewed and merged by people.');
  let body: unknown;
  try { body = sanitize(entry, input.body, redactor, `<!-- dept-bot-write:${marker} -->`); }
  catch (error) { if (error instanceof Unsendable) return refuse(error.code, error.detail); throw error; }
  const requestDigest = digest(JSON.stringify([String(repository.id), method, path, body ?? null]));
  // Answered from the ledger: a key that already reached GitHub (or may have) is never sent again.
  const earlier = () => {
    const row = store.get("SELECT * FROM github_writes WHERE scope=? AND key=? AND state IN ('sent','inflight','unknown') ORDER BY rowid DESC LIMIT 1", context.scope, key);
    if (!row) return null;
    if (row.request_digest !== requestDigest) return { error: 'github_write_key_conflict', detail: `Key "${key}" was already used for ${row.method} ${row.path} with another body. Use a new key for a different write.` };
    if (row.state === 'sent') return { ...JSON.parse(String(row.response ?? 'null')), status: row.status, replayed: true };
    return { error: 'github_write_unknown', detail: `An earlier call with key "${key}" may have reached GitHub without a confirmed answer. Read GitHub to check; write again only with a new key.` };
  };
  const previous = earlier();
  if (previous) return previous;
  // The resources this caller may write for the route; an Issue-or-PR route is narrowed to its object's kind below.
  const candidates: WriteResource[] = entry.resource === 'shared' || entry.resource === 'comment' ? ['issues', 'pull_requests'] : [entry.resource];
  const permitted = candidates.filter(resource => context.allowed(resource, entry.operation));
  if (!permitted.length) return refuse('github_resource_forbidden', `Your role has no write on ${candidates.map(resourceName).join(' or ')} for ${method} ${path}.`);
  // A merge also takes Pull requests write (#1170): GitHub's merge queue is a pull request operation.
  const writing: WriteResource[] = entry.merge ? ['contents', 'pull_requests'] : [];
  if (entry.merge && !context.allowed('pull_requests', entry.operation)) return refuse('github_resource_forbidden', 'Merging a pull request needs write on Contents and Pull requests; your role has no write on Pull requests.');
  // Issues and pull requests share one level, so a route on either is checked before its object is read.
  const ceilingRefusal = aboveCeiling(permitted[0]!);
  if (ceilingRefusal) return ceilingRefusal;
  const repositoryId = String(repository.id);
  const policyRefusal = (policy: AutoMergePolicy, own: boolean, number: number, reason: string) => refuse('auto_merge_not_allowed',
    `This project's auto-merge policy is ${policy}${policy === 'non_bot_only' ? ` and #${number} is the bot's own pull request` : ''}, so merging it needs a maintainer's explicit request for it. ${reason} Nothing was sent.`,
    { policy, bot_pull_request: own });
  const issued: GitHub[] = [];
  let sending = false;
  const client = async (permissions: Record<string, string>, requested = false) => {
    const github = new GitHub(store, repository, redactor, context.guard, context.apiUrl);github.purpose = 'github_write';
    issued.push(github);
    await github.connect(false, requested ? undefined : { ...permissions, metadata: 'read' }, requested ? { ...permissions, metadata: 'read' } : undefined, false);
    return github;
  };
  try {
    let resource: WriteResource = permitted[0]!;
    if (entry.resource === 'shared' || entry.resource === 'comment') {
      // Which kind of object the number or comment belongs to, read with a read-only token before any write token exists.
      const reader = await client({ issues: 'read', pull_requests: 'read' }, true);
      let number = entry.number;
      if (entry.comment) {
        const comment = await reader.request('GET', reader.path('/issues/comments/' + entry.comment), undefined, true);
        number = Number(/\/issues\/(\d+)$/.exec(String(comment?.issue_url ?? ''))?.[1]);
        if (!comment || !Number.isSafeInteger(number)) return refuse('github_write_target_missing', `Comment ${entry.comment} was not found in this repository.`);
      }
      const object = await reader.request('GET', reader.path('/issues/' + number), undefined, true);
      if (!object) return refuse('github_write_target_missing', `Issue or pull request #${number} was not found in this repository.`);
      resource = object.pull_request ? 'pull_requests' : 'issues';
      if (!permitted.includes(resource)) return refuse('github_resource_forbidden', `#${number} is ${resource === 'pull_requests' ? 'a pull request' : 'an Issue'}; your role has no write on ${resourceName(resource)}.`);
    }
    // A merge (#1170): read the pull request, apply the auto-merge policy (checking the maintainer's request where it needs
    // one) and learn whether its base branch requires a merge queue, all before any write token exists.
    let merging: { number: number; pr: any; own: boolean; request: string | null; queued: boolean } | null = null;
    if (entry.merge) {
      const reader = await client({ pull_requests: 'read', issues: 'read', contents: 'read' }, true), number = entry.number!;
      const pr = await reader.request('GET', reader.path('/pulls/' + number), undefined, true);
      if (!pr) return refuse('github_write_target_missing', `Pull request #${number} was not found in this repository.`);
      const own = isBotPullRequest(store, repositoryId, number), policy = autoMergePolicy(store, repositoryId);
      let request: string | null = null;
      if (mergeNeedsRequest(policy, own)) {
        const checked = await verifyMergeRequest(context, reader, number, input.merge_request);
        if ('reason' in checked) return policyRefusal(policy, own, number, checked.reason);
        request = checked.source;
      }
      const queue = await mergeQueue({ get: path => reader.request('GET', path, undefined, true), graphql: async (query, variables) => ({ data: await reader.graphql(query, variables) }) },
        reader.fullName, String(pr.base?.ref ?? ''));
      merging = { number, pr, own, request, queued: queue.state === 'enabled' };
    }
    // Exactly the needed resources: GitHub refuses the token for anything else.
    const wanted = writing.length ? writing : [resource];
    const github = await client(Object.fromEntries(wanted.map(name => [name, 'write'])));
    if (github.expiresAt && Object.entries(github.permissions).some(([name, level]) => name !== 'metadata' && !(wanted as string[]).includes(name) || (wanted as string[]).includes(name) && level !== 'write'))
      return refuse('github_write_token_scope_invalid', 'GitHub returned a token with other permissions than the one write requested; nothing was sent.');
    await context.guard();
    // Authority is live: a permission revoked while the token was issued refuses the write.
    for (const name of wanted) if (!context.allowed(name, entry.operation)) return refuse('github_resource_forbidden', `Your role no longer has write on ${resourceName(name)}.`);
    const lowered = aboveCeiling(resource);
    if (lowered) return lowered;
    // So is the auto-merge policy: a stricter level saved meanwhile refuses a merge that rested on the looser one.
    if (merging && !merging.request) {
      const policy = autoMergePolicy(store, repositoryId);
      if (mergeNeedsRequest(policy, merging.own)) return policyRefusal(policy, merging.own, merging.number, 'The policy changed while the merge was prepared.');
    }
    // No await between this check and the inflight record: one key reaches GitHub at most once.
    const again = earlier();
    if (again) return again;
    const id = randomId(), time = now();
    store.run('INSERT INTO github_writes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, context.scope, key, String(repository.id), JSON.stringify(context.actor), method, path,
      requestDigest, 'inflight', null, null, null, null, time, time, marker);
    sending = true;
    try {
      // Token issuance may have registered a new exact value since the idempotency digest was computed.
      const outgoing = () => sanitize(entry, input.body, registeredRedactor(store, redactor), `<!-- dept-bot-write:${marker} -->`);
      let response: any, url: string | null = null;
      if (merging?.queued) {
        // The base branch requires a merge queue: the same merge is GitHub's enqueuePullRequest, pinned to the head the agent
        // named (sha) or the one it read. The queue's own settings choose the merge method.
        const head = typeof (input.body as any)?.sha === 'string' ? (input.body as any).sha : String(merging.pr.head?.sha ?? '');
        const value = await github.graphql('mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id position state}}}',
          { id: merging.pr.node_id, head });
        const queued = value?.enqueuePullRequest?.mergeQueueEntry;
        response = { number: merging.number, merged: false, queued: true, sha: head, merge_queue: { id: queued?.id ?? null, position: queued?.position ?? null, state: queued?.state ?? null } };
      } else {
        const value = await github.request(method, github.path(path), outgoing);
        response = summarize(value); url = urlOf(value);
      }
      if (merging) {
        response = { ...response, via: merging.queued ? 'merge_queue' : 'merge', ...(merging.request ? { merge_request: merging.request } : {}) };
        url = typeof merging.pr.html_url === 'string' && /^https:\/\//.test(merging.pr.html_url) ? merging.pr.html_url : null;
      }
      const status = github.status || 200;
      store.run("UPDATE github_writes SET state='sent',status=?,html_url=?,response=?,updated_at=? WHERE id=?", status, url, JSON.stringify(response), now(), id);
      audit('sent', status, url);
      return { ...(response && typeof response === 'object' && !Array.isArray(response) ? response : { result: response }), status };
    } catch (error) {
      if (error instanceof Unsendable) {
        store.run("UPDATE github_writes SET state='refused',error=?,updated_at=? WHERE id=?", error.code, now(), id);
        audit('refused', null, null);
        return { error: error.code, detail: error.detail };
      }
      if (!(error instanceof TaskError)) throw error;
      const unknown = error.code === 'github_response_unknown', status = Number(/^github_(?:http|permission)_(\d+)$/.exec(error.code)?.[1]) || null;
      store.run('UPDATE github_writes SET state=?,status=?,error=?,updated_at=? WHERE id=?', unknown ? 'unknown' : 'failed', status, error.code, now(), id);
      audit(unknown ? 'unknown' : 'failed', status, null);
      // A stopped caller (cancelled task, revoked binding) ends; a rate limit waits like reads do; GitHub's refusals are observations.
      if (error.code === 'github_rate_limited') throw error;
      await context.guard();
      return { error: error.code, detail: redactor.text(error.detail || 'GitHub refused the write.'),
        ...(unknown ? { instruction: 'The write may have reached GitHub. Read GitHub to check before writing again with a new key.' } : {}) };
    }
  } catch (error) {
    // Failures before anything was sent: a missing installation permission, a revoked installation, an unreachable GitHub.
    if (sending || !(error instanceof TaskError)) throw error;
    record('failed', { request_digest: requestDigest, error: error.code });
    if (error.code === 'github_rate_limited') throw error;
    await context.guard();
    return { error: error.code, detail: redactor.text(error.detail || 'The write could not be prepared; nothing was sent.') };
  } finally {
    for (const github of issued) await github.revokeTokens('github_write');
  }
}
const resourceName = (resource: WriteResource) => ({ issues: 'Issues', pull_requests: 'Pull requests', contents: 'Contents', actions: 'Actions' })[resource];

/**
 * The maintainer's request a merge rests on (#1170), checked rather than believed: a comment, review or review comment on
 * this very pull request by someone with write access who is not the bot, or the message this conversation turn answers,
 * sent by a person whose live authority writes tasks in the project. What the words ask for is the agent's to judge.
 */
async function verifyMergeRequest(context: WriteContext, reader: GitHub, number: number, value: unknown): Promise<{ source: string } | { reason: string }> {
  const { store, repository } = context, repositoryId = String(repository.id);
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { reason: 'No merge_request was given: pass the link to the maintainer\'s comment, review or review comment on this pull request that asks for this merge, or "current_message" for the conversation message you are answering.' };
  if (text === 'current_message') {
    if (!context.speaker) return { reason: 'There is no conversation message in this call: pass the link to the maintainer\'s comment, review or review comment on this pull request.' };
    const principal = context.speaker();
    if (!principal) return { reason: 'The sender of the message you are answering is not linked to a platform account, so their write access cannot be checked.' };
    if (!principalMaintainer(store, principal, repositoryId)) return { reason: 'The sender of the message you are answering does not have write access to this repository.' };
    return { source: 'current_message' };
  }
  const full = reader.fullName || String(repository.full_name);
  const match = /^https:\/\/github\.com\/([^/#?]+\/[^/#?]+)\/(?:pull|issues)\/(\d+)#(?:(issuecomment|pullrequestreview)-(\d+)|discussion_r(\d+))$/.exec(text);
  if (!match || match[1]!.toLowerCase() !== full.toLowerCase() || Number(match[2]) !== number)
    return { reason: `merge_request must be the link to a comment (#issuecomment-…), review (#pullrequestreview-…) or review comment (#discussion_r…) on pull request #${number} of ${full}, or "current_message".` };
  const kind = match[3] ?? 'discussion', id = match[4] ?? match[5];
  const item = await reader.request('GET', reader.path(kind === 'issuecomment' ? '/issues/comments/' + id : kind === 'pullrequestreview' ? `/pulls/${number}/reviews/${id}` : '/pulls/comments/' + id), undefined, true);
  const on = kind === 'issuecomment' ? /\/issues\/(\d+)$/.exec(String(item?.issue_url ?? ''))?.[1] : /\/pulls\/(\d+)$/.exec(String(item?.pull_request_url ?? ''))?.[1];
  if (!item || Number(on) !== number) return { reason: `${text} was not found on pull request #${number}.` };
  // The bot writes as an ordinary user under a bot account; its own account and its marker both say it was the bot.
  const author = item.user, bot = store.get('SELECT actor_id FROM github_actors WHERE account_id=?', repository.account_id)?.actor_id;
  if (!/^[1-9]\d*$/.test(String(author?.id ?? '')) || author.type === 'Bot' || String(author.id) === String(bot ?? '') || /<!-- dept-bot[:-]/.test(String(item.body ?? '')))
    return { reason: `${text} was written by a bot, not by a maintainer.` };
  if (!githubMaintainer(store, repositoryId, String(author.id)))
    return { reason: `@${author.login ?? author.id} has no write access to ${full} in the platform's record of the repository's collaborators, so their request does not allow this merge.` };
  return { source: typeof item.html_url === 'string' && /^https:\/\//.test(item.html_url) ? item.html_url : text };
}
const auditActor = (actor: WriteActor) => actor.principal_id ? String(actor.principal_id)
  : actor.service_role_id ? 'service:' + actor.service_role_id : 'role:' + (actor.role ?? actor.kind);

/** The writes a scope already made, for an agent that resumes it (a retried dispatch). */
export function earlierWrites(store: Store, scope: string) {
  return store.all("SELECT key,method,path,state,status,html_url FROM github_writes WHERE scope=? AND state IN ('sent','inflight','unknown') ORDER BY rowid", scope)
    .map(row => ({ key: row.key, method: row.method, path: row.path, state: row.state, status: row.status, html_url: row.html_url }));
}
