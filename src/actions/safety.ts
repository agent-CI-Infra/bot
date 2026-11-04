import type { Store } from '../storage/database.js';
import { Redactor } from '../agent/common.js';

export function actionsRedactor(store: Store) {
  const redactor = new Redactor();
  const add = (value: unknown) => { if (typeof value === 'string' && value) redactor.values.add(value); };
  for (const account of store.all('SELECT id,credentials FROM accounts')) {
    const credentials = store.secrets.open(account.credentials, `account:${account.id}`);
    for (const name of ['token', 'private_key', 'webhook_secret']) add(credentials[name]);
  }
  for (const model of store.all('SELECT id,api_key FROM models WHERE api_key IS NOT NULL')) add(store.secrets.open(model.api_key, `model:${model.id}`).value);
  for (const endpoint of store.all('SELECT id,secret FROM endpoints')) add(store.secrets.open(endpoint.secret, `endpoint:${endpoint.id}`).value);
  return redactor;
}

export function publicText(value: string, redactor: Redactor, checkOpaque = true): string {
  let text = redactor.text(value);
  text = text.replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[REDACTED]')
    .replace(/\b(?:github_pat_|gh[pousr]_)[\w]+|\b(?:sk|sk-proj)-[\w-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\b(?:glpat-[\w-]+|xox[baprs]-[\w-]+|AIza[\w-]{30,})/g, '[REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[REDACTED]')
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '[REDACTED]')
    .replace(/((?:[\w-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|credential)[\w-]*)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1[REDACTED]')
    .replace(/((?:[\w-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|credential)[\w-]*)["']?\s*[:=]\s*)["']?[^\s,;"'}]+["']?/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  // Encoded/high-entropy material cannot reliably be made public by replacing known shapes.
  if (checkOpaque && /\b[A-Za-z0-9+/_=-]{48,}\b/.test(text) || /\x00|-----BEGIN/.test(text)) return '';
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

// Revisions of a bot PR retain the original Issue's feature and approval boundary.
export function actionsSourceIssue(store: Store, task: { repository_id: string; kind: string; object_number: number }): number | null {
  if (task.kind.endsWith('.issue')) return store.get('SELECT number FROM actions_failure_issues WHERE repository_id=? AND number=?', task.repository_id, task.object_number)?.number ?? null;
  return store.get(`SELECT a.number FROM bot_pull_requests p JOIN tasks t ON t.id=p.source_task_id
    JOIN actions_failure_issues a ON a.repository_id=t.repository_id AND a.number=t.object_number
    WHERE p.repository_id=? AND p.number=? AND t.kind='development.issue'`, task.repository_id, task.object_number)?.number ?? null;
}

export function actionsDevelopmentAllowed(store: Store, id: string, number: number, issue?: any, result?: any) {
  const source = store.get('SELECT classification FROM actions_failure_issues WHERE repository_id=? AND number=?', id, number);
  if (!source) return true;
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', id);
  if (source.classification !== 'code' || !policy?.enabled || !policy.actions_failures_enabled || !policy.review_enabled || !policy.development_enabled) return false;
  const config = store.get('SELECT configured_at,error FROM actions_failure_scans WHERE repository_id=?', id);
  if (!config?.configured_at || config.error === 'actions_workflow_run_subscription_missing') return false;
  if (!issue) return true;
  const prose = String(issue.body || '').split('<!-- dept-bot-actions-log-start -->')[0]!;
  if (!['Current behavior', 'Expected behavior', 'Requested code change'].every(title => new RegExp(`## ${title}\\n+\\S`).test(prose))) return false;
  return !result || result.product_defect === true && !!result.request_quote?.trim() && (String(issue.title || '') + '\n' + prose).includes(result.request_quote);
}
