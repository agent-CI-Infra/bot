import type { Store, Row } from '../storage/database.js';
import { fail, digest } from '../core/security.js';
import { taskPermissions } from './configuration.js';
import { taskToolAllowed, assertTaskExternalEffect } from './management.js';
import { GitHub, revokeInstallationToken } from '../github/client.js';
import { Publisher } from '../github/publisher.js';
import { publicText } from '../actions/safety.js';
import type { Redactor } from '../agent/common.js';

export const taskIssueTool = { type: 'function', function: { name: 'create_issue',
  description: 'Publish an Issue for this task through the existing Publisher. Keep the same key when recovering an uncertain write. This does not add development labels or assign another role.',
  parameters: { type: 'object', properties: { key: { type: 'string', maxLength: 120 }, title: { type: 'string', maxLength: 256 }, body: { type: 'string', maxLength: 60000 } },
    required: ['key', 'title', 'body'], additionalProperties: false } } };
export function canReportTaskIssue(store: Store, task: Row): boolean {
  return taskPermissions(store, task).writes.includes('issue') && taskToolAllowed(store, task, String(task.active_role ?? ''), 'create_issue');
}
/** A short-lived write client stays in the control plane; the executor keeps its read-only workspace credentials. */
export async function reportTaskIssue(store: Store, task: Row, args: any, redactor: Redactor, guard: () => Promise<void>, apiUrl?: string): Promise<any> {
  if (!args || Object.keys(args).some(k => !['key', 'title', 'body'].includes(k)) || typeof args.key !== 'string' || !args.key.trim() || args.key.length > 120 ||
    typeof args.title !== 'string' || !args.title.trim() || args.title.length > 256 || typeof args.body !== 'string' || args.body.length > 60000) return fail(400, 'create_issue_invalid');
  const validate = async () => { await guard(); if (!canReportTaskIssue(store, task)) fail(403, 'task_external_write_forbidden'); assertTaskExternalEffect(store, task, 'issue'); };
  await validate();
  const safe = (value: string) => publicText(value, redactor).replace(/@/g, '&#64;');
  const title = safe(args.title).replace(/[\r\n]+/g, ' ').trim(), body = safe(args.body), key = 'issue:' + digest(args.key);
  const previous = store.get('SELECT request FROM github_effects WHERE id=?', digest(task.id + ':' + key).slice(0, 48));
  if (previous) {
    const request = JSON.parse(previous.request);
    if (request.title !== title || !String(request.body).startsWith(body + '\n\n<!-- dept-bot:')) fail(409, 'task_issue_key_conflict');
  }
  const repo = store.get('SELECT * FROM repositories WHERE id=?', task.repository_id)!;
  const github = new GitHub(store, repo, redactor, validate, apiUrl);
  try {
    await github.connect(false, { issues: 'write', metadata: 'read' });
    const issue = await new Publisher(store, github, task, validate).issue(key, title, body);
    return { number: issue.number, html_url: issue.html_url };
  } finally {
    if (github.expiresAt && github.token) await revokeInstallationToken(apiUrl ?? 'https://api.github.com', github.token).catch(() => false);
  }
}
