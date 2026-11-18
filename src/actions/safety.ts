import { marked } from 'marked';
import { hasCredentials, redactCredentials } from '../core/redaction.js';
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

// GitHub registers newly minted tokens through add() on this same instance during delivery.
class ActionsRedactor extends Redactor {
  override add(value: unknown) {
    if (typeof value !== 'string' || !value) return;
    this.values.add(value);
    this.values.add(encodeURIComponent(value));
    this.values.add(value.split('/').map(encodeURIComponent).join('/'));
    const base64 = Buffer.from(value).toString('base64');
    const urlSafe = base64.replace(/\+/g, '-').replace(/\//g, '_');
    for (const encoded of [base64, urlSafe]) {
      this.values.add(encoded);
      this.values.add(encoded.replace(/=+$/, ''));
    }
  }
}

export function actionsRedactor(store: Store, redactor: Redactor = new ActionsRedactor()) {
  for (const account of store.all('SELECT id,credentials FROM accounts')) {
    const credentials = store.secrets.open(account.credentials, `account:${account.id}`);
    for (const name of ['token', 'private_key', 'webhook_secret']) redactor.add(credentials[name]);
  }
  for (const model of store.all('SELECT id,api_key FROM models WHERE api_key IS NOT NULL')) redactor.add(store.secrets.open(model.api_key, `model:${model.id}`).value);
  for (const endpoint of store.all('SELECT id,secret FROM endpoints')) redactor.add(store.secrets.open(endpoint.secret, `endpoint:${endpoint.id}`).value);
  return redactor;
}

export function publicText(value: string, redactor: Redactor): string {
  if (value.includes('\0')) return '';
  // A log can encode an entire JSON object or header, so its token need not equal Base64(secret).
  // Inspect the payload before literal replacement; an encoding may share a substring with the encoded secret.
  const inspect = (encoded: string) => {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return redactor.text(decoded) !== decoded || hasCredentials(decoded) ? '[REDACTED]' : encoded;
  };
  // CLI/MIME encoders use fixed-width lines with a possibly shorter final line. Keep surrounding
  // Markdown and prose outside the payload, including a label before the first encoded line.
  const tokens = /[A-Za-z0-9+/_-]{8,}={0,2}/g;
  const continuation = /[ \t]*\r?\n[ \t]*([A-Za-z0-9+/_-]+={0,2})(?=[ \t]*\r?$|[`"'\])>])/my;
  let inspected = '', copied = 0;
  for (let first; (first = tokens.exec(value));) {
    const width = first[0].length;
    let line = first[0], end = tokens.lastIndex;
    while (line.length === width && !line.endsWith('=')) {
      continuation.lastIndex = end;
      const next = continuation.exec(value)?.[1];
      if (!next || next.length > width) break;
      line = next;
      end = continuation.lastIndex;
    }
    const encoded = value.slice(first.index, end);
    let safe = inspect(encoded);
    // Adjacent independent Base64 strings may each carry their own credential.
    if (safe === encoded && end > tokens.lastIndex) safe = encoded.replace(tokens, inspect);
    inspected += value.slice(copied, first.index) + safe;
    copied = end;
    tokens.lastIndex = end;
  }
  inspected += value.slice(copied);
  const text = redactor.text(inspected).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
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
  const sections = new Set<string>();
  let section = '';
  for (const block of marked.lexer(prose)) {
    if (block.type === 'heading') section = block.depth === 2 ? block.text : '';
    else if (section && ['paragraph', 'list', 'code', 'table', 'blockquote'].includes(block.type)
      && ('text' in block ? block.text : block.raw).trim()) sections.add(section);
  }
  if (!['Current behavior', 'Expected behavior', 'Requested code change'].every(title => sections.has(title))) return false;
  // The review that checked repository code confirms the product defect; the quote it once had to return went with #815.
  return !result || result.product_defect === true;
}
