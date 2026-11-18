import { marked } from 'marked';
import { redactCredentials } from '../core/redaction.js';
import type { Store } from '../storage/database.js';
import { Redactor } from '../agent/common.js';
import { covers, projectCeiling } from '../work/ceiling.js';

// Configuration errors that stop Actions failure handling until an App manager or installation owner acts.
export const actionsConfigurationErrors = ['actions_permission_missing', 'actions_workflow_run_subscription_missing'];
/**
 * The first missing piece of the installation's Actions setup, or null. workflow_run is a webhook event subscription
 * (GitHub's "Workflow run"), not the Workflows permission: GitHub offers it only to an App with at least Actions read, so
 * an installation without Actions access is reported as such rather than as a missing subscription it cannot have.
 */
export function actionsConfigurationError(github: { installationPermissions: Record<string, string> | null; installationEvents: string[] | null }) {
  if (github.installationPermissions && !github.installationPermissions.actions) return 'actions_permission_missing';
  if (!github.installationEvents?.includes('workflow_run')) return 'actions_workflow_run_subscription_missing';
  return null;
}

export function actionsRedactor(store: Store, redactor = new Redactor()) {
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    redactor.values.add(value);
    // A URL may encode the whole value or each repository path segment.
    redactor.values.add(encodeURIComponent(value));
    redactor.values.add(value.split('/').map(encodeURIComponent).join('/'));
  };
  for (const account of store.all('SELECT id,credentials FROM accounts')) {
    const credentials = store.secrets.open(account.credentials, `account:${account.id}`);
    for (const name of ['token', 'private_key', 'webhook_secret']) add(credentials[name]);
  }
  for (const model of store.all('SELECT id,api_key FROM models WHERE api_key IS NOT NULL')) add(store.secrets.open(model.api_key, `model:${model.id}`).value);
  for (const endpoint of store.all('SELECT id,secret FROM endpoints')) add(store.secrets.open(endpoint.secret, `endpoint:${endpoint.id}`).value);
  return redactor;
}

export function publicText(value: string, redactor: Redactor): string {
  if (value.includes('\0')) return '';
  const text = redactor.text(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const cleaned = redactCredentials(redactor.text(text))
    .replace(/-----BEGIN ([A-Z0-9][A-Z0-9 -]*)-----[\s\S]*?(?:-----END \1-----|$)/g, '[REDACTED]');
  return cleaned.includes('-----BEGIN') ? '' : cleaned;
}

// Revisions of a bot PR retain the original Issue's feature and approval boundary.
export function actionsSourceIssue(store: Store, task: { repository_id: string; kind: string; object_number: number }): number | null {
  if (task.kind.endsWith('.issue')) return store.get('SELECT number FROM actions_failure_issues WHERE repository_id=? AND number=?', task.repository_id, task.object_number)?.number ?? null;
  return store.get(`SELECT a.number FROM bot_pull_requests p JOIN tasks t ON t.id=p.source_task_id
    JOIN actions_failure_issues a ON a.repository_id=t.repository_id AND a.number=t.object_number
    WHERE p.repository_id=? AND p.number=? AND t.kind='development.issue'`, task.repository_id, task.object_number)?.number ?? null;
}

/**
 * An Issue filed from an Actions failure keeps the strict development gates other Issues hand to the Manager: its text
 * comes from logs, so it is developed only unassigned and with a review that found the change requested.
 */
export const actionsReport = (store: Store, id: string, number: number) => !!store.get('SELECT 1 FROM actions_failure_issues WHERE repository_id=? AND number=?', id, number);
export function actionsIssueAssigned(store: Store, id: string, number: number, issue: any) {
  const assigned = !!issue?.assignee || Array.isArray(issue?.assignees) && issue.assignees.length > 0;
  return assigned && actionsReport(store, id, number);
}
export function actionsDevelopmentAllowed(store: Store, id: string, number: number, issue?: any, result?: any) {
  const source = store.get('SELECT classification FROM actions_failure_issues WHERE repository_id=? AND number=?', id, number);
  if (!source) return true;
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', id);
  if (source.classification !== 'code' || !policy?.enabled || !policy.actions_failures_enabled || !covers(projectCeiling(store, id, policy), 'develop')) return false;
  const config = store.get('SELECT configured_at,error FROM actions_failure_scans WHERE repository_id=?', id);
  if (!config?.configured_at || actionsConfigurationErrors.includes(config.error)) return false;
  if (!issue) return true;
  const prose = String(issue.body || '').split('<!-- dept-bot-actions-log-start -->')[0]!;
  // Only sections in the author's prose count. Examples inside fenced code and blockquotes are evidence.
  const blocks = marked.lexer(prose).filter(block => block.type !== 'space');
  const sections = new Set(blocks.flatMap((block, index) => block.type === 'heading' && block.depth === 2
    && ['paragraph', 'list'].includes(blocks[index + 1]?.type ?? '') ? [block.text] : []));
  if (!['Current behavior', 'Expected behavior', 'Requested code change'].every(title => sections.has(title))) return false;
  // The review that checked repository code confirms the product defect; the quote it once had to return went with #815.
  return !result || result.product_defect === true;
}
