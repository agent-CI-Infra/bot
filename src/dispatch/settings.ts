import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store, Row } from '../storage/database.js';
import { fail } from '../core/security.js';
import { checkRules, rulesStorage } from './rules.js';
import { roleConfiguration } from '../roles/definition.js';

/**
 * Project configuration of the unified Manager (#1122): one Markdown prompt (its flow and decision rules), project-wide
 * event filters, and standing rules for routine events. Work types (`work_settings`, `writeCatalog`, 11 prompt sections)
 * are retired; delivery rights are governed solely by `capability_ceiling`, `task_write_grants`, and role permissions.
 */
export const defaultManagerPrompt = readFileSync(resolve(import.meta.dirname, '../../docs/prompts/manager-dispatch.md'), 'utf8');
/** How the management assistant explains the Manager's flows and changes them with a before/after flowchart (#1123). */
export const managerFlowInstructions = readFileSync(resolve(import.meta.dirname, '../../docs/prompts/manager-flows.md'), 'utf8');

export function managerStorage(store: Store) {
  rulesStorage(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS manager_revisions(repository_id TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,
      work_settings TEXT NOT NULL DEFAULT '{}',event_filters TEXT NOT NULL,source TEXT NOT NULL,actor TEXT,created_at TEXT NOT NULL,PRIMARY KEY(repository_id,revision));
    CREATE TABLE IF NOT EXISTS manager_migrations(repository_id TEXT PRIMARY KEY,migrated_at TEXT NOT NULL,archive TEXT NOT NULL,report TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS manager_dispatch_prompts(repository_id TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(repository_id,revision));
  `);
  const columns = new Set(store.all('PRAGMA table_info(policies)').map(row => String(row.name)));
  if (!columns.has('work_settings')) store.db.exec("ALTER TABLE policies ADD COLUMN work_settings TEXT NOT NULL DEFAULT '{}'");
  if (!columns.has('event_filters')) store.db.exec("ALTER TABLE policies ADD COLUMN event_filters TEXT NOT NULL DEFAULT '{}'");
  if (!store.all('PRAGMA table_info(tasks)').some(row => row.name === 'workflow_id')) store.db.exec('ALTER TABLE tasks ADD COLUMN workflow_id TEXT');
}

const json = (text: unknown, fallback: any) => { try { const value = JSON.parse(String(text)); return value ?? fallback; } catch { return fallback; } };
const policyOf = (store: Store, repositoryId: string) => store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);

export interface ManagerPrompt { revision: number; content: string; updated_at: string | null; actor: string | null; source: string | null }

export function managerPrompt(store: Store, repositoryId: string): ManagerPrompt {
  const row = store.get('SELECT * FROM manager_revisions WHERE repository_id=? ORDER BY revision DESC LIMIT 1', repositoryId);
  if (!row) return { revision: 0, content: '', updated_at: null, actor: null, source: null };
  const dispatchRow = store.get('SELECT content FROM manager_dispatch_prompts WHERE repository_id=? AND revision=?', repositoryId, row.revision);
  const content = dispatchRow ? String(dispatchRow.content) : String(row.content);
  return { revision: Number(row.revision), content, updated_at: String(row.created_at), actor: row.actor ?? null, source: String(row.source) };
}

/** The Manager prompt in effect now: the project's saved text when non-empty, else the built-in default prompt. */
export function effectiveManagerPrompt(store: Store, repositoryId: string): string {
  const saved = managerPrompt(store, repositoryId);
  if (saved.content.trim()) return saved.content;
  const legacyDispatch = store.get('SELECT content FROM manager_dispatch_prompts WHERE repository_id=? ORDER BY revision DESC LIMIT 1', repositoryId);
  if (legacyDispatch && String(legacyDispatch.content).trim()) return String(legacyDispatch.content);
  return defaultManagerPrompt;
}

// ---- Event filters ----

export interface EventFilters {
  'issue.opened': boolean; 'issue.updated': boolean; 'issue.mention': boolean; 'issue.labels': string[]; 'issue.development_label': boolean;
  'pull_request.opened': boolean; 'pull_request.synchronize': boolean; 'pull_request.updated': boolean; 'pull_request.mention': boolean; 'pull_request.labels': string[];
  'review.published.issue': boolean; 'review.published.pr': boolean; 'actions.run_failed': boolean;
}
export const dispatchEventTypes = ['issue.opened', 'issue.updated', 'issue.mention', 'issue.labeled', 'pull_request.opened', 'pull_request.synchronize', 'pull_request.updated',
  'pull_request.mention', 'pull_request.labeled', 'pull_request.checks_failed', 'pull_request.conflicted', 'review.published', 'development.stopped', 'release.manual', 'actions.run_failed', 'schedule.due'];
export const filterColumns: Record<string, string> = { 'issue.opened': 'review_issues', 'issue.updated': 'review_issue_updates', 'pull_request.opened': 'review_pull_requests',
  'pull_request.synchronize': 'review_pr_updates', 'pull_request.updated': 'review_pr_discussion', 'actions.run_failed': 'actions_failures_enabled' };
const filterFlags = ['issue.mention', 'issue.development_label', 'pull_request.mention', 'review.published.issue', 'review.published.pr'];

export function syncEventFilters(store: Store, repositoryId: string, changes: Record<string, unknown>) {
  const policy = policyOf(store, repositoryId); if (!policy) return;
  const saved = json(policy.event_filters || '{}', {});
  for (const [column, key] of [['review_issue_updates', 'issue.updated'], ['review_pr_discussion', 'pull_request.updated']] as const)
    if (changes[column] !== undefined && typeof saved[key] === 'boolean') saved[key] = !!changes[column];
  store.run('UPDATE policies SET event_filters=? WHERE repository_id=?', JSON.stringify(saved), repositoryId);
}

export function eventFilters(store: Store, repositoryId: string, policy = policyOf(store, repositoryId)): EventFilters {
  const saved = json(policy?.event_filters ?? '{}', {}), flag = (key: string, fallback = true) => typeof saved[key] === 'boolean' ? saved[key] : fallback;
  const labels = (key: string) => Array.isArray(saved[key]) ? saved[key].filter((label: unknown) => typeof label === 'string' && label.trim()).map((label: string) => label.trim()) : [];
  const issues = !!policy?.review_issues, pulls = !!policy?.review_pull_requests;
  return {
    'issue.opened': issues, 'issue.updated': flag('issue.updated', issues && !!policy?.review_issue_updates), 'issue.mention': flag('issue.mention', issues), 'issue.labels': labels('issue.labels'),
    'issue.development_label': flag('issue.development_label'), 'pull_request.opened': pulls, 'pull_request.synchronize': !!policy?.review_pr_updates,
    'pull_request.updated': flag('pull_request.updated', pulls && !!policy?.review_pr_discussion), 'pull_request.mention': flag('pull_request.mention', pulls), 'pull_request.labels': labels('pull_request.labels'),
    'review.published.issue': flag('review.published.issue'), 'review.published.pr': flag('review.published.pr'), 'actions.run_failed': !!policy?.actions_failures_enabled,
  };
}

export const labelDispatched = (filters: EventFilters, object: 'issue' | 'pull_request', label: string) =>
  filters[`${object}.labels`].some(name => name.toLowerCase() === label.toLowerCase());

export function checkFilters(value: unknown): Partial<EventFilters> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_event_filters', 'events');
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.endsWith('.labels')) {
      if (!['issue.labels', 'pull_request.labels'].includes(key) || !Array.isArray(entry) || entry.length > 30 || entry.some(label => typeof label !== 'string' || !label.trim() || label.length > 50 || /\p{Cc}/u.test(label)))
        fail(400, 'invalid_event_filters', 'events.' + key);
      out[key] = [...new Set((entry as string[]).map(label => label.trim()))];
    } else if ((Object.hasOwn(filterColumns, key) || filterFlags.includes(key)) && typeof entry === 'boolean') out[key] = entry;
    else fail(400, 'invalid_event_filters', 'events.' + key);
  }
  return out as Partial<EventFilters>;
}

export interface ManagerChange { expected_revision: number; content?: string; prompt?: string; events?: unknown; standing_rules?: unknown }

/** Saves one immutable Manager revision atomically: prompt text, event filters and standing rules. */
export function saveManager(store: Store, repositoryId: string, change: ManagerChange, actor: string | null, source = 'console', onActions?: (enabled: boolean) => void) {
  return store.transaction(() => {
    const policy = policyOf(store, repositoryId); if (!policy) return fail(404, 'repository_not_found');
    const current = managerPrompt(store, repositoryId);
    if (!Number.isSafeInteger(change.expected_revision) || change.expected_revision !== current.revision) fail(409, 'manager_revision_conflict', 'expected_revision');
    let content = current.content;
    if (change.prompt !== undefined) {
      if (typeof change.prompt !== 'string' || !change.prompt.trim() || change.prompt.includes('\0') || Buffer.byteLength(change.prompt) > 512 * 1024)
        fail(400, 'invalid_manager_prompt', 'prompt');
      content = change.prompt;
    } else if (change.content !== undefined) {
      if (typeof change.content !== 'string' || change.content.includes('\0') || Buffer.byteLength(change.content) > 512 * 1024)
        fail(400, 'invalid_manager_prompt', 'content');
      content = change.content;
    }
    const filters = change.events === undefined ? undefined : checkFilters(change.events);
    const roleIds = roleConfiguration(store, repositoryId).roles.map(role => role.role_id);
    const standing = change.standing_rules === undefined ? undefined : checkRules(change.standing_rules, dispatchEventTypes, roleIds);
    const saved = json(policy.event_filters || '{}', {});
    if (filters) for (const [key, value] of Object.entries(filters)) {
      if (Object.hasOwn(filterColumns, key)) store.run(`UPDATE policies SET ${filterColumns[key]}=? WHERE repository_id=?`, Number(value), repositoryId);
      if (!Object.hasOwn(filterColumns, key) || ['issue.updated', 'pull_request.updated'].includes(key)) saved[key] = value;
    }
    store.run('UPDATE policies SET event_filters=? WHERE repository_id=?', JSON.stringify(saved), repositoryId);
    if (filters?.['actions.run_failed'] === true && !policy.actions_failures_enabled) onActions?.(true);
    const revision = current.revision + 1, now = new Date().toISOString();
    store.run('INSERT INTO manager_revisions VALUES(?,?,?,?,?,?,?,?)', repositoryId, revision, content, '{}',
      JSON.stringify(eventFilters(store, repositoryId)), source, actor, now);
    if (change.prompt !== undefined) store.run('INSERT INTO manager_dispatch_prompts VALUES(?,?,?)', repositoryId, revision, content);
    if (standing) store.run('INSERT INTO manager_rules VALUES(?,?,?)', repositoryId, revision, JSON.stringify(standing));
    return managerPrompt(store, repositoryId);
  });
}
