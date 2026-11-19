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

function redactEncodedCredentials(value: string, redactor: Redactor): string {
  const sensitive = (decoded: string) => redactor.text(decoded) !== decoded || hasCredentials(decoded);
  const decode = (encoded: string) => Buffer.from(encoded, 'base64').toString('utf8');
  // Ignore an incomplete trailing UTF-8 character when classifying the start of a text fragment.
  const nonText = (part: string) => /[\u0000-\u0008\u000e-\u001f\u007f\uFFFD]/.test(decode(part).replace(/\uFFFD$/, ''));
  const tokens = /[A-Za-z0-9+/_-]{8,}={0,2}/g;
  // A report may wrap a log in a blockquote or list, or reflow its lines into one paragraph.
  // Capture only the Base64 characters: an ordered list number or a dash is not payload data.
  const linePrefix = /[ \t]*\r?\n[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?/;
  const clock = /(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?/;
  const stamp = `(?:\\[${clock.source}\\]|${clock.source})[ \\t]+`;
  const continuation = new RegExp(`(?:${linePrefix.source}(?<timestamp>${stamp})?|[ \\t]+)(?<fragment>[A-Za-z0-9+/_-]+={0,2})`, 'y');
  let inspected = '', copied = 0;
  for (let first; (first = tokens.exec(value));) {
    const width = first[0].length, parts = [first[0]];
    const ends = [tokens.lastIndex];
    const timedLines: { end: number; prefix: string }[] = [];
    let line = first[0], end = tokens.lastIndex, lastFullEnd = end;
    while (line.length === width && !line.endsWith('=')) {
      continuation.lastIndex = end;
      const groups = continuation.exec(value)?.groups;
      const next = groups?.fragment;
      if (!next || next.length > width) break;
      if (groups?.timestamp) timedLines.push({ end: continuation.lastIndex, prefix: value.slice(end, continuation.lastIndex - next.length) });
      line = next;
      parts.push(next);
      end = continuation.lastIndex;
      ends.push(end);
      if (next.length === width) lastFullEnd = end;
    }
    const decoded = decode(parts.join(''));
    let safe: string;
    const second = parts[1];
    if (second && nonText(first[0]) && !nonText(second) && sensitive(decode(parts.slice(1).join('')))) {
      // A SHA or other public identifier can have exactly the encoder's line width. Inspect
      // it independently when the following fragments already identify a sensitive text payload.
      end = tokens.lastIndex;
      safe = sensitive(decode(first[0])) ? '[REDACTED]' : first[0];
    } else if (sensitive(decoded)) {
      // A complete JSON diagnostic can end on an unpadded, full-width fragment. Following
      // prose and SHAs belong to the report even when their tokens have exactly that width.
      const document = parts.length > 1 ? jsonDocumentPrefix(decoded) : undefined;
      const count = document ? Math.ceil(Buffer.byteLength(document) * 4 / 3) / width : 0;
      if (document && count && Number.isInteger(count) && count < parts.length && sensitive(document)) {
        end = ends[count - 1]!;
      } else if (lastFullEnd < end) {
        const prefix = decode(parts.slice(0, -1).join(''));
        if (sensitive(prefix) && (redactor.values.has(prefix)
          || !prefix.includes('\uFFFD') && decoded.includes('\uFFFD'))) end = lastFullEnd;
      }
      // Preserve the timestamps of individual log records, including their Markdown prefixes.
      safe = '[REDACTED]' + timedLines.filter(record => record.end <= end).map(record => record.prefix + '[REDACTED]').join('');
    } else {
      // A shorter token can start another folded payload. Reconsider it at its own width,
      // and check the full-width tokens individually for adjacent independent encodings.
      end = lastFullEnd;
      safe = parts.length === 1 ? first[0] : value.slice(first.index, end)
        .replace(tokens, encoded => sensitive(decode(encoded)) ? '[REDACTED]' : encoded);
    }
    inspected += value.slice(copied, first.index) + safe;
    copied = end;
    tokens.lastIndex = end;
  }
  return inspected + value.slice(copied);
}

// Locate the document boundary once even when unrelated Base64-looking prose decodes after it.
function jsonDocumentPrefix(text: string): string | undefined {
  if (!/^\s*[\[{]/.test(text)) return;
  let depth = 0, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '\\') i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if ((char === '}' || char === ']') && --depth === 0) {
      const prefix = text.slice(0, i + 1);
      try { JSON.parse(prefix); return prefix; } catch { return; }
    }
  }
}

export function publicText(value: string, redactor: Redactor): string {
  if (value.includes('\0')) return '';
  // Inspect encoded diagnostic objects and headers before replacing individual registered values.
  const inspected = redactEncodedCredentials(value, redactor);
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
 * An Issue filed from an Actions failure is developed like any other the Manager judges (#1104): its classification, structure,
 * review conclusion and assignees are facts for the Manager, not gates. What stays are the project's switches: the project is
 * enabled, Actions failure handling is on, and the capability ceiling allows development.
 */
export const actionsReport = (store: Store, id: string, number: number) => !!store.get('SELECT 1 FROM actions_failure_issues WHERE repository_id=? AND number=?', id, number);
export function actionsDevelopmentAllowed(store: Store, id: string, number: number, _issue?: any, _result?: any) {
  if (!actionsReport(store, id, number)) return true;
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', id);
  return !!policy?.enabled && !!policy.actions_failures_enabled && covers(projectCeiling(store, id, policy), 'develop');
}
