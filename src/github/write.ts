import type { Store, Row } from '../storage/database.js';
import { GitHub, revokeInstallationToken } from './client.js';
import { publicText, actionsRedactor } from '../actions/safety.js';
import { Redactor, TaskError } from '../agent/common.js';
import { digest, randomId } from '../core/security.js';

/**
 * github_write: one GitHub write tool for every agent, shaped like the GitHub REST API (#381).
 *
 * An agent names a repository-relative REST route (`POST /issues/12/comments`) and its JSON body, plus a key. The control
 * plane maps the route to the GitHub resource that GitHub's fine-grained permissions use for it (Issues, Pull requests,
 * Contents), checks the caller's role still has write on that resource, mints a token with exactly that permission for this
 * one call, sends the request, revokes the token and returns the useful part of GitHub's answer. The agent never holds a
 * token that can write.
 *
 * - Text meant for people (title and body of Issues, comments, PRs and reviews) has `@` mentions escaped; every string is
 *   redacted for known secrets. Code and file content are redacted but never escaped.
 * - The key makes a retried call return the earlier result instead of writing twice: within one scope (a task, a dispatched
 *   event, a group or management turn) a key that already reached GitHub is answered from the ledger.
 * - Every call is recorded in github_writes (who, repository, method, path, a request digest, GitHub's status and URL) and in
 *   the project audit.
 */

export type WriteResource = 'issues' | 'pull_requests' | 'contents';
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
}

// One route: `shared` routes act on an Issue or a pull request by number (GitHub keeps both under /issues), `comment` routes on
// an Issue or PR conversation comment by id. human: which body fields people read and therefore get their mentions escaped.
// base64: whether body.content is base64 file content always (contents) or only with encoding base64 (blobs).
interface Route { methods: string[]; pattern: RegExp; resource: WriteResource | 'shared' | 'comment'; operation?: WriteOperation; human?: 'text' | 'review'; base64?: 'always' | 'encoding' }
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
  // Contents: files, Git objects and refs, merges. Merging a pull request is a Contents write on GitHub.
  route('PUT', '/contents/.+', 'contents', { base64: 'always' }), route('DELETE', '/contents/.+', 'contents'),
  route('POST', '/git/blobs', 'contents', { base64: 'encoding' }), route('POST', '/git/(?:trees|commits|tags|refs)', 'contents'),
  route('PATCH|DELETE', '/git/refs/.+', 'contents'),
  route('PUT', `/pulls/${n}/merge`, 'contents'), route('POST', '/merges', 'contents')
];

const fn = (name: string, description: string, properties: any, required: string[]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const description = 'Write to GitHub through the control plane, exactly like the GitHub REST API: method and a path relative to the repository (/repos/{owner}/{repo} is implied), with the REST JSON body. '
  + 'Examples: POST /issues {title, body}; POST /issues/12/comments {body}; POST /issues/12/labels {labels}; PATCH /issues/12 {state}; POST /pulls {title, head, base, body}; '
  + 'POST /pulls/7/reviews {event, body, comments}; PUT /pulls/7/merge; PUT /contents/docs/a.md {message, content (base64), sha?, branch?}; POST /git/refs {ref, sha}. '
  + 'Allowed only where your role has write on the route\'s GitHub resource (Issues, Pull requests or Contents); other repositories and other routes are refused. '
  + 'Mentions (@) in titles and bodies people read are escaped and secrets are removed. key: a short stable name for this write (for example "triage-comment"); calling again with the same key returns the earlier result instead of writing twice, so keep it when retrying and use a new key for a different write. '
  + 'Use github_read to check state before writing; write only what your task needs.';
const properties = { method: { type: 'string', enum: [...writeMethods] }, path: { type: 'string', description: 'Repository-relative REST path, such as /issues/12/comments. No query string.' },
  body: { type: 'object', description: 'The REST request body. Omit when the route takes none.' }, key: { type: 'string', maxLength: 120 } };
/** What an agent is told about github_write; it applies only where the tool is among its tools. */
export const githubWriteInstructions = ' If github_write is among your tools, your role may write to this repository on GitHub through the control plane, shaped like the GitHub REST API. Use it only for what this task and its prompt ask for (for example a comment, a label or a follow-up Issue), read the current state with github_read first, keep one stable key per intended write and never use it to approve, merge or push unless the task explicitly asks for that. Your task\'s own result is still delivered by its finishing tool.';
/** The tool of task entries and the Manager: the repository is the one of the task or event. */
export const githubWriteTool = fn('github_write', description, properties, ['method', 'path', 'key']);
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
/** The route a write names, or null when no resource covers it. */
export function writeRoute(method: string, path: string): (Route & { number?: number; comment?: number }) | null {
  for (const entry of routes) {
    const match = entry.methods.includes(method) ? entry.pattern.exec(path) : null;
    if (match) return { ...entry, ...(entry.resource === 'shared' ? { number: Number(match[1]) } : entry.resource === 'comment' ? { comment: Number(match[1]) } : {}) };
  }
  return null;
}

// Known secrets shapes that are never legitimate repository content: private keys and GitHub tokens.
const secretShapes = (text: string) => text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[REDACTED]')
  .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/g, '[REDACTED]');
const escapeMentions = (text: string) => text.replace(/@/g, '&#64;');
// A body that cannot be sent as given: binary content holding a credential, or human text that redaction would empty.
class Unsendable extends Error { constructor(readonly code: string, readonly detail: string) { super(code); } }
/**
 * The body GitHub receives. Human text gets the public-text redaction and escaped mentions; every other string (code, commit
 * messages, refs) only loses known secrets. Base64 file content is redacted as text when it is UTF-8; binary content that
 * contains a known secret is refused instead of being corrupted. Every text body carries the bot's marker: a bot account
 * writes as an ordinary user, and the marker keeps its own comments and Issues from coming back as new events.
 */
function sanitize(entry: Route, body: unknown, redactor: Redactor, marker: string): unknown {
  const plain = (value: unknown): unknown => typeof value === 'string' ? secretShapes(redactor.text(value))
    : Array.isArray(value) ? value.map(plain) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)])) : value;
  const human = (value: unknown, title = false) => {
    if (typeof value !== 'string') return plain(value);
    const cleaned = publicText(value, redactor, false);
    if (value.trim() && !cleaned.trim()) throw new Unsendable('github_write_text_unsafe', 'The text contains key or certificate material that cannot be published; remove it and write again.');
    const text = escapeMentions(cleaned);
    return title ? text.replace(/[\r\n]+/g, ' ').trim() : text;
  };
  const marked = (value: unknown) => typeof value === 'string' ? value + '\n\n' + marker : value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return plain(body);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (entry.human && key === 'title') result[key] = human(value, true);
    else if (entry.human && key === 'body') result[key] = marked(human(value));
    else if (entry.human === 'review' && key === 'comments' && Array.isArray(value))
      result[key] = value.map(item => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, k === 'body' ? marked(human(v)) : plain(v)])) : plain(item));
    else if (key === 'content' && typeof value === 'string' && (entry.base64 === 'always' || entry.base64 === 'encoding' && (body as any).encoding === 'base64')) result[key] = base64Content(value, redactor);
    else result[key] = plain(value);
  }
  return result;
}
function base64Content(value: string, redactor: Redactor): string {
  const data = Buffer.from(value, 'base64');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { if (redactor.contains(data)) throw new Unsendable('github_write_secret_in_content', 'The binary content contains a credential of this deployment.'); return value; }
  const cleaned = secretShapes(redactor.text(text));
  return cleaned === text ? value : Buffer.from(cleaned).toString('base64');
}

/** The useful part of GitHub's answer: identities, links and states, never whole objects. */
function summarize(value: any): any {
  if (Array.isArray(value)) return value.slice(0, 100).map(item => item && typeof item === 'object' && typeof item.name === 'string' ? item.name : summarize(item));
  if (!value || typeof value !== 'object') return value ?? null;
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'number', 'html_url', 'state', 'title', 'name', 'ref', 'sha', 'merged', 'message', 'draft'])
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
  if (Object.keys(input).some(name => !['method', 'path', 'body', 'key'].includes(name)) || !(writeMethods as readonly string[]).includes(method) || !path || !key || key.length > 120
    || input.body !== undefined && (input.body === null || typeof input.body !== 'object'))
    return { error: 'invalid_arguments', detail: 'github_write takes method (POST, PATCH, PUT or DELETE), a repository-relative path without a query, an optional JSON object body and a key of up to 120 characters.' };
  if (input.body !== undefined && Buffer.byteLength(JSON.stringify(input.body)) > 1024 * 1024) return { error: 'github_write_body_too_large', detail: 'The request body exceeds 1 MiB.' };
  // Every known credential of this deployment is redacted, not only the ones this caller holds.
  const redactor = new Redactor();
  for (const value of [...base.values, ...actionsRedactor(store).values]) redactor.values.add(value);
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
  const refuse = (error: string, detail?: string) => { record('refused', { error }); return { error, ...(detail ? { detail } : {}) }; };
  if (!entry) return refuse('github_write_route_unsupported', `${method} ${path} is not a supported repository write. Supported: Issues, comments, labels, assignees, milestones, pull requests, reviews, review comments, files and Git refs, merges.`);
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
  const issued: GitHub[] = [];
  let sending = false;
  const client = async (permissions: Record<string, string>, requested = false) => {
    const github = new GitHub(store, repository, redactor, context.guard, context.apiUrl);
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
    // Exactly the needed resource: GitHub refuses the token for anything else.
    const github = await client({ [resource]: 'write' });
    if (github.expiresAt && Object.entries(github.permissions).some(([name, level]) => name !== 'metadata' && name !== resource || name === resource && level !== 'write'))
      return refuse('github_write_token_scope_invalid', 'GitHub returned a token with other permissions than the one write requested; nothing was sent.');
    await context.guard();
    // Authority is live: a permission revoked while the token was issued refuses the write.
    if (!context.allowed(resource, entry.operation)) return refuse('github_resource_forbidden', `Your role no longer has write on ${resourceName(resource)}.`);
    // No await between this check and the inflight record: one key reaches GitHub at most once.
    const again = earlier();
    if (again) return again;
    const id = randomId(), time = now();
    store.run('INSERT INTO github_writes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, context.scope, key, String(repository.id), JSON.stringify(context.actor), method, path,
      requestDigest, 'inflight', null, null, null, null, time, time, marker);
    sending = true;
    try {
      const value = await github.request(method, github.path(path), body);
      const response = summarize(value), url = urlOf(value), status = github.status || 200;
      store.run("UPDATE github_writes SET state='sent',status=?,html_url=?,response=?,updated_at=? WHERE id=?", status, url, JSON.stringify(response), now(), id);
      audit('sent', status, url);
      return { ...(response && typeof response === 'object' && !Array.isArray(response) ? response : { result: response }), status };
    } catch (error) {
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
    for (const github of issued) if (github.expiresAt && github.token) await revokeInstallationToken(github.apiUrl, github.token).catch(() => false);
  }
}
const resourceName = (resource: WriteResource) => ({ issues: 'Issues', pull_requests: 'Pull requests', contents: 'Contents' })[resource];
const auditActor = (actor: WriteActor) => actor.principal_id ? String(actor.principal_id)
  : actor.service_role_id ? 'service:' + actor.service_role_id : 'role:' + (actor.role ?? actor.kind);

/** The writes a scope already made, for an agent that resumes it (a retried dispatch). */
export function earlierWrites(store: Store, scope: string) {
  return store.all("SELECT key,method,path,state,status,html_url FROM github_writes WHERE scope=? AND state IN ('sent','inflight','unknown') ORDER BY rowid", scope)
    .map(row => ({ key: row.key, method: row.method, path: row.path, state: row.state, status: row.status, html_url: row.html_url }));
}
