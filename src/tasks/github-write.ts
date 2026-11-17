import type { Store, Row } from '../storage/database.js';
import type { Redactor } from '../agent/common.js';
import { githubWrite, type WriteResource, type WriteOperation } from '../github/write.js';
import { githubWriteAllowed } from '../roles/permissions.js';
import { taskActingRole, taskRolePolicies, sourcePolicies } from './management.js';
import { effectiveWrites } from './grants.js';
import { scheduledIssueOperationAllowed } from './schedule-write.js';
import { publicationScope } from '../github/publisher.js';

/**
 * github_write for a task (#381): the task's repository only, keys unique per task (so a retried attempt never writes twice;
 * a review's later round, #770, writes anew),
 * allowed while every policy over the acting role allows the route's resource: the role itself, the source roles that
 * delegated the task and a group binding's service role. A role never lends a write it does not hold.
 * A scheduled check's `file_issues` flag overrides role policy for Issue create/reply: true allows
 * those writes even when the executing role has no GitHub write; false denies them even when the
 * role has it; absent/unset falls back to role policy. The flag never grants Contents or
 * pull-request writes. Every write still goes through the project capability ceiling (#850).
 */
/** Live write check for a task: a scheduled `file_issues` flag can allow or deny Issues writes; otherwise role policy applies. */
export function taskWriteAllowed(store: Store, task: Row, resource: WriteResource, operation?: WriteOperation): boolean {
  const scheduled = scheduledIssueOperationAllowed(task, resource, operation);
  if (scheduled !== null) return scheduled;
  return taskRolePolicies(store, task).every(policy => githubWriteAllowed(policy, resource, operation));
}

export function taskGithubWrite(store: Store, task: Row, redactor: Redactor, guard: () => Promise<void>, apiUrl?: string) {
  const scope = 'task:' + publicationScope(task);
  return (args: unknown) => {
    const repository = store.get('SELECT * FROM repositories WHERE id=?', task.repository_id)!;
    return githubWrite({ store, repository, redactor, guard, apiUrl, scope,
      actor: { kind: 'task', role: taskActingRole(store, task), task_id: String(task.id) },
      allowed: (resource, operation) => taskWriteAllowed(store, task, resource, operation) }, args);
  };
}

const fn = (name: string, description: string, properties: any, required: string[]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
/** post_review (#814): a COMMENT review on a pull request of the task's repository, with optional inline comments. */
export const postReviewTool = fn('post_review', 'Publish a review on a pull request of this repository as the bot: always a COMMENT review (it never approves or requests changes), with an optional list of inline comments on lines of the diff. Offered only while this task is granted the review write; each call is checked again and a refusal comes back with its reason, nothing written. key: a short stable name for this review; calling again with the same key returns the earlier result.', {
  pull_number: { type: 'integer', minimum: 1 }, body: { type: 'string' },
  comments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'line', 'body'], properties: { path: { type: 'string' }, line: { type: 'integer', minimum: 1 }, start_line: { type: 'integer', minimum: 1 }, side: { type: 'string', enum: ['LEFT', 'RIGHT'] }, body: { type: 'string' } } } },
  key: { type: 'string', maxLength: 120 } }, ['pull_number', 'body', 'key']);

// GitHub refuses a whole review whose inline comment has no line, so each one is checked before anything is sent.
const inlineComment = (c: any) => c && typeof c === 'object' && typeof c.path === 'string' && !!c.path && Number.isSafeInteger(c.line) && c.line >= 1 && typeof c.body === 'string' && !!c.body.trim()
  && (c.start_line === undefined || Number.isSafeInteger(c.start_line) && c.start_line >= 1) && (c.side === undefined || ['LEFT', 'RIGHT'].includes(c.side));
/**
 * The GitHub writes of a generic task (#814): github_write and post_review, each allowed while the task holds the write and
 * every policy of its source (the roles that created or delegated it, a group's level) allows the route. The executing role's
 * own GitHub permission does not matter: the grant is the Manager's decision, made within those ceilings.
 */
export function grantedTaskWrite(store: Store, task: Row, redactor: Redactor, guard: () => Promise<void>, apiUrl?: string) {
  const scope = 'task:' + publicationScope(task);
  return async (name: string, args: any) => {
    const write = name === 'post_review' ? 'review' : 'github';
    const refused = () => ({ error: 'delivery_not_granted', tool: name, missing: 'grant:' + write,
      message: `This task does not hold the ${write} write now, so nothing was sent. Ask the Manager to grant it (grant_writes), or report what is missing.` });
    if (!effectiveWrites(store, task, sourcePolicies(store, task)).includes(write)) return refused();
    const repository = store.get('SELECT * FROM repositories WHERE id=?', task.repository_id)!;
    const context = { store, repository, redactor, guard, apiUrl, scope, actor: { kind: 'task' as const, role: taskActingRole(store, task), task_id: String(task.id) },
      allowed: (resource: string, operation?: 'create' | 'reply' | 'labels') => effectiveWrites(store, task, sourcePolicies(store, task)).includes(write)
        && (write !== 'review' || resource === 'pull_requests') && sourcePolicies(store, task).every(policy => githubWriteAllowed(policy, resource, operation)) };
    if (name === 'github_write') return githubWrite(context, args);
    if (!args || typeof args !== 'object' || !Number.isSafeInteger(args.pull_number) || args.pull_number < 1 || typeof args.body !== 'string' || !args.body.trim()
      || args.comments !== undefined && !(Array.isArray(args.comments) && args.comments.every(inlineComment)) || Object.keys(args).some(key => !['pull_number', 'body', 'comments', 'key'].includes(key)))
      return { error: 'invalid_arguments', detail: 'post_review takes pull_number, a nonempty body, optional comments [{path, line, body}] (GitHub needs the line of every inline comment) and a key. Nothing was sent.' };
    return githubWrite(context, { method: 'POST', path: `/pulls/${args.pull_number}/reviews`, key: args.key,
      body: { event: 'COMMENT', body: args.body, ...(args.comments?.length ? { comments: args.comments } : {}) } });
  };
}
